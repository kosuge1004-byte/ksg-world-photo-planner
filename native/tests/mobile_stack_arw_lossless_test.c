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

enum {
  kIfdOffset = 8,
  kCropOriginOffset = 248,
  kCropSizeOffset = 256,
  kBlackOffset = 264,
  kWhiteBalanceOffset = 272,
  kCameraModelOffset = 288,
  kJpegOffset = 320,
  kFileLength = 512,
  kEntryCount = 19,
};

static const uint8_t kConstantLosslessJpeg[] = {
    0xFF, 0xD8,
    0xFF, 0xC3, 0x00, 0x14,
    0x0E, 0x00, 0x01, 0x00, 0x01, 0x04,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0x04, 0x11, 0x00,
    0xFF, 0xC4, 0x00, 0x15,
    0x00,
    0x02, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x01,
    0xFF, 0xDA, 0x00, 0x0E,
    0x04,
    0x01, 0x00,
    0x02, 0x00,
    0x03, 0x00,
    0x04, 0x00,
    0x01, 0x00, 0x00,
    0x73,
    0xFF, 0xD9,
};

static void write_u16_le(uint8_t* bytes,
                         uint32_t offset,
                         uint16_t value) {
  bytes[offset] = (uint8_t)(value & 0xFFu);
  bytes[offset + 1u] = (uint8_t)(value >> 8);
}

static void write_u32_le(uint8_t* bytes,
                         uint32_t offset,
                         uint32_t value) {
  bytes[offset] = (uint8_t)(value & 0xFFu);
  bytes[offset + 1u] = (uint8_t)((value >> 8) & 0xFFu);
  bytes[offset + 2u] = (uint8_t)((value >> 16) & 0xFFu);
  bytes[offset + 3u] = (uint8_t)(value >> 24);
}

static void write_entry(uint8_t* bytes,
                        uint32_t index,
                        uint16_t tag,
                        uint16_t type,
                        uint32_t count,
                        uint32_t value) {
  const uint32_t offset = kIfdOffset + 2u + index * 12u;
  write_u16_le(bytes, offset, tag);
  write_u16_le(bytes, offset + 2u, type);
  write_u32_le(bytes, offset + 4u, count);
  write_u32_le(bytes, offset + 8u, value);
}

static void write_lsb_bits(uint8_t* bytes,
                           uint32_t position,
                           uint32_t count,
                           uint32_t value) {
  for (uint32_t bit = 0; bit < count; bit++) {
    bytes[(position + bit) >> 3] |=
        (uint8_t)(((value >> bit) & 1u) << ((position + bit) & 7u));
  }
}

static void write_arw2_block(uint8_t* bytes) {
  memset(bytes, 0, 16);
  write_lsb_bits(bytes, 0, 11, 200);
  write_lsb_bits(bytes, 11, 11, 50);
  write_lsb_bits(bytes, 22, 4, 2);
  write_lsb_bits(bytes, 26, 4, 9);
  uint32_t position = 30;
  for (uint32_t index = 0; index < 16; index++) {
    if (index == 2 || index == 9) continue;
    write_lsb_bits(bytes, position, 7, index + 1u);
    position += 7;
  }
}

static int write_arw2_fixture(const char* path,
                              uint16_t bits_per_sample,
                              uint32_t* length_out) {
  enum { kArw2EntryCount = 14 };
  uint8_t bytes[kFileLength];
  memset(bytes, 0, sizeof(bytes));
  bytes[0] = 'I';
  bytes[1] = 'I';
  write_u16_le(bytes, 2, 42);
  write_u32_le(bytes, 4, kIfdOffset);
  write_u16_le(bytes, kIfdOffset, kArw2EntryCount);
  uint32_t index = 0;
  write_entry(bytes, index++, 0x0100, 3, 1, 32);
  write_entry(bytes, index++, 0x0101, 3, 1, 2);
  write_entry(bytes, index++, 0x0102, 3, 1, bits_per_sample);
  write_entry(bytes, index++, 0x0103, 3, 1, 32767);
  write_entry(bytes, index++, 0x0106, 3, 1, 32803);
  write_entry(bytes, index++, 0x0111, 4, 1, kJpegOffset);
  write_entry(bytes, index++, 0x0112, 3, 1, 1);
  write_entry(bytes, index++, 0x0115, 3, 1, 1);
  write_entry(bytes, index++, 0x0116, 4, 1, 2);
  write_entry(bytes, index++, 0x0117, 4, 1, 64);
  write_entry(bytes, index++, 0x7310, 3, 4, kBlackOffset);
  write_entry(bytes, index++, 0x828D, 3, 2, 0x00020002u);
  write_entry(bytes, index++, 0x828E, 1, 4, 0x02010100u);
  write_entry(bytes, index++, 0xC61D, 3, 1, 16380);
  write_u32_le(bytes, kIfdOffset + 2u + kArw2EntryCount * 12u, 0);
  for (uint32_t black = 0; black < 4; black++) {
    write_u16_le(bytes, kBlackOffset + black * 2u, 512);
  }
  write_arw2_block(bytes + kJpegOffset);
  write_arw2_block(bytes + kJpegOffset + 16u);
  write_arw2_block(bytes + kJpegOffset + 32u);
  write_arw2_block(bytes + kJpegOffset + 48u);
  FILE* file = fopen(path, "wb");
  if (file == NULL) return 0;
  const int written = fwrite(bytes, 1, sizeof(bytes), file) == sizeof(bytes);
  const int closed = fclose(file) == 0;
  if (!written || !closed) {
    remove(path);
    return 0;
  }
  *length_out = sizeof(bytes);
  return 1;
}

static int write_fixture_with_model(const char* path,
                                    uint8_t predictor,
                                    const char* camera_model,
                                    uint32_t* length_out) {
  const size_t camera_model_length = strlen(camera_model) + 1u;
  if (camera_model_length > 16u) return 0;
  uint8_t bytes[kFileLength];
  memset(bytes, 0, sizeof(bytes));
  bytes[0] = 'I';
  bytes[1] = 'I';
  write_u16_le(bytes, 2, 42);
  write_u32_le(bytes, 4, kIfdOffset);
  write_u16_le(bytes, kIfdOffset, kEntryCount);

  uint32_t index = 0;
  write_entry(bytes, index++, 0x0100, 3, 1, 2);
  write_entry(bytes, index++, 0x0101, 3, 1, 2);
  write_entry(bytes, index++, 0x0102, 3, 1, 14);
  write_entry(bytes, index++, 0x0103, 3, 1, 7);
  write_entry(bytes, index++, 0x0106, 3, 1, 32803);
  write_entry(bytes, index++, 0x0110, 2,
              (uint32_t)camera_model_length, kCameraModelOffset);
  write_entry(bytes, index++, 0x0112, 3, 1, 1);
  write_entry(bytes, index++, 0x0115, 3, 1, 1);
  write_entry(bytes, index++, 0x0142, 3, 1, 2);
  write_entry(bytes, index++, 0x0143, 3, 1, 2);
  write_entry(bytes, index++, 0x0144, 4, 1, kJpegOffset);
  write_entry(
      bytes, index++, 0x0145, 4, 1,
      (uint32_t)sizeof(kConstantLosslessJpeg));
  write_entry(bytes, index++, 0x7310, 3, 4, kBlackOffset);
  write_entry(bytes, index++, 0x7313, 8, 4, kWhiteBalanceOffset);
  write_entry(bytes, index++, 0x828D, 3, 2, 0x00020002u);
  write_entry(bytes, index++, 0x828E, 1, 4, 0x02010100u);
  write_entry(bytes, index++, 0xC61D, 3, 1, 16383);
  write_entry(bytes, index++, 0xC61F, 4, 2, kCropOriginOffset);
  write_entry(bytes, index++, 0xC620, 4, 2, kCropSizeOffset);
  write_u32_le(
      bytes, kIfdOffset + 2u + kEntryCount * 12u, 0);

  write_u32_le(bytes, kCropOriginOffset, 0);
  write_u32_le(bytes, kCropOriginOffset + 4u, 0);
  write_u32_le(bytes, kCropSizeOffset, 2);
  write_u32_le(bytes, kCropSizeOffset + 4u, 2);
  for (uint32_t black = 0; black < 4; black++) {
    write_u16_le(bytes, kBlackOffset + black * 2u, 512);
  }
  write_u16_le(bytes, kWhiteBalanceOffset, 2048);
  write_u16_le(bytes, kWhiteBalanceOffset + 2u, 1024);
  write_u16_le(bytes, kWhiteBalanceOffset + 4u, 1024);
  write_u16_le(bytes, kWhiteBalanceOffset + 6u, 1536);
  memcpy(bytes + kCameraModelOffset, camera_model, camera_model_length);
  memcpy(bytes + kJpegOffset, kConstantLosslessJpeg,
         sizeof(kConstantLosslessJpeg));
  bytes[kJpegOffset + sizeof(kConstantLosslessJpeg) - 6u] = predictor;

  FILE* file = fopen(path, "wb");
  if (file == NULL) return 0;
  const int written =
      fwrite(bytes, 1, sizeof(bytes), file) == sizeof(bytes);
  const int closed = fclose(file) == 0;
  if (!written || !closed) {
    remove(path);
    return 0;
  }
  *length_out = sizeof(bytes);
  return 1;
}

static int write_fixture(const char* path,
                         uint8_t predictor,
                         uint32_t* length_out) {
  return write_fixture_with_model(
      path, predictor, "ILCE-7M3", length_out);
}

static MobileStackRawDecodeRequest request_for(uint64_t length,
                                                uint64_t pixel_limit) {
  const MobileStackRawDecodeRequest request = {
      MOBILE_STACK_RAW_ABI_VERSION,
      (uint32_t)sizeof(MobileStackRawDecodeRequest),
      MOBILE_STACK_RAW_FORMAT_ARW,
      MOBILE_STACK_RAW_PRECISION_FLOAT32,
      MOBILE_STACK_RAW_FLAG_PRESERVE_SENSOR_VALUES,
      length,
      pixel_limit,
  };
  return request;
}

static int check_success(MobileStackRawDecoder* decoder) {
  static const char path[] = "mobile_stack_arw_lossless_fixture.arw";
  uint32_t length = 0;
  CHECK(write_fixture(path, 1, &length));
  const MobileStackRawDecodeRequest request = request_for(length, 4);
  MobileStackRawDecodeResult* result = NULL;
  const int32_t status = mobile_stack_raw_decode(
      decoder, (const uint8_t*)path, (uint32_t)(sizeof(path) - 1u),
      &request, &result);

  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_OK);
  CHECK(result->format == MOBILE_STACK_RAW_FORMAT_ARW);
  CHECK(result->width == 2u);
  CHECK(result->height == 2u);
  CHECK(result->active_width == 2u);
  CHECK(result->active_height == 2u);
  CHECK(result->cfa_pattern == MOBILE_STACK_RAW_CFA_RGGB);
  CHECK(result->orientation == 1u);
  CHECK(result->black_level_0 == 512.0f);
  CHECK(result->black_level_3 == 512.0f);
  CHECK(result->white_level == 16383.0f);
  CHECK(result->has_camera_white_balance == 1u);
  CHECK(result->camera_white_balance_0 == 2.0f);
  CHECK(result->camera_white_balance_1 == 1.0f);
  CHECK(result->camera_white_balance_2 == 1.0f);
  CHECK(result->camera_white_balance_3 == 1.5f);
  CHECK(result->sample_count == 4u);
  CHECK(result->row_stride_samples == 2u);
  CHECK(result->samples != NULL);
  CHECK(result->samples[0] == 8192.0f);
  CHECK(result->samples[1] == 8193.0f);
  CHECK(result->samples[2] == 8191.0f);
  CHECK(result->samples[3] == 8192.0f);

  mobile_stack_raw_decode_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_unknown_model_has_no_color_matrix(
    MobileStackRawDecoder* decoder) {
  static const char path[] = "mobile_stack_arw_unknown_model_fixture.arw";
  uint32_t length = 0;
  CHECK(write_fixture_with_model(path, 1, "ILCE-TEST", &length));
  const MobileStackRawMetadataProbeRequest request = {
      MOBILE_STACK_RAW_ABI_VERSION,
      (uint32_t)sizeof(MobileStackRawMetadataProbeRequest),
      MOBILE_STACK_RAW_FORMAT_ARW,
      0u,
      length,
  };
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status = mobile_stack_raw_probe_metadata(
      decoder, (const uint8_t*)path, (uint32_t)(sizeof(path) - 1u),
      &request, &result);
  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->has_d65_xyz_to_camera == 0u);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_metadata_probe(MobileStackRawDecoder* decoder) {
  static const char path[] = "mobile_stack_arw_metadata_fixture.arw";
  uint32_t length = 0;
  CHECK(write_fixture(path, 1, &length));
  const MobileStackRawMetadataProbeRequest request = {
      MOBILE_STACK_RAW_ABI_VERSION,
      (uint32_t)sizeof(MobileStackRawMetadataProbeRequest),
      MOBILE_STACK_RAW_FORMAT_ARW,
      0u,
      length,
  };
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status = mobile_stack_raw_probe_metadata(
      decoder, (const uint8_t*)path, (uint32_t)(sizeof(path) - 1u),
      &request, &result);

  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_OK);
  CHECK(result->format == MOBILE_STACK_RAW_FORMAT_ARW);
  CHECK(result->width == 2u);
  CHECK(result->height == 2u);
  CHECK(result->active_width == 2u);
  CHECK(result->active_height == 2u);
  CHECK(result->cfa_pattern == MOBILE_STACK_RAW_CFA_RGGB);
  CHECK(result->orientation == 1u);
  CHECK(result->black_level_0 == 512.0f);
  CHECK(result->black_level_3 == 512.0f);
  CHECK(result->white_level == 16383.0f);
  CHECK(result->has_camera_white_balance == 1u);
  CHECK(result->camera_white_balance_0 == 2.0f);
  CHECK(result->camera_white_balance_1 == 1.0f);
  CHECK(result->camera_white_balance_2 == 1.0f);
  CHECK(result->camera_white_balance_3 == 1.5f);
  CHECK(result->has_d65_xyz_to_camera == 1u);
  CHECK(result->d65_xyz_to_camera_0 == 0.7374f);
  CHECK(result->d65_xyz_to_camera_1 == -0.2389f);
  CHECK(result->d65_xyz_to_camera_2 == -0.0551f);
  CHECK(result->d65_xyz_to_camera_3 == -0.5435f);
  CHECK(result->d65_xyz_to_camera_4 == 1.3162f);
  CHECK(result->d65_xyz_to_camera_5 == 0.2519f);
  CHECK(result->d65_xyz_to_camera_6 == -0.1006f);
  CHECK(result->d65_xyz_to_camera_7 == 0.1795f);
  CHECK(result->d65_xyz_to_camera_8 == 0.6552f);

  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_pixel_limit(MobileStackRawDecoder* decoder) {
  static const char path[] = "mobile_stack_arw_limit_fixture.arw";
  uint32_t length = 0;
  CHECK(write_fixture(path, 1, &length));
  const MobileStackRawDecodeRequest request = request_for(length, 3);
  MobileStackRawDecodeResult* result = NULL;
  const int32_t status = mobile_stack_raw_decode(
      decoder, (const uint8_t*)path, (uint32_t)(sizeof(path) - 1u),
      &request, &result);
  CHECK(status == MOBILE_STACK_RAW_RESOURCE_LIMIT);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_RESOURCE_LIMIT);
  mobile_stack_raw_decode_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_arw2_success(MobileStackRawDecoder* decoder,
                              uint16_t bits_per_sample,
                              const char* path) {
  static const float expected[32] = {
      104, 104, 108, 108, 400, 400, 116, 116,
      120, 120, 124, 124, 128, 128, 132, 132,
      136, 136, 100, 100, 144, 144, 148, 148,
      152, 152, 156, 156, 160, 160, 164, 164,
  };
  uint32_t length = 0;
  CHECK(write_arw2_fixture(path, bits_per_sample, &length));
  const MobileStackRawDecodeRequest request = request_for(length, 64);
  MobileStackRawDecodeResult* result = NULL;
  const int32_t status = mobile_stack_raw_decode(
      decoder, (const uint8_t*)path, (uint32_t)strlen(path),
      &request, &result);
  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->width == 32u);
  CHECK(result->height == 2u);
  CHECK(result->sample_count == 64u);
  CHECK(result->black_level_0 == 512.0f);
  CHECK(result->white_level == 16380.0f);
  for (uint32_t index = 0; index < 32; index++) {
    CHECK(result->samples[index] == expected[index]);
    CHECK(result->samples[index + 32u] == expected[index]);
  }
  mobile_stack_raw_decode_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_unsupported_predictor(MobileStackRawDecoder* decoder) {
  // predictor=2 is unsupported by the in-house lossless-JPEG ARW decoder.
  // This used to be a hard failure. mobile_stack_raw_ffi_stub.c now falls
  // back to LibRaw for any custom-decoder failure other than
  // MOBILE_STACK_RAW_RESOURCE_LIMIT (see its ARW branch), so this synthetic,
  // minimal, hand-built fixture is then handed to LibRaw instead of failing
  // immediately. LibRaw cannot recognize this fixture as a valid RAW file
  // either (it is a deliberately tiny/incomplete structure, not a real
  // camera file), and reports MOBILE_STACK_RAW_UNSUPPORTED_FORMAT — not the
  // original MOBILE_STACK_RAW_DECODE_FAILURE, and not MOBILE_STACK_RAW_OK.
  // Confirmed empirically against the current stub (native ctest, this
  // exact fixture): status=2 (MOBILE_STACK_RAW_UNSUPPORTED_FORMAT).
  static const char path[] = "mobile_stack_arw_predictor_fixture.arw";
  uint32_t length = 0;
  CHECK(write_fixture(path, 2, &length));
  const MobileStackRawDecodeRequest request = request_for(length, 4);
  MobileStackRawDecodeResult* result = NULL;
  const int32_t status = mobile_stack_raw_decode(
      decoder, (const uint8_t*)path, (uint32_t)(sizeof(path) - 1u),
      &request, &result);
  CHECK(status == MOBILE_STACK_RAW_UNSUPPORTED_FORMAT);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_UNSUPPORTED_FORMAT);
  mobile_stack_raw_decode_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_length_mismatch(MobileStackRawDecoder* decoder) {
  static const char path[] = "mobile_stack_arw_length_fixture.arw";
  uint32_t length = 0;
  CHECK(write_fixture(path, 1, &length));
  const MobileStackRawDecodeRequest request =
      request_for((uint64_t)length + 1u, 4);
  MobileStackRawDecodeResult* result = NULL;
  const int32_t status = mobile_stack_raw_decode(
      decoder, (const uint8_t*)path, (uint32_t)(sizeof(path) - 1u),
      &request, &result);
  CHECK(status == MOBILE_STACK_RAW_CORRUPT_DATA);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_decode_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

int main(void) {
  const uint64_t capabilities = mobile_stack_raw_capabilities();
  CHECK((capabilities &
         MOBILE_STACK_RAW_CAPABILITY_ARW_LOSSLESS_JPEG) != 0u);
  CHECK((capabilities & MOBILE_STACK_RAW_CAPABILITY_SONY_ARW2) != 0u);

  MobileStackRawDecoder* decoder = mobile_stack_raw_decoder_create();
  CHECK(decoder != NULL);
  CHECK(check_success(decoder) == 0);
  CHECK(check_metadata_probe(decoder) == 0);
  CHECK(check_unknown_model_has_no_color_matrix(decoder) == 0);
  CHECK(check_arw2_success(
            decoder, 12u, "mobile_stack_arw2_12_bit_fixture.arw") == 0);
  CHECK(check_arw2_success(
            decoder, 14u, "mobile_stack_arw2_14_bit_fixture.arw") == 0);
  CHECK(check_pixel_limit(decoder) == 0);
  CHECK(check_unsupported_predictor(decoder) == 0);
  CHECK(check_length_mismatch(decoder) == 0);
  mobile_stack_raw_decoder_destroy(decoder);
  return 0;
}
