#ifndef MOBILE_STACK_DNG_METADATA_H_
#define MOBILE_STACK_DNG_METADATA_H_

#include "mobile_stack_raw_ffi.h"

#include <stdint.h>

typedef struct MobileStackDngMetadata {
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
  uint32_t linearization_table_count;
  uint16_t* linearization_table;
  uint32_t black_level_delta_h_count;
  float* black_level_delta_h;
  uint32_t black_level_delta_v_count;
  float* black_level_delta_v;
  uint32_t has_camera_white_balance;
  float camera_white_balance[4];
  uint32_t has_d65_xyz_to_camera;
  float d65_xyz_to_camera[9];
  uint32_t has_baseline_exposure;
  float baseline_exposure;
  uint32_t has_baseline_exposure_offset;
  float baseline_exposure_offset;
  uint32_t profile_tone_curve_point_count;
  float* profile_tone_curve_xy;
  uint32_t has_profile_white_xy;
  double profile_white_xy[2];
  uint32_t profile_hue_divisions;
  uint32_t profile_sat_divisions;
  uint32_t profile_val_divisions;
  uint32_t profile_hue_sat_map_encoding;
  uint32_t profile_hue_sat_map_entry_count;
  float* profile_hue_sat_map;
  uint32_t profile_look_hue_divisions;
  uint32_t profile_look_sat_divisions;
  uint32_t profile_look_val_divisions;
  uint32_t profile_look_table_encoding;
  uint32_t profile_look_table_entry_count;
  float* profile_look_table;
  uint32_t has_profile_dynamic_range;
  uint32_t profile_dynamic_range;
  float profile_hint_max_output_value;
} MobileStackDngMetadata;

void mobile_stack_dng_metadata_release(MobileStackDngMetadata* metadata);

MobileStackRawStatus mobile_stack_dng_probe_metadata(
    const uint8_t* path_utf8,
    uint32_t path_length,
    uint64_t expected_byte_length,
    MobileStackDngMetadata* metadata_out,
    int32_t* error_code_out,
    const char** error_message_out);

#endif  // MOBILE_STACK_DNG_METADATA_H_
