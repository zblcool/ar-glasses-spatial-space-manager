/*
 * viture-display-helper
 *
 * Creates N macOS virtual displays (private CoreGraphics CGVirtualDisplay API,
 * the same mechanism Spacewalker-style apps use), arranges them to the right
 * of the existing displays, and keeps them alive until it exits. The displays
 * disappear automatically when this process dies.
 *
 * stdout (JSON lines):
 *   {"event":"ready","displays":[{"id":N,"name":"…","width":px,"height":px,
 *     "x":pt,"y":pt,"w":pt,"h":pt}, …]}
 *   {"event":"error","message":"…"}
 *   {"event":"main","id":N}                 after `main` / `restore`
 *   {"event":"windows","moved":N}            windows moved off the protected display
 *   {"event":"ax","trusted":bool}            Accessibility permission state
 * stdin (one command per line):
 *   warp <displayId> <x> <y>   move the cursor to display-local point (x, y)
 *   main <displayId>           make that display the macOS main display (menu bar,
 *                              Dock, new windows); physical displays keep their
 *                              relative arrangement, centred below the virtual ones
 *   restore                    put the original arrangement / main display back
 *   release                    remove the virtual displays (e.g. before the glasses go 3D)
 *   create                     create them again (with the bandwidth fallback below)
 *   protect <displayId> <pid>  every second, move other apps' windows off that
 *                              display (the glasses, covered by our app) onto the
 *                              main display; needs Accessibility permission
 *   quit
 *
 * The original physical arrangement is saved to --state-file before changing
 * it, and restored on quit, SIGTERM, stdin EOF, or the next start after a crash.
 *
 * Display bandwidth: on base Apple Silicon (e.g. M2 MacBook Air) virtual
 * displays share the display engine's pixel budget with the real ones, and when
 * it is exceeded macOS silently turns an external display off — the glasses go
 * black. After creating the displays we check that every physical display is
 * still online; if one dropped, the virtual displays are removed and recreated
 * at the next lower tier (lower refresh, then smaller, then fewer).
 *
 * The private interfaces below declare only members whose existence and type
 * encodings were verified with the Objective-C runtime on macOS 26.6
 * (class_copyPropertyList / class_copyMethodList).
 */

#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

@interface CGVirtualDisplayDescriptor : NSObject
@property(retain, nonatomic) NSString *name;
@property(nonatomic) unsigned int maxPixelsWide;
@property(nonatomic) unsigned int maxPixelsHigh;
@property(nonatomic) CGSize sizeInMillimeters;
@property(nonatomic) unsigned int vendorID;
@property(nonatomic) unsigned int productID;
@property(nonatomic) unsigned int serialNumber;
@property(retain, nonatomic) dispatch_queue_t queue;
@end

@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)refreshRate;
@end

@interface CGVirtualDisplaySettings : NSObject
@property(retain, nonatomic) NSArray *modes;
@property(nonatomic) unsigned int hiDPI;
@end

@interface CGVirtualDisplay : NSObject
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@property(readonly, nonatomic) unsigned int displayID;
@end

static NSMutableArray *g_displays; /* keeps the CGVirtualDisplay objects alive */
static NSString *g_stateFile;      /* original physical arrangement, for crash recovery */
static BOOL g_changedMain = NO;
static CGDirectDisplayID g_protectDisplay = 0;
static pid_t g_protectPid = 0;
static dispatch_source_t g_sweepTimer;
static int g_axTrusted = -1;
static unsigned g_count = 2, g_width = 1920, g_height = 1080, g_hidpi = 0;
static double g_hz = 50;
static int g_generation = 0; /* invalidates pending fallback checks after release/create */

static void emit(NSDictionary *obj)
{
    NSData *data = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static void fail(NSString *msg)
{
    fprintf(stderr, "[display-helper] %s\n", msg.UTF8String);
    emit(@{ @"event" : @"error", @"message" : msg });
}

static BOOL is_ours(CGDirectDisplayID d)
{
    for (CGVirtualDisplay *v in g_displays)
        if (v.displayID == d) return YES;
    return NO;
}

/* Place the virtual displays side by side, right of everything else, top-aligned with the main display. */
static void arrange(void)
{
    CGDirectDisplayID ids[32];
    uint32_t n = 0;
    if (CGGetActiveDisplayList(32, ids, &n) != kCGErrorSuccess) return;
    CGFloat right = 0;
    for (uint32_t i = 0; i < n; i++) {
        if (is_ours(ids[i])) continue;
        CGRect b = CGDisplayBounds(ids[i]);
        if (CGRectGetMaxX(b) > right) right = CGRectGetMaxX(b);
    }
    CGDisplayConfigRef cfg;
    if (CGBeginDisplayConfiguration(&cfg) != kCGErrorSuccess) return;
    CGFloat x = right;
    for (CGVirtualDisplay *v in g_displays) {
        CGConfigureDisplayOrigin(cfg, v.displayID, (int32_t)x, 0);
        x += CGDisplayBounds(v.displayID).size.width;
    }
    CGError err = CGCompleteDisplayConfiguration(cfg, kCGConfigureForSession);
    if (err != kCGErrorSuccess) fprintf(stderr, "[display-helper] arrange failed: %d\n", err);
}

/* ---- main display switch ---------------------------------------------------- */

static NSDictionary *physical_origins(void)
{
    CGDirectDisplayID ids[32];
    uint32_t n = 0;
    NSMutableDictionary *out = [NSMutableDictionary dictionary];
    if (CGGetActiveDisplayList(32, ids, &n) != kCGErrorSuccess) return out;
    for (uint32_t i = 0; i < n; i++) {
        if (is_ours(ids[i])) continue;
        CGRect b = CGDisplayBounds(ids[i]);
        out[[NSString stringWithFormat:@"%u", ids[i]]] = @[ @(b.origin.x), @(b.origin.y) ];
    }
    return out;
}

/* Apply origins {displayId: [x, y]} for physical displays, then line the virtual ones up at `vx`. */
static BOOL configure(NSDictionary *physical, CGFloat vx, CGFloat vy)
{
    CGDisplayConfigRef cfg;
    if (CGBeginDisplayConfiguration(&cfg) != kCGErrorSuccess) return NO;
    for (NSString *key in physical) {
        NSArray *o = physical[key];
        CGConfigureDisplayOrigin(cfg, (CGDirectDisplayID)key.longLongValue, (int32_t)[o[0] doubleValue], (int32_t)[o[1] doubleValue]);
    }
    for (CGVirtualDisplay *v in g_displays) {
        CGConfigureDisplayOrigin(cfg, v.displayID, (int32_t)vx, (int32_t)vy);
        vx += CGDisplayBounds(v.displayID).size.width;
    }
    CGError err = CGCompleteDisplayConfiguration(cfg, kCGConfigureForSession);
    if (err != kCGErrorSuccess) fprintf(stderr, "[display-helper] configure failed: %d\n", err);
    return err == kCGErrorSuccess;
}

static void set_main(CGDirectDisplayID target)
{
    if (!is_ours(target)) {
        fprintf(stderr, "[display-helper] main: %u is not one of our displays\n", target);
        return;
    }
    NSDictionary *orig = physical_origins();
    if (!g_changedMain && g_stateFile) {
        /* Save before touching anything, so a crash can be undone on the next start. */
        NSData *data = [NSJSONSerialization dataWithJSONObject:orig options:0 error:nil];
        [data writeToFile:g_stateFile atomically:YES];
    }
    /* Physical block keeps its shape and sits centred *below* the row of virtual
     * displays. That keeps a virtual display leftmost and rightmost, so a Dock on
     * the left/right (which lives on the leftmost/rightmost display) and the
     * bottom Dock (main display) all stay off the glasses. */
    CGFloat minX = INFINITY, maxX = -INFINITY, minY = INFINITY;
    for (NSString *k in orig) {
        CGRect b = CGDisplayBounds((CGDirectDisplayID)k.longLongValue);
        minX = fmin(minX, b.origin.x);
        maxX = fmax(maxX, CGRectGetMaxX(b));
        minY = fmin(minY, b.origin.y);
    }
    CGFloat vdWidth = 0, vdHeight = 0;
    for (CGVirtualDisplay *v in g_displays) {
        CGRect b = CGDisplayBounds(v.displayID);
        vdWidth += b.size.width;
        vdHeight = fmax(vdHeight, b.size.height);
    }
    CGFloat dx = round((vdWidth - (maxX - minX)) / 2) - minX;
    CGFloat dy = vdHeight - minY;
    NSMutableDictionary *shifted = [NSMutableDictionary dictionary];
    for (NSString *k in orig) {
        NSArray *o = orig[k];
        shifted[k] = @[ @([o[0] doubleValue] + dx), @([o[1] doubleValue] + dy) ];
    }
    /* The target display goes first at (0, 0), which makes it the main display. */
    [g_displays sortUsingComparator:^NSComparisonResult(CGVirtualDisplay *a, CGVirtualDisplay *b) {
        return a.displayID == target ? NSOrderedAscending : b.displayID == target ? NSOrderedDescending : NSOrderedSame;
    }];
    if (configure(shifted, 0, 0)) {
        g_changedMain = YES;
        emit(@{ @"event" : @"main", @"id" : @(CGMainDisplayID()) });
    }
}

static void restore_main(void)
{
    NSDictionary *orig = nil;
    if (g_stateFile) {
        NSData *data = [NSData dataWithContentsOfFile:g_stateFile];
        if (data) orig = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    }
    if (!orig) return;
    /* Only restore displays that still exist. */
    CGDirectDisplayID ids[32];
    uint32_t n = 0;
    CGGetActiveDisplayList(32, ids, &n);
    NSMutableDictionary *present = [NSMutableDictionary dictionary];
    CGFloat right = 0;
    for (uint32_t i = 0; i < n; i++) {
        NSString *k = [NSString stringWithFormat:@"%u", ids[i]];
        if (!orig[k]) continue;
        present[k] = orig[k];
        right = fmax(right, [orig[k][0] doubleValue] + CGDisplayBounds(ids[i]).size.width);
    }
    if (present.count && configure(present, right, 0)) {
        fprintf(stderr, "[display-helper] restored original display arrangement\n");
        emit(@{ @"event" : @"main", @"id" : @(CGMainDisplayID()) });
    }
    g_changedMain = NO;
    [[NSFileManager defaultManager] removeItemAtPath:g_stateFile error:nil];
}

/* ---- keep windows off the protected (glasses) display ------------------------ */

static BOOL ax_get_frame(AXUIElementRef w, CGRect *out)
{
    CFTypeRef pos = NULL, size = NULL;
    BOOL ok = AXUIElementCopyAttributeValue(w, kAXPositionAttribute, &pos) == kAXErrorSuccess &&
              AXUIElementCopyAttributeValue(w, kAXSizeAttribute, &size) == kAXErrorSuccess &&
              AXValueGetValue(pos, kAXValueTypeCGPoint, &out->origin) && AXValueGetValue(size, kAXValueTypeCGSize, &out->size);
    if (pos) CFRelease(pos);
    if (size) CFRelease(size);
    return ok;
}

static void sweep(void)
{
    if (!g_protectDisplay) return;
    int trusted = AXIsProcessTrusted() ? 1 : 0;
    if (trusted != g_axTrusted) {
        g_axTrusted = trusted;
        /* Report only. Never prompt from here: in immersive mode the system dialog
         * would open on the glasses behind the app's fullscreen window, where the
         * user cannot see or answer it. The app's setup screen asks instead. */
        emit(@{ @"event" : @"ax", @"trusted" : @(trusted) });
    }
    if (!trusted) return;

    CGRect guard = CGDisplayBounds(g_protectDisplay);
    CGRect dest = CGDisplayBounds(CGMainDisplayID());
    if (CGRectIsEmpty(guard) || CGMainDisplayID() == g_protectDisplay) return;

    /* Find apps with normal windows centred on the protected display. All windows, not
     * just on-screen ones: the app's native fullscreen Space hides the glasses' desktop. */
    CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    NSMutableSet *pids = [NSMutableSet set];
    for (NSDictionary *w in (__bridge NSArray *)list) {
        if ([w[(__bridge NSString *)kCGWindowLayer] intValue] != 0) continue;
        pid_t pid = [w[(__bridge NSString *)kCGWindowOwnerPID] intValue];
        if (pid == g_protectPid || pid == getpid()) continue;
        CGRect b;
        if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(__bridge NSString *)kCGWindowBounds], &b)) continue;
        if (CGRectContainsPoint(guard, CGPointMake(CGRectGetMidX(b), CGRectGetMidY(b)))) [pids addObject:@(pid)];
    }
    if (list) CFRelease(list);

    int moved = 0;
    for (NSNumber *pidNum in pids) {
        AXUIElementRef app = AXUIElementCreateApplication(pidNum.intValue);
        CFArrayRef windows = NULL;
        if (AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, (CFTypeRef *)&windows) == kAXErrorSuccess && windows) {
            for (CFIndex i = 0; i < CFArrayGetCount(windows); i++) {
                AXUIElementRef w = CFArrayGetValueAtIndex(windows, i);
                CGRect f;
                if (!ax_get_frame(w, &f) || !CGRectContainsPoint(guard, CGPointMake(CGRectGetMidX(f), CGRectGetMidY(f)))) continue;
                /* Same relative position on the destination, clamped so the title bar stays reachable. */
                CGPoint p = CGPointMake(dest.origin.x + fmin(fmax(f.origin.x - guard.origin.x, 0), fmax(dest.size.width - f.size.width, 0)),
                                        dest.origin.y + fmin(fmax(f.origin.y - guard.origin.y, 25), fmax(dest.size.height - 100, 25)));
                AXValueRef v = AXValueCreate(kAXValueTypeCGPoint, &p);
                if (AXUIElementSetAttributeValue(w, kAXPositionAttribute, v) == kAXErrorSuccess) moved++;
                CFRelease(v);
            }
            CFRelease(windows);
        }
        CFRelease(app);
    }
    if (moved) emit(@{ @"event" : @"windows", @"moved" : @(moved) });
}

static void start_protect(CGDirectDisplayID d, pid_t pid)
{
    g_protectDisplay = d;
    g_protectPid = pid;
    if (g_sweepTimer) return;
    g_sweepTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
    dispatch_source_set_timer(g_sweepTimer, DISPATCH_TIME_NOW, NSEC_PER_SEC, NSEC_PER_SEC / 10);
    dispatch_source_set_event_handler(g_sweepTimer, ^{ sweep(); });
    dispatch_resume(g_sweepTimer);
}

static void shutdown_and_exit(void)
{
    if (g_changedMain) restore_main();
    exit(0); /* virtual displays vanish with the process */
}

static void report_ready(void)
{
    NSMutableArray *list = [NSMutableArray array];
    for (CGVirtualDisplay *v in g_displays) {
        CGDirectDisplayID d = v.displayID;
        CGRect b = CGDisplayBounds(d);
        [list addObject:@{
            @"id" : @(d),
            @"name" : [NSString stringWithFormat:@"VOW Virtual %lu", (unsigned long)list.count + 1],
            @"width" : @(CGDisplayPixelsWide(d)),
            @"hz" : @(CGDisplayModeGetRefreshRate(CGDisplayCopyDisplayMode(d))),
            @"height" : @(CGDisplayPixelsHigh(d)),
            @"x" : @(b.origin.x),
            @"y" : @(b.origin.y),
            @"w" : @(b.size.width),
            @"h" : @(b.size.height),
        }];
    }
    emit(@{ @"event" : @"ready", @"displays" : list });
}

static void warp(CGDirectDisplayID d, double x, double y)
{
    CGRect b = CGDisplayBounds(d);
    if (CGRectIsEmpty(b)) {
        fprintf(stderr, "[display-helper] warp: unknown display %u\n", d);
        return;
    }
    x = fmin(fmax(x, 0), b.size.width - 1);
    y = fmin(fmax(y, 0), b.size.height - 1);
    CGWarpMouseCursorPosition(CGPointMake(b.origin.x + x, b.origin.y + y));
    /* Re-couple mouse and cursor immediately (warping briefly suppresses movement). */
    CGAssociateMouseAndMouseCursorPosition(true);
}

static void release_displays(void);
static void create_with_fallback(void);

static void *stdin_loop(void *arg)
{
    (void)arg;
    char line[256];
    while (fgets(line, sizeof line, stdin)) {
        unsigned id;
        int pid;
        double x, y;
        if (sscanf(line, "warp %u %lf %lf", &id, &x, &y) == 3) {
            dispatch_async(dispatch_get_main_queue(), ^{ warp(id, x, y); });
        } else if (sscanf(line, "main %u", &id) == 1) {
            dispatch_async(dispatch_get_main_queue(), ^{ set_main(id); });
        } else if (!strncmp(line, "restore", 7)) {
            dispatch_async(dispatch_get_main_queue(), ^{ restore_main(); });
        } else if (!strncmp(line, "release", 7)) {
            dispatch_async(dispatch_get_main_queue(), ^{
                g_generation++;
                release_displays();
                emit(@{ @"event" : @"released" });
            });
        } else if (!strncmp(line, "create", 6)) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (!g_displays.count) create_with_fallback();
            });
        } else if (sscanf(line, "protect %u %d", &id, &pid) == 2) {
            dispatch_async(dispatch_get_main_queue(), ^{ start_protect(id, pid); });
        } else if (!strncmp(line, "quit", 4)) {
            break;
        }
    }
    /* stdin closed (parent gone) or quit: restore, then exit (displays vanish). */
    dispatch_async(dispatch_get_main_queue(), ^{ shutdown_and_exit(); });
    return NULL;
}

/* ---- creation with bandwidth fallback ---------------------------------------- */

typedef struct {
    unsigned count, width, height;
    double hz;
} Tier;

static NSSet *online_physical(void)
{
    CGDirectDisplayID ids[32];
    uint32_t n = 0;
    NSMutableSet *out = [NSMutableSet set];
    if (CGGetOnlineDisplayList(32, ids, &n) != kCGErrorSuccess) return out;
    for (uint32_t i = 0; i < n; i++)
        if (!is_ours(ids[i])) [out addObject:@(ids[i])];
    return out;
}

static void release_displays(void)
{
    if (g_changedMain) restore_main();
    [g_displays removeAllObjects]; /* dropping the objects removes the displays */
}

static BOOL create_displays(Tier t)
{
    for (unsigned i = 0; i < t.count; i++) {
        CGVirtualDisplayDescriptor *desc = [[CGVirtualDisplayDescriptor alloc] init];
        desc.queue = dispatch_get_main_queue();
        desc.name = [NSString stringWithFormat:@"VOW Virtual %u", i + 1];
        /* HiDPI modes need twice the pixels per point. */
        desc.maxPixelsWide = t.width * (g_hidpi ? 2 : 1);
        desc.maxPixelsHigh = t.height * (g_hidpi ? 2 : 1);
        /* ~24" 16:9 panel; only used for the reported physical size / DPI. */
        desc.sizeInMillimeters = CGSizeMake(527, 527.0 * t.height / t.width);
        desc.vendorID = 0x3456;
        desc.productID = 0x1000 + i;
        desc.serialNumber = 0x1000 + i;

        CGVirtualDisplay *display = [[CGVirtualDisplay alloc] initWithDescriptor:desc];
        if (!display || display.displayID == 0) {
            fail([NSString stringWithFormat:@"failed to create virtual display %u", i + 1]);
            return NO;
        }
        CGVirtualDisplaySettings *settings = [[CGVirtualDisplaySettings alloc] init];
        settings.hiDPI = g_hidpi;
        settings.modes = @[ [[CGVirtualDisplayMode alloc] initWithWidth:t.width height:t.height refreshRate:t.hz] ];
        if (![display applySettings:settings]) {
            fail([NSString stringWithFormat:@"applySettings failed for virtual display %u", i + 1]);
            return NO;
        }
        [g_displays addObject:display];
        fprintf(stderr, "[display-helper] created display %u (%ux%u@%.0f%s)\n", display.displayID, t.width, t.height, t.hz,
                g_hidpi ? " HiDPI" : "");
    }
    return YES;
}

/* Fallback tiers, from the requested configuration downwards. */
static const int NTIERS = 6;
static Tier tier_at(int i)
{
    switch (i) {
    case 0: return (Tier){ g_count, g_width, g_height, g_hz };
    case 1: return (Tier){ g_count, g_width, g_height, 30 };
    case 2: return (Tier){ g_count, 1600, 900, 30 };
    case 3: return (Tier){ g_count, 1280, 720, 30 };
    case 4: return (Tier){ 1, g_width, g_height, 30 };
    default: return (Tier){ 1, 1280, 720, 30 };
    }
}

static BOOL same_tier(Tier a, Tier b)
{
    return a.count == b.count && a.width == b.width && a.height == b.height && a.hz == b.hz;
}

/* Try tiers until no physical display drops. */
static void create_with_fallback(void)
{
    const int generation = ++g_generation;
    __block int tier = 0;
    __block void (^attempt)(void);
    attempt = ^{
        if (generation != g_generation) return;
        if (tier >= NTIERS) {
            fail(@"not enough display bandwidth for virtual displays alongside your displays; they stay off");
            return;
        }
        NSSet *before = online_physical();
        Tier t = tier_at(tier);
        if (t.count > g_count || t.width * t.height > g_width * g_height || (tier > 0 && same_tier(t, tier_at(tier - 1)))) {
            tier++; /* skip tiers that are not actually lower */
            attempt();
            return;
        }
        if (!create_displays(t)) return;
        /* Give the display engine time to drop a display if the budget is exceeded. */
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2500 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
            if (generation != g_generation) return;
            NSMutableSet *missing = [before mutableCopy];
            [missing minusSet:online_physical()];
            if (missing.count) {
                fprintf(stderr, "[display-helper] %lu physical display(s) went offline with %u×%ux%u@%.0f — too much display bandwidth, trying a lower tier\n",
                        (unsigned long)missing.count, t.count, t.width, t.height, t.hz);
                release_displays();
                tier++;
                /* Wait for the dropped display to come back before trying again. */
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 3000 * NSEC_PER_MSEC), dispatch_get_main_queue(), attempt);
                return;
            }
            arrange();
            report_ready();
            attempt = nil; /* break the block's self-reference */
        });
    };
    attempt();
}

int main(int argc, char **argv)
{
    @autoreleasepool {
        for (int i = 1; i < argc; i++) {
            const char *a = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
            if (!strcmp(a, "--count") && v) { g_count = (unsigned)atoi(v); i++; }
            else if (!strcmp(a, "--width") && v) { g_width = (unsigned)atoi(v); i++; }
            else if (!strcmp(a, "--height") && v) { g_height = (unsigned)atoi(v); i++; }
            else if (!strcmp(a, "--hz") && v) { g_hz = atof(v); i++; }
            else if (!strcmp(a, "--hidpi") && v) { g_hidpi = (unsigned)atoi(v); i++; }
            else if (!strcmp(a, "--state-file") && v) { g_stateFile = @(v); i++; }
            else {
                fprintf(stderr, "usage: %s [--count N] [--width PX] [--height PX] [--hz HZ] [--hidpi 0|1] [--state-file PATH]\n", argv[0]);
                return 2;
            }
        }
        if (g_count < 1 || g_count > 4) g_count = 2;

        /* Signals are handled on the main queue so the arrangement can be restored first. */
        signal(SIGPIPE, SIG_IGN);
        static dispatch_source_t sigsrc[2];
        int sigs[2] = { SIGTERM, SIGINT };
        for (int k = 0; k < 2; k++) {
            signal(sigs[k], SIG_IGN);
            sigsrc[k] = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, (uintptr_t)sigs[k], 0, dispatch_get_main_queue());
            dispatch_source_set_event_handler(sigsrc[k], ^{ shutdown_and_exit(); });
            dispatch_resume(sigsrc[k]);
        }

        /* A previous run that crashed after `main` left its saved arrangement behind. */
        if (g_stateFile && [[NSFileManager defaultManager] fileExistsAtPath:g_stateFile]) {
            fprintf(stderr, "[display-helper] restoring arrangement left by an unclean exit\n");
            restore_main();
        }

        if (!NSClassFromString(@"CGVirtualDisplay")) {
            fail(@"CGVirtualDisplay is not available on this macOS version");
            return 1;
        }

        g_displays = [NSMutableArray array];
        create_with_fallback();

        pthread_t t;
        pthread_create(&t, NULL, stdin_loop, NULL);
        dispatch_main();
    }
}
