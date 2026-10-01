#ifndef MOBILE_STACK_RAW_FFI_H_
#define MOBILE_STACK_RAW_FFI_H_

#include <stddef.h>
#include <stdint.h>

#if defined(_WIN32)
#define MOBILE_STACK_RAW_EXPORT __declspec(dllexport)
#else
#define MOBILE_STACK_RAW_EXPORT \
  __attribute__((visibility("default"))) __attribute__((used))
#endif

#ifdef __cplusplus
extern "C" {
#endif

enum {
  MOBILE_STACK_RAW_ABI_VERSION = 1,
  MOBILE_STACK_RAW_FLAG_PRESERVE_SENSOR_VALUES = 1u << 0,
  MOBILE_STACK_RAW_CAPABILITY_DECODE = 1u << 0,
  MOBILE_STACK_RAW_CAPABILITY_METADATA_PROBE = 1u << 1,
  MOBILE_STACK_RAW_CAPABILITY_CONFORMANCE_STUB = 1u << 2,
  MOBILE_STACK_RAW_CAPABILITY_DNG_METADATA = 1u << 3,
  MOBILE_STACK_RAW_CAPABILITY_ARW_LOSSLESS_JPEG = 1u << 4,
  MOBILE_STACK_RAW_CAPABILITY_SONY_ARW2 = 1u << 5,
  MOBILE_STACK_RAW_CAPABILITY_LIBRAW_SONY = 1u << 6,
  MOBILE_STACK_RAW_CAPABILITY_LIBRAW_NIKON = 1u << 7,
  MOBILE_STACK_RAW_CAPABILITY_DECODE_TO_FILE = 1u << 8,
};

typedef enum MobileStackRawStatus {
  MOBILE_STACK_RAW_OK = 0,
  MOBILE_STACK_RAW_INVALID_ARGUMENT = 1,
  MOBILE_STACK_RAW_UNSUPPORTED_FORMAT = 2,
  MOBILE_STACK_RAW_FILE_IO = 3,
  MOBILE_STACK_RAW_CORRUPT_DATA = 4,
  MOBILE_STACK_RAW_RESOURCE_LIMIT = 5,
  MOBILE_STACK_RAW_ABI_MISMATCH = 6,
  MOBILE_STACK_RAW_OUT_OF_MEMORY = 7,
  MOBILE_STACK_RAW_CANCELLED = 8,
  MOBILE_STACK_RAW_DECODE_FAILURE = 9,
  MOBILE_STACK_RAW_INTERNAL = 10,
} MobileStackRawStatus;

typedef enum MobileStackRawFormat {
  MOBILE_STACK_RAW_FORMAT_UNKNOWN = 0,
  MOBILE_STACK_RAW_FORMAT_ARW = 1,
  MOBILE_STACK_RAW_FORMAT_CR2 = 2,
  MOBILE_STACK_RAW_FORMAT_CR3 = 3,
  MOBILE_STACK_RAW_FORMAT_DNG = 4,
  MOBILE_STACK_RAW_FORMAT_NEF = 5,
  MOBILE_STACK_RAW_FORMAT_NRW = 6,
  MOBILE_STACK_RAW_FORMAT_ORF = 7,
  MOBILE_STACK_RAW_FORMAT_PEF = 8,
  MOBILE_STACK_RAW_FORMAT_RAF = 9,
  MOBILE_STACK_RAW_FORMAT_RW2 = 10,
} MobileStackRawFormat;

typedef enum MobileStackRawPrecision {
  MOBILE_STACK_RAW_PRECISION_SOURCE_INTEGER = 1,
  MOBILE_STACK_RAW_PRECISION_FLOAT32 = 2,
  MOBILE_STACK_RAW_PRECISION_FLOAT64 = 3,
} MobileStackRawPrecision;

typedef enum MobileStackRawCfaPattern {
  MOBILE_STACK_RAW_CFA_UNKNOWN = 0,
  MOBILE_STACK_RAW_CFA_RGGB = 1,
  MOBILE_STACK_RAW_CFA_BGGR = 2,
  MOBILE_STACK_RAW_CFA_GRBG = 3,
  MOBILE_STACK_RAW_CFA_GBRG = 4,
} MobileStackRawCfaPattern;

typedef struct MobileStackRawDecodeRequest {
  uint32_t abi_version;
  uint32_t struct_size;
  uint32_t expected_format;
  uint32_t output_precision;
  uint32_t flags;
  uint64_t expected_byte_length;
  uint64_t maximum_pixel_count;
} MobileStackRawDecodeRequest;

typedef struct MobileStackRawDecodeResult {
  uint32_t abi_version;
  uint32_t struct_size;
  int32_t status_code;
  int32_t error_code;
  uint32_t format;
  uint32_t width;
  uint32_t height;
  uint32_t active_left;
  uint32_t active_top;
  uint32_t active_width;
  uint32_t active_height;
  uint32_t cfa_pattern;
  uint32_t orientation;
  float black_level_0;
  float black_level_1;
  float black_level_2;
  float black_level_3;
  float white_level;
  uint32_t has_camera_white_balance;
  float camera_white_balance_0;
  float camera_white_balance_1;
  float camera_white_balance_2;
  float camera_white_balance_3;
  const float* samples;
  uint64_t sample_count;
  uint32_t row_stride_samples;
  const uint8_t* error_message;
  uint32_t error_message_length;
} MobileStackRawDecodeResult;

/*
 * Optional ABI v1 extension. Callers must resolve the three metadata symbols
 * dynamically and check MOBILE_STACK_RAW_CAPABILITY_METADATA_PROBE before use.
 * Older ABI v1 libraries are valid even when these declarations are absent.
 */
typedef struct MobileStackRawMetadataProbeRequest {
  uint32_t abi_version;
  uint32_t struct_size;
  uint32_t expected_format;
  uint32_t flags;
  uint64_t expected_byte_length;
} MobileStackRawMetadataProbeRequest;

typedef struct MobileStackRawMetadataProbeResult {
  uint32_t abi_version;
  uint32_t struct_size;
  int32_t status_code;
  int32_t error_code;
  uint32_t format;
  uint32_t width;
  uint32_t height;
  uint32_t active_left;
  uint32_t active_top;
  uint32_t active_width;
  uint32_t active_height;
  uint32_t cfa_pattern;
  uint32_t orientation;
  float black_level_0;
  float black_level_1;
  float black_level_2;
  float black_level_3;
  float white_level;
  uint32_t has_camera_white_balance;
  float camera_white_balance_0;
  float camera_white_balance_1;
  float camera_white_balance_2;
  float camera_white_balance_3;
  const uint8_t* error_message;
  uint32_t error_message_length;
  /* Optional ABI v1 tail: valid when struct_size reaches this field. */
  uint32_t has_d65_xyz_to_camera;
  float d65_xyz_to_camera_0;
  float d65_xyz_to_camera_1;
  float d65_xyz_to_camera_2;
  float d65_xyz_to_camera_3;
  float d65_xyz_to_camera_4;
  float d65_xyz_to_camera_5;
  float d65_xyz_to_camera_6;
  float d65_xyz_to_camera_7;
  float d65_xyz_to_camera_8;
  /* Optional ABI v1 tail: valid when struct_size reaches this field. */
  uint32_t has_baseline_exposure;
  float baseline_exposure;
  /* Optional ABI v1 tail owned by this result and freed by release. */
  const float* profile_tone_curve_xy;
  uint32_t profile_tone_curve_point_count;
  /* Optional ABI v1 tail: selected/blended value-hue-saturation map. */
  const float* profile_hue_sat_map;
  uint32_t profile_hue_sat_map_entry_count;
  uint32_t profile_hue_divisions;
  uint32_t profile_sat_divisions;
  uint32_t profile_val_divisions;
  uint32_t profile_hue_sat_map_encoding;
  /* Optional ABI v1 tail: profile-wide final-render look table. */
  const float* profile_look_table;
  uint32_t profile_look_table_entry_count;
  uint32_t profile_look_hue_divisions;
  uint32_t profile_look_sat_divisions;
  uint32_t profile_look_val_divisions;
  uint32_t profile_look_table_encoding;
  /* Optional ABI v1 tail: selected profile exposure offset in EV. */
  uint32_t has_baseline_exposure_offset;
  float baseline_exposure_offset;
  /* Optional ABI v1 tail: DNG 1.7 ProfileDynamicRange (0=SDR, 1=HDR). */
  uint32_t has_profile_dynamic_range;
  uint32_t profile_dynamic_range;
  float profile_hint_max_output_value;
  /* Optional ABI v1 tail: DNG raw-linearization metadata. */
  const uint16_t* linearization_table;
  uint32_t linearization_table_count;
  const float* black_level_delta_h;
  uint32_t black_level_delta_h_count;
  const float* black_level_delta_v;
  uint32_t black_level_delta_v_count;
} MobileStackRawMetadataProbeResult;

typedef struct MobileStackRawDecoder MobileStackRawDecoder;

MOBILE_STACK_RAW_EXPORT uint32_t mobile_stack_raw_abi_version(void);

MOBILE_STACK_RAW_EXPORT uint64_t mobile_stack_raw_capabilities(void);

MOBILE_STACK_RAW_EXPORT MobileStackRawDecoder*
mobile_stack_raw_decoder_create(void);

MOBILE_STACK_RAW_EXPORT void mobile_stack_raw_decoder_destroy(
    MobileStackRawDecoder* decoder);

MOBILE_STACK_RAW_EXPORT int32_t mobile_stack_raw_decode(
    MobileStackRawDecoder* decoder,
    const uint8_t* path_utf8,
    uint32_t path_length,
    const MobileStackRawDecodeRequest* request,
    MobileStackRawDecodeResult** result_out);

/* Optional ABI v1 extension: decode sensor FP32 rows directly to a file.
 * The returned result contains metadata but owns no sample buffer. */
MOBILE_STACK_RAW_EXPORT int32_t mobile_stack_raw_decode_to_file(
    MobileStackRawDecoder* decoder,
    const uint8_t* path_utf8,
    uint32_t path_length,
    const uint8_t* output_path_utf8,
    uint32_t output_path_length,
    const MobileStackRawDecodeRequest* request,
    MobileStackRawDecodeResult** result_out);

MOBILE_STACK_RAW_EXPORT const float* mobile_stack_raw_decode_result_take_samples(
    MobileStackRawDecodeResult* result);

MOBILE_STACK_RAW_EXPORT void mobile_stack_raw_samples_release(void* samples);

MOBILE_STACK_RAW_EXPORT void mobile_stack_raw_decode_result_release(
    MobileStackRawDecodeResult* result);

MOBILE_STACK_RAW_EXPORT int32_t mobile_stack_raw_probe_metadata(
    MobileStackRawDecoder* decoder,
    const uint8_t* path_utf8,
    uint32_t path_length,
    const MobileStackRawMetadataProbeRequest* request,
    MobileStackRawMetadataProbeResult** result_out);

MOBILE_STACK_RAW_EXPORT void mobile_stack_raw_metadata_result_release(
    MobileStackRawMetadataProbeResult* result);

#ifdef __cplusplus
}
#endif

#endif  // MOBILE_STACK_RAW_FFI_H_
