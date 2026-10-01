#include "mobile_stack_raw_ffi.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define CHECK(condition)                                                \
  do {                                                                  \
    if (!(condition)) {                                                 \
      fprintf(stderr, "check failed at line %d: %s\n", __LINE__,       \
              #condition);                                              \
      return 1;                                                         \
    }                                                                   \
  } while (0)

static void write_u16_le(uint8_t* bytes, uint32_t offset, uint16_t value) {
  bytes[offset] = (uint8_t)(value & 0xFFu);
  bytes[offset + 1u] = (uint8_t)(value >> 8);
}

static void write_u32_le(uint8_t* bytes, uint32_t offset, uint32_t value) {
  bytes[offset] = (uint8_t)(value & 0xFFu);
  bytes[offset + 1u] = (uint8_t)((value >> 8) & 0xFFu);
  bytes[offset + 2u] = (uint8_t)((value >> 16) & 0xFFu);
  bytes[offset + 3u] = (uint8_t)(value >> 24);
}

static void write_ifd_entry(uint8_t* bytes,
                            uint32_t index,
                            uint16_t tag,
                            uint16_t type,
                            uint32_t count,
                            uint32_t value) {
  const uint32_t offset = 10u + index * 12u;
  write_u16_le(bytes, offset, tag);
  write_u16_le(bytes, offset + 2u, type);
  write_u32_le(bytes, offset + 4u, count);
  write_u32_le(bytes, offset + 8u, value);
}

static int write_minimal_dng(const char* path, uint32_t* length_out) {
  enum {
    kEntryCount = 15,
    kBlackOffset = 194,
    kNeutralOffset = 202,
    kActiveOffset = 226,
    kFileLength = 242,
  };
  uint8_t bytes[kFileLength];
  memset(bytes, 0, sizeof(bytes));
  bytes[0] = 'I';
  bytes[1] = 'I';
  write_u16_le(bytes, 2, 42);
  write_u32_le(bytes, 4, 8);
  write_u16_le(bytes, 8, kEntryCount);

  write_ifd_entry(bytes, 0, 254, 4, 1, 0);
  write_ifd_entry(bytes, 1, 256, 4, 1, 6000);
  write_ifd_entry(bytes, 2, 257, 4, 1, 4000);
  write_ifd_entry(bytes, 3, 258, 3, 1, 16);
  write_ifd_entry(bytes, 4, 262, 3, 1, 32803);
  write_ifd_entry(bytes, 5, 274, 3, 1, 1);
  write_ifd_entry(bytes, 6, 277, 3, 1, 1);
  write_ifd_entry(bytes, 7, 33421, 3, 2, 0x00020002u);
  write_ifd_entry(bytes, 8, 33422, 1, 4, 0x02010100u);
  write_ifd_entry(bytes, 9, 50706, 1, 4, 0x00000401u);
  write_ifd_entry(bytes, 10, 50713, 3, 2, 0x00020002u);
  write_ifd_entry(bytes, 11, 50714, 3, 4, kBlackOffset);
  write_ifd_entry(bytes, 12, 50717, 4, 1, 16383);
  write_ifd_entry(bytes, 13, 50728, 5, 3, kNeutralOffset);
  write_ifd_entry(bytes, 14, 50829, 4, 4, kActiveOffset);
  write_u32_le(bytes, 190, 0);

  for (uint32_t index = 0; index < 4; index++) {
    write_u16_le(bytes, kBlackOffset + index * 2u, 64);
  }
  write_u32_le(bytes, kNeutralOffset, 1);
  write_u32_le(bytes, kNeutralOffset + 4u, 2);
  write_u32_le(bytes, kNeutralOffset + 8u, 1);
  write_u32_le(bytes, kNeutralOffset + 12u, 1);
  write_u32_le(bytes, kNeutralOffset + 16u, 2);
  write_u32_le(bytes, kNeutralOffset + 20u, 3);
  write_u32_le(bytes, kActiveOffset, 8);
  write_u32_le(bytes, kActiveOffset + 4u, 8);
  write_u32_le(bytes, kActiveOffset + 8u, 3992);
  write_u32_le(bytes, kActiveOffset + 12u, 5992);

  FILE* file = fopen(path, "wb");
  if (file == NULL) {
    return 0;
  }
  const int written = fwrite(bytes, 1, sizeof(bytes), file) == sizeof(bytes);
  const int closed = fclose(file) == 0;
  if (written && closed) {
    *length_out = (uint32_t)sizeof(bytes);
    return 1;
  }
  remove(path);
  return 0;
}

static int write_unsupported_black_repeat_dng(const char* path,
                                              uint32_t* length_out) {
  if (!write_minimal_dng(path, length_out)) return 0;
  FILE* file = fopen(path, "r+b");
  if (file == NULL) return 0;
  /* Entry 10 is BlackLevelRepeatDim. Patch its inline SHORT pair from 2x2
   * to 1x4, which is valid DNG but cannot be represented by the current
   * four-phase internal calibration contract without losing information. */
  const uint32_t value_offset = 10u + 10u * 12u + 8u;
  const uint8_t repeat_1x4[4] = {1u, 0u, 4u, 0u};
  const int seek_ok = fseek(file, (long)value_offset, SEEK_SET) == 0;
  const int write_ok = seek_ok &&
      fwrite(repeat_1x4, 1, sizeof(repeat_1x4), file) == sizeof(repeat_1x4);
  const int close_ok = fclose(file) == 0;
  if (write_ok && close_ok) return 1;
  remove(path);
  return 0;
}

static int write_linearization_delta_dng(const char* path,
                                         uint32_t* length_out,
                                         int invalid_black_range) {
  enum {
    kEntryCount = 18,
    kBlackOffset = 230,
    kNeutralOffset = 238,
    kActiveOffset = 262,
    kLinearizationOffset = 278,
    kDeltaHOffset = 286,
    kDeltaVOffset = 302,
    kFileLength = 318,
  };
  uint8_t bytes[kFileLength];
  memset(bytes, 0, sizeof(bytes));
  bytes[0] = 'I';
  bytes[1] = 'I';
  write_u16_le(bytes, 2, 42);
  write_u32_le(bytes, 4, 8);
  write_u16_le(bytes, 8, kEntryCount);

  write_ifd_entry(bytes, 0, 254, 4, 1, 0);
  write_ifd_entry(bytes, 1, 256, 4, 1, 2);
  write_ifd_entry(bytes, 2, 257, 4, 1, 2);
  write_ifd_entry(bytes, 3, 258, 3, 1, 16);
  write_ifd_entry(bytes, 4, 262, 3, 1, 32803);
  write_ifd_entry(bytes, 5, 274, 3, 1, 1);
  write_ifd_entry(bytes, 6, 277, 3, 1, 1);
  write_ifd_entry(bytes, 7, 33421, 3, 2, 0x00020002u);
  write_ifd_entry(bytes, 8, 33422, 1, 4, 0x02010100u);
  write_ifd_entry(bytes, 9, 50706, 1, 4, 0x00000401u);
  write_ifd_entry(bytes, 10, 50712, 3, 4, kLinearizationOffset);
  write_ifd_entry(bytes, 11, 50713, 3, 2, 0x00020002u);
  write_ifd_entry(bytes, 12, 50714, 3, 4, kBlackOffset);
  write_ifd_entry(bytes, 13, 50715, 10, 2, kDeltaHOffset);
  write_ifd_entry(bytes, 14, 50716, 10, 2, kDeltaVOffset);
  write_ifd_entry(bytes, 15, 50717, 4, 1,
                  invalid_black_range ? 69u : 100u);
  write_ifd_entry(bytes, 16, 50728, 5, 3, kNeutralOffset);
  write_ifd_entry(bytes, 17, 50829, 4, 4, kActiveOffset);
  write_u32_le(bytes, 226, 0);

  for (uint32_t index = 0; index < 4; index++) {
    write_u16_le(bytes, kBlackOffset + index * 2u, 64);
  }
  write_u32_le(bytes, kNeutralOffset, 1);
  write_u32_le(bytes, kNeutralOffset + 4u, 2);
  write_u32_le(bytes, kNeutralOffset + 8u, 1);
  write_u32_le(bytes, kNeutralOffset + 12u, 1);
  write_u32_le(bytes, kNeutralOffset + 16u, 2);
  write_u32_le(bytes, kNeutralOffset + 20u, 3);
  write_u32_le(bytes, kActiveOffset, 0);
  write_u32_le(bytes, kActiveOffset + 4u, 0);
  write_u32_le(bytes, kActiveOffset + 8u, 2);
  write_u32_le(bytes, kActiveOffset + 12u, 2);

  write_u16_le(bytes, kLinearizationOffset, 0);
  write_u16_le(bytes, kLinearizationOffset + 2u, 2);
  write_u16_le(bytes, kLinearizationOffset + 4u, 5);
  write_u16_le(bytes, kLinearizationOffset + 6u, 9);

  /* SRATIONAL BlackLevelDeltaH = [1, 2]. */
  write_u32_le(bytes, kDeltaHOffset, 1);
  write_u32_le(bytes, kDeltaHOffset + 4u, 1);
  write_u32_le(bytes, kDeltaHOffset + 8u, 2);
  write_u32_le(bytes, kDeltaHOffset + 12u, 1);
  /* SRATIONAL BlackLevelDeltaV = [3, 4]. */
  write_u32_le(bytes, kDeltaVOffset, 3);
  write_u32_le(bytes, kDeltaVOffset + 4u, 1);
  write_u32_le(bytes, kDeltaVOffset + 8u, 4);
  write_u32_le(bytes, kDeltaVOffset + 12u, 1);

  FILE* file = fopen(path, "wb");
  if (file == NULL) return 0;
  const int written = fwrite(bytes, 1, sizeof(bytes), file) == sizeof(bytes);
  const int closed = fclose(file) == 0;
  if (written && closed) {
    *length_out = (uint32_t)sizeof(bytes);
    return 1;
  }
  remove(path);
  return 0;
}

static int write_ifd_limit_fixture(const char* path,
                                   uint32_t* length_out) {
  uint8_t bytes[10] = {'I', 'I', 42, 0, 8, 0, 0, 0, 1, 2};
  FILE* file = fopen(path, "wb");
  if (file == NULL) {
    return 0;
  }
  const int written = fwrite(bytes, 1, sizeof(bytes), file) == sizeof(bytes);
  const int closed = fclose(file) == 0;
  if (written && closed) {
    *length_out = (uint32_t)sizeof(bytes);
    return 1;
  }
  remove(path);
  return 0;
}

static int check_decode(MobileStackRawDecoder* decoder) {
  static const uint8_t path[] = "mobile-stack-abi://success";
  const MobileStackRawDecodeRequest request = {
      MOBILE_STACK_RAW_ABI_VERSION,
      (uint32_t)sizeof(MobileStackRawDecodeRequest),
      MOBILE_STACK_RAW_FORMAT_DNG,
      MOBILE_STACK_RAW_PRECISION_FLOAT32,
      MOBILE_STACK_RAW_FLAG_PRESERVE_SENSOR_VALUES,
      4u,
      4u,
  };
  MobileStackRawDecodeResult* result = NULL;
  const int32_t status = mobile_stack_raw_decode(
      decoder, path, (uint32_t)(sizeof(path) - 1u), &request, &result);

  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->abi_version == MOBILE_STACK_RAW_ABI_VERSION);
  CHECK(result->struct_size == sizeof(*result));
  CHECK(result->status_code == MOBILE_STACK_RAW_OK);
  CHECK(result->format == MOBILE_STACK_RAW_FORMAT_DNG);
  CHECK(result->width == 2u);
  CHECK(result->height == 2u);
  CHECK(result->sample_count == 4u);
  CHECK(result->row_stride_samples == 2u);
  CHECK(result->samples != NULL);
  CHECK(result->samples[0] == 64.0f);
  CHECK(result->samples[3] == 4095.0f);

  const float* detached_samples =
      mobile_stack_raw_decode_result_take_samples(result);
  CHECK(detached_samples != NULL);
  CHECK(result->samples == NULL);
  CHECK(detached_samples[0] == 64.0f);
  CHECK(detached_samples[3] == 4095.0f);
  mobile_stack_raw_decode_result_release(result);
  mobile_stack_raw_samples_release((void*)detached_samples);
  return 0;
}

static int check_decode_to_file(MobileStackRawDecoder* decoder) {
  static const uint8_t path[] = "mobile-stack-abi://success";
  static const uint8_t output_path[] = "mobile_stack_raw_stream_fixture.f32";
  const MobileStackRawDecodeRequest request = {
      MOBILE_STACK_RAW_ABI_VERSION,
      (uint32_t)sizeof(MobileStackRawDecodeRequest),
      MOBILE_STACK_RAW_FORMAT_DNG,
      MOBILE_STACK_RAW_PRECISION_FLOAT32,
      MOBILE_STACK_RAW_FLAG_PRESERVE_SENSOR_VALUES,
      4u,
      4u,
  };
  MobileStackRawDecodeResult* result = NULL;
  const int32_t status = mobile_stack_raw_decode_to_file(
      decoder, path, (uint32_t)(sizeof(path) - 1u), output_path,
      (uint32_t)(sizeof(output_path) - 1u), &request, &result);
  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_OK);
  CHECK(result->width == 2u);
  CHECK(result->height == 2u);
  CHECK(result->samples == NULL);
  CHECK(result->sample_count == 4u);
  CHECK(result->row_stride_samples == 2u);

  FILE* file = fopen((const char*)output_path, "rb");
  CHECK(file != NULL);
  float samples[4] = {0};
  CHECK(fread(samples, sizeof(float), 4u, file) == 4u);
  CHECK(fclose(file) == 0);
  CHECK(samples[0] == 64.0f);
  CHECK(samples[1] == 1024.0f);
  CHECK(samples[2] == 2048.0f);
  CHECK(samples[3] == 4095.0f);
  CHECK(remove((const char*)output_path) == 0);
  mobile_stack_raw_decode_result_release(result);
  return 0;
}

static int check_metadata(MobileStackRawDecoder* decoder) {
  static const uint8_t path[] = "mobile-stack-abi://metadata";
  const MobileStackRawMetadataProbeRequest request = {
      MOBILE_STACK_RAW_ABI_VERSION,
      (uint32_t)sizeof(MobileStackRawMetadataProbeRequest),
      MOBILE_STACK_RAW_FORMAT_DNG,
      0u,
      4u,
  };
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status = mobile_stack_raw_probe_metadata(
      decoder, path, (uint32_t)(sizeof(path) - 1u), &request, &result);

  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->abi_version == MOBILE_STACK_RAW_ABI_VERSION);
  CHECK(result->struct_size == sizeof(*result));
  CHECK(result->status_code == MOBILE_STACK_RAW_OK);
  CHECK(result->format == MOBILE_STACK_RAW_FORMAT_DNG);
  CHECK(result->width == 6000u);
  CHECK(result->height == 4000u);
  CHECK(result->active_left == 8u);
  CHECK(result->active_top == 8u);
  CHECK(result->active_width == 5984u);
  CHECK(result->active_height == 3984u);
  CHECK(result->cfa_pattern == MOBILE_STACK_RAW_CFA_RGGB);
  CHECK(result->white_level == 16383.0f);

  mobile_stack_raw_metadata_result_release(result);
  return 0;
}

static int check_missing_dng_rejection(MobileStackRawDecoder* decoder) {
  static const uint8_t path[] = "/not/a/production/decoder.dng";
  const MobileStackRawMetadataProbeRequest request = {
      MOBILE_STACK_RAW_ABI_VERSION,
      (uint32_t)sizeof(MobileStackRawMetadataProbeRequest),
      MOBILE_STACK_RAW_FORMAT_DNG,
      0u,
      4u,
  };
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status = mobile_stack_raw_probe_metadata(
      decoder, path, (uint32_t)(sizeof(path) - 1u), &request, &result);

  CHECK(status == MOBILE_STACK_RAW_FILE_IO);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_FILE_IO);
  CHECK(result->error_message != NULL);
  CHECK(result->error_message_length > 0u);

  mobile_stack_raw_metadata_result_release(result);
  return 0;
}

static int check_production_dng_metadata(
    MobileStackRawDecoder* decoder) {
  static const char path[] = "mobile_stack_raw_minimal_fixture.dng";
  uint32_t byte_length = 0;
  CHECK(write_minimal_dng(path, &byte_length));

  const MobileStackRawMetadataProbeRequest request = {
      MOBILE_STACK_RAW_ABI_VERSION,
      (uint32_t)sizeof(MobileStackRawMetadataProbeRequest),
      MOBILE_STACK_RAW_FORMAT_DNG,
      0u,
      byte_length,
  };
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status = mobile_stack_raw_probe_metadata(
      decoder, (const uint8_t*)path, (uint32_t)(sizeof(path) - 1u),
      &request, &result);

  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_OK);
  CHECK(result->format == MOBILE_STACK_RAW_FORMAT_DNG);
  CHECK(result->width == 6000u);
  CHECK(result->height == 4000u);
  CHECK(result->active_left == 8u);
  CHECK(result->active_top == 8u);
  CHECK(result->active_width == 5984u);
  CHECK(result->active_height == 3984u);
  CHECK(result->cfa_pattern == MOBILE_STACK_RAW_CFA_RGGB);
  CHECK(result->orientation == 1u);
  CHECK(result->black_level_0 == 64.0f);
  CHECK(result->white_level == 16383.0f);
  CHECK(result->has_camera_white_balance == 1u);
  CHECK(result->camera_white_balance_0 == 2.0f);
  CHECK(result->camera_white_balance_1 == 1.0f);
  CHECK(result->camera_white_balance_3 == 1.5f);

  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_unsupported_black_repeat_rejection(
    MobileStackRawDecoder* decoder) {
  static const char path[] = "mobile_stack_raw_black_repeat_1x4.dng";
  uint32_t byte_length = 0;
  CHECK(write_unsupported_black_repeat_dng(path, &byte_length));
  const MobileStackRawMetadataProbeRequest request = {
      MOBILE_STACK_RAW_ABI_VERSION,
      (uint32_t)sizeof(MobileStackRawMetadataProbeRequest),
      MOBILE_STACK_RAW_FORMAT_DNG,
      0u,
      byte_length,
  };
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status = mobile_stack_raw_probe_metadata(
      decoder, (const uint8_t*)path, (uint32_t)(sizeof(path) - 1u),
      &request, &result);
  CHECK(status == MOBILE_STACK_RAW_CORRUPT_DATA);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_dng_linearization_and_deltas(
    MobileStackRawDecoder* decoder) {
  static const char path[] = "mobile_stack_raw_linearization_delta.dng";
  uint32_t byte_length = 0;
  CHECK(write_linearization_delta_dng(path, &byte_length, 0));

  const MobileStackRawMetadataProbeRequest request = {
      MOBILE_STACK_RAW_ABI_VERSION,
      (uint32_t)sizeof(MobileStackRawMetadataProbeRequest),
      MOBILE_STACK_RAW_FORMAT_DNG,
      0u,
      byte_length,
  };
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status = mobile_stack_raw_probe_metadata(
      decoder, (const uint8_t*)path, (uint32_t)(sizeof(path) - 1u),
      &request, &result);

  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->linearization_table_count == 4u);
  CHECK(result->linearization_table != NULL);
  CHECK(result->linearization_table[0] == 0u);
  CHECK(result->linearization_table[1] == 2u);
  CHECK(result->linearization_table[2] == 5u);
  CHECK(result->linearization_table[3] == 9u);
  CHECK(result->black_level_delta_h_count == 2u);
  CHECK(result->black_level_delta_h != NULL);
  CHECK(result->black_level_delta_h[0] == 1.0f);
  CHECK(result->black_level_delta_h[1] == 2.0f);
  CHECK(result->black_level_delta_v_count == 2u);
  CHECK(result->black_level_delta_v != NULL);
  CHECK(result->black_level_delta_v[0] == 3.0f);
  CHECK(result->black_level_delta_v[1] == 4.0f);

  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_dng_invalid_computed_black_rejection(
    MobileStackRawDecoder* decoder) {
  static const char path[] = "mobile_stack_raw_invalid_black_range.dng";
  uint32_t byte_length = 0;
  CHECK(write_linearization_delta_dng(path, &byte_length, 1));

  const MobileStackRawMetadataProbeRequest request = {
      MOBILE_STACK_RAW_ABI_VERSION,
      (uint32_t)sizeof(MobileStackRawMetadataProbeRequest),
      MOBILE_STACK_RAW_FORMAT_DNG,
      0u,
      byte_length,
  };
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status = mobile_stack_raw_probe_metadata(
      decoder, (const uint8_t*)path, (uint32_t)(sizeof(path) - 1u),
      &request, &result);

  CHECK(status == MOBILE_STACK_RAW_CORRUPT_DATA);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_dng_length_mismatch(
    MobileStackRawDecoder* decoder) {
  static const char path[] = "mobile_stack_raw_length_fixture.dng";
  uint32_t byte_length = 0;
  CHECK(write_minimal_dng(path, &byte_length));

  const MobileStackRawMetadataProbeRequest request = {
      MOBILE_STACK_RAW_ABI_VERSION,
      (uint32_t)sizeof(MobileStackRawMetadataProbeRequest),
      MOBILE_STACK_RAW_FORMAT_DNG,
      0u,
      (uint64_t)byte_length + 1u,
  };
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status = mobile_stack_raw_probe_metadata(
      decoder, (const uint8_t*)path, (uint32_t)(sizeof(path) - 1u),
      &request, &result);

  CHECK(status == MOBILE_STACK_RAW_CORRUPT_DATA);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_dng_ifd_resource_limit(
    MobileStackRawDecoder* decoder) {
  static const char path[] = "mobile_stack_raw_limit_fixture.dng";
  uint32_t byte_length = 0;
  CHECK(write_ifd_limit_fixture(path, &byte_length));

  const MobileStackRawMetadataProbeRequest request = {
      MOBILE_STACK_RAW_ABI_VERSION,
      (uint32_t)sizeof(MobileStackRawMetadataProbeRequest),
      MOBILE_STACK_RAW_FORMAT_DNG,
      0u,
      byte_length,
  };
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status = mobile_stack_raw_probe_metadata(
      decoder, (const uint8_t*)path, (uint32_t)(sizeof(path) - 1u),
      &request, &result);

  CHECK(status == MOBILE_STACK_RAW_RESOURCE_LIMIT);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_RESOURCE_LIMIT);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

int main(void) {
  CHECK(mobile_stack_raw_abi_version() == MOBILE_STACK_RAW_ABI_VERSION);

  const uint64_t capabilities = mobile_stack_raw_capabilities();
  CHECK((capabilities & MOBILE_STACK_RAW_CAPABILITY_DECODE) != 0u);
  CHECK((capabilities & MOBILE_STACK_RAW_CAPABILITY_METADATA_PROBE) != 0u);
  CHECK((capabilities & MOBILE_STACK_RAW_CAPABILITY_CONFORMANCE_STUB) != 0u);
  CHECK((capabilities & MOBILE_STACK_RAW_CAPABILITY_DNG_METADATA) != 0u);
  CHECK((capabilities &
         MOBILE_STACK_RAW_CAPABILITY_ARW_LOSSLESS_JPEG) != 0u);
  CHECK((capabilities & MOBILE_STACK_RAW_CAPABILITY_SONY_ARW2) != 0u);
  CHECK((capabilities & MOBILE_STACK_RAW_CAPABILITY_LIBRAW_SONY) != 0u);
  CHECK((capabilities & MOBILE_STACK_RAW_CAPABILITY_LIBRAW_NIKON) != 0u);
  CHECK((capabilities & MOBILE_STACK_RAW_CAPABILITY_DECODE_TO_FILE) != 0u);

  MobileStackRawDecoder* decoder = mobile_stack_raw_decoder_create();
  CHECK(decoder != NULL);
  CHECK(check_decode(decoder) == 0);
  CHECK(check_decode_to_file(decoder) == 0);
  CHECK(check_metadata(decoder) == 0);
  CHECK(check_missing_dng_rejection(decoder) == 0);
  CHECK(check_production_dng_metadata(decoder) == 0);
  CHECK(check_unsupported_black_repeat_rejection(decoder) == 0);
  CHECK(check_dng_linearization_and_deltas(decoder) == 0);
  CHECK(check_dng_invalid_computed_black_rejection(decoder) == 0);
  CHECK(check_dng_length_mismatch(decoder) == 0);
  CHECK(check_dng_ifd_resource_limit(decoder) == 0);
  mobile_stack_raw_decoder_destroy(decoder);
  return 0;
}
