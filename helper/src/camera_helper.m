/*
 * viture-camera-helper
 *
 * Streams all three cameras of a VITURE Luma Ultra (Carina) to stdout, for
 * the camera viewer in tools/camera-viewer:
 *
 *   - the two grayscale VIO (tracking) cameras, from the Carina camera
 *     callback (8-bit, width*height bytes per eye);
 *   - the RGB camera, from xr_camera_provider (1920x1080 MJPEG, ~30 fps).
 *
 * stdout is a sequence of packets, each a 24-byte little-endian header
 * followed by `length` payload bytes:
 *
 *   u32 magic 'VCAM' (0x4D414356)   u8 kind   u8[3] reserved
 *   u16 width   u16 height          u32 length   f64 timestamp (epoch ms)
 *
 *   kind 1  stereo pair: left plane then right plane, width*height bytes each,
 *           then a 40-byte pose trailer: f64 SDK frame timestamp, f32[7] head
 *           pose [px py pz qw qx qy qz] (OpenGL frame, metres) read when the
 *           frame arrived, i32 pose status (0 stable, 1 unstable, -1 none)
 *   kind 2  RGB frame: one JPEG
 *   kind 3  status: a JSON object (width/height 0)
 *
 * --log-level 3 makes the SDK log everything to stderr (it may print the
 * factory camera calibration).
 *
 * stdin commands (one per line):
 *   exposure auto              automatic exposure for the tracking cameras
 *   exposure <ms> <gain>       manual exposure, 0.01-8 ms, gain 0-15
 *   pair 0|1                   which of the two stereo pairs per callback to send
 *   rgb 1|0                    start / stop the RGB camera
 *
 * Only the latest frame of each camera is kept: the SDK callbacks copy into a
 * slot and a writer thread sends whatever is newest, so a slow reader drops
 * frames instead of stalling the SDK's threads.
 *
 * Opens the glasses the same way viture-pose-helper does, so the two cannot
 * run at the same time (quit Viture Open Walker first).
 */

#import <AVFoundation/AVFoundation.h>

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "usb_enum.h"
#include "viture_camera_provider.h"
#include "viture_device_carina.h"
#include "viture_glasses_provider.h"
#include "viture_result.h"

#define MAGIC 0x4D414356u /* "VCAM" */
#define POSE_TRAILER 40
enum { KIND_STEREO = 1, KIND_RGB = 2, KIND_STATUS = 3 };

static volatile sig_atomic_t g_stop = 0;
static int g_out_fd = -1;
static pthread_mutex_t g_out_mtx = PTHREAD_MUTEX_INITIALIZER;

/* Pending stdin commands, applied on the main thread. */
static atomic_int g_cmd_exposure = 0; /* 0 none, 1 auto, 2 manual */
static float g_cmd_exp_ms = 4.0f;
static int g_cmd_exp_gain = 4;
static atomic_int g_cmd_rgb = -1;
static atomic_int g_pair = 0;

/* Latest 6DoF pose, polled on its own thread (never from an SDK callback,
 * which could deadlock against the VIO thread that is calling us). */
static XRDeviceProviderHandle g_handle = NULL;
static atomic_int g_pose_run = 0;
static pthread_mutex_t g_pose_mtx = PTHREAD_MUTEX_INITIALIZER;
static float g_pose[7];
static int g_pose_status = -1;

/* ---- utilities ----------------------------------------------------------- */

static void logf_err(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    fputs("[camera-helper] ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
}

static double now_epoch_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
}

static void sleep_ms(int ms)
{
    struct timespec ts = { ms / 1000, (long)(ms % 1000) * 1000000L };
    while (nanosleep(&ts, &ts) == -1 && errno == EINTR && !g_stop) {}
}

static const char *result_str(int rc)
{
    switch (rc) {
    case VITURE_GLASSES_SUCCESS:                 return "SUCCESS";
    case VITURE_GLASSES_ERROR_INVALID_PARAM:     return "INVALID_PARAM";
    case VITURE_GLASSES_ERROR_USB_UNAVAILABLE:   return "USB_UNAVAILABLE";
    case VITURE_GLASSES_ERROR_USB_EXEC:          return "USB_EXEC";
    case VITURE_GLASSES_ERROR_NOT_SUPPORTED:     return "NOT_SUPPORTED";
    case VITURE_GLASSES_ERROR_INVALID_STATE:     return "INVALID_STATE";
    default:                                     return "ERROR";
    }
}

static int write_all(const void *buf, size_t len)
{
    const uint8_t *p = buf;
    while (len > 0) {
        ssize_t n = write(g_out_fd, p, len);
        if (n < 0) {
            if (errno == EINTR) continue;
            logf_err("stdout write failed (%s); stopping", strerror(errno));
            g_stop = 1;
            return -1;
        }
        p += n;
        len -= (size_t)n;
    }
    return 0;
}

/* One packet; `b` is an optional second payload part (the right eye). */
static void emit_packet(int kind, int w, int h, double t, const void *a, size_t alen, const void *b, size_t blen)
{
    uint8_t hdr[24];
    uint32_t magic = MAGIC, length = (uint32_t)(alen + blen);
    uint16_t w16 = (uint16_t)w, h16 = (uint16_t)h;
    memcpy(hdr, &magic, 4);
    hdr[4] = (uint8_t)kind;
    hdr[5] = hdr[6] = hdr[7] = 0;
    memcpy(hdr + 8, &w16, 2);
    memcpy(hdr + 10, &h16, 2);
    memcpy(hdr + 12, &length, 4);
    memcpy(hdr + 16, &t, 8);
    pthread_mutex_lock(&g_out_mtx);
    if (write_all(hdr, sizeof hdr) == 0 && write_all(a, alen) == 0 && blen) write_all(b, blen);
    pthread_mutex_unlock(&g_out_mtx);
}

static void emit_status(const char *fmt, ...)
{
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    if (n > 0 && (size_t)n < sizeof buf) emit_packet(KIND_STATUS, 0, 0, now_epoch_ms(), buf, (size_t)n, NULL, 0);
}

/* ---- latest-frame slots ---------------------------------------------------- */

typedef struct {
    pthread_mutex_t mtx;
    uint8_t *data;
    size_t size, cap;
    int w, h;
    double t;
    uint64_t seq;
} Slot;

static Slot g_stereo = { PTHREAD_MUTEX_INITIALIZER, NULL, 0, 0, 0, 0, 0, 0 };
static Slot g_rgb = { PTHREAD_MUTEX_INITIALIZER, NULL, 0, 0, 0, 0, 0, 0 };
static pthread_mutex_t g_wake_mtx = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_wake = PTHREAD_COND_INITIALIZER;

/* Copy parts into the slot (called on SDK threads; never blocks on stdout). */
static void slot_put(Slot *s, int w, int h, const void *a, size_t alen, const void *b, size_t blen)
{
    pthread_mutex_lock(&s->mtx);
    size_t need = alen + blen;
    if (need > s->cap) {
        uint8_t *p = realloc(s->data, need);
        if (!p) {
            pthread_mutex_unlock(&s->mtx);
            return;
        }
        s->data = p;
        s->cap = need;
    }
    memcpy(s->data, a, alen);
    if (blen) memcpy(s->data + alen, b, blen);
    s->size = need;
    s->w = w;
    s->h = h;
    s->t = now_epoch_ms();
    s->seq++;
    pthread_mutex_unlock(&s->mtx);
    pthread_mutex_lock(&g_wake_mtx);
    pthread_cond_signal(&g_wake);
    pthread_mutex_unlock(&g_wake_mtx);
}

/* Send the slot if it has a frame newer than *sent. */
static void slot_send(Slot *s, int kind, uint64_t *sent, uint8_t **buf, size_t *cap)
{
    pthread_mutex_lock(&s->mtx);
    if (s->seq == *sent || s->size == 0) {
        pthread_mutex_unlock(&s->mtx);
        return;
    }
    if (s->size > *cap) {
        uint8_t *p = realloc(*buf, s->size);
        if (!p) {
            pthread_mutex_unlock(&s->mtx);
            return;
        }
        *buf = p;
        *cap = s->size;
    }
    memcpy(*buf, s->data, s->size);
    size_t size = s->size;
    int w = s->w, h = s->h;
    double t = s->t;
    *sent = s->seq;
    pthread_mutex_unlock(&s->mtx);
    emit_packet(kind, w, h, t, *buf, size, NULL, 0);
}

static void *writer_fn(void *arg)
{
    (void)arg;
    uint64_t sent_stereo = 0, sent_rgb = 0;
    uint8_t *buf = NULL;
    size_t cap = 0;
    while (!g_stop) {
        pthread_mutex_lock(&g_wake_mtx);
        struct timespec deadline;
        clock_gettime(CLOCK_REALTIME, &deadline);
        deadline.tv_nsec += 50000000L;
        if (deadline.tv_nsec >= 1000000000L) {
            deadline.tv_sec++;
            deadline.tv_nsec -= 1000000000L;
        }
        pthread_cond_timedwait(&g_wake, &g_wake_mtx, &deadline);
        pthread_mutex_unlock(&g_wake_mtx);
        slot_send(&g_stereo, KIND_STEREO, &sent_stereo, &buf, &cap);
        slot_send(&g_rgb, KIND_RGB, &sent_rgb, &buf, &cap);
    }
    free(buf);
    return NULL;
}

/* ---- SDK callbacks ------------------------------------------------------- */

static void on_signal(int sig)
{
    (void)sig;
    g_stop = 1;
}

static void sdk_log_hook(int level, const char *tag, const char *message)
{
    fprintf(stderr, "[sdk:%d:%s] %s\n", level, tag ? tag : "", message ? message : "");
}

static void *pose_fn(void *arg)
{
    (void)arg;
    while (atomic_load(&g_pose_run) && !g_stop) {
        float pose[7];
        int status = 1;
        if (xr_device_provider_get_gl_pose_carina(g_handle, pose, 0.0, &status) == VITURE_GLASSES_SUCCESS) {
            pthread_mutex_lock(&g_pose_mtx);
            memcpy(g_pose, pose, sizeof pose);
            g_pose_status = status;
            pthread_mutex_unlock(&g_pose_mtx);
        }
        sleep_ms(2);
    }
    return NULL;
}

/* Each callback carries two stereo pairs; `pair` picks which one is sent. */
static void on_stereo(char *left0, char *right0, char *left1, char *right1, double timestamp, int width, int height)
{
    int second = atomic_load(&g_pair) == 1 && left1 && right1;
    char *l = second ? left1 : left0, *r = second ? right1 : right0;
    if (!l || !r || width <= 0 || height <= 0 || width > 65535 || height > 65535) return;
    size_t plane = (size_t)width * (size_t)height;
    uint8_t *pair = malloc(2 * plane + POSE_TRAILER);
    if (!pair) return;
    memcpy(pair, l, plane);
    memcpy(pair + plane, r, plane);
    uint8_t *tr = pair + 2 * plane;
    memcpy(tr, &timestamp, 8);
    pthread_mutex_lock(&g_pose_mtx);
    memcpy(tr + 8, g_pose, 28);
    memcpy(tr + 36, &g_pose_status, 4);
    pthread_mutex_unlock(&g_pose_mtx);
    slot_put(&g_stereo, width, height, pair, 2 * plane + POSE_TRAILER, NULL, 0);
    free(pair);
}

static void on_rgb(const XRCameraFrame *frame, void *user_data)
{
    (void)user_data;
    if (!frame || frame->format != XR_CAMERA_FORMAT_MJPEG || !frame->data || frame->size == 0) return;
    slot_put(&g_rgb, (int)frame->width, (int)frame->height, frame->data, frame->size, NULL, 0);
}

/* ---- stdin commands -------------------------------------------------------- */

static void *stdin_fn(void *arg)
{
    (void)arg;
    char line[128];
    float ms;
    int gain, v;
    while (fgets(line, sizeof line, stdin)) {
        if (!strncmp(line, "exposure auto", 13)) {
            atomic_store(&g_cmd_exposure, 1);
        } else if (sscanf(line, "exposure %f %d", &ms, &gain) == 2) {
            g_cmd_exp_ms = ms;
            g_cmd_exp_gain = gain;
            atomic_store(&g_cmd_exposure, 2);
        } else if (sscanf(line, "pair %d", &v) == 1) {
            atomic_store(&g_pair, v ? 1 : 0);
            emit_status("{\"pair\":%d}", v ? 1 : 0);
        } else if (sscanf(line, "rgb %d", &v) == 1) {
            atomic_store(&g_cmd_rgb, v ? 1 : 0);
        }
    }
    return NULL;
}

/* ---- RGB camera ------------------------------------------------------------ */

/* The RGB camera is a USB video device, so macOS asks for camera access. */
static int camera_permission(void)
{
    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
    if (status == AVAuthorizationStatusAuthorized) return 1;
    if (status != AVAuthorizationStatusNotDetermined) return 0;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block BOOL granted = NO;
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo
                             completionHandler:^(BOOL g) {
                                 granted = g;
                                 dispatch_semaphore_signal(sem);
                             }];
    dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);
    return granted;
}

static XRCameraProviderHandle rgb_start(int pid)
{
    int vid = xr_camera_provider_get_camera_vid(pid), cpid = xr_camera_provider_get_camera_pid(pid);
    if (!cpid) {
        emit_status("{\"rgb\":\"unsupported\"}");
        return NULL;
    }
    if (!camera_permission()) {
        logf_err("camera access denied (System Settings > Privacy & Security > Camera)");
        emit_status("{\"rgb\":\"error\",\"message\":\"macOS camera access denied for this terminal\"}");
        return NULL;
    }
    XRCameraProviderHandle cam = xr_camera_provider_create(vid, cpid);
    if (!cam) {
        emit_status("{\"rgb\":\"error\",\"message\":\"xr_camera_provider_create failed\"}");
        return NULL;
    }
    int rc = xr_camera_provider_start(cam, on_rgb, NULL);
    if (rc != VITURE_GLASSES_SUCCESS) {
        logf_err("xr_camera_provider_start: %d %s", rc, result_str(rc));
        emit_status("{\"rgb\":\"error\",\"message\":\"camera start failed: %s (another app using it?)\"}", result_str(rc));
        xr_camera_provider_destroy(cam);
        return NULL;
    }
    emit_status("{\"rgb\":\"on\"}");
    return cam;
}

static void rgb_stop(XRCameraProviderHandle cam)
{
    if (!cam) return;
    xr_camera_provider_stop(cam);
    xr_camera_provider_destroy(cam);
    emit_status("{\"rgb\":\"off\"}");
}

/* ---- session ---------------------------------------------------------------- */

static int run_session(int pid, int want_rgb)
{
    char name[64] = "unknown";
    int name_len = (int)sizeof name;
    xr_device_provider_get_market_name(pid, name, &name_len);
    name[sizeof name - 1] = '\0';

    XRDeviceProviderHandle h = xr_device_provider_create(pid);
    if (!h) return -1;
    if (xr_device_provider_get_device_type(h) != XR_DEVICE_TYPE_VITURE_CARINA) {
        emit_status("{\"status\":\"error\",\"message\":\"%s is not a Luma Ultra; it has no tracking cameras\"}", name);
        xr_device_provider_destroy(h);
        return -2;
    }
    /* The tracking cameras run for VIO, i.e. in 6DoF. */
    xr_device_provider_set_dof_type_carina(h, 1);
    int rc = xr_device_provider_initialize(h, NULL, NULL);
    if (rc != VITURE_GLASSES_SUCCESS) {
        logf_err("initialize: %d %s", rc, result_str(rc));
        xr_device_provider_destroy(h);
        return -1;
    }
    /* The VIO engine captures the camera callback at start, so register first. */
    xr_device_provider_register_callbacks_carina(h, NULL, NULL, NULL, on_stereo);
    rc = xr_device_provider_start(h);
    if (rc != VITURE_GLASSES_SUCCESS) {
        logf_err("start: %d %s", rc, result_str(rc));
        xr_device_provider_shutdown(h);
        xr_device_provider_destroy(h);
        return -1;
    }
    g_handle = h;
    atomic_store(&g_pose_run, 1);
    pthread_t pose_thread;
    int have_pose = pthread_create(&pose_thread, NULL, pose_fn, NULL) == 0;
    emit_status("{\"status\":\"streaming\",\"device\":\"%s\",\"pid\":%d}", name, pid);
    logf_err("streaming %s (pid 0x%04X)", name, pid);

    XRCameraProviderHandle cam = want_rgb ? rgb_start(pid) : NULL;
    int lost = 0;
    for (int tick = 0; !g_stop; tick++) {
        sleep_ms(50);
        int exp = atomic_exchange(&g_cmd_exposure, 0);
        if (exp == 1) {
            rc = xr_device_provider_set_auto_exposure_carina(h);
            emit_status("{\"exposure\":\"auto\",\"ok\":%s}", rc == VITURE_GLASSES_SUCCESS ? "true" : "false");
        } else if (exp == 2) {
            rc = xr_device_provider_set_manual_exposure_carina(h, g_cmd_exp_ms, g_cmd_exp_gain);
            emit_status("{\"exposure\":\"manual\",\"ms\":%.2f,\"gain\":%d,\"ok\":%s}", g_cmd_exp_ms, g_cmd_exp_gain,
                        rc == VITURE_GLASSES_SUCCESS ? "true" : "false");
        }
        int want = atomic_exchange(&g_cmd_rgb, -1);
        if (want == 1 && !cam) cam = rgb_start(pid);
        else if (want == 0 && cam) {
            rgb_stop(cam);
            cam = NULL;
        }
        if (tick % 20 == 0 && !is_device_present(pid)) {
            lost = 1;
            break;
        }
    }

    rgb_stop(cam);
    atomic_store(&g_pose_run, 0);
    if (have_pose) pthread_join(pose_thread, NULL);
    pthread_mutex_lock(&g_pose_mtx);
    g_pose_status = -1;
    pthread_mutex_unlock(&g_pose_mtx);
    xr_device_provider_stop(h);
    xr_device_provider_shutdown(h);
    xr_device_provider_destroy(h);
    return lost ? 1 : 0;
}

int main(int argc, char **argv)
{
    int want_rgb = 1, log_level = LOG_LEVEL_ERROR;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--no-rgb")) want_rgb = 0;
        else if (!strcmp(argv[i], "--log-level") && i + 1 < argc) log_level = atoi(argv[++i]);
        else {
            fprintf(stderr, "usage: %s [--no-rgb] [--log-level 0-3]\n", argv[0]);
            return 2;
        }
    }

    /* Keep the real stdout for packets; stray prints (the SDK's) go to stderr. */
    g_out_fd = dup(STDOUT_FILENO);
    if (g_out_fd < 0 || dup2(STDERR_FILENO, STDOUT_FILENO) < 0) {
        perror("dup");
        return 1;
    }
    fcntl(g_out_fd, F_SETFD, FD_CLOEXEC);

    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_signal;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGHUP, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);

    pthread_t t;
    pthread_create(&t, NULL, stdin_fn, NULL);
    pthread_detach(t);
    pthread_t writer;
    pthread_create(&writer, NULL, writer_fn, NULL);

    xr_device_provider_set_log_level(log_level);
    xr_device_provider_set_log_hook(sdk_log_hook);

    int announced = 0;
    while (!g_stop) {
        int pids[16];
        int n = find_viture_devices(pids, 16);
        if (n == 0) {
            if (!announced) emit_status("{\"status\":\"searching\"}");
            announced = 1;
            sleep_ms(500);
            continue;
        }
        announced = 0;
        int r = run_session(pids[0], want_rgb);
        if (g_stop) break;
        if (r == 1) emit_status("{\"status\":\"lost\"}");
        else if (r == -1) emit_status("{\"status\":\"error\",\"message\":\"SDK init/start failed (is Viture Open Walker running?), retrying\"}");
        sleep_ms(r == -2 ? 5000 : 1000);
    }

    pthread_join(writer, NULL);
    logf_err("exiting");
    return 0;
}
