#ifndef VOW_USB_ENUM_H
#define VOW_USB_ENUM_H

/* USB vendor ID used by VITURE glasses (taken from the SDK's glasses-demo). */
#define VITURE_USB_VENDOR_ID 0x35CA

/* Fill `pids` with up to `max_pids` distinct VITURE product IDs currently on
 * the USB bus that the SDK reports as valid. Returns the number found. */
int find_viture_devices(int *pids, int max_pids);

/* 1 if a device with this product ID is still attached, 0 otherwise. */
int is_device_present(int pid);

#endif
