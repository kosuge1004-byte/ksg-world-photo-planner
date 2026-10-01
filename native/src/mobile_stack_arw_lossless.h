#ifndef MOBILE_STACK_ARW_LOSSLESS_H_
#define MOBILE_STACK_ARW_LOSSLESS_H_

#include "mobile_stack_raw_ffi.h"

#include <stdint.h>

typedef struct MobileStackArwDecoded {
  uint32_t width;
  uint32_t height;
  uint32_t active_left;
  uint32_t active_top;
  uint32_t active_width;
  uint32_t active_height;
  uint32_t cfa_pattern;
  uint32_t orientation;
  float black_levels[4];
  float white_level;
  uint32_t has_camera_white_balance;
  float camera_white_balance[4];
  uint32_t has_d65_xyz_to_camera;
  float d65_xyz_to_camera[9];
  float* samples;
  uint64_t sample_count;
  uint32_t row_stride_samples;
} MobileStackArwDecoded;

MobileStackRawStatus mobile_stack_arw_decode_lossless(
    const uint8_t* path_utf8,
    uint32_t path_length,
    uint64_t expected_byte_length,
    uint64_t maximum_pixel_count,
    MobileStackArwDecoded* decoded_out,
    int32_t* error_code_out,
    const char** error_message_out);

MobileStackRawStatus mobile_stack_arw_probe_metadata(
    const uint8_t* path_utf8,
    uint32_t path_length,
    uint64_t expected_byte_length,
    uint64_t maximum_pixel_count,
    MobileStackArwDecoded* metadata_out,
    int32_t* error_code_out,
    const char** error_message_out);

#endif  // MOBILE_STACK_ARW_LOSSLESS_H_
