/*
 * USB enumeration for VITURE glasses on macOS (IOKit).
 *
 * The Luma Ultra (Carina) uses bulk transfers and is not visible to HID
 * enumeration, so we walk the IOUSB device registry directly, mirroring the
 * fallback path in the SDK's glasses-demo (device_enum.cpp).
 */

#include "usb_enum.h"

#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/usb/IOUSBLib.h>

#include "viture_glasses_provider.h"

static int get_usb_u16(io_service_t svc, CFStringRef key, uint16_t *out)
{
    CFTypeRef prop = IORegistryEntryCreateCFProperty(svc, key, kCFAllocatorDefault, 0);
    if (!prop) return 0;
    int ok = 0;
    if (CFGetTypeID(prop) == CFNumberGetTypeID())
        ok = CFNumberGetValue((CFNumberRef)prop, kCFNumberSInt16Type, out) ? 1 : 0;
    CFRelease(prop);
    return ok;
}

int find_viture_devices(int *pids, int max_pids)
{
    int count = 0;
    CFMutableDictionaryRef match = IOServiceMatching(kIOUSBDeviceClassName);
    if (!match) return 0;

    io_iterator_t it = 0;
    /* IOServiceGetMatchingServices consumes the `match` reference. */
    if (IOServiceGetMatchingServices(0 /* kIOMainPortDefault */, match, &it) != KERN_SUCCESS || !it)
        return 0;

    CFStringRef vid_key = CFSTR(kUSBVendorID);
    CFStringRef pid_key = CFSTR(kUSBProductID);
    io_service_t svc;
    while ((svc = IOIteratorNext(it))) {
        uint16_t vid = 0, pid = 0;
        if (get_usb_u16(svc, vid_key, &vid) && vid == VITURE_USB_VENDOR_ID &&
            get_usb_u16(svc, pid_key, &pid) &&
            xr_device_provider_is_product_id_valid((int)pid)) {
            int dup = 0;
            for (int i = 0; i < count; i++)
                if (pids[i] == (int)pid) dup = 1;
            if (!dup && count < max_pids) pids[count++] = (int)pid;
        }
        IOObjectRelease(svc);
    }
    IOObjectRelease(it);
    return count;
}

int is_device_present(int pid)
{
    int pids[16];
    int n = find_viture_devices(pids, 16);
    for (int i = 0; i < n; i++)
        if (pids[i] == pid) return 1;
    return 0;
}
