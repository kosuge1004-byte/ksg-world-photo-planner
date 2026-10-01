#include "mobile_stack_raw_ffi.h"

#if defined(MOBILE_STACK_RAW_ENABLE_DNG_METADATA)
#include "mobile_stack_dng_metadata.h"
#endif

#if defined(MOBILE_STACK_RAW_ENABLE_ARW_LOSSLESS_JPEG)
#include "mobile_stack_arw_lossless.h"
#endif

#if defined(MOBILE_STACK_RAW_ENABLE_LIBRAW)
#include "mobile_stack_libraw.h"
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

_Static_assert(sizeof(uint32_t) == 4, "ABI v1 requires 32-bit uint32_t.");
_Static_assert(sizeof(uint64_t) == 8, "ABI v1 requires 64-bit uint64_t.");
_Static_assert(sizeof(float) == 4, "ABI v1 requires IEEE-sized FP32.");

struct MobileStackRawDecoder {
  uint32_t marker;
};

static const uint32_t kDecoderMarker = 0x4D535231u;
static const char kSuccessPath[] = "mobile-stack-abi://success";
static const char kMetadataPath[] = "mobile-stack-abi://metadata";
static const char kStubMessage[] =
    "ABI conformance stub: no production RAW decoder linked.";

static int path_equals(const uint8_t* path,
                       uint32_t path_length,
                       const char* expected) {
  const size_t expected_length = strlen(expected);
  return path != NULL && path_length == expected_length &&
         memcmp(path, expected, expected_length) == 0;
}

static MobileStackRawDecodeResult* allocate_result(
    MobileStackRawStatus status) {
  MobileStackRawDecodeResult* result =
      (MobileStackRawDecodeResult*)calloc(1, sizeof(*result));
  if (result == NULL) {
    return NULL;
  }
  result->abi_version = MOBILE_STACK_RAW_ABI_VERSION;
  result->struct_size = (uint32_t)sizeof(*result);
  result->status_code = (int32_t)status;
  return result;
}

static int set_error(MobileStackRawDecodeResult* result,
                     MobileStackRawStatus status,
                     int32_t error_code,
                     const char* message) {
  if (result == NULL) {
    return (int)MOBILE_STACK_RAW_OUT_OF_MEMORY;
  }
  result->status_code = (int32_t)status;
  result->error_code = error_code;
  if (message != NULL) {
    const size_t length = strlen(message);
    uint8_t* copy = (uint8_t*)malloc(length);
    if (copy == NULL) {
      result->status_code = (int32_t)MOBILE_STACK_RAW_OUT_OF_MEMORY;
      result->error_code = 9001;
      return (int)MOBILE_STACK_RAW_OUT_OF_MEMORY;
    }
    memcpy(copy, message, length);
    result->error_message = copy;
    result->error_message_length = (uint32_t)length;
  }
  return (int)status;
}

static MobileStackRawMetadataProbeResult* allocate_metadata_result(
    MobileStackRawStatus status) {
  MobileStackRawMetadataProbeResult* result =
      (MobileStackRawMetadataProbeResult*)calloc(1, sizeof(*result));
  if (result == NULL) {
    return NULL;
  }
  result->abi_version = MOBILE_STACK_RAW_ABI_VERSION;
  result->struct_size = (uint32_t)sizeof(*result);
  result->status_code = (int32_t)status;
  return result;
}

static int set_metadata_error(MobileStackRawMetadataProbeResult* result,
                              MobileStackRawStatus status,
                              int32_t error_code,
                              const char* message) {
  if (result == NULL) {
    return (int)MOBILE_STACK_RAW_OUT_OF_MEMORY;
  }
  result->status_code = (int32_t)status;
  result->error_code = error_code;
  if (message != NULL) {
    const size_t length = strlen(message);
    uint8_t* copy = (uint8_t*)malloc(length);
    if (copy == NULL) {
      result->status_code = (int32_t)MOBILE_STACK_RAW_OUT_OF_MEMORY;
      result->error_code = 9002;
      return (int)MOBILE_STACK_RAW_OUT_OF_MEMORY;
    }
    memcpy(copy, message, length);
    result->error_message = copy;
    result->error_message_length = (uint32_t)length;
  }
  return (int)status;
}

static void populate_decode_result(MobileStackRawDecodeResult* result,
                                   uint32_t format,
                                   MobileStackArwDecoded* decoded) {
  result->status_code = MOBILE_STACK_RAW_OK;
  result->error_code = 0;
  result->format = format;
  result->width = decoded->width;
  result->height = decoded->height;
  result->active_left = decoded->active_left;
  result->active_top = decoded->active_top;
  result->active_width = decoded->active_width;
  result->active_height = decoded->active_height;
  result->cfa_pattern = decoded->cfa_pattern;
  result->orientation = decoded->orientation;
  result->black_level_0 = decoded->black_levels[0];
  result->black_level_1 = decoded->black_levels[1];
  result->black_level_2 = decoded->black_levels[2];
  result->black_level_3 = decoded->black_levels[3];
  result->white_level = decoded->white_level;
  result->has_camera_white_balance = decoded->has_camera_white_balance;
  result->camera_white_balance_0 = decoded->camera_white_balance[0];
  result->camera_white_balance_1 = decoded->camera_white_balance[1];
  result->camera_white_balance_2 = decoded->camera_white_balance[2];
  result->camera_white_balance_3 = decoded->camera_white_balance[3];
  result->samples = decoded->samples;
  result->sample_count = decoded->sample_count;
  result->row_stride_samples = decoded->row_stride_samples;
  decoded->samples = NULL;
}

static void populate_metadata_result(
    MobileStackRawMetadataProbeResult* result,
    uint32_t format,
    const MobileStackArwDecoded* metadata) {
  result->status_code = MOBILE_STACK_RAW_OK;
  result->error_code = 0;
  result->format = format;
  result->width = metadata->width;
  result->height = metadata->height;
  result->active_left = metadata->active_left;
  result->active_top = metadata->active_top;
  result->active_width = metadata->active_width;
  result->active_height = metadata->active_height;
  result->cfa_pattern = metadata->cfa_pattern;
  result->orientation = metadata->orientation;
  result->black_level_0 = metadata->black_levels[0];
  result->black_level_1 = metadata->black_levels[1];
  result->black_level_2 = metadata->black_levels[2];
  result->black_level_3 = metadata->black_levels[3];
  result->white_level = metadata->white_level;
  result->has_camera_white_balance = metadata->has_camera_white_balance;
  result->camera_white_balance_0 = metadata->camera_white_balance[0];
  result->camera_white_balance_1 = metadata->camera_white_balance[1];
  result->camera_white_balance_2 = metadata->camera_white_balance[2];
  result->camera_white_balance_3 = metadata->camera_white_balance[3];
  result->has_d65_xyz_to_camera = metadata->has_d65_xyz_to_camera;
  result->d65_xyz_to_camera_0 = metadata->d65_xyz_to_camera[0];
  result->d65_xyz_to_camera_1 = metadata->d65_xyz_to_camera[1];
  result->d65_xyz_to_camera_2 = metadata->d65_xyz_to_camera[2];
  result->d65_xyz_to_camera_3 = metadata->d65_xyz_to_camera[3];
  result->d65_xyz_to_camera_4 = metadata->d65_xyz_to_camera[4];
  result->d65_xyz_to_camera_5 = metadata->d65_xyz_to_camera[5];
  result->d65_xyz_to_camera_6 = metadata->d65_xyz_to_camera[6];
  result->d65_xyz_to_camera_7 = metadata->d65_xyz_to_camera[7];
  result->d65_xyz_to_camera_8 = metadata->d65_xyz_to_camera[8];
}

MOBILE_STACK_RAW_EXPORT uint32_t mobile_stack_raw_abi_version(void) {
  return MOBILE_STACK_RAW_ABI_VERSION;
}

MOBILE_STACK_RAW_EXPORT uint64_t mobile_stack_raw_capabilities(void) {
  uint64_t capabilities =
      MOBILE_STACK_RAW_CAPABILITY_DECODE |
      MOBILE_STACK_RAW_CAPABILITY_METADATA_PROBE |
      MOBILE_STACK_RAW_CAPABILITY_CONFORMANCE_STUB |
      MOBILE_STACK_RAW_CAPABILITY_DECODE_TO_FILE;
#if defined(MOBILE_STACK_RAW_ENABLE_DNG_METADATA)
  capabilities |= MOBILE_STACK_RAW_CAPABILITY_DNG_METADATA;
#endif
#if defined(MOBILE_STACK_RAW_ENABLE_ARW_LOSSLESS_JPEG)
  capabilities |= MOBILE_STACK_RAW_CAPABILITY_ARW_LOSSLESS_JPEG |
                  MOBILE_STACK_RAW_CAPABILITY_SONY_ARW2;
#endif
#if defined(MOBILE_STACK_RAW_ENABLE_LIBRAW)
  capabilities |= MOBILE_STACK_RAW_CAPABILITY_LIBRAW_SONY |
                  MOBILE_STACK_RAW_CAPABILITY_LIBRAW_NIKON;
#endif
  return capabilities;
}

MOBILE_STACK_RAW_EXPORT MobileStackRawDecoder*
mobile_stack_raw_decoder_create(void) {
  MobileStackRawDecoder* decoder =
      (MobileStackRawDecoder*)calloc(1, sizeof(*decoder));
  if (decoder != NULL) {
    decoder->marker = kDecoderMarker;
  }
  return decoder;
}

MOBILE_STACK_RAW_EXPORT void mobile_stack_raw_decoder_destroy(
    MobileStackRawDecoder* decoder) {
  if (decoder == NULL) {
    return;
  }
  decoder->marker = 0;
  free(decoder);
}

MOBILE_STACK_RAW_EXPORT int32_t mobile_stack_raw_decode(
    MobileStackRawDecoder* decoder,
    const uint8_t* path_utf8,
    uint32_t path_length,
    const MobileStackRawDecodeRequest* request,
    MobileStackRawDecodeResult** result_out) {
  if (result_out == NULL) {
    return (int32_t)MOBILE_STACK_RAW_INVALID_ARGUMENT;
  }
  *result_out = NULL;

  MobileStackRawDecodeResult* result =
      allocate_result(MOBILE_STACK_RAW_INVALID_ARGUMENT);
  if (result == NULL) {
    return (int32_t)MOBILE_STACK_RAW_OUT_OF_MEMORY;
  }
  *result_out = result;

  if (decoder == NULL || decoder->marker != kDecoderMarker ||
      request == NULL || path_utf8 == NULL || path_length == 0) {
    return (int32_t)set_error(result, MOBILE_STACK_RAW_INVALID_ARGUMENT, 1001,
                              "Invalid ABI conformance request.");
  }
  if (request->abi_version != MOBILE_STACK_RAW_ABI_VERSION ||
      request->struct_size < sizeof(*request)) {
    return (int32_t)set_error(result, MOBILE_STACK_RAW_ABI_MISMATCH, 1002,
                              "ABI version or request size mismatch.");
  }
  if (request->expected_format == MOBILE_STACK_RAW_FORMAT_UNKNOWN ||
      request->output_precision != MOBILE_STACK_RAW_PRECISION_FLOAT32 ||
      (request->flags & MOBILE_STACK_RAW_FLAG_PRESERVE_SENSOR_VALUES) == 0) {
    return (int32_t)set_error(result, MOBILE_STACK_RAW_INVALID_ARGUMENT, 1003,
                              "ABI v1 requires format, FP32, and preserved values.");
  }

  if (path_equals(path_utf8, path_length, kSuccessPath)) {
    if (request->expected_byte_length != 4u) {
      return (int32_t)set_error(result, MOBILE_STACK_RAW_CORRUPT_DATA, 1101,
                                "Conformance input length must be four.");
    }
    if (request->maximum_pixel_count < 4u) {
      return (int32_t)set_error(result, MOBILE_STACK_RAW_RESOURCE_LIMIT, 1102,
                                "Conformance frame exceeds the pixel limit.");
    }

    float* samples = (float*)malloc(4u * sizeof(float));
    if (samples == NULL) {
      return (int32_t)set_error(result, MOBILE_STACK_RAW_OUT_OF_MEMORY, 1103,
                                "Unable to allocate conformance samples.");
    }
    samples[0] = 64.0f;
    samples[1] = 1024.0f;
    samples[2] = 2048.0f;
    samples[3] = 4095.0f;

    result->status_code = MOBILE_STACK_RAW_OK;
    result->error_code = 0;
    result->format = request->expected_format;
    result->width = 2;
    result->height = 2;
    result->active_left = 0;
    result->active_top = 0;
    result->active_width = 2;
    result->active_height = 2;
    result->cfa_pattern = MOBILE_STACK_RAW_CFA_RGGB;
    result->orientation = 1;
    result->black_level_0 = 64.0f;
    result->black_level_1 = 64.0f;
    result->black_level_2 = 64.0f;
    result->black_level_3 = 64.0f;
    result->white_level = 4095.0f;
    result->has_camera_white_balance = 1;
    result->camera_white_balance_0 = 2.0f;
    result->camera_white_balance_1 = 1.0f;
    result->camera_white_balance_2 = 1.0f;
    result->camera_white_balance_3 = 1.5f;
    result->samples = samples;
    result->sample_count = 4;
    result->row_stride_samples = 2;
    return (int32_t)MOBILE_STACK_RAW_OK;
  }

#if defined(MOBILE_STACK_RAW_ENABLE_ARW_LOSSLESS_JPEG)
  if (request->expected_format == MOBILE_STACK_RAW_FORMAT_ARW) {
    MobileStackArwDecoded decoded;
    int32_t error_code = 0;
    const char* error_message = NULL;
    const MobileStackRawStatus status =
        mobile_stack_arw_decode_lossless(
            path_utf8, path_length, request->expected_byte_length,
            request->maximum_pixel_count, &decoded, &error_code,
            &error_message);
    if (status == MOBILE_STACK_RAW_OK) {
      populate_decode_result(result, MOBILE_STACK_RAW_FORMAT_ARW, &decoded);
      return (int32_t)MOBILE_STACK_RAW_OK;
    }
    /* The caller's pixel ceiling is a hard resource boundary. Never bypass it
       by retrying the same input through LibRaw. */
    if (status == MOBILE_STACK_RAW_RESOURCE_LIMIT) {
      return (int32_t)set_error(result, status, error_code, error_message);
    }
#if !defined(MOBILE_STACK_RAW_ENABLE_LIBRAW)
    {
      return (int32_t)set_error(
          result, status, error_code, error_message);
    }
#endif
  }
#endif

#if defined(MOBILE_STACK_RAW_ENABLE_LIBRAW)
  if (request->expected_format == MOBILE_STACK_RAW_FORMAT_ARW ||
      request->expected_format == MOBILE_STACK_RAW_FORMAT_NEF ||
      request->expected_format == MOBILE_STACK_RAW_FORMAT_NRW) {
    MobileStackArwDecoded decoded;
    int32_t error_code = 0;
    const char* error_message = NULL;
    const MobileStackRawStatus status = mobile_stack_libraw_decode(
        path_utf8, path_length, request->expected_byte_length,
        request->maximum_pixel_count, request->expected_format, &decoded,
        &error_code, &error_message);
    if (status != MOBILE_STACK_RAW_OK) {
      return (int32_t)set_error(result, status, error_code, error_message);
    }
    populate_decode_result(result, request->expected_format, &decoded);
    return (int32_t)MOBILE_STACK_RAW_OK;
  }
#endif

  return (int32_t)set_error(result, MOBILE_STACK_RAW_UNSUPPORTED_FORMAT, 1100,
                            kStubMessage);
}

MOBILE_STACK_RAW_EXPORT int32_t mobile_stack_raw_decode_to_file(
    MobileStackRawDecoder* decoder,
    const uint8_t* path_utf8,
    uint32_t path_length,
    const uint8_t* output_path_utf8,
    uint32_t output_path_length,
    const MobileStackRawDecodeRequest* request,
    MobileStackRawDecodeResult** result_out) {
  if (result_out == NULL) return (int32_t)MOBILE_STACK_RAW_INVALID_ARGUMENT;
  *result_out = NULL;
  MobileStackRawDecodeResult* result =
      allocate_result(MOBILE_STACK_RAW_INVALID_ARGUMENT);
  if (result == NULL) return (int32_t)MOBILE_STACK_RAW_OUT_OF_MEMORY;
  *result_out = result;
  if (decoder == NULL || decoder->marker != kDecoderMarker || request == NULL ||
      path_utf8 == NULL || path_length == 0 || output_path_utf8 == NULL ||
      output_path_length == 0) {
    return (int32_t)set_error(result, MOBILE_STACK_RAW_INVALID_ARGUMENT, 1201,
                              "Invalid streamed RAW decode request.");
  }
  if (request->abi_version != MOBILE_STACK_RAW_ABI_VERSION ||
      request->struct_size < sizeof(*request) ||
      request->output_precision != MOBILE_STACK_RAW_PRECISION_FLOAT32 ||
      (request->flags & MOBILE_STACK_RAW_FLAG_PRESERVE_SENSOR_VALUES) == 0) {
    return (int32_t)set_error(result, MOBILE_STACK_RAW_ABI_MISMATCH, 1202,
                              "Streamed RAW decode ABI mismatch.");
  }

  if (path_equals(path_utf8, path_length, kSuccessPath)) {
    char* output_path = (char*)malloc((size_t)output_path_length + 1u);
    if (output_path == NULL) {
      return (int32_t)set_error(result, MOBILE_STACK_RAW_OUT_OF_MEMORY, 1203,
                                "Unable to allocate streamed output path.");
    }
    memcpy(output_path, output_path_utf8, output_path_length);
    output_path[output_path_length] = '\0';
    FILE* file = fopen(output_path, "wb");
    free(output_path);
    if (file == NULL) {
      return (int32_t)set_error(result, MOBILE_STACK_RAW_FILE_IO, 1204,
                                "Unable to create streamed output file.");
    }
    const float samples[4] = {64.0f, 1024.0f, 2048.0f, 4095.0f};
    if (fwrite(samples, sizeof(float), 4u, file) != 4u || fclose(file) != 0) {
      return (int32_t)set_error(result, MOBILE_STACK_RAW_FILE_IO, 1205,
                                "Unable to write streamed output file.");
    }
    result->status_code = MOBILE_STACK_RAW_OK;
    result->format = request->expected_format;
    result->width = 2; result->height = 2;
    result->active_width = 2; result->active_height = 2;
    result->cfa_pattern = MOBILE_STACK_RAW_CFA_RGGB;
    result->orientation = 1;
    result->black_level_0 = 64.0f; result->black_level_1 = 64.0f;
    result->black_level_2 = 64.0f; result->black_level_3 = 64.0f;
    result->white_level = 4095.0f;
    result->has_camera_white_balance = 1;
    result->camera_white_balance_0 = 2.0f;
    result->camera_white_balance_1 = 1.0f;
    result->camera_white_balance_2 = 1.0f;
    result->camera_white_balance_3 = 1.5f;
    result->samples = NULL;
    result->sample_count = 4;
    result->row_stride_samples = 2;
    return (int32_t)MOBILE_STACK_RAW_OK;
  }

#if defined(MOBILE_STACK_RAW_ENABLE_LIBRAW)
  if (request->expected_format == MOBILE_STACK_RAW_FORMAT_ARW ||
      request->expected_format == MOBILE_STACK_RAW_FORMAT_NEF ||
      request->expected_format == MOBILE_STACK_RAW_FORMAT_NRW) {
    MobileStackArwDecoded decoded;
    int32_t error_code = 0;
    const char* error_message = NULL;
    const MobileStackRawStatus status = mobile_stack_libraw_decode_to_file(
        path_utf8, path_length, output_path_utf8, output_path_length,
        request->expected_byte_length, request->maximum_pixel_count,
        request->expected_format, &decoded, &error_code, &error_message);
    if (status != MOBILE_STACK_RAW_OK) {
      return (int32_t)set_error(result, status, error_code, error_message);
    }
    populate_decode_result(result, request->expected_format, &decoded);
    return (int32_t)MOBILE_STACK_RAW_OK;
  }
#endif

  return (int32_t)set_error(result, MOBILE_STACK_RAW_UNSUPPORTED_FORMAT, 1200,
                            "Streamed RAW decode is unavailable for this format.");
}

MOBILE_STACK_RAW_EXPORT const float* mobile_stack_raw_decode_result_take_samples(
    MobileStackRawDecodeResult* result) {
  if (result == NULL) {
    return NULL;
  }
  const float* samples = result->samples;
  result->samples = NULL;
  return samples;
}

MOBILE_STACK_RAW_EXPORT void mobile_stack_raw_samples_release(void* samples) {
  free(samples);
}

MOBILE_STACK_RAW_EXPORT void mobile_stack_raw_decode_result_release(
    MobileStackRawDecodeResult* result) {
  if (result == NULL) {
    return;
  }
  free((void*)result->samples);
  free((void*)result->error_message);
  free(result);
}

MOBILE_STACK_RAW_EXPORT int32_t mobile_stack_raw_probe_metadata(
    MobileStackRawDecoder* decoder,
    const uint8_t* path_utf8,
    uint32_t path_length,
    const MobileStackRawMetadataProbeRequest* request,
    MobileStackRawMetadataProbeResult** result_out) {
  if (result_out == NULL) {
    return (int32_t)MOBILE_STACK_RAW_INVALID_ARGUMENT;
  }
  *result_out = NULL;

  MobileStackRawMetadataProbeResult* result =
      allocate_metadata_result(MOBILE_STACK_RAW_INVALID_ARGUMENT);
  if (result == NULL) {
    return (int32_t)MOBILE_STACK_RAW_OUT_OF_MEMORY;
  }
  *result_out = result;

  if (decoder == NULL || decoder->marker != kDecoderMarker ||
      request == NULL || path_utf8 == NULL || path_length == 0) {
    return (int32_t)set_metadata_error(
        result, MOBILE_STACK_RAW_INVALID_ARGUMENT, 1201,
        "Invalid metadata conformance request.");
  }
  if (request->abi_version != MOBILE_STACK_RAW_ABI_VERSION ||
      request->struct_size < sizeof(*request)) {
    return (int32_t)set_metadata_error(
        result, MOBILE_STACK_RAW_ABI_MISMATCH, 1202,
        "Metadata ABI version or request size mismatch.");
  }
  if (request->expected_format == MOBILE_STACK_RAW_FORMAT_UNKNOWN ||
      request->flags != 0) {
    return (int32_t)set_metadata_error(
        result, MOBILE_STACK_RAW_INVALID_ARGUMENT, 1203,
        "Metadata ABI v1 requires a format and zero flags.");
  }

  if (path_equals(path_utf8, path_length, kMetadataPath)) {
    if (request->expected_byte_length != 4u) {
      return (int32_t)set_metadata_error(
          result, MOBILE_STACK_RAW_CORRUPT_DATA, 1205,
          "Metadata conformance input length must be four.");
    }

    result->status_code = MOBILE_STACK_RAW_OK;
    result->error_code = 0;
    result->format = request->expected_format;
    result->width = 6000;
    result->height = 4000;
    result->active_left = 8;
    result->active_top = 8;
    result->active_width = 5984;
    result->active_height = 3984;
    result->cfa_pattern = MOBILE_STACK_RAW_CFA_RGGB;
    result->orientation = 1;
    result->black_level_0 = 64.0f;
    result->black_level_1 = 64.0f;
    result->black_level_2 = 64.0f;
    result->black_level_3 = 64.0f;
    result->white_level = 16383.0f;
    result->has_camera_white_balance = 1;
    result->camera_white_balance_0 = 2.0f;
    result->camera_white_balance_1 = 1.0f;
    result->camera_white_balance_2 = 1.0f;
    result->camera_white_balance_3 = 1.5f;
    result->has_d65_xyz_to_camera = 1u;
    result->d65_xyz_to_camera_0 = 1.0f;
    result->d65_xyz_to_camera_4 = 1.0f;
    result->d65_xyz_to_camera_8 = 1.0f;
    return (int32_t)MOBILE_STACK_RAW_OK;
  }

#if defined(MOBILE_STACK_RAW_ENABLE_DNG_METADATA)
  if (request->expected_format == MOBILE_STACK_RAW_FORMAT_DNG) {
    MobileStackDngMetadata metadata;
    int32_t error_code = 0;
    const char* error_message = NULL;
    const MobileStackRawStatus status = mobile_stack_dng_probe_metadata(
        path_utf8, path_length, request->expected_byte_length, &metadata,
        &error_code, &error_message);
    if (status != MOBILE_STACK_RAW_OK) {
      return (int32_t)set_metadata_error(
          result, status, error_code, error_message);
    }

    result->status_code = MOBILE_STACK_RAW_OK;
    result->error_code = 0;
    result->format = MOBILE_STACK_RAW_FORMAT_DNG;
    result->width = metadata.width;
    result->height = metadata.height;
    result->active_left = metadata.active_left;
    result->active_top = metadata.active_top;
    result->active_width = metadata.active_width;
    result->active_height = metadata.active_height;
    result->cfa_pattern = metadata.cfa_pattern;
    result->orientation = metadata.orientation;
    result->black_level_0 = metadata.black_levels[0];
    result->black_level_1 = metadata.black_levels[1];
    result->black_level_2 = metadata.black_levels[2];
    result->black_level_3 = metadata.black_levels[3];
    result->white_level = metadata.white_level;
    result->has_camera_white_balance =
        metadata.has_camera_white_balance;
    result->camera_white_balance_0 =
        metadata.camera_white_balance[0];
    result->camera_white_balance_1 =
        metadata.camera_white_balance[1];
    result->camera_white_balance_2 =
        metadata.camera_white_balance[2];
    result->camera_white_balance_3 =
        metadata.camera_white_balance[3];
    result->has_d65_xyz_to_camera = metadata.has_d65_xyz_to_camera;
    result->d65_xyz_to_camera_0 = metadata.d65_xyz_to_camera[0];
    result->d65_xyz_to_camera_1 = metadata.d65_xyz_to_camera[1];
    result->d65_xyz_to_camera_2 = metadata.d65_xyz_to_camera[2];
    result->d65_xyz_to_camera_3 = metadata.d65_xyz_to_camera[3];
    result->d65_xyz_to_camera_4 = metadata.d65_xyz_to_camera[4];
    result->d65_xyz_to_camera_5 = metadata.d65_xyz_to_camera[5];
    result->d65_xyz_to_camera_6 = metadata.d65_xyz_to_camera[6];
    result->d65_xyz_to_camera_7 = metadata.d65_xyz_to_camera[7];
    result->d65_xyz_to_camera_8 = metadata.d65_xyz_to_camera[8];
    result->has_baseline_exposure = metadata.has_baseline_exposure;
    result->baseline_exposure = metadata.baseline_exposure;
    result->profile_tone_curve_xy = metadata.profile_tone_curve_xy;
    result->profile_tone_curve_point_count =
        metadata.profile_tone_curve_point_count;
    metadata.profile_tone_curve_xy = NULL;
    metadata.profile_tone_curve_point_count = 0u;
    result->profile_hue_sat_map = metadata.profile_hue_sat_map;
    result->profile_hue_sat_map_entry_count =
        metadata.profile_hue_sat_map_entry_count;
    result->profile_hue_divisions = metadata.profile_hue_divisions;
    result->profile_sat_divisions = metadata.profile_sat_divisions;
    result->profile_val_divisions = metadata.profile_val_divisions;
    result->profile_hue_sat_map_encoding =
        metadata.profile_hue_sat_map_encoding;
    metadata.profile_hue_sat_map = NULL;
    metadata.profile_hue_sat_map_entry_count = 0u;
    result->profile_look_table = metadata.profile_look_table;
    result->profile_look_table_entry_count =
        metadata.profile_look_table_entry_count;
    result->profile_look_hue_divisions =
        metadata.profile_look_hue_divisions;
    result->profile_look_sat_divisions =
        metadata.profile_look_sat_divisions;
    result->profile_look_val_divisions =
        metadata.profile_look_val_divisions;
    result->profile_look_table_encoding =
        metadata.profile_look_table_encoding;
    metadata.profile_look_table = NULL;
    metadata.profile_look_table_entry_count = 0u;
    result->has_baseline_exposure_offset =
        metadata.has_baseline_exposure_offset;
    result->baseline_exposure_offset =
        metadata.baseline_exposure_offset;
    result->has_profile_dynamic_range =
        metadata.has_profile_dynamic_range;
    result->profile_dynamic_range = metadata.profile_dynamic_range;
    result->profile_hint_max_output_value =
        metadata.profile_hint_max_output_value;
    result->linearization_table = metadata.linearization_table;
    result->linearization_table_count = metadata.linearization_table_count;
    metadata.linearization_table = NULL;
    metadata.linearization_table_count = 0u;
    result->black_level_delta_h = metadata.black_level_delta_h;
    result->black_level_delta_h_count = metadata.black_level_delta_h_count;
    metadata.black_level_delta_h = NULL;
    metadata.black_level_delta_h_count = 0u;
    result->black_level_delta_v = metadata.black_level_delta_v;
    result->black_level_delta_v_count = metadata.black_level_delta_v_count;
    metadata.black_level_delta_v = NULL;
    metadata.black_level_delta_v_count = 0u;
    mobile_stack_dng_metadata_release(&metadata);
    return (int32_t)MOBILE_STACK_RAW_OK;
  }
#endif

#if defined(MOBILE_STACK_RAW_ENABLE_ARW_LOSSLESS_JPEG)
  if (request->expected_format == MOBILE_STACK_RAW_FORMAT_ARW) {
    MobileStackArwDecoded metadata;
    int32_t error_code = 0;
    const char* error_message = NULL;
    const MobileStackRawStatus status = mobile_stack_arw_probe_metadata(
        path_utf8, path_length, request->expected_byte_length, 64000000u,
        &metadata, &error_code, &error_message);
    if (status == MOBILE_STACK_RAW_OK) {
#if defined(MOBILE_STACK_RAW_ENABLE_LIBRAW)
      if (metadata.has_d65_xyz_to_camera == 0u) {
        MobileStackArwDecoded libraw_metadata;
        int32_t libraw_error_code = 0;
        const char* libraw_error_message = NULL;
        const MobileStackRawStatus libraw_status =
            mobile_stack_libraw_probe_metadata(
                path_utf8, path_length, request->expected_byte_length,
                64000000u, MOBILE_STACK_RAW_FORMAT_ARW, &libraw_metadata,
                &libraw_error_code, &libraw_error_message);
        if (libraw_status == MOBILE_STACK_RAW_OK &&
            libraw_metadata.has_d65_xyz_to_camera != 0u) {
          metadata.has_d65_xyz_to_camera = 1u;
          memcpy(metadata.d65_xyz_to_camera,
                 libraw_metadata.d65_xyz_to_camera,
                 sizeof(metadata.d65_xyz_to_camera));
        }
      }
#endif
      populate_metadata_result(result, MOBILE_STACK_RAW_FORMAT_ARW,
                               &metadata);
      return (int32_t)MOBILE_STACK_RAW_OK;
    }
#if !defined(MOBILE_STACK_RAW_ENABLE_LIBRAW)
    {
      return (int32_t)set_metadata_error(
          result, status, error_code, error_message);
    }
#endif
  }
#endif

#if defined(MOBILE_STACK_RAW_ENABLE_LIBRAW)
  if (request->expected_format == MOBILE_STACK_RAW_FORMAT_ARW ||
      request->expected_format == MOBILE_STACK_RAW_FORMAT_NEF ||
      request->expected_format == MOBILE_STACK_RAW_FORMAT_NRW) {
    MobileStackArwDecoded metadata;
    int32_t error_code = 0;
    const char* error_message = NULL;
    const MobileStackRawStatus status = mobile_stack_libraw_probe_metadata(
        path_utf8, path_length, request->expected_byte_length, 64000000u,
        request->expected_format, &metadata, &error_code, &error_message);
    if (status != MOBILE_STACK_RAW_OK) {
      return (int32_t)set_metadata_error(
          result, status, error_code, error_message);
    }
    populate_metadata_result(result, request->expected_format, &metadata);
    return (int32_t)MOBILE_STACK_RAW_OK;
  }
#endif

  return (int32_t)set_metadata_error(
      result, MOBILE_STACK_RAW_UNSUPPORTED_FORMAT, 1204, kStubMessage);
}

MOBILE_STACK_RAW_EXPORT void mobile_stack_raw_metadata_result_release(
    MobileStackRawMetadataProbeResult* result) {
  if (result == NULL) {
    return;
  }
  free((void*)result->error_message);
  free((void*)result->profile_tone_curve_xy);
  free((void*)result->profile_hue_sat_map);
  free((void*)result->profile_look_table);
  free((void*)result->linearization_table);
  free((void*)result->black_level_delta_h);
  free((void*)result->black_level_delta_v);
  free(result);
}
