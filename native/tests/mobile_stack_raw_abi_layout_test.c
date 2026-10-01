#include "mobile_stack_raw_ffi.h"

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#define ABI_OFFSET(type, field, expected) \
  _Static_assert(offsetof(type, field) == (expected), #type "." #field)

_Static_assert(MOBILE_STACK_RAW_ABI_VERSION == 1, "ABI version changed.");
_Static_assert(sizeof(uint32_t) == 4, "uint32_t must be four bytes.");
_Static_assert(sizeof(uint64_t) == 8, "uint64_t must be eight bytes.");
_Static_assert(sizeof(float) == 4, "float must be four bytes.");

ABI_OFFSET(MobileStackRawDecodeRequest, abi_version, 0);
ABI_OFFSET(MobileStackRawDecodeRequest, struct_size, 4);
ABI_OFFSET(MobileStackRawDecodeRequest, expected_format, 8);
ABI_OFFSET(MobileStackRawDecodeRequest, output_precision, 12);
ABI_OFFSET(MobileStackRawDecodeRequest, flags, 16);

ABI_OFFSET(MobileStackRawMetadataProbeRequest, abi_version, 0);
ABI_OFFSET(MobileStackRawMetadataProbeRequest, struct_size, 4);
ABI_OFFSET(MobileStackRawMetadataProbeRequest, expected_format, 8);
ABI_OFFSET(MobileStackRawMetadataProbeRequest, flags, 12);
ABI_OFFSET(MobileStackRawMetadataProbeRequest, expected_byte_length, 16);
_Static_assert(sizeof(MobileStackRawMetadataProbeRequest) == 24,
               "Metadata request layout changed.");

ABI_OFFSET(MobileStackRawDecodeResult, abi_version, 0);
ABI_OFFSET(MobileStackRawDecodeResult, struct_size, 4);
ABI_OFFSET(MobileStackRawDecodeResult, status_code, 8);
ABI_OFFSET(MobileStackRawDecodeResult, error_code, 12);
ABI_OFFSET(MobileStackRawDecodeResult, format, 16);
ABI_OFFSET(MobileStackRawDecodeResult, width, 20);
ABI_OFFSET(MobileStackRawDecodeResult, height, 24);
ABI_OFFSET(MobileStackRawDecodeResult, active_left, 28);
ABI_OFFSET(MobileStackRawDecodeResult, active_top, 32);
ABI_OFFSET(MobileStackRawDecodeResult, active_width, 36);
ABI_OFFSET(MobileStackRawDecodeResult, active_height, 40);
ABI_OFFSET(MobileStackRawDecodeResult, cfa_pattern, 44);
ABI_OFFSET(MobileStackRawDecodeResult, orientation, 48);
ABI_OFFSET(MobileStackRawDecodeResult, black_level_0, 52);
ABI_OFFSET(MobileStackRawDecodeResult, black_level_1, 56);
ABI_OFFSET(MobileStackRawDecodeResult, black_level_2, 60);
ABI_OFFSET(MobileStackRawDecodeResult, black_level_3, 64);
ABI_OFFSET(MobileStackRawDecodeResult, white_level, 68);
ABI_OFFSET(MobileStackRawDecodeResult, has_camera_white_balance, 72);
ABI_OFFSET(MobileStackRawDecodeResult, camera_white_balance_0, 76);
ABI_OFFSET(MobileStackRawDecodeResult, camera_white_balance_1, 80);
ABI_OFFSET(MobileStackRawDecodeResult, camera_white_balance_2, 84);
ABI_OFFSET(MobileStackRawDecodeResult, camera_white_balance_3, 88);

ABI_OFFSET(MobileStackRawMetadataProbeResult, abi_version, 0);
ABI_OFFSET(MobileStackRawMetadataProbeResult, struct_size, 4);
ABI_OFFSET(MobileStackRawMetadataProbeResult, status_code, 8);
ABI_OFFSET(MobileStackRawMetadataProbeResult, error_code, 12);
ABI_OFFSET(MobileStackRawMetadataProbeResult, format, 16);
ABI_OFFSET(MobileStackRawMetadataProbeResult, width, 20);
ABI_OFFSET(MobileStackRawMetadataProbeResult, height, 24);
ABI_OFFSET(MobileStackRawMetadataProbeResult, active_left, 28);
ABI_OFFSET(MobileStackRawMetadataProbeResult, active_top, 32);
ABI_OFFSET(MobileStackRawMetadataProbeResult, active_width, 36);
ABI_OFFSET(MobileStackRawMetadataProbeResult, active_height, 40);
ABI_OFFSET(MobileStackRawMetadataProbeResult, cfa_pattern, 44);
ABI_OFFSET(MobileStackRawMetadataProbeResult, orientation, 48);
ABI_OFFSET(MobileStackRawMetadataProbeResult, black_level_0, 52);
ABI_OFFSET(MobileStackRawMetadataProbeResult, black_level_1, 56);
ABI_OFFSET(MobileStackRawMetadataProbeResult, black_level_2, 60);
ABI_OFFSET(MobileStackRawMetadataProbeResult, black_level_3, 64);
ABI_OFFSET(MobileStackRawMetadataProbeResult, white_level, 68);
ABI_OFFSET(MobileStackRawMetadataProbeResult, has_camera_white_balance, 72);
ABI_OFFSET(MobileStackRawMetadataProbeResult, camera_white_balance_0, 76);
ABI_OFFSET(MobileStackRawMetadataProbeResult, camera_white_balance_1, 80);
ABI_OFFSET(MobileStackRawMetadataProbeResult, camera_white_balance_2, 84);
ABI_OFFSET(MobileStackRawMetadataProbeResult, camera_white_balance_3, 88);

#if UINTPTR_MAX == UINT64_MAX
ABI_OFFSET(MobileStackRawDecodeRequest, expected_byte_length, 24);
ABI_OFFSET(MobileStackRawDecodeRequest, maximum_pixel_count, 32);
_Static_assert(sizeof(MobileStackRawDecodeRequest) == 40,
               "64-bit decode request layout changed.");

ABI_OFFSET(MobileStackRawDecodeResult, samples, 96);
ABI_OFFSET(MobileStackRawDecodeResult, sample_count, 104);
ABI_OFFSET(MobileStackRawDecodeResult, row_stride_samples, 112);
ABI_OFFSET(MobileStackRawDecodeResult, error_message, 120);
ABI_OFFSET(MobileStackRawDecodeResult, error_message_length, 128);
_Static_assert(sizeof(MobileStackRawDecodeResult) == 136,
               "64-bit decode result layout changed.");

ABI_OFFSET(MobileStackRawMetadataProbeResult, error_message, 96);
ABI_OFFSET(MobileStackRawMetadataProbeResult, error_message_length, 104);
ABI_OFFSET(MobileStackRawMetadataProbeResult, has_d65_xyz_to_camera, 108);
ABI_OFFSET(MobileStackRawMetadataProbeResult, d65_xyz_to_camera_0, 112);
ABI_OFFSET(MobileStackRawMetadataProbeResult, has_baseline_exposure, 148);
ABI_OFFSET(MobileStackRawMetadataProbeResult, baseline_exposure, 152);
ABI_OFFSET(MobileStackRawMetadataProbeResult, profile_tone_curve_xy, 160);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           profile_tone_curve_point_count, 168);
ABI_OFFSET(MobileStackRawMetadataProbeResult, profile_hue_sat_map, 176);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           profile_hue_sat_map_entry_count, 184);
ABI_OFFSET(MobileStackRawMetadataProbeResult, profile_hue_divisions, 188);
ABI_OFFSET(MobileStackRawMetadataProbeResult, profile_sat_divisions, 192);
ABI_OFFSET(MobileStackRawMetadataProbeResult, profile_val_divisions, 196);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           profile_hue_sat_map_encoding, 200);
ABI_OFFSET(MobileStackRawMetadataProbeResult, profile_look_table, 208);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           profile_look_table_entry_count, 216);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           profile_look_hue_divisions, 220);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           profile_look_sat_divisions, 224);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           profile_look_val_divisions, 228);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           profile_look_table_encoding, 232);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           has_baseline_exposure_offset, 236);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           baseline_exposure_offset, 240);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           has_profile_dynamic_range, 244);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           profile_dynamic_range, 248);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           profile_hint_max_output_value, 252);
ABI_OFFSET(MobileStackRawMetadataProbeResult, linearization_table, 256);
ABI_OFFSET(MobileStackRawMetadataProbeResult, linearization_table_count, 264);
ABI_OFFSET(MobileStackRawMetadataProbeResult, black_level_delta_h, 272);
ABI_OFFSET(MobileStackRawMetadataProbeResult, black_level_delta_h_count, 280);
ABI_OFFSET(MobileStackRawMetadataProbeResult, black_level_delta_v, 288);
ABI_OFFSET(MobileStackRawMetadataProbeResult, black_level_delta_v_count, 296);
_Static_assert(sizeof(MobileStackRawMetadataProbeResult) == 304,
               "64-bit metadata result layout changed.");
#elif UINTPTR_MAX == UINT32_MAX
_Static_assert(
    offsetof(MobileStackRawDecodeRequest, expected_byte_length) == 20 ||
        offsetof(MobileStackRawDecodeRequest, expected_byte_length) == 24,
    "32-bit uint64_t alignment is unsupported.");
_Static_assert(
    offsetof(MobileStackRawDecodeRequest, maximum_pixel_count) == 28 ||
        offsetof(MobileStackRawDecodeRequest, maximum_pixel_count) == 32,
    "32-bit maximum-pixel-count offset changed.");
_Static_assert(sizeof(MobileStackRawDecodeRequest) == 36 ||
                   sizeof(MobileStackRawDecodeRequest) == 40,
               "32-bit decode request layout changed.");

ABI_OFFSET(MobileStackRawDecodeResult, samples, 92);
ABI_OFFSET(MobileStackRawDecodeResult, sample_count, 96);
ABI_OFFSET(MobileStackRawDecodeResult, row_stride_samples, 104);
ABI_OFFSET(MobileStackRawDecodeResult, error_message, 108);
ABI_OFFSET(MobileStackRawDecodeResult, error_message_length, 112);
_Static_assert(sizeof(MobileStackRawDecodeResult) == 116 ||
                   sizeof(MobileStackRawDecodeResult) == 120,
               "32-bit decode result layout changed.");

ABI_OFFSET(MobileStackRawMetadataProbeResult, error_message, 92);
ABI_OFFSET(MobileStackRawMetadataProbeResult, error_message_length, 96);
ABI_OFFSET(MobileStackRawMetadataProbeResult, has_d65_xyz_to_camera, 100);
ABI_OFFSET(MobileStackRawMetadataProbeResult, d65_xyz_to_camera_0, 104);
ABI_OFFSET(MobileStackRawMetadataProbeResult, has_baseline_exposure, 140);
ABI_OFFSET(MobileStackRawMetadataProbeResult, baseline_exposure, 144);
ABI_OFFSET(MobileStackRawMetadataProbeResult, profile_tone_curve_xy, 148);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           profile_tone_curve_point_count, 152);
ABI_OFFSET(MobileStackRawMetadataProbeResult, profile_hue_sat_map, 156);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           profile_hue_sat_map_entry_count, 160);
ABI_OFFSET(MobileStackRawMetadataProbeResult, profile_hue_divisions, 164);
ABI_OFFSET(MobileStackRawMetadataProbeResult, profile_sat_divisions, 168);
ABI_OFFSET(MobileStackRawMetadataProbeResult, profile_val_divisions, 172);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           profile_hue_sat_map_encoding, 176);
ABI_OFFSET(MobileStackRawMetadataProbeResult, profile_look_table, 180);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           profile_look_table_entry_count, 184);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           profile_look_hue_divisions, 188);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           profile_look_sat_divisions, 192);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           profile_look_val_divisions, 196);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           profile_look_table_encoding, 200);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           has_baseline_exposure_offset, 204);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           baseline_exposure_offset, 208);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           has_profile_dynamic_range, 212);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           profile_dynamic_range, 216);
ABI_OFFSET(MobileStackRawMetadataProbeResult,
           profile_hint_max_output_value, 220);
ABI_OFFSET(MobileStackRawMetadataProbeResult, linearization_table, 224);
ABI_OFFSET(MobileStackRawMetadataProbeResult, linearization_table_count, 228);
ABI_OFFSET(MobileStackRawMetadataProbeResult, black_level_delta_h, 232);
ABI_OFFSET(MobileStackRawMetadataProbeResult, black_level_delta_h_count, 236);
ABI_OFFSET(MobileStackRawMetadataProbeResult, black_level_delta_v, 240);
ABI_OFFSET(MobileStackRawMetadataProbeResult, black_level_delta_v_count, 244);
_Static_assert(sizeof(MobileStackRawMetadataProbeResult) == 248,
               "32-bit metadata result layout changed.");
#else
#error "Unsupported pointer size."
#endif

int main(void) {
  printf("pointer=%zu decode_request=%zu decode_result=%zu "
         "metadata_request=%zu metadata_result=%zu\n",
         sizeof(void*), sizeof(MobileStackRawDecodeRequest),
         sizeof(MobileStackRawDecodeResult),
         sizeof(MobileStackRawMetadataProbeRequest),
         sizeof(MobileStackRawMetadataProbeResult));
  return 0;
}
