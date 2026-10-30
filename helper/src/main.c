/*
 * viture-pose-helper
 *
 * Streams head pose from a VITURE Luma Ultra (Carina) as JSON lines on stdout.
 *
 *   pose line:   {"t":<epoch_ms>,"q":[x,y,z,w]}            (3DoF)
 *                {"t":<epoch_ms>,"q":[x,y,z,w],"p":[x,y,z]} (6DoF, metres)
 *   status line: {"status":"searching"|"tracking"|"lost"|"error"|"display", ...}
 *
 * stdin commands (one per line):
 *   display3d 1|0   switch the glasses to SBS 3D (3840-wide) or back to 2D.
 *                   Uses xr_device_provider_set_display_mode, which the SDK
 *                   documents for Carina; switch_dimension is documented as
 *                   Gen1/Gen2-only. The original mode is restored on exit.
 *
 * Coordinates are the SDK's OpenGL frame (x right, y up, z backward), which is
 * also three.js's frame, so the quaternion can be applied to a camera as-is.
 * `t` is CLOCK_REALTIME in milliseconds at the moment the pose was read from
 * the SDK, so the renderer can compare it to performance.timeOrigin+now().
 *
 * Everything that is not a JSON line goes to stderr. The SDK's own logging may
 * write to stdio, so fd 1 is redirected to stderr at startup and JSON lines are
 * written to a private duplicate of the original stdout.
 */

#include <errno.h>
#include <fcntl.h>
#include <math.h>
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
#include "viture_device_carina.h"
#include "viture_glasses_provider.h"
#include "viture_protocol_public.h"
#include "viture_result.h"

/* ---- configuration ------------------------------------------------------ */

static struct {
    int    dof;          /* 3 or 6 */
    double max_hz;       /* output rate cap; 0 = uncapped */
    double predict_ms;   /* passed to get_gl_pose_carina (converted to seconds) */
    int    log_level;    /* SDK log level 0..3 */
    int    pid_override; /* 0 = auto-detect */
    int    imu_wake;     /* use the IMU callback as a "new data" signal */
} g_cfg = { 3, 250.0, 0.0, LOG_LEVEL_ERROR, 0, 1 };

/* ---- globals ------------------------------------------------------------- */

static volatile sig_atomic_t g_stop = 0;
static int g_json_fd = -1;

static pthread_mutex_t g_imu_mtx = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t  g_imu_cond = PTHREAD_COND_INITIALIZER;
static uint64_t        g_imu_seq = 0;

static atomic_int g_device_present = 1;
static atomic_int g_monitor_run = 0;

/* Pending stdin command, applied on the pose thread: -1 none, 0 = 2D, 1 = 3D. */
static atomic_int g_cmd_3d = -1;

/* ---- utilities ----------------------------------------------------------- */

static void logf_err(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    fputs("[helper] ", stderr);
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

static double now_mono_s(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

static void sleep_s(double s)
{
    if (s <= 0) return;
    struct timespec ts;
    ts.tv_sec = (time_t)s;
    ts.tv_nsec = (long)((s - (double)ts.tv_sec) * 1e9);
    while (nanosleep(&ts, &ts) == -1 && errno == EINTR && !g_stop) {}
}

/* Sleep in small slices so SIGTERM is honoured promptly. */
static void sleep_interruptible(double s)
{
    double end = now_mono_s() + s;
    while (!g_stop) {
        double left = end - now_mono_s();
        if (left <= 0) break;
        sleep_s(left < 0.05 ? left : 0.05);
    }
}

/* Write one full line to the JSON fd. Exits if the reader is gone. */
static void emit_line(const char *buf, size_t len)
{
    size_t off = 0;
    while (off < len) {
        ssize_t n = write(g_json_fd, buf + off, len - off);
        if (n < 0) {
            if (errno == EINTR) continue;
            /* EPIPE: the parent closed our stdout. Shut down cleanly. */
            logf_err("stdout write failed (%s); stopping", strerror(errno));
            g_stop = 1;
            return;
        }
        off += (size_t)n;
    }
}

static void emit_status(const char *status, const char *extra_json)
{
    char buf[512];
    int n = snprintf(buf, sizeof buf, "{\"status\":\"%s\",\"t\":%.3f%s%s}\n",
                     status, now_epoch_ms(), extra_json ? "," : "", extra_json ? extra_json : "");
    if (n > 0 && (size_t)n < sizeof buf) emit_line(buf, (size_t)n);
}

static const char *result_str(int rc)
{
    switch (rc) {
    case VITURE_GLASSES_SUCCESS:                 return "SUCCESS";
    case VITURE_GLASSES_ERROR_INVALID_PARAM:     return "INVALID_PARAM";
    case VITURE_GLASSES_ERROR_USB_UNAVAILABLE:   return "USB_UNAVAILABLE";
    case VITURE_GLASSES_ERROR_USB_EXEC:          return "USB_EXEC";
    case VITURE_GLASSES_ERROR_NOT_SUPPORTED:     return "NOT_SUPPORTED";
    case VITURE_GLASSES_ERROR_NO_DATA:           return "NO_DATA";
    case VITURE_GLASSES_ERROR_DATA_PARSE:        return "DATA_PARSE";
    case VITURE_GLASSES_ERROR_DEVICE_REJECTED:   return "DEVICE_REJECTED";
    case VITURE_GLASSES_ERROR_CALIB_INIT:        return "CALIB_INIT";
    case VITURE_GLASSES_ERROR_SERIAL_FETCH:      return "SERIAL_FETCH";
    case VITURE_GLASSES_ERROR_INVALID_STATE:     return "INVALID_STATE";
    case VITURE_GLASSES_ERROR_HANDLE_DESTROYED:  return "HANDLE_DESTROYED";
    default:                                     return "UNKNOWN";
    }
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

/* Carina IMU callback: only used as a wake-up so we read the pose as soon as
 * the SDK has new inertial data, instead of sleeping a fixed interval. */
static void on_imu(float *imu, double timestamp)
{
    (void)imu;
    (void)timestamp;
    pthread_mutex_lock(&g_imu_mtx);
    g_imu_seq++;
    pthread_cond_signal(&g_imu_cond);
    pthread_mutex_unlock(&g_imu_mtx);
}

/* Wait until a new IMU sample arrives or `timeout_s` elapses. */
static void wait_for_imu(uint64_t *last_seq, double timeout_s)
{
    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    long ns = deadline.tv_nsec + (long)(timeout_s * 1e9);
    deadline.tv_sec += ns / 1000000000L;
    deadline.tv_nsec = ns % 1000000000L;

    pthread_mutex_lock(&g_imu_mtx);
    while (g_imu_seq == *last_seq && !g_stop) {
        if (pthread_cond_timedwait(&g_imu_cond, &g_imu_mtx, &deadline) == ETIMEDOUT) break;
    }
    *last_seq = g_imu_seq;
    pthread_mutex_unlock(&g_imu_mtx);
}

/* ---- device presence monitor (separate thread so IOKit enumeration never
 *      stalls the pose loop) ---------------------------------------------- */

static void *monitor_fn(void *arg)
{
    int pid = *(int *)arg;
    while (atomic_load(&g_monitor_run) && !g_stop) {
        atomic_store(&g_device_present, is_device_present(pid));
        sleep_interruptible(1.0);
    }
    return NULL;
}

/* ---- stdin commands -------------------------------------------------------- */

static void *stdin_fn(void *arg)
{
    (void)arg;
    char line[128];
    int v;
    while (fgets(line, sizeof line, stdin)) {
        if (sscanf(line, "display3d %d", &v) == 1) atomic_store(&g_cmd_3d, v ? 1 : 0);
    }
    return NULL; /* EOF: parent closed stdin; SIGTERM handles shutdown */
}

/* ---- display mode (2D <-> SBS 3D) ------------------------------------------ */

static int is_3d_mode(int m)
{
    return m == VITURE_DISPLAY_MODE_3840_1080_60HZ || m == VITURE_DISPLAY_MODE_3840_1080_90HZ ||
           m == VITURE_DISPLAY_MODE_3840_1200_60HZ || m == VITURE_DISPLAY_MODE_3840_1200_90HZ;
}

/* The 3D (or 2D) counterpart of a mode, keeping panel height and, where one exists, refresh rate. */
static int counterpart_mode(int m, int want_3d)
{
    int is1200 = m == VITURE_DISPLAY_MODE_1920_1200_60HZ || m == VITURE_DISPLAY_MODE_1920_1200_90HZ ||
                 m == VITURE_DISPLAY_MODE_1920_1200_120HZ || m == VITURE_DISPLAY_MODE_3840_1200_60HZ ||
                 m == VITURE_DISPLAY_MODE_3840_1200_90HZ;
    int is90 = m == VITURE_DISPLAY_MODE_1920_1080_90HZ || m == VITURE_DISPLAY_MODE_1920_1200_90HZ ||
               m == VITURE_DISPLAY_MODE_3840_1080_90HZ || m == VITURE_DISPLAY_MODE_3840_1200_90HZ;
    if (want_3d) {
        if (is1200) return is90 ? VITURE_DISPLAY_MODE_3840_1200_90HZ : VITURE_DISPLAY_MODE_3840_1200_60HZ;
        return is90 ? VITURE_DISPLAY_MODE_3840_1080_90HZ : VITURE_DISPLAY_MODE_3840_1080_60HZ;
    }
    if (is1200) return is90 ? VITURE_DISPLAY_MODE_1920_1200_90HZ : VITURE_DISPLAY_MODE_1920_1200_60HZ;
    return is90 ? VITURE_DISPLAY_MODE_1920_1080_90HZ : VITURE_DISPLAY_MODE_1920_1080_60HZ;
}

static void emit_display_mode(int mode, int rc)
{
    char extra[96];
    if (mode >= 0)
        snprintf(extra, sizeof extra, "\"mode\":%d,\"is3d\":%s", mode, is_3d_mode(mode) ? "true" : "false");
    else
        snprintf(extra, sizeof extra, "\"mode\":null,\"is3d\":false,\"error\":\"%s\"", result_str(rc));
    emit_status("display", extra);
}

/* ---- one tracking session ---------------------------------------------- */

enum session_result { SESSION_STOPPED, SESSION_LOST, SESSION_ERROR, SESSION_UNSUPPORTED };

static enum session_result run_session(int pid)
{
    char name[64] = "unknown";
    int name_len = (int)sizeof name;
    if (xr_device_provider_get_market_name(pid, name, &name_len) != VITURE_GLASSES_SUCCESS)
        snprintf(name, sizeof name, "unknown");
    name[sizeof name - 1] = '\0';

    XRDeviceProviderHandle h = xr_device_provider_create(pid);
    if (!h) {
        logf_err("xr_device_provider_create(0x%04X) returned NULL", pid);
        return SESSION_ERROR;
    }

    int type = xr_device_provider_get_device_type(h);
    if (type != XR_DEVICE_TYPE_VITURE_CARINA) {
        logf_err("device 0x%04X (%s) is type %d, not Carina/Luma Ultra; unsupported", pid, name, type);
        xr_device_provider_destroy(h);
        return SESSION_UNSUPPORTED;
    }

    /* Must be after create and before initialize (viture_device_carina.h). */
    int rc = xr_device_provider_set_dof_type_carina(h, g_cfg.dof == 6 ? 1 : 0);
    if (rc != VITURE_GLASSES_SUCCESS)
        logf_err("set_dof_type_carina failed: %d %s", rc, result_str(rc));

    rc = xr_device_provider_initialize(h, NULL, NULL);
    if (rc != VITURE_GLASSES_SUCCESS) {
        logf_err("initialize failed: %d %s", rc, result_str(rc));
        xr_device_provider_destroy(h);
        return SESSION_ERROR;
    }

    /* Callbacks are captured at start time, so register before start. */
    if (g_cfg.imu_wake) {
        rc = xr_device_provider_register_callbacks_carina(h, NULL, NULL, on_imu, NULL);
        if (rc != VITURE_GLASSES_SUCCESS)
            logf_err("register_callbacks_carina failed: %d %s (falling back to polling)", rc, result_str(rc));
    }

    rc = xr_device_provider_start(h);
    if (rc != VITURE_GLASSES_SUCCESS) {
        logf_err("start failed: %d %s", rc, result_str(rc));
        xr_device_provider_shutdown(h);
        xr_device_provider_destroy(h);
        return SESSION_ERROR;
    }

    char extra[192];
    snprintf(extra, sizeof extra, "\"device\":\"%s\",\"pid\":%d,\"dof\":%d,\"stable\":false",
             name, pid, g_cfg.dof);
    emit_status("tracking", extra);

    /* Remember the display mode so a 3D switch can be undone on exit. */
    int original_mode = xr_device_provider_get_display_mode(h);
    int current_mode = original_mode;
    if (original_mode < 0) logf_err("get_display_mode: %d %s", original_mode, result_str(original_mode));
    emit_display_mode(original_mode, original_mode);
    logf_err("tracking %s (pid 0x%04X) in %dDoF, max %.0f Hz", name, pid, g_cfg.dof, g_cfg.max_hz);

    atomic_store(&g_device_present, 1);
    atomic_store(&g_monitor_run, 1);
    pthread_t monitor;
    int monitor_pid = pid;
    int have_monitor = pthread_create(&monitor, NULL, monitor_fn, &monitor_pid) == 0;

    enum session_result result = SESSION_STOPPED;
    const double min_interval = g_cfg.max_hz > 0 ? 1.0 / g_cfg.max_hz : 0.0;
    const double predict_s = g_cfg.predict_ms / 1000.0;
    double last_emit = 0.0, last_ok = now_mono_s();
    double stats_start = last_ok;
    unsigned stats_emitted = 0, stats_imu = 0;
    uint64_t imu_seq = 0, imu_seq_stats = 0;
    float prev[7] = {0};
    int prev_status = -1;

    while (!g_stop) {
        /* Block until the SDK has new data (or 4 ms max, as a polling fallback). */
        wait_for_imu(&imu_seq, 0.004);
        if (g_stop) break;

        int want3d = atomic_exchange(&g_cmd_3d, -1);
        if (want3d >= 0 && current_mode >= 0) {
            int target = counterpart_mode(current_mode, want3d);
            int r = target == current_mode ? VITURE_GLASSES_SUCCESS : xr_device_provider_set_display_mode(h, target);
            if (r == VITURE_GLASSES_SUCCESS) current_mode = target;
            else logf_err("set_display_mode(0x%02X): %d %s", target, r, result_str(r));
            emit_display_mode(r == VITURE_GLASSES_SUCCESS ? current_mode : -1, r);
        }

        /* Respect the output cap, but read the pose *after* waiting so the
         * emitted sample is as fresh as possible. */
        double wait_left = last_emit + min_interval - now_mono_s();
        if (wait_left > 0) sleep_s(wait_left);

        if (!atomic_load(&g_device_present)) {
            logf_err("device 0x%04X disappeared from USB", pid);
            result = SESSION_LOST;
            break;
        }

        float pose[7];
        int status = 1;
        rc = xr_device_provider_get_gl_pose_carina(h, pose, predict_s, &status);
        double t_ms = now_epoch_ms();
        double now = now_mono_s();
        if (rc != VITURE_GLASSES_SUCCESS) {
            if (now - last_ok > 2.0) {
                logf_err("get_gl_pose_carina failing for >2 s (last rc %d %s)", rc, result_str(rc));
                result = SESSION_LOST;
                break;
            }
            continue;
        }
        last_ok = now;

        if (status != prev_status) {
            emit_status("tracking", status == 0 ? "\"stable\":true" : "\"stable\":false");
            prev_status = status;
        }

        /* Skip exact repeats: the SDK has not produced a newer pose. */
        if (memcmp(prev, pose, sizeof pose) == 0) continue;
        memcpy(prev, pose, sizeof pose);

        /* SDK layout: [px, py, pz, qw, qx, qy, qz]. Output q as [x, y, z, w]. */
        float qw = pose[3], qx = pose[4], qy = pose[5], qz = pose[6];
        float norm = sqrtf(qw * qw + qx * qx + qy * qy + qz * qz);
        if (!(norm > 0.5f && norm < 1.5f)) continue; /* zero/garbage while warming up */
        /* While pose_status is unstable (~1 s after start) the SDK returns an
         * exact identity pose as a placeholder; emitting it would snap the
         * camera to "forward/level" and then jump. */
        if (status != 0 && qw == 1.0f && qx == 0.0f && qy == 0.0f && qz == 0.0f) continue;

        char buf[256];
        int n;
        if (g_cfg.dof == 6) {
            n = snprintf(buf, sizeof buf,
                         "{\"t\":%.3f,\"q\":[%.6f,%.6f,%.6f,%.6f],\"p\":[%.5f,%.5f,%.5f]}\n",
                         t_ms, qx / norm, qy / norm, qz / norm, qw / norm, pose[0], pose[1], pose[2]);
        } else {
            n = snprintf(buf, sizeof buf, "{\"t\":%.3f,\"q\":[%.6f,%.6f,%.6f,%.6f]}\n",
                         t_ms, qx / norm, qy / norm, qz / norm, qw / norm);
        }
        if (n > 0 && (size_t)n < sizeof buf) emit_line(buf, (size_t)n);
        last_emit = now;
        stats_emitted++;

        if (now - stats_start >= 5.0) {
            pthread_mutex_lock(&g_imu_mtx);
            stats_imu = (unsigned)(g_imu_seq - imu_seq_stats);
            imu_seq_stats = g_imu_seq;
            pthread_mutex_unlock(&g_imu_mtx);
            logf_err("rate: %.1f poses/s emitted, %.1f IMU callbacks/s",
                     stats_emitted / (now - stats_start), stats_imu / (now - stats_start));
            stats_emitted = 0;
            stats_start = now;
        }
    }

    /* Leave the glasses in the mode we found them in. */
    if (original_mode >= 0 && current_mode != original_mode && atomic_load(&g_device_present)) {
        int r = xr_device_provider_set_display_mode(h, original_mode);
        logf_err("restoring display mode 0x%02X: %s", original_mode, result_str(r));
    }

    atomic_store(&g_monitor_run, 0);
    if (have_monitor) pthread_join(monitor, NULL);

    /* Lifecycle teardown order from viture_glasses_provider.h. */
    rc = xr_device_provider_stop(h);
    if (rc != VITURE_GLASSES_SUCCESS) logf_err("stop: %d %s", rc, result_str(rc));
    rc = xr_device_provider_shutdown(h);
    if (rc != VITURE_GLASSES_SUCCESS) logf_err("shutdown: %d %s", rc, result_str(rc));
    xr_device_provider_destroy(h);
    logf_err("provider stopped");
    return result;
}

/* ---- main ---------------------------------------------------------------- */

static void usage(const char *argv0)
{
    fprintf(stderr,
            "usage: %s [--dof 3|6] [--max-hz N] [--predict-ms F] [--log-level 0-3]\n"
            "          [--pid 0xNNNN] [--no-imu-wake] [--list]\n",
            argv0);
}

int main(int argc, char **argv)
{
    int list_only = 0;
    for (int i = 1; i < argc; i++) {
        const char *a = argv[i];
        const char *v = i + 1 < argc ? argv[i + 1] : NULL;
        if (!strcmp(a, "--dof") && v) { g_cfg.dof = atoi(v) == 6 ? 6 : 3; i++; }
        else if (!strcmp(a, "--max-hz") && v) { g_cfg.max_hz = atof(v); i++; }
        else if (!strcmp(a, "--predict-ms") && v) { g_cfg.predict_ms = atof(v); i++; }
        else if (!strcmp(a, "--log-level") && v) { g_cfg.log_level = atoi(v); i++; }
        else if (!strcmp(a, "--pid") && v) { g_cfg.pid_override = (int)strtol(v, NULL, 0); i++; }
        else if (!strcmp(a, "--no-imu-wake")) { g_cfg.imu_wake = 0; }
        else if (!strcmp(a, "--list")) { list_only = 1; }
        else { usage(argv[0]); return 2; }
    }

    /* Keep a private handle on the real stdout for JSON, then point fd 1 at
     * stderr so any stray printf (ours or the SDK's) cannot corrupt the stream. */
    g_json_fd = dup(STDOUT_FILENO);
    if (g_json_fd < 0 || dup2(STDERR_FILENO, STDOUT_FILENO) < 0) {
        perror("dup");
        return 1;
    }
    fcntl(g_json_fd, F_SETFD, FD_CLOEXEC);

    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_signal;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGHUP, &sa, NULL);

    pthread_t stdin_thread;
    pthread_create(&stdin_thread, NULL, stdin_fn, NULL);
    pthread_detach(stdin_thread);
    signal(SIGPIPE, SIG_IGN);

    xr_device_provider_set_log_level(g_cfg.log_level);
    xr_device_provider_set_log_hook(sdk_log_hook);

    if (list_only) {
        int pids[16];
        int n = find_viture_devices(pids, 16);
        for (int i = 0; i < n; i++) {
            char name[64] = "unknown";
            int len = (int)sizeof name;
            xr_device_provider_get_market_name(pids[i], name, &len);
            name[sizeof name - 1] = '\0';
            fprintf(stderr, "0x%04X %s\n", pids[i], name);
        }
        if (n == 0) fprintf(stderr, "no VITURE devices found\n");
        return 0;
    }

    int announced_search = 0;
    double backoff = 1.0;
    while (!g_stop) {
        int pid = g_cfg.pid_override;
        if (!pid) {
            int pids[16];
            int n = find_viture_devices(pids, 16);
            pid = n > 0 ? pids[0] : 0;
            if (n > 1) logf_err("%d VITURE devices found, using the first (0x%04X)", n, pid);
        }
        if (!pid) {
            if (!announced_search) {
                emit_status("searching", NULL);
                logf_err("waiting for glasses...");
                announced_search = 1;
            }
            sleep_interruptible(0.5);
            continue;
        }

        announced_search = 0;
        enum session_result r = run_session(pid);
        if (g_stop) break;
        switch (r) {
        case SESSION_LOST:
            emit_status("lost", NULL);
            backoff = 1.0;
            sleep_interruptible(0.5);
            break;
        case SESSION_UNSUPPORTED:
            emit_status("error", "\"message\":\"connected glasses are not a Luma Ultra\"");
            sleep_interruptible(5.0);
            break;
        case SESSION_ERROR:
        default:
            emit_status("error", "\"message\":\"SDK init/start failed, retrying\"");
            sleep_interruptible(backoff);
            backoff = backoff * 2 > 10.0 ? 10.0 : backoff * 2;
            break;
        }
    }

    logf_err("exiting");
    close(g_json_fd);
    return 0;
}
