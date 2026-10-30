# viture-pose-helper — build with:  make -C helper
#
# SDK_DIR must contain include/ (headers) and aarch64/ (libglasses.dylib,
# libcarina_vio.dylib). Defaults to vendor/viture-sdk, falling back to the
# repository root (where the SDK zip was originally unpacked).

ROOT     := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)
SDK_DIR  ?= $(if $(wildcard $(ROOT)/vendor/viture-sdk/include/viture_glasses_provider.h),$(ROOT)/vendor/viture-sdk,$(ROOT))
SDK_INC  := $(SDK_DIR)/include
SDK_LIB  := $(SDK_DIR)/aarch64

BUILD    := build
TARGET   := $(BUILD)/viture-pose-helper
SRCS     := src/main.c src/usb_enum.c
DISPLAY  := $(BUILD)/viture-display-helper
DYLIBS   := libglasses.dylib libcarina_vio.dylib

CC       ?= clang
CFLAGS   := -arch arm64 -mmacosx-version-min=13.0 -std=c11 -O2 -Wall -Wextra -Wno-unused-parameter -I$(SDK_INC)
# libglasses dlopen()s libcarina_vio.dylib from its own directory, so both are
# copied next to the binary and found via @executable_path.
LDFLAGS  := -arch arm64 -mmacosx-version-min=13.0 -L$(SDK_LIB) -lglasses \
            -framework IOKit -framework CoreFoundation -Wl,-rpath,@executable_path

.PHONY: all clean check-sdk

all: check-sdk $(TARGET) $(DISPLAY) $(addprefix $(BUILD)/,$(DYLIBS))

check-sdk:
	@test -f $(SDK_INC)/viture_glasses_provider.h || { echo "Viture SDK headers not found in $(SDK_INC) (set SDK_DIR=...)"; exit 1; }
	@test -f $(SDK_LIB)/libglasses.dylib || { echo "libglasses.dylib not found in $(SDK_LIB) (set SDK_DIR=...)"; exit 1; }

$(BUILD):
	mkdir -p $@

$(TARGET): $(SRCS) src/usb_enum.h | $(BUILD)
	$(CC) $(CFLAGS) $(SRCS) $(LDFLAGS) -o $@

# Virtual displays (no Viture SDK dependency).
$(DISPLAY): src/display_helper.m | $(BUILD)
	$(CC) -arch arm64 -mmacosx-version-min=13.0 -O2 -Wall -Wextra -fobjc-arc $< \
	      -framework Foundation -framework CoreGraphics -framework ApplicationServices -o $@

# SDK 2.4.1 ships libglasses.dylib with an invalid ad-hoc signature, and on
# Apple Silicon the kernel SIGKILLs any process that loads it. Re-sign the
# local copy only (the SDK files are left untouched).
$(BUILD)/%.dylib: $(SDK_LIB)/%.dylib | $(BUILD)
	cp $< $@
	@codesign --verify $@ 2>/dev/null || { echo "re-signing $@ (SDK signature invalid)"; codesign --force --sign - $@; }

clean:
	rm -rf $(BUILD)
