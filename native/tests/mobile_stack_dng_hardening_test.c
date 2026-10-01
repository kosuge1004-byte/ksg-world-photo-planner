#include "mobile_stack_raw_ffi.h"

#include <math.h>
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
  kTiffTypeByte = 1,
  kTiffTypeAscii = 2,
  kTiffTypeShort = 3,
  kTiffTypeLong = 4,
  kTiffTypeRational = 5,
  kTiffTypeUndefined = 7,
  kTiffTypeSignedRational = 10,
  kTiffTypeFloat = 11,
  kMinimalEntryCount = 17,
  kMinimalBlackOffset = 218,
  kMinimalNeutralOffset = 226,
  kMinimalActiveOffset = 250,
  kMinimalColorMatrixOffset = 266,
  kMinimalFileLength = 338,
  kAnalogBalanceFileLength = 362,
  kCameraCalibrationFileLength = 410,
  kExternalCameraSignatureOffset = 410,
  kExternalProfileSignatureOffset = 416,
  kExternalCalibrationFileLength = 422,
  kDualColorFileLength = 434,
};

static void write_u16(uint8_t* bytes,
                      uint32_t offset,
                      uint16_t value,
                      int little_endian) {
  if (little_endian) {
    bytes[offset] = (uint8_t)(value & 0xFFu);
    bytes[offset + 1u] = (uint8_t)(value >> 8);
  } else {
    bytes[offset] = (uint8_t)(value >> 8);
    bytes[offset + 1u] = (uint8_t)(value & 0xFFu);
  }
}

static void write_u32(uint8_t* bytes,
                      uint32_t offset,
                      uint32_t value,
                      int little_endian) {
  if (little_endian) {
    bytes[offset] = (uint8_t)(value & 0xFFu);
    bytes[offset + 1u] = (uint8_t)((value >> 8) & 0xFFu);
    bytes[offset + 2u] = (uint8_t)((value >> 16) & 0xFFu);
    bytes[offset + 3u] = (uint8_t)(value >> 24);
  } else {
    bytes[offset] = (uint8_t)(value >> 24);
    bytes[offset + 1u] = (uint8_t)((value >> 16) & 0xFFu);
    bytes[offset + 2u] = (uint8_t)((value >> 8) & 0xFFu);
    bytes[offset + 3u] = (uint8_t)(value & 0xFFu);
  }
}

static void write_float32(uint8_t* bytes,
                          uint32_t offset,
                          float value,
                          int little_endian) {
  uint32_t bits = 0u;
  memcpy(&bits, &value, sizeof(bits));
  write_u32(bytes, offset, bits, little_endian);
}

static void write_signed_rational(uint8_t* bytes,
                                  uint32_t offset,
                                  int32_t numerator,
                                  int32_t denominator,
                                  int little_endian) {
  write_u32(bytes, offset, (uint32_t)numerator, little_endian);
  write_u32(bytes, offset + 4u, (uint32_t)denominator, little_endian);
}

static void write_illuminant_xy_data(uint8_t* bytes,
                                     uint32_t offset,
                                     uint32_t x_numerator,
                                     uint32_t x_denominator,
                                     uint32_t y_numerator,
                                     uint32_t y_denominator,
                                     int little_endian) {
  write_u16(bytes, offset, 0u, little_endian);
  write_u32(bytes, offset + 2u, x_numerator, little_endian);
  write_u32(bytes, offset + 6u, x_denominator, little_endian);
  write_u32(bytes, offset + 10u, y_numerator, little_endian);
  write_u32(bytes, offset + 14u, y_denominator, little_endian);
}

static void write_illuminant_spectrum_data(uint8_t* bytes,
                                           uint32_t offset,
                                           uint32_t sample_count,
                                           uint32_t min_lambda,
                                           uint32_t spacing,
                                           uint32_t sample_value,
                                           int little_endian) {
  write_u16(bytes, offset, 1u, little_endian);
  write_u32(bytes, offset + 2u, sample_count, little_endian);
  write_u32(bytes, offset + 6u, min_lambda, little_endian);
  write_u32(bytes, offset + 10u, 1u, little_endian);
  write_u32(bytes, offset + 14u, spacing, little_endian);
  write_u32(bytes, offset + 18u, 1u, little_endian);
  for (uint32_t index = 0; index < sample_count && index < 2u; index++) {
    write_u32(bytes, offset + 22u + index * 8u,
              sample_value, little_endian);
    write_u32(bytes, offset + 26u + index * 8u, 1u, little_endian);
  }
}

static uint32_t entry_offset(uint32_t ifd_offset, uint32_t index) {
  return ifd_offset + 2u + index * 12u;
}

static void write_entry_header(uint8_t* bytes,
                               uint32_t ifd_offset,
                               uint32_t index,
                               uint16_t tag,
                               uint16_t type,
                               uint32_t count,
                               int little_endian) {
  const uint32_t offset = entry_offset(ifd_offset, index);
  write_u16(bytes, offset, tag, little_endian);
  write_u16(bytes, offset + 2u, type, little_endian);
  write_u32(bytes, offset + 4u, count, little_endian);
}

static void write_long_entry(uint8_t* bytes,
                             uint32_t ifd_offset,
                             uint32_t index,
                             uint16_t tag,
                             uint32_t count,
                             uint32_t value,
                             int little_endian) {
  write_entry_header(bytes, ifd_offset, index, tag, kTiffTypeLong,
                     count, little_endian);
  write_u32(bytes, entry_offset(ifd_offset, index) + 8u, value,
            little_endian);
}

static void write_short_entry(uint8_t* bytes,
                              uint32_t ifd_offset,
                              uint32_t index,
                              uint16_t tag,
                              uint16_t value,
                              int little_endian) {
  write_entry_header(bytes, ifd_offset, index, tag, kTiffTypeShort,
                     1, little_endian);
  write_u16(bytes, entry_offset(ifd_offset, index) + 8u, value,
            little_endian);
}

static void write_short_pair_entry(uint8_t* bytes,
                                   uint32_t ifd_offset,
                                   uint32_t index,
                                   uint16_t tag,
                                   uint16_t first,
                                   uint16_t second,
                                   int little_endian) {
  const uint32_t value_offset =
      entry_offset(ifd_offset, index) + 8u;
  write_entry_header(bytes, ifd_offset, index, tag, kTiffTypeShort,
                     2, little_endian);
  write_u16(bytes, value_offset, first, little_endian);
  write_u16(bytes, value_offset + 2u, second, little_endian);
}

static void write_byte_four_entry(uint8_t* bytes,
                                  uint32_t ifd_offset,
                                  uint32_t index,
                                  uint16_t tag,
                                  uint8_t first,
                                  uint8_t second,
                                  uint8_t third,
                                  uint8_t fourth,
                                  int little_endian) {
  const uint32_t value_offset =
      entry_offset(ifd_offset, index) + 8u;
  write_entry_header(bytes, ifd_offset, index, tag, kTiffTypeByte,
                     4, little_endian);
  bytes[value_offset] = first;
  bytes[value_offset + 1u] = second;
  bytes[value_offset + 2u] = third;
  bytes[value_offset + 3u] = fourth;
}

static void write_offset_entry(uint8_t* bytes,
                               uint32_t ifd_offset,
                               uint32_t index,
                               uint16_t tag,
                               uint16_t type,
                               uint32_t count,
                               uint32_t value_offset,
                               int little_endian) {
  write_entry_header(bytes, ifd_offset, index, tag, type, count,
                     little_endian);
  write_u32(bytes, entry_offset(ifd_offset, index) + 8u,
            value_offset, little_endian);
}

static void write_inline_signature(uint8_t* bytes,
                                   uint32_t ifd_offset,
                                   uint32_t index,
                                   uint16_t tag,
                                   uint8_t character,
                                   uint8_t terminator,
                                   int little_endian) {
  const uint32_t offset = entry_offset(ifd_offset, index);
  write_entry_header(bytes, ifd_offset, index, tag, kTiffTypeAscii, 2,
                     little_endian);
  bytes[offset + 8u] = character;
  bytes[offset + 9u] = terminator;
  bytes[offset + 10u] = 0;
  bytes[offset + 11u] = 0;
}

static void write_tiff_header(uint8_t* bytes,
                              uint32_t first_ifd,
                              int little_endian) {
  bytes[0] = (uint8_t)(little_endian ? 'I' : 'M');
  bytes[1] = bytes[0];
  write_u16(bytes, 2, 42, little_endian);
  write_u32(bytes, 4, first_ifd, little_endian);
}

static void build_minimal_dng(uint8_t* bytes,
                              int little_endian,
                              uint32_t active_value_offset) {
  const uint32_t ifd_offset = 8;
  memset(bytes, 0, kMinimalFileLength);
  write_tiff_header(bytes, ifd_offset, little_endian);
  write_u16(bytes, ifd_offset, kMinimalEntryCount, little_endian);

  write_long_entry(bytes, ifd_offset, 0, 254, 1, 0, little_endian);
  write_long_entry(bytes, ifd_offset, 1, 256, 1, 6000,
                   little_endian);
  write_long_entry(bytes, ifd_offset, 2, 257, 1, 4000,
                   little_endian);
  write_short_entry(bytes, ifd_offset, 3, 258, 16, little_endian);
  write_short_entry(bytes, ifd_offset, 4, 262, 32803,
                    little_endian);
  write_short_entry(bytes, ifd_offset, 5, 274, 1, little_endian);
  write_short_entry(bytes, ifd_offset, 6, 277, 1, little_endian);
  write_short_pair_entry(bytes, ifd_offset, 7, 33421, 2, 2,
                         little_endian);
  write_byte_four_entry(bytes, ifd_offset, 8, 33422, 0, 1, 1, 2,
                        little_endian);
  write_byte_four_entry(bytes, ifd_offset, 9, 50706, 1, 4, 0, 0,
                        little_endian);
  write_short_pair_entry(bytes, ifd_offset, 10, 50713, 2, 2,
                         little_endian);
  write_offset_entry(bytes, ifd_offset, 11, 50714, kTiffTypeShort,
                     4, kMinimalBlackOffset, little_endian);
  write_long_entry(bytes, ifd_offset, 12, 50717, 1, 16383,
                   little_endian);
  write_offset_entry(bytes, ifd_offset, 13, 50728,
                     kTiffTypeRational, 3, kMinimalNeutralOffset,
                     little_endian);
  write_offset_entry(bytes, ifd_offset, 14, 50829, kTiffTypeLong,
                     4, active_value_offset, little_endian);
  write_offset_entry(bytes, ifd_offset, 15, 50722,
                     kTiffTypeSignedRational, 9,
                     kMinimalColorMatrixOffset, little_endian);
  write_short_entry(bytes, ifd_offset, 16, 50779, 21,
                    little_endian);
  write_u32(bytes, 214, 0, little_endian);

  for (uint32_t index = 0; index < 4; index++) {
    write_u16(bytes, kMinimalBlackOffset + index * 2u, 64,
              little_endian);
  }
  write_u32(bytes, kMinimalNeutralOffset, 1, little_endian);
  write_u32(bytes, kMinimalNeutralOffset + 4u, 2, little_endian);
  write_u32(bytes, kMinimalNeutralOffset + 8u, 1, little_endian);
  write_u32(bytes, kMinimalNeutralOffset + 12u, 1, little_endian);
  write_u32(bytes, kMinimalNeutralOffset + 16u, 2, little_endian);
  write_u32(bytes, kMinimalNeutralOffset + 20u, 3, little_endian);
  write_u32(bytes, kMinimalActiveOffset, 8, little_endian);
  write_u32(bytes, kMinimalActiveOffset + 4u, 8, little_endian);
  write_u32(bytes, kMinimalActiveOffset + 8u, 3992,
            little_endian);
  write_u32(bytes, kMinimalActiveOffset + 12u, 5992,
            little_endian);
  for (uint32_t index = 0; index < 9; index++) {
    const int32_t numerator = index == 1u
        ? -1
        : (index == 0u || index == 4u || index == 8u ? 1 : 0);
    write_signed_rational(
        bytes, kMinimalColorMatrixOffset + index * 8u,
        numerator, index == 1u ? 10 : 1, little_endian);
  }
}


static void build_forward_matrix_dng(uint8_t* bytes, int little_endian) {
  enum {
    kIfdOffset = 8,
    kEntryCount = 18,
    kBlackOffset = 230,
    kNeutralOffset = 238,
    kActiveOffset = 262,
    kMatrixOffset = 278,
    kForwardOffset = 350,
    kFileLength = 422,
  };
  memset(bytes, 0, kFileLength);
  write_tiff_header(bytes, kIfdOffset, little_endian);
  write_u16(bytes, kIfdOffset, kEntryCount, little_endian);
  write_long_entry(bytes, kIfdOffset, 0, 254, 1, 0, little_endian);
  write_long_entry(bytes, kIfdOffset, 1, 256, 1, 6000, little_endian);
  write_long_entry(bytes, kIfdOffset, 2, 257, 1, 4000, little_endian);
  write_short_entry(bytes, kIfdOffset, 3, 258, 16, little_endian);
  write_short_entry(bytes, kIfdOffset, 4, 262, 32803, little_endian);
  write_short_entry(bytes, kIfdOffset, 5, 274, 1, little_endian);
  write_short_entry(bytes, kIfdOffset, 6, 277, 1, little_endian);
  write_short_pair_entry(bytes, kIfdOffset, 7, 33421, 2, 2, little_endian);
  write_byte_four_entry(bytes, kIfdOffset, 8, 33422, 0, 1, 1, 2,
                        little_endian);
  write_byte_four_entry(bytes, kIfdOffset, 9, 50706, 1, 4, 0, 0,
                        little_endian);
  write_short_pair_entry(bytes, kIfdOffset, 10, 50713, 2, 2,
                         little_endian);
  write_offset_entry(bytes, kIfdOffset, 11, 50714, kTiffTypeShort, 4,
                     kBlackOffset, little_endian);
  write_long_entry(bytes, kIfdOffset, 12, 50717, 1, 16383, little_endian);
  write_offset_entry(bytes, kIfdOffset, 13, 50728, kTiffTypeRational, 3,
                     kNeutralOffset, little_endian);
  write_offset_entry(bytes, kIfdOffset, 14, 50829, kTiffTypeLong, 4,
                     kActiveOffset, little_endian);
  write_offset_entry(bytes, kIfdOffset, 15, 50721, kTiffTypeSignedRational,
                     9, kMatrixOffset, little_endian);
  write_short_entry(bytes, kIfdOffset, 16, 50778, 23, little_endian);
  write_offset_entry(bytes, kIfdOffset, 17, 50964, kTiffTypeSignedRational,
                     9, kForwardOffset, little_endian);
  write_u32(bytes, kIfdOffset + 2u + kEntryCount * 12u, 0, little_endian);

  for (uint32_t index = 0; index < 4; index++) {
    write_u16(bytes, kBlackOffset + index * 2u, 64, little_endian);
  }
  for (uint32_t index = 0; index < 3; index++) {
    write_u32(bytes, kNeutralOffset + index * 8u, 1, little_endian);
    write_u32(bytes, kNeutralOffset + index * 8u + 4u, 1, little_endian);
  }
  write_u32(bytes, kActiveOffset, 8, little_endian);
  write_u32(bytes, kActiveOffset + 4u, 8, little_endian);
  write_u32(bytes, kActiveOffset + 8u, 3992, little_endian);
  write_u32(bytes, kActiveOffset + 12u, 5992, little_endian);
  for (uint32_t index = 0; index < 9; index++) {
    write_signed_rational(bytes, kMatrixOffset + index * 8u,
                          (index == 0u || index == 4u || index == 8u) ? 1 : 0,
                          1, little_endian);
  }
  for (uint32_t index = 0; index < 9; index++) {
    int32_t numerator = 0;
    int32_t denominator = 1;
    if (index == 0u) { numerator = 96422; denominator = 100000; }
    if (index == 4u) { numerator = 1; denominator = 1; }
    if (index == 8u) { numerator = 82521; denominator = 100000; }
    write_signed_rational(bytes, kForwardOffset + index * 8u,
                          numerator, denominator, little_endian);
  }
}


static void build_forward_matrix_as_shot_white_xy_dng(
    uint8_t* bytes, int little_endian) {
  enum {
    kIfdOffset = 8,
    kAsShotWhiteOffset = 238,
  };
  build_forward_matrix_dng(bytes, little_endian);
  /* Replace AsShotNeutral with AsShotWhiteXY = D50 (0.3457, 0.3585). */
  write_offset_entry(bytes, kIfdOffset, 13, 50729, kTiffTypeRational, 2,
                     kAsShotWhiteOffset, little_endian);
  write_u32(bytes, kAsShotWhiteOffset, 3457, little_endian);
  write_u32(bytes, kAsShotWhiteOffset + 4u, 10000, little_endian);
  write_u32(bytes, kAsShotWhiteOffset + 8u, 3585, little_endian);
  write_u32(bytes, kAsShotWhiteOffset + 12u, 10000, little_endian);
}

static void build_dual_color_dng(uint8_t* bytes,
                                 uint16_t illuminant_1,
                                 uint16_t illuminant_2) {
  enum {
    kIfdOffset = 8,
    kEntryCount = 19,
    kBlackOffset = 242,
    kNeutralOffset = 250,
    kActiveOffset = 274,
    kMatrix1Offset = 290,
    kMatrix2Offset = 362,
  };
  const int little_endian = 1;
  memset(bytes, 0, kDualColorFileLength);
  write_tiff_header(bytes, kIfdOffset, little_endian);
  write_u16(bytes, kIfdOffset, kEntryCount, little_endian);
  write_long_entry(bytes, kIfdOffset, 0, 254, 1, 0, little_endian);
  write_long_entry(bytes, kIfdOffset, 1, 256, 1, 6000, little_endian);
  write_long_entry(bytes, kIfdOffset, 2, 257, 1, 4000, little_endian);
  write_short_entry(bytes, kIfdOffset, 3, 258, 16, little_endian);
  write_short_entry(bytes, kIfdOffset, 4, 262, 32803, little_endian);
  write_short_entry(bytes, kIfdOffset, 5, 274, 1, little_endian);
  write_short_entry(bytes, kIfdOffset, 6, 277, 1, little_endian);
  write_short_pair_entry(bytes, kIfdOffset, 7, 33421, 2, 2,
                         little_endian);
  write_byte_four_entry(bytes, kIfdOffset, 8, 33422, 0, 1, 1, 2,
                        little_endian);
  write_byte_four_entry(bytes, kIfdOffset, 9, 50706, 1, 4, 0, 0,
                        little_endian);
  write_short_pair_entry(bytes, kIfdOffset, 10, 50713, 2, 2,
                         little_endian);
  write_offset_entry(bytes, kIfdOffset, 11, 50714, kTiffTypeShort, 4,
                     kBlackOffset, little_endian);
  write_long_entry(bytes, kIfdOffset, 12, 50717, 1, 16383,
                   little_endian);
  write_offset_entry(bytes, kIfdOffset, 13, 50728, kTiffTypeRational, 3,
                     kNeutralOffset, little_endian);
  write_offset_entry(bytes, kIfdOffset, 14, 50829, kTiffTypeLong, 4,
                     kActiveOffset, little_endian);
  write_offset_entry(bytes, kIfdOffset, 15, 50721,
                     kTiffTypeSignedRational, 9, kMatrix1Offset,
                     little_endian);
  write_offset_entry(bytes, kIfdOffset, 16, 50722,
                     kTiffTypeSignedRational, 9, kMatrix2Offset,
                     little_endian);
  write_short_entry(bytes, kIfdOffset, 17, 50778, illuminant_1,
                    little_endian);
  write_short_entry(bytes, kIfdOffset, 18, 50779, illuminant_2,
                    little_endian);
  write_u32(bytes, 238, 0, little_endian);

  for (uint32_t index = 0; index < 4; index++) {
    write_u16(bytes, kBlackOffset + index * 2u, 64, little_endian);
  }
  write_u32(bytes, kNeutralOffset, 1, little_endian);
  write_u32(bytes, kNeutralOffset + 4u, 2, little_endian);
  write_u32(bytes, kNeutralOffset + 8u, 1, little_endian);
  write_u32(bytes, kNeutralOffset + 12u, 1, little_endian);
  write_u32(bytes, kNeutralOffset + 16u, 2, little_endian);
  write_u32(bytes, kNeutralOffset + 20u, 3, little_endian);
  write_u32(bytes, kActiveOffset, 8, little_endian);
  write_u32(bytes, kActiveOffset + 4u, 8, little_endian);
  write_u32(bytes, kActiveOffset + 8u, 3992, little_endian);
  write_u32(bytes, kActiveOffset + 12u, 5992, little_endian);
  for (uint32_t index = 0; index < 9; index++) {
    const int32_t matrix_1_numerator =
        index == 0u || index == 4u || index == 8u ? 1 : 0;
    const int32_t matrix_2_numerator =
        index == 0u ? 2 : (index == 4u || index == 8u ? 1 : 0);
    write_signed_rational(bytes, kMatrix1Offset + index * 8u,
                          matrix_1_numerator, 1, little_endian);
    write_signed_rational(bytes, kMatrix2Offset + index * 8u,
                          matrix_2_numerator, 1, little_endian);
  }
}

static void build_dual_forward_matrix_dng(uint8_t* bytes) {
  enum {
    kIfdOffset = 8,
    kForward1Offset = kDualColorFileLength,
    kForward2Offset = kDualColorFileLength + 72,
  };
  build_dual_color_dng(bytes, 17, 21);

  /* Reuse two optional IFD slots so the fixture layout stays compact. */
  write_offset_entry(bytes, kIfdOffset, 11, 50964,
                     kTiffTypeSignedRational, 9, kForward1Offset, 1);
  write_offset_entry(bytes, kIfdOffset, 14, 50965,
                     kTiffTypeSignedRational, 9, kForward2Offset, 1);

  for (uint32_t index = 0; index < 9u; index++) {
    const int diagonal = index == 0u || index == 4u || index == 8u;
    /* Deliberately distinct valid forward matrices so interpolation is
     * observable instead of collapsing to an endpoint/fallback path. */
    write_signed_rational(bytes, kForward1Offset + index * 8u,
                          index == 0u ? 9 : (index == 4u ? 10 :
                          (index == 8u ? 8 : 0)),
                          10, 1);
    write_signed_rational(bytes, kForward2Offset + index * 8u,
                          index == 0u ? 11 : (index == 4u ? 10 :
                          (index == 8u ? 12 : 0)),
                          10, 1);
    (void)diagonal;
  }
}

static void build_dual_calibrated_color_dng(uint8_t* bytes) {
  enum {
    kIfdOffset = 8,
    kEntryCount = 21,
    kBlackOffset = 266,
    kWhiteXyOffset = 274,
    kActiveOffset = 290,
    kMatrix1Offset = 306,
    kMatrix2Offset = 378,
    kCalibration1Offset = 450,
    kCalibration2Offset = 522,
    kFileLength = 594,
  };
  const int little_endian = 1;
  memset(bytes, 0, kFileLength);
  write_tiff_header(bytes, kIfdOffset, little_endian);
  write_u16(bytes, kIfdOffset, kEntryCount, little_endian);
  write_long_entry(bytes, kIfdOffset, 0, 254, 1, 0, little_endian);
  write_long_entry(bytes, kIfdOffset, 1, 256, 1, 6000, little_endian);
  write_long_entry(bytes, kIfdOffset, 2, 257, 1, 4000, little_endian);
  write_short_entry(bytes, kIfdOffset, 3, 258, 16, little_endian);
  write_short_entry(bytes, kIfdOffset, 4, 262, 32803, little_endian);
  write_short_entry(bytes, kIfdOffset, 5, 274, 1, little_endian);
  write_short_entry(bytes, kIfdOffset, 6, 277, 1, little_endian);
  write_short_pair_entry(bytes, kIfdOffset, 7, 33421, 2, 2,
                         little_endian);
  write_byte_four_entry(bytes, kIfdOffset, 8, 33422, 0, 1, 1, 2,
                        little_endian);
  write_byte_four_entry(bytes, kIfdOffset, 9, 50706, 1, 4, 0, 0,
                        little_endian);
  write_short_pair_entry(bytes, kIfdOffset, 10, 50713, 2, 2,
                         little_endian);
  write_offset_entry(bytes, kIfdOffset, 11, 50714, kTiffTypeShort, 4,
                     kBlackOffset, little_endian);
  write_long_entry(bytes, kIfdOffset, 12, 50717, 1, 16383,
                   little_endian);
  write_offset_entry(bytes, kIfdOffset, 13, 50729, kTiffTypeRational, 2,
                     kWhiteXyOffset, little_endian);
  write_offset_entry(bytes, kIfdOffset, 14, 50829, kTiffTypeLong, 4,
                     kActiveOffset, little_endian);
  write_offset_entry(bytes, kIfdOffset, 15, 50721,
                     kTiffTypeSignedRational, 9, kMatrix1Offset,
                     little_endian);
  write_offset_entry(bytes, kIfdOffset, 16, 50722,
                     kTiffTypeSignedRational, 9, kMatrix2Offset,
                     little_endian);
  write_short_entry(bytes, kIfdOffset, 17, 50778, 17, little_endian);
  write_short_entry(bytes, kIfdOffset, 18, 50779, 21, little_endian);
  write_offset_entry(bytes, kIfdOffset, 19, 50723,
                     kTiffTypeSignedRational, 9, kCalibration1Offset,
                     little_endian);
  write_offset_entry(bytes, kIfdOffset, 20, 50724,
                     kTiffTypeSignedRational, 9, kCalibration2Offset,
                     little_endian);
  write_u32(bytes, 262, 0, little_endian);

  for (uint32_t index = 0; index < 4u; index++) {
    write_u16(bytes, kBlackOffset + index * 2u, 64, little_endian);
  }
  write_u32(bytes, kWhiteXyOffset, 3457, little_endian);
  write_u32(bytes, kWhiteXyOffset + 4u, 10000, little_endian);
  write_u32(bytes, kWhiteXyOffset + 8u, 3585, little_endian);
  write_u32(bytes, kWhiteXyOffset + 12u, 10000, little_endian);
  write_u32(bytes, kActiveOffset, 8, little_endian);
  write_u32(bytes, kActiveOffset + 4u, 8, little_endian);
  write_u32(bytes, kActiveOffset + 8u, 3992, little_endian);
  write_u32(bytes, kActiveOffset + 12u, 5992, little_endian);

  for (uint32_t index = 0; index < 9u; index++) {
    const int diagonal = index == 0u || index == 4u || index == 8u;
    write_signed_rational(bytes, kMatrix1Offset + index * 8u,
                          diagonal ? 1 : 0, 1, little_endian);
    write_signed_rational(bytes, kMatrix2Offset + index * 8u,
                          index == 0u ? 2 : (diagonal ? 1 : 0),
                          1, little_endian);
    write_signed_rational(bytes, kCalibration1Offset + index * 8u,
                          index == 0u ? 2 : (diagonal ? 1 : 0),
                          1, little_endian);
    write_signed_rational(bytes, kCalibration2Offset + index * 8u,
                          index == 8u ? 1 : (diagonal ? 1 : 0),
                          index == 8u ? 2 : 1, little_endian);
  }
}

static void build_triple_color_dng(uint8_t* bytes,
                                   int use_as_shot_white_xy) {
  enum {
    kIfdOffset = 8,
    kEntryCount = 22,
    kBlackOffset = 278,
    kNeutralOffset = 286,
    kActiveOffset = 310,
    kMatrix1Offset = 326,
    kMatrix2Offset = 398,
    kMatrix3Offset = 470,
    kIlluminant3DataOffset = 542,
    kFileLength = 560,
  };
  const int little_endian = 1;
  memset(bytes, 0, kFileLength);
  write_tiff_header(bytes, kIfdOffset, little_endian);
  write_u16(bytes, kIfdOffset, kEntryCount, little_endian);
  write_long_entry(bytes, kIfdOffset, 0, 254, 1, 0, little_endian);
  write_long_entry(bytes, kIfdOffset, 1, 256, 1, 6000, little_endian);
  write_long_entry(bytes, kIfdOffset, 2, 257, 1, 4000, little_endian);
  write_short_entry(bytes, kIfdOffset, 3, 258, 16, little_endian);
  write_short_entry(bytes, kIfdOffset, 4, 262, 32803,
                    little_endian);
  write_short_entry(bytes, kIfdOffset, 5, 274, 1, little_endian);
  write_short_entry(bytes, kIfdOffset, 6, 277, 1, little_endian);
  write_short_pair_entry(bytes, kIfdOffset, 7, 33421, 2, 2,
                         little_endian);
  write_byte_four_entry(bytes, kIfdOffset, 8, 33422, 0, 1, 1, 2,
                        little_endian);
  write_byte_four_entry(bytes, kIfdOffset, 9, 50706, 1, 6, 0, 0,
                        little_endian);
  write_short_pair_entry(bytes, kIfdOffset, 10, 50713, 2, 2,
                         little_endian);
  write_offset_entry(bytes, kIfdOffset, 11, 50714, kTiffTypeShort, 4,
                     kBlackOffset, little_endian);
  write_long_entry(bytes, kIfdOffset, 12, 50717, 1, 16383,
                   little_endian);
  write_offset_entry(bytes, kIfdOffset, 13,
                     use_as_shot_white_xy ? 50729 : 50728,
                     kTiffTypeRational,
                     use_as_shot_white_xy ? 2 : 3,
                     kNeutralOffset, little_endian);
  write_offset_entry(bytes, kIfdOffset, 14, 50829, kTiffTypeLong, 4,
                     kActiveOffset, little_endian);
  write_offset_entry(bytes, kIfdOffset, 15, 50721,
                     kTiffTypeSignedRational, 9,
                     kMatrix1Offset, little_endian);
  write_offset_entry(bytes, kIfdOffset, 16, 50722,
                     kTiffTypeSignedRational, 9,
                     kMatrix2Offset, little_endian);
  write_offset_entry(bytes, kIfdOffset, 17, 52531,
                     kTiffTypeSignedRational, 9,
                     kMatrix3Offset, little_endian);
  write_short_entry(bytes, kIfdOffset, 18, 50778, 17,
                    little_endian);
  write_short_entry(bytes, kIfdOffset, 19, 50779, 21,
                    little_endian);
  write_short_entry(bytes, kIfdOffset, 20, 52529, 255,
                    little_endian);
  write_offset_entry(bytes, kIfdOffset, 21, 52535,
                     kTiffTypeUndefined, 18,
                     kIlluminant3DataOffset, little_endian);
  write_u32(bytes, 274, 0, little_endian);

  for (uint32_t index = 0; index < 4u; index++) {
    write_u16(bytes, kBlackOffset + index * 2u, 64, little_endian);
  }
  if (use_as_shot_white_xy) {
    write_u32(bytes, kNeutralOffset, 38, little_endian);
    write_u32(bytes, kNeutralOffset + 4u, 100, little_endian);
    write_u32(bytes, kNeutralOffset + 8u, 30, little_endian);
    write_u32(bytes, kNeutralOffset + 12u, 100, little_endian);
  } else {
    write_u32(bytes, kNeutralOffset, 1, little_endian);
    write_u32(bytes, kNeutralOffset + 4u, 2, little_endian);
    write_u32(bytes, kNeutralOffset + 8u, 1, little_endian);
    write_u32(bytes, kNeutralOffset + 12u, 1, little_endian);
    write_u32(bytes, kNeutralOffset + 16u, 2, little_endian);
    write_u32(bytes, kNeutralOffset + 20u, 3, little_endian);
  }
  write_u32(bytes, kActiveOffset, 8, little_endian);
  write_u32(bytes, kActiveOffset + 4u, 8, little_endian);
  write_u32(bytes, kActiveOffset + 8u, 3992, little_endian);
  write_u32(bytes, kActiveOffset + 12u, 5992, little_endian);
  for (uint32_t index = 0; index < 9u; index++) {
    const int diagonal = index == 0u || index == 4u || index == 8u;
    write_signed_rational(bytes, kMatrix1Offset + index * 8u,
                          diagonal ? 1 : 0, 1, little_endian);
    write_signed_rational(bytes, kMatrix2Offset + index * 8u,
                          index == 0u ? 2 : (diagonal ? 1 : 0),
                          1, little_endian);
    write_signed_rational(bytes, kMatrix3Offset + index * 8u,
                          index == 0u ? 3 : (diagonal ? 1 : 0),
                          1, little_endian);
  }
  write_illuminant_xy_data(bytes, kIlluminant3DataOffset,
                           38, 100, 30, 100, little_endian);
}

static void build_triple_forward_matrix_dng(uint8_t* bytes,
                                            int omit_forward_3) {
  enum {
    kIfdOffset = 8,
    kForward1Offset = 560,
    kForward2Offset = 632,
    kForward3Offset = 704,
  };
  build_triple_color_dng(bytes, 0);

  /* Replace optional BlackLevel / AsShotNeutral / ActiveArea entries. */
  write_offset_entry(bytes, kIfdOffset, 11, 50964,
                     kTiffTypeSignedRational, 9, kForward1Offset, 1);
  write_offset_entry(bytes, kIfdOffset, 13, 50965,
                     kTiffTypeSignedRational, 9, kForward2Offset, 1);
  if (!omit_forward_3) {
    write_offset_entry(bytes, kIfdOffset, 14, 52532,
                       kTiffTypeSignedRational, 9, kForward3Offset, 1);
  }

  for (uint32_t index = 0; index < 9u; index++) {
    const int32_t f1 = index == 0u ? 9 :
        (index == 4u ? 10 : (index == 8u ? 8 : 0));
    const int32_t f2 = index == 0u ? 11 :
        (index == 4u ? 10 : (index == 8u ? 12 : 0));
    const int32_t f3 = index == 0u ? 10 :
        (index == 4u ? 9 : (index == 8u ? 11 : 0));
    write_signed_rational(bytes, kForward1Offset + index * 8u, f1, 10, 1);
    write_signed_rational(bytes, kForward2Offset + index * 8u, f2, 10, 1);
    write_signed_rational(bytes, kForward3Offset + index * 8u, f3, 10, 1);
  }
}

static void build_analog_balance_dng(uint8_t* bytes,
                                     uint32_t red_numerator) {
  enum {
    kIfdOffset = 8,
    kAnalogBalanceOffset = kMinimalFileLength,
  };
  const int little_endian = 1;
  memset(bytes, 0, kAnalogBalanceFileLength);
  build_minimal_dng(bytes, little_endian, kMinimalActiveOffset);
  write_offset_entry(bytes, kIfdOffset, 5, 50727, kTiffTypeRational, 3,
                     kAnalogBalanceOffset, little_endian);
  write_u32(bytes, kAnalogBalanceOffset, red_numerator, little_endian);
  write_u32(bytes, kAnalogBalanceOffset + 4u, 1, little_endian);
  write_u32(bytes, kAnalogBalanceOffset + 8u, 1, little_endian);
  write_u32(bytes, kAnalogBalanceOffset + 12u, 1, little_endian);
  write_u32(bytes, kAnalogBalanceOffset + 16u, 1, little_endian);
  write_u32(bytes, kAnalogBalanceOffset + 20u, 2, little_endian);
}

static void build_camera_calibration_dng(uint8_t* bytes,
                                         uint8_t profile_signature,
                                         uint8_t profile_terminator) {
  enum {
    kIfdOffset = 8,
    kCalibrationOffset = kMinimalFileLength,
  };
  const int little_endian = 1;
  memset(bytes, 0, kCameraCalibrationFileLength);
  build_minimal_dng(bytes, little_endian, kMinimalActiveOffset);
  write_inline_signature(bytes, kIfdOffset, 4, 50931, 'x', 0,
                         little_endian);
  write_offset_entry(bytes, kIfdOffset, 5, 50724,
                     kTiffTypeSignedRational, 9, kCalibrationOffset,
                     little_endian);
  write_inline_signature(bytes, kIfdOffset, 6, 50932,
                         profile_signature, profile_terminator,
                         little_endian);
  for (uint32_t index = 0; index < 9; index++) {
    const int32_t numerator =
        index == 0u ? 2 : (index == 4u ? 1 : (index == 8u ? 1 : 0));
    const int32_t denominator = index == 8u ? 2 : 1;
    write_signed_rational(bytes, kCalibrationOffset + index * 8u,
                          numerator, denominator, little_endian);
  }
}

static void build_external_camera_calibration_dng(
    uint8_t* bytes,
    uint16_t profile_signature_type,
    uint32_t signature_count,
    uint32_t profile_signature_offset) {
  enum {
    kIfdOffset = 8,
    kCalibrationOffset = kMinimalFileLength,
  };
  const int little_endian = 1;
  memset(bytes, 0, kExternalCalibrationFileLength);
  build_camera_calibration_dng(bytes, 'x', 0u);

  /* Exercise the slot-1 path instead of the slot-2 path. */
  write_offset_entry(bytes, kIfdOffset, 15, 50721,
                     kTiffTypeSignedRational, 9,
                     kMinimalColorMatrixOffset, little_endian);
  write_short_entry(bytes, kIfdOffset, 16, 50778, 21,
                    little_endian);
  write_offset_entry(bytes, kIfdOffset, 5, 50723,
                     kTiffTypeSignedRational, 9, kCalibrationOffset,
                     little_endian);

  write_offset_entry(bytes, kIfdOffset, 4, 50931, kTiffTypeAscii,
                     signature_count, kExternalCameraSignatureOffset,
                     little_endian);
  write_offset_entry(bytes, kIfdOffset, 6, 50932,
                     profile_signature_type, signature_count,
                     profile_signature_offset, little_endian);
  memcpy(bytes + kExternalCameraSignatureOffset, "calib", 6u);
  memcpy(bytes + kExternalProfileSignatureOffset, "calib", 6u);
}

static void build_sub_ifd_dng(uint8_t* bytes) {
  enum {
    kIfdZeroOffset = 8,
    kRawIfdOffset = 50,
    kRawEntryCount = 13,
    kBlackOffset = 212,
    kNeutralOffset = 220,
    kActiveOffset = 244,
  };
  const int little_endian = 1;
  memset(bytes, 0, 260);
  write_tiff_header(bytes, kIfdZeroOffset, little_endian);
  write_u16(bytes, kIfdZeroOffset, 3, little_endian);
  write_short_entry(bytes, kIfdZeroOffset, 0, 274, 6,
                    little_endian);
  write_long_entry(bytes, kIfdZeroOffset, 1, 330, 1,
                   kRawIfdOffset, little_endian);
  write_byte_four_entry(bytes, kIfdZeroOffset, 2, 50706, 1, 4, 0, 0,
                        little_endian);
  write_u32(bytes, 46, 0, little_endian);

  write_u16(bytes, kRawIfdOffset, kRawEntryCount, little_endian);
  write_long_entry(bytes, kRawIfdOffset, 0, 254, 1, 0,
                   little_endian);
  write_long_entry(bytes, kRawIfdOffset, 1, 256, 1, 6000,
                   little_endian);
  write_long_entry(bytes, kRawIfdOffset, 2, 257, 1, 4000,
                   little_endian);
  write_short_entry(bytes, kRawIfdOffset, 3, 258, 16,
                    little_endian);
  write_short_entry(bytes, kRawIfdOffset, 4, 262, 32803,
                    little_endian);
  write_short_entry(bytes, kRawIfdOffset, 5, 277, 1,
                    little_endian);
  write_short_pair_entry(bytes, kRawIfdOffset, 6, 33421, 2, 2,
                         little_endian);
  write_byte_four_entry(bytes, kRawIfdOffset, 7, 33422, 0, 1, 1, 2,
                        little_endian);
  write_short_pair_entry(bytes, kRawIfdOffset, 8, 50713, 2, 2,
                         little_endian);
  write_offset_entry(bytes, kRawIfdOffset, 9, 50714,
                     kTiffTypeShort, 4, kBlackOffset, little_endian);
  write_long_entry(bytes, kRawIfdOffset, 10, 50717, 1, 16383,
                   little_endian);
  write_offset_entry(bytes, kRawIfdOffset, 11, 50728,
                     kTiffTypeRational, 3, kNeutralOffset,
                     little_endian);
  write_offset_entry(bytes, kRawIfdOffset, 12, 50829, kTiffTypeLong,
                     4, kActiveOffset, little_endian);
  write_u32(bytes, 208, 0, little_endian);

  for (uint32_t index = 0; index < 4; index++) {
    write_u16(bytes, kBlackOffset + index * 2u, 64, little_endian);
  }
  write_u32(bytes, kNeutralOffset, 1, little_endian);
  write_u32(bytes, kNeutralOffset + 4u, 2, little_endian);
  write_u32(bytes, kNeutralOffset + 8u, 1, little_endian);
  write_u32(bytes, kNeutralOffset + 12u, 1, little_endian);
  write_u32(bytes, kNeutralOffset + 16u, 2, little_endian);
  write_u32(bytes, kNeutralOffset + 20u, 3, little_endian);
  write_u32(bytes, kActiveOffset, 8, little_endian);
  write_u32(bytes, kActiveOffset + 4u, 8, little_endian);
  write_u32(bytes, kActiveOffset + 8u, 3992, little_endian);
  write_u32(bytes, kActiveOffset + 12u, 5992, little_endian);
}

static void build_ifd_chain_over_limit(uint8_t* bytes) {
  enum {
    kIfdCount = 17,
    kFirstIfdOffset = 8,
    kIfdBytes = 6,
  };
  const int little_endian = 1;
  memset(bytes, 0, kFirstIfdOffset + kIfdCount * kIfdBytes);
  write_tiff_header(bytes, kFirstIfdOffset, little_endian);
  for (uint32_t index = 0; index < kIfdCount; index++) {
    const uint32_t ifd_offset =
        kFirstIfdOffset + index * kIfdBytes;
    const uint32_t next_offset =
        index + 1u < kIfdCount ? ifd_offset + kIfdBytes : 0u;
    write_u16(bytes, ifd_offset, 0, little_endian);
    write_u32(bytes, ifd_offset + 2u, next_offset, little_endian);
  }
}

static int write_fixture(const char* path,
                         const uint8_t* bytes,
                         uint32_t length) {
  FILE* file = fopen(path, "wb");
  if (file == NULL) {
    return 0;
  }
  const int written = fwrite(bytes, 1, length, file) == length;
  const int closed = fclose(file) == 0;
  if (!written || !closed) {
    remove(path);
    return 0;
  }
  return 1;
}

static int probe_fixture(
    MobileStackRawDecoder* decoder,
    const char* path,
    uint32_t byte_length,
    MobileStackRawMetadataProbeResult** result_out) {
  const MobileStackRawMetadataProbeRequest request = {
      MOBILE_STACK_RAW_ABI_VERSION,
      (uint32_t)sizeof(MobileStackRawMetadataProbeRequest),
      MOBILE_STACK_RAW_FORMAT_DNG,
      0u,
      byte_length,
  };
  return mobile_stack_raw_probe_metadata(
      decoder, (const uint8_t*)path, (uint32_t)strlen(path),
      &request, result_out);
}

static int check_expected_metadata(
    const MobileStackRawMetadataProbeResult* result,
    uint32_t orientation,
    int expect_d65_matrix) {
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
  CHECK(result->orientation == orientation);
  CHECK(result->black_level_0 == 64.0f);
  CHECK(result->black_level_3 == 64.0f);
  CHECK(result->white_level == 16383.0f);
  CHECK(result->has_camera_white_balance == 1u);
  CHECK(result->camera_white_balance_0 == 2.0f);
  CHECK(result->camera_white_balance_1 == 1.0f);
  CHECK(result->camera_white_balance_3 == 1.5f);
  CHECK(result->has_d65_xyz_to_camera ==
        (uint32_t)(expect_d65_matrix ? 1 : 0));
  if (expect_d65_matrix) {
    CHECK(result->d65_xyz_to_camera_0 == 1.0f);
    CHECK(result->d65_xyz_to_camera_1 > -0.101f);
    CHECK(result->d65_xyz_to_camera_1 < -0.099f);
    CHECK(result->d65_xyz_to_camera_4 == 1.0f);
    CHECK(result->d65_xyz_to_camera_8 == 1.0f);
  }
  return 0;
}

static int check_minimal_endian(MobileStackRawDecoder* decoder,
                                int little_endian) {
  static const char little_path[] =
      "mobile_stack_raw_hardening_little.dng";
  static const char big_path[] =
      "mobile_stack_raw_hardening_big.dng";
  const char* path = little_endian ? little_path : big_path;
  uint8_t bytes[kMinimalFileLength];
  build_minimal_dng(bytes, little_endian, kMinimalActiveOffset);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));

  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(check_expected_metadata(result, 1, 1) == 0);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_color_matrix_1_d65(MobileStackRawDecoder* decoder) {
  static const char path[] =
      "mobile_stack_raw_hardening_color_matrix_1.dng";
  const int little_endian = 1;
  const uint32_t ifd_offset = 8u;
  uint8_t bytes[kMinimalFileLength];
  build_minimal_dng(bytes, little_endian, kMinimalActiveOffset);
  write_u16(bytes, entry_offset(ifd_offset, 15u), 50721,
            little_endian);
  write_u16(bytes, entry_offset(ifd_offset, 16u), 50778,
            little_endian);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));

  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(check_expected_metadata(result, 1, 1) == 0);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_color_matrix_1_standard_a_is_adapted(
    MobileStackRawDecoder* decoder) {
  static const char path[] =
      "mobile_stack_raw_hardening_color_matrix_1_tungsten.dng";
  const int little_endian = 1;
  const uint32_t ifd_offset = 8u;
  uint8_t bytes[kMinimalFileLength];
  build_minimal_dng(bytes, little_endian, kMinimalActiveOffset);
  write_u16(bytes, entry_offset(ifd_offset, 15u), 50721,
            little_endian);
  write_u16(bytes, entry_offset(ifd_offset, 16u), 50778,
            little_endian);
  write_u16(bytes, entry_offset(ifd_offset, 16u) + 8u, 17,
            little_endian);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));

  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_OK);
  CHECK(result->has_d65_xyz_to_camera == 1u);
  CHECK(isfinite(result->d65_xyz_to_camera_0));
  CHECK(isfinite(result->d65_xyz_to_camera_4));
  CHECK(isfinite(result->d65_xyz_to_camera_8));
  CHECK(result->d65_xyz_to_camera_0 > 1.1f);
  CHECK(result->d65_xyz_to_camera_8 < 0.6f);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_as_shot_white_xy(MobileStackRawDecoder* decoder) {
  static const char path[] =
      "mobile_stack_raw_hardening_as_shot_white_xy.dng";
  const int little_endian = 1;
  const uint32_t ifd_offset = 8u;
  uint8_t bytes[kMinimalFileLength];
  build_minimal_dng(bytes, little_endian, kMinimalActiveOffset);
  write_offset_entry(bytes, ifd_offset, 13, 50729, kTiffTypeRational, 2,
                     kMinimalNeutralOffset, little_endian);
  write_u32(bytes, kMinimalNeutralOffset, 3457, little_endian);
  write_u32(bytes, kMinimalNeutralOffset + 4u, 10000, little_endian);
  write_u32(bytes, kMinimalNeutralOffset + 8u, 3585, little_endian);
  write_u32(bytes, kMinimalNeutralOffset + 12u, 10000, little_endian);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));

  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->has_d65_xyz_to_camera == 1u);
  CHECK(result->has_camera_white_balance == 1u);
  const double d65[3] = {0.3127 / 0.3290, 1.0,
                         (1.0 - 0.3127 - 0.3290) / 0.3290};
  const double red = result->d65_xyz_to_camera_0 * d65[0] +
                     result->d65_xyz_to_camera_1 * d65[1] +
                     result->d65_xyz_to_camera_2 * d65[2];
  const double green = result->d65_xyz_to_camera_3 * d65[0] +
                       result->d65_xyz_to_camera_4 * d65[1] +
                       result->d65_xyz_to_camera_5 * d65[2];
  const double blue = result->d65_xyz_to_camera_6 * d65[0] +
                      result->d65_xyz_to_camera_7 * d65[1] +
                      result->d65_xyz_to_camera_8 * d65[2];
  double maximum = red > green ? red : green;
  if (blue > maximum) maximum = blue;
  CHECK(maximum > 0.0);
  CHECK(fabs(result->camera_white_balance_0 - maximum / red) <
        0.00001);
  CHECK(fabs(result->camera_white_balance_1 - maximum / green) <
        0.00001);
  CHECK(fabs(result->camera_white_balance_3 - maximum / blue) <
        0.00001);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_invalid_as_shot_white_xy_rejection(
    MobileStackRawDecoder* decoder) {
  static const char path[] =
      "mobile_stack_raw_hardening_invalid_as_shot_white_xy.dng";
  const int little_endian = 1;
  const uint32_t ifd_offset = 8u;
  uint8_t bytes[kMinimalFileLength];
  build_minimal_dng(bytes, little_endian, kMinimalActiveOffset);
  write_offset_entry(bytes, ifd_offset, 13, 50729, kTiffTypeRational, 2,
                     kMinimalNeutralOffset, little_endian);
  write_u32(bytes, kMinimalNeutralOffset, 1, little_endian);
  write_u32(bytes, kMinimalNeutralOffset + 4u, 2, little_endian);
  write_u32(bytes, kMinimalNeutralOffset + 8u, 1, little_endian);
  write_u32(bytes, kMinimalNeutralOffset + 12u, 2, little_endian);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_CORRUPT_DATA);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_as_shot_neutral_precedes_white_xy(
    MobileStackRawDecoder* decoder) {
  enum { kWhiteOffset = kDualColorFileLength };
  static const char path[] =
      "mobile_stack_raw_hardening_neutral_precedes_white_xy.dng";
  const int little_endian = 1;
  const uint32_t ifd_offset = 8u;
  uint8_t bytes[kDualColorFileLength + 16u];
  memset(bytes, 0, sizeof(bytes));
  build_dual_color_dng(bytes, 17, 21);
  write_offset_entry(bytes, ifd_offset, 5, 50729, kTiffTypeRational, 2,
                     kWhiteOffset, little_endian);
  write_u32(bytes, kWhiteOffset, 3127, little_endian);
  write_u32(bytes, kWhiteOffset + 4u, 10000, little_endian);
  write_u32(bytes, kWhiteOffset + 8u, 3290, little_endian);
  write_u32(bytes, kWhiteOffset + 12u, 10000, little_endian);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  const double d65[3] = {0.3127 / 0.3290, 1.0,
                         (1.0 - 0.3127 - 0.3290) / 0.3290};
  const double red = result->d65_xyz_to_camera_0 * d65[0] +
                     result->d65_xyz_to_camera_1 * d65[1] +
                     result->d65_xyz_to_camera_2 * d65[2];
  const double green = result->d65_xyz_to_camera_3 * d65[0] +
                       result->d65_xyz_to_camera_4 * d65[1] +
                       result->d65_xyz_to_camera_5 * d65[2];
  const double blue = result->d65_xyz_to_camera_6 * d65[0] +
                      result->d65_xyz_to_camera_7 * d65[1] +
                      result->d65_xyz_to_camera_8 * d65[2];
  CHECK(green > 0.0);
  CHECK(fabs(red / green - 0.5) < 0.00001);
  CHECK(fabs(blue / green - 2.0 / 3.0) < 0.00001);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_dual_color_selection(MobileStackRawDecoder* decoder,
                                      uint16_t illuminant_2,
                                      float expected_matrix_0,
                                      const char* path) {
  uint8_t bytes[kDualColorFileLength];
  build_dual_color_dng(bytes, 21, illuminant_2);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->has_d65_xyz_to_camera == 1u);
  if (illuminant_2 == 21u) {
    CHECK(result->d65_xyz_to_camera_0 == expected_matrix_0);
    CHECK(result->d65_xyz_to_camera_4 == 1.0f);
    CHECK(result->d65_xyz_to_camera_8 == 1.0f);
  } else {
    const double d65[3] = {0.3127 / 0.3290, 1.0,
                           (1.0 - 0.3127 - 0.3290) / 0.3290};
    const double red = result->d65_xyz_to_camera_0 * d65[0] +
                       result->d65_xyz_to_camera_1 * d65[1] +
                       result->d65_xyz_to_camera_2 * d65[2];
    const double green = result->d65_xyz_to_camera_3 * d65[0] +
                         result->d65_xyz_to_camera_4 * d65[1] +
                         result->d65_xyz_to_camera_5 * d65[2];
    const double blue = result->d65_xyz_to_camera_6 * d65[0] +
                        result->d65_xyz_to_camera_7 * d65[1] +
                        result->d65_xyz_to_camera_8 * d65[2];
    CHECK(green > 0.0);
    CHECK(fabs(red / green - 0.5) < 0.00001);
    CHECK(fabs(blue / green - 2.0 / 3.0) < 0.00001);
    CHECK(result->d65_xyz_to_camera_0 != expected_matrix_0);
  }
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_d50_color_selection(MobileStackRawDecoder* decoder,
                                     uint16_t illuminant_1,
                                     uint16_t illuminant_2,
                                     float first_row_scale,
                                     const char* path) {
  uint8_t bytes[kDualColorFileLength];
  build_dual_color_dng(bytes, illuminant_1, illuminant_2);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->has_d65_xyz_to_camera == 1u);
  const double d65[3] = {0.3127 / 0.3290, 1.0,
                         (1.0 - 0.3127 - 0.3290) / 0.3290};
  const double red = result->d65_xyz_to_camera_0 * d65[0] +
                     result->d65_xyz_to_camera_1 * d65[1] +
                     result->d65_xyz_to_camera_2 * d65[2];
  const double green = result->d65_xyz_to_camera_3 * d65[0] +
                       result->d65_xyz_to_camera_4 * d65[1] +
                       result->d65_xyz_to_camera_5 * d65[2];
  const double blue = result->d65_xyz_to_camera_6 * d65[0] +
                      result->d65_xyz_to_camera_7 * d65[1] +
                      result->d65_xyz_to_camera_8 * d65[2];
  CHECK(green > 0.0);
  CHECK(fabs(red / green - 0.5) < 0.00001);
  CHECK(fabs(blue / green - 2.0 / 3.0) < 0.00001);
  CHECK(fabs(result->d65_xyz_to_camera_0 - first_row_scale) > 0.01f);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_dual_calibration_interpolation_order(
    MobileStackRawDecoder* decoder) {
  enum { kFileLength = 594 };
  static const char path[] =
      "mobile_stack_raw_hardening_dual_calibration_order.dng";
  uint8_t bytes[kFileLength];
  build_dual_calibrated_color_dng(bytes);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->has_d65_xyz_to_camera == 1u);
  // DNG Chapter 6 interpolates ColorMatrix and CameraCalibration
  // separately before composing AB * CC * CM.  For this fixture that gives
  // matrix[0] ~= 2.2837522 after D50->D65 adaptation.  The old, incorrect
  // interpolate-after-multiplication path produced ~= 2.0958595.
  CHECK(fabs(result->d65_xyz_to_camera_0 - 2.2837522f) < 0.00001f);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_other_illuminant_xy_dual(
    MobileStackRawDecoder* decoder) {
  enum {
    kIlluminant1Offset = kDualColorFileLength,
    kIlluminant2Offset = kDualColorFileLength + 18,
    kFileLength = kDualColorFileLength + 36,
  };
  static const char path[] =
      "mobile_stack_raw_hardening_other_illuminant_xy.dng";
  const int little_endian = 1;
  const uint32_t ifd_offset = 8u;
  uint8_t bytes[kFileLength];
  memset(bytes, 0, sizeof(bytes));
  build_dual_color_dng(bytes, 255, 255);
  write_offset_entry(bytes, ifd_offset, 5, 52533, kTiffTypeUndefined,
                     18, kIlluminant1Offset, little_endian);
  write_offset_entry(bytes, ifd_offset, 6, 52534, kTiffTypeUndefined,
                     18, kIlluminant2Offset, little_endian);
  write_illuminant_xy_data(bytes, kIlluminant1Offset, 4476, 10000,
                           4074, 10000, little_endian);
  write_illuminant_xy_data(bytes, kIlluminant2Offset, 3127, 10000,
                           3290, 10000, little_endian);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->has_d65_xyz_to_camera == 1u);
  const double d65[3] = {0.3127 / 0.3290, 1.0,
                         (1.0 - 0.3127 - 0.3290) / 0.3290};
  const double red = result->d65_xyz_to_camera_0 * d65[0] +
                     result->d65_xyz_to_camera_1 * d65[1] +
                     result->d65_xyz_to_camera_2 * d65[2];
  const double green = result->d65_xyz_to_camera_3 * d65[0] +
                       result->d65_xyz_to_camera_4 * d65[1] +
                       result->d65_xyz_to_camera_5 * d65[2];
  const double blue = result->d65_xyz_to_camera_6 * d65[0] +
                      result->d65_xyz_to_camera_7 * d65[1] +
                      result->d65_xyz_to_camera_8 * d65[2];
  CHECK(green > 0.0);
  CHECK(fabs(red / green - 0.5) < 0.00001);
  CHECK(fabs(blue / green - 2.0 / 3.0) < 0.00001);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_other_illuminant_missing_data_rejection(
    MobileStackRawDecoder* decoder) {
  static const char path[] =
      "mobile_stack_raw_hardening_other_missing_data.dng";
  uint8_t bytes[kDualColorFileLength];
  build_dual_color_dng(bytes, 255, 255);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_CORRUPT_DATA);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_spectral_illuminant_equal_energy(
    MobileStackRawDecoder* decoder) {
  enum {
    kIlluminant1Offset = kDualColorFileLength,
    kSpectrumBytes = 38,
    kIlluminant2Offset = kDualColorFileLength + kSpectrumBytes,
    kFileLength = kDualColorFileLength + kSpectrumBytes + 18,
  };
  static const char path[] =
      "mobile_stack_raw_hardening_spectral_illuminant.dng";
  const int little_endian = 1;
  const uint32_t ifd_offset = 8u;
  uint8_t bytes[kFileLength];
  memset(bytes, 0, sizeof(bytes));
  build_dual_color_dng(bytes, 255, 255);
  write_offset_entry(bytes, ifd_offset, 5, 52533, kTiffTypeUndefined,
                     kSpectrumBytes, kIlluminant1Offset, little_endian);
  write_offset_entry(bytes, ifd_offset, 6, 52534, kTiffTypeUndefined,
                     18, kIlluminant2Offset, little_endian);
  write_illuminant_spectrum_data(bytes, kIlluminant1Offset, 2u,
                                 360u, 470u, 1u, little_endian);
  write_illuminant_xy_data(bytes, kIlluminant2Offset, 3127, 10000,
                           3290, 10000, little_endian);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->has_d65_xyz_to_camera == 1u);
  CHECK(result->d65_xyz_to_camera_0 > 1.0f);
  CHECK(result->d65_xyz_to_camera_0 < 2.0f);
  const double d65[3] = {0.3127 / 0.3290, 1.0,
                         (1.0 - 0.3127 - 0.3290) / 0.3290};
  const double red = result->d65_xyz_to_camera_0 * d65[0] +
                     result->d65_xyz_to_camera_1 * d65[1] +
                     result->d65_xyz_to_camera_2 * d65[2];
  const double green = result->d65_xyz_to_camera_3 * d65[0] +
                       result->d65_xyz_to_camera_4 * d65[1] +
                       result->d65_xyz_to_camera_5 * d65[2];
  const double blue = result->d65_xyz_to_camera_6 * d65[0] +
                      result->d65_xyz_to_camera_7 * d65[1] +
                      result->d65_xyz_to_camera_8 * d65[2];
  CHECK(green > 0.0);
  CHECK(fabs(red / green - 0.5) < 0.00001);
  CHECK(fabs(blue / green - 2.0 / 3.0) < 0.00001);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_spectral_illuminant_bounds_rejection(
    MobileStackRawDecoder* decoder) {
  enum {
    kIlluminant1Offset = kDualColorFileLength,
    kSpectrumBytes = 38,
    kIlluminant2Offset = kDualColorFileLength + kSpectrumBytes,
    kFileLength = kDualColorFileLength + kSpectrumBytes + 18,
  };
  static const char path[] =
      "mobile_stack_raw_hardening_bad_spectral_illuminant.dng";
  const int little_endian = 1;
  const uint32_t ifd_offset = 8u;
  uint8_t bytes[kFileLength];
  memset(bytes, 0, sizeof(bytes));
  build_dual_color_dng(bytes, 255, 255);
  write_offset_entry(bytes, ifd_offset, 5, 52533, kTiffTypeUndefined,
                     kSpectrumBytes, kIlluminant1Offset, little_endian);
  write_offset_entry(bytes, ifd_offset, 6, 52534, kTiffTypeUndefined,
                     18, kIlluminant2Offset, little_endian);
  write_illuminant_spectrum_data(bytes, kIlluminant1Offset, 2u,
                                 360u, 470u, 1u, little_endian);
  write_illuminant_xy_data(bytes, kIlluminant2Offset, 3127, 10000,
                           3290, 10000, little_endian);

  write_u32(bytes, kIlluminant1Offset + 2u, 1u, little_endian);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);

  write_u32(bytes, kIlluminant1Offset + 2u, 1001u, little_endian);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);

  write_u32(bytes, kIlluminant1Offset + 2u, 2u, little_endian);
  write_u32(bytes, kIlluminant1Offset + 14u, 0u, little_endian);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);

  write_u32(bytes, kIlluminant1Offset + 14u, 470u, little_endian);
  write_u32(bytes, kIlluminant1Offset + 22u, 0u, little_endian);
  write_u32(bytes, kIlluminant1Offset + 30u, 0u, little_endian);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_triple_illuminant_explicit_white(
    MobileStackRawDecoder* decoder) {
  enum { kFileLength = 560 };
  static const char path[] =
      "mobile_stack_raw_hardening_triple_explicit_white.dng";
  uint8_t bytes[kFileLength];
  build_triple_color_dng(bytes, 1);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->has_d65_xyz_to_camera == 1u);
  CHECK(result->has_camera_white_balance == 1u);
  CHECK(fabs(result->camera_white_balance_0 - 1.0) < 0.00001);
  CHECK(fabs(result->camera_white_balance_1 - 3.8) < 0.00002);
  CHECK(fabs(result->camera_white_balance_3 - 3.5625) < 0.00002);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_triple_illuminant_neutral_iteration(
    MobileStackRawDecoder* decoder) {
  enum { kFileLength = 560 };
  static const char path[] =
      "mobile_stack_raw_hardening_triple_neutral.dng";
  uint8_t bytes[kFileLength];
  build_triple_color_dng(bytes, 0);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->has_d65_xyz_to_camera == 1u);
  const double d65[3] = {0.3127 / 0.3290, 1.0,
                         (1.0 - 0.3127 - 0.3290) / 0.3290};
  const double red = result->d65_xyz_to_camera_0 * d65[0] +
                     result->d65_xyz_to_camera_1 * d65[1] +
                     result->d65_xyz_to_camera_2 * d65[2];
  const double green = result->d65_xyz_to_camera_3 * d65[0] +
                       result->d65_xyz_to_camera_4 * d65[1] +
                       result->d65_xyz_to_camera_5 * d65[2];
  const double blue = result->d65_xyz_to_camera_6 * d65[0] +
                      result->d65_xyz_to_camera_7 * d65[1] +
                      result->d65_xyz_to_camera_8 * d65[2];
  CHECK(green > 0.0);
  CHECK(fabs(red / green - 0.5) < 0.00001);
  CHECK(fabs(blue / green - 2.0 / 3.0) < 0.00001);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_triple_illuminant_schema_rejection(
    MobileStackRawDecoder* decoder) {
  enum { kFileLength = 560, kIfdOffset = 8 };
  static const char path[] =
      "mobile_stack_raw_hardening_bad_triple_profile.dng";
  const int little_endian = 1;
  uint8_t bytes[kFileLength];
  build_triple_color_dng(bytes, 1);
  write_short_entry(bytes, kIfdOffset, 20, 52529, 21,
                    little_endian);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);

  build_triple_color_dng(bytes, 1);
  write_u16(bytes, entry_offset(kIfdOffset, 17), 65000,
            little_endian);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_malformed_illuminant_schema_rejection(
    MobileStackRawDecoder* decoder) {
  static const char path[] =
      "mobile_stack_raw_hardening_bad_illuminant_type.dng";
  const int little_endian = 1;
  const uint32_t ifd_offset = 8u;
  uint8_t bytes[kMinimalFileLength];
  build_minimal_dng(bytes, little_endian, kMinimalActiveOffset);
  write_u16(bytes, entry_offset(ifd_offset, 16u) + 2u,
            kTiffTypeLong, little_endian);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_CORRUPT_DATA);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_baseline_exposure_tail(MobileStackRawDecoder* decoder) {
  enum {
    kExposureOffset = kMinimalFileLength,
    kFileLength = kMinimalFileLength + 8,
  };
  static const char path[] =
      "mobile_stack_raw_hardening_baseline_exposure.dng";
  const int little_endian = 1;
  const uint32_t ifd_offset = 8u;
  uint8_t bytes[kFileLength];
  memset(bytes, 0, sizeof(bytes));
  build_minimal_dng(bytes, little_endian, kMinimalActiveOffset);
  write_offset_entry(bytes, ifd_offset, 5, 50730,
                     kTiffTypeSignedRational, 1,
                     kExposureOffset, little_endian);
  write_signed_rational(bytes, kExposureOffset, 1, 2, little_endian);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->struct_size >= sizeof(*result));
  CHECK(result->has_baseline_exposure == 1u);
  CHECK(fabs(result->baseline_exposure - 0.5) < 0.000001);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_profile_dynamic_range(MobileStackRawDecoder* decoder,
                                       int little_endian) {
  enum {
    kDynamicRangeOffset = kMinimalFileLength,
    kFileLength = kMinimalFileLength + 8,
  };
  const char* path = little_endian
      ? "mobile_stack_raw_hardening_profile_dynamic_range_le.dng"
      : "mobile_stack_raw_hardening_profile_dynamic_range_be.dng";
  uint8_t bytes[kFileLength];
  memset(bytes, 0, sizeof(bytes));
  build_minimal_dng(bytes, little_endian, kMinimalActiveOffset);
  write_offset_entry(bytes, 8u, 5u, 52551u, kTiffTypeUndefined, 8u,
                     kDynamicRangeOffset, little_endian);
  write_u16(bytes, kDynamicRangeOffset, 1u, little_endian);
  write_u16(bytes, kDynamicRangeOffset + 2u, 1u, little_endian);
  write_float32(bytes, kDynamicRangeOffset + 4u, 8.0f, little_endian);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->has_profile_dynamic_range == 1u);
  CHECK(result->profile_dynamic_range == 1u);
  CHECK(fabsf(result->profile_hint_max_output_value - 8.0f) < 0.000001f);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_profile_dynamic_range_rejection(
    MobileStackRawDecoder* decoder) {
  enum {
    kDynamicRangeOffset = kMinimalFileLength,
    kFileLength = kMinimalFileLength + 8,
  };
  static const char path[] =
      "mobile_stack_raw_hardening_bad_profile_dynamic_range.dng";
  uint8_t bytes[kFileLength];
  memset(bytes, 0, sizeof(bytes));
  build_minimal_dng(bytes, 1, kMinimalActiveOffset);
  write_offset_entry(bytes, 8u, 5u, 52551u, kTiffTypeUndefined, 8u,
                     kDynamicRangeOffset, 1);
  write_u16(bytes, kDynamicRangeOffset, 1u, 1);
  write_u16(bytes, kDynamicRangeOffset + 2u, 2u, 1);
  write_float32(bytes, kDynamicRangeOffset + 4u, 1.0f, 1);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_baseline_exposure_rejection(
    MobileStackRawDecoder* decoder) {
  enum {
    kExposureOffset = kMinimalFileLength,
    kFileLength = kMinimalFileLength + 8,
  };
  static const char path[] =
      "mobile_stack_raw_hardening_bad_baseline_exposure.dng";
  const int little_endian = 1;
  const uint32_t ifd_offset = 8u;
  uint8_t bytes[kFileLength];
  memset(bytes, 0, sizeof(bytes));
  build_minimal_dng(bytes, little_endian, kMinimalActiveOffset);
  write_offset_entry(bytes, ifd_offset, 5, 50730,
                     kTiffTypeSignedRational, 1,
                     kExposureOffset, little_endian);
  write_signed_rational(bytes, kExposureOffset, 33, 1, little_endian);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_baseline_exposure_offset_tail(
    MobileStackRawDecoder* decoder) {
  enum {
    kExposureOffset = kMinimalFileLength,
    kProfileOffset = kMinimalFileLength + 8,
    kFileLength = kMinimalFileLength + 16,
  };
  static const char path[] =
      "mobile_stack_raw_hardening_baseline_exposure_offset.dng";
  uint8_t bytes[kFileLength];
  memset(bytes, 0, sizeof(bytes));
  build_minimal_dng(bytes, 1, kMinimalActiveOffset);
  write_offset_entry(bytes, 8u, 5u, 50730u,
                     kTiffTypeSignedRational, 1u, kExposureOffset, 1);
  write_offset_entry(bytes, 8u, 6u, 51109u,
                     kTiffTypeSignedRational, 1u, kProfileOffset, 1);
  write_signed_rational(bytes, kExposureOffset, 1, 2, 1);
  write_signed_rational(bytes, kProfileOffset, -1, 4, 1);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->has_baseline_exposure == 1u);
  CHECK(fabsf(result->baseline_exposure - 0.5f) < 0.000001f);
  CHECK(result->has_baseline_exposure_offset == 1u);
  CHECK(fabsf(result->baseline_exposure_offset + 0.25f) < 0.000001f);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_baseline_exposure_offset_rejection(
    MobileStackRawDecoder* decoder) {
  enum {
    kOffset = kMinimalFileLength,
    kFileLength = kMinimalFileLength + 8,
  };
  static const char path[] =
      "mobile_stack_raw_hardening_bad_baseline_exposure_offset.dng";
  uint8_t bytes[kFileLength];
  memset(bytes, 0, sizeof(bytes));
  build_minimal_dng(bytes, 1, kMinimalActiveOffset);
  write_offset_entry(bytes, 8u, 5u, 51109u,
                     kTiffTypeSignedRational, 1u, kOffset, 1);
  write_signed_rational(bytes, kOffset, 33, 1, 1);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_analog_balance_composition(
    MobileStackRawDecoder* decoder) {
  static const char path[] =
      "mobile_stack_raw_hardening_analog_balance.dng";
  uint8_t bytes[kAnalogBalanceFileLength];
  build_analog_balance_dng(bytes, 2u);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->has_d65_xyz_to_camera == 1u);
  CHECK(result->d65_xyz_to_camera_0 == 2.0f);
  CHECK(result->d65_xyz_to_camera_1 > -0.201f);
  CHECK(result->d65_xyz_to_camera_1 < -0.199f);
  CHECK(result->d65_xyz_to_camera_4 == 1.0f);
  CHECK(result->d65_xyz_to_camera_8 == 0.5f);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_nonpositive_analog_balance_rejection(
    MobileStackRawDecoder* decoder) {
  static const char path[] =
      "mobile_stack_raw_hardening_bad_analog_balance.dng";
  uint8_t bytes[kAnalogBalanceFileLength];
  build_analog_balance_dng(bytes, 0u);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_CORRUPT_DATA);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_camera_calibration_signature_selection(
    MobileStackRawDecoder* decoder,
    uint8_t profile_signature,
    float expected_matrix_0,
    float expected_matrix_1,
    float expected_matrix_8,
    const char* path) {
  uint8_t bytes[kCameraCalibrationFileLength];
  build_camera_calibration_dng(bytes, profile_signature, 0u);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->has_d65_xyz_to_camera == 1u);
  CHECK(result->d65_xyz_to_camera_0 == expected_matrix_0);
  CHECK(result->d65_xyz_to_camera_1 > expected_matrix_1 - 0.001f);
  CHECK(result->d65_xyz_to_camera_1 < expected_matrix_1 + 0.001f);
  CHECK(result->d65_xyz_to_camera_4 == 1.0f);
  CHECK(result->d65_xyz_to_camera_8 == expected_matrix_8);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_nonterminated_calibration_signature_rejection(
    MobileStackRawDecoder* decoder) {
  static const char path[] =
      "mobile_stack_raw_hardening_nonterminated_signature.dng";
  uint8_t bytes[kCameraCalibrationFileLength];
  build_camera_calibration_dng(bytes, 'x', 'z');
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_CORRUPT_DATA);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_external_camera_calibration_slot_1(
    MobileStackRawDecoder* decoder,
    uint16_t profile_signature_type,
    const char* path) {
  uint8_t bytes[kExternalCalibrationFileLength];
  build_external_camera_calibration_dng(
      bytes, profile_signature_type, 6u,
      kExternalProfileSignatureOffset);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->has_d65_xyz_to_camera == 1u);
  CHECK(result->d65_xyz_to_camera_0 == 2.0f);
  CHECK(result->d65_xyz_to_camera_1 > -0.201f);
  CHECK(result->d65_xyz_to_camera_1 < -0.199f);
  CHECK(result->d65_xyz_to_camera_4 == 1.0f);
  CHECK(result->d65_xyz_to_camera_8 == 0.5f);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_external_calibration_signature_rejection(
    MobileStackRawDecoder* decoder,
    uint32_t signature_count,
    uint32_t profile_signature_offset,
    int insert_embedded_null,
    const char* path) {
  uint8_t bytes[kExternalCalibrationFileLength];
  build_external_camera_calibration_dng(
      bytes, kTiffTypeAscii, signature_count, profile_signature_offset);
  if (insert_embedded_null) {
    bytes[kExternalCameraSignatureOffset + 2u] = 0u;
  }
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_CORRUPT_DATA);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_unsafe_composite_matrix_rejection(
    MobileStackRawDecoder* decoder,
    int ill_conditioned,
    const char* path) {
  const int little_endian = 1;
  uint8_t bytes[kCameraCalibrationFileLength];
  build_camera_calibration_dng(bytes, 'x', 0u);
  if (ill_conditioned) {
    write_signed_rational(
        bytes, kMinimalColorMatrixOffset + 8u * 8u,
        1, 2000000000, little_endian);
    write_signed_rational(
        bytes, kMinimalFileLength + 8u * 8u,
        1, 2000000000, little_endian);
  } else {
    write_signed_rational(
        bytes, kMinimalFileLength + 8u * 8u,
        0, 1, little_endian);
  }
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_CORRUPT_DATA);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_sub_ifd_metadata(MobileStackRawDecoder* decoder) {
  static const char path[] =
      "mobile_stack_raw_hardening_sub_ifd.dng";
  uint8_t bytes[260];
  build_sub_ifd_dng(bytes);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));

  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_OK);
  CHECK(check_expected_metadata(result, 6, 0) == 0);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_external_offset_rejection(
    MobileStackRawDecoder* decoder) {
  static const char path[] =
      "mobile_stack_raw_hardening_offset.dng";
  uint8_t bytes[kMinimalFileLength];
  build_minimal_dng(bytes, 1, 0xFFFFFFF0u);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));

  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_CORRUPT_DATA);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_ifd_chain_resource_limit(
    MobileStackRawDecoder* decoder) {
  enum { kFileLength = 110 };
  static const char path[] =
      "mobile_stack_raw_hardening_ifd_chain.dng";
  uint8_t bytes[kFileLength];
  build_ifd_chain_over_limit(bytes);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));

  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status =
      probe_fixture(decoder, path, sizeof(bytes), &result);
  CHECK(status == MOBILE_STACK_RAW_RESOURCE_LIMIT);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_RESOURCE_LIMIT);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_repeated_probe_release(
    MobileStackRawDecoder* decoder) {
  enum { kProbeIterations = 128 };
  static const char path[] =
      "mobile_stack_raw_hardening_repeated.dng";
  uint8_t bytes[kMinimalFileLength];
  build_minimal_dng(bytes, 0, kMinimalActiveOffset);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));

  for (uint32_t index = 0; index < kProbeIterations; index++) {
    MobileStackRawMetadataProbeResult* result = NULL;
    const int32_t status =
        probe_fixture(decoder, path, sizeof(bytes), &result);
    CHECK(status == MOBILE_STACK_RAW_OK);
    CHECK(check_expected_metadata(result, 1, 1) == 0);
    mobile_stack_raw_metadata_result_release(result);
  }
  CHECK(remove(path) == 0);
  return 0;
}

static void build_profile_tone_curve_dng(uint8_t* bytes,
                                         const float* xy,
                                         uint32_t value_count) {
  enum { kCurveOffset = kMinimalFileLength };
  memset(bytes, 0, kMinimalFileLength + 24u);
  build_minimal_dng(bytes, 1, kMinimalActiveOffset);
  write_offset_entry(bytes, 8u, 5u, 50940u, kTiffTypeFloat,
                     value_count, kCurveOffset, 1);
  const uint32_t writable_count = value_count > 6u ? 6u : value_count;
  for (uint32_t index = 0; index < writable_count; index++) {
    write_float32(bytes, kCurveOffset + index * 4u, xy[index], 1);
  }
}

static int check_profile_tone_curve(MobileStackRawDecoder* decoder) {
  enum { kFileLength = kMinimalFileLength + 24u };
  static const char path[] =
      "mobile_stack_raw_hardening_profile_tone_curve.dng";
  static const float curve[6] = {0.0f, 0.0f, 0.5f, 0.25f, 1.0f, 1.0f};
  uint8_t bytes[kFileLength];
  build_profile_tone_curve_dng(bytes, curve, 6u);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->profile_tone_curve_point_count == 3u);
  CHECK(result->profile_tone_curve_xy != NULL);
  CHECK(result->profile_tone_curve_xy[0] == 0.0f);
  CHECK(result->profile_tone_curve_xy[3] == 0.25f);
  CHECK(result->profile_tone_curve_xy[5] == 1.0f);
  mobile_stack_raw_metadata_result_release(result);

  for (uint32_t index = 0; index < 128u; index++) {
    result = NULL;
    CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
          MOBILE_STACK_RAW_OK);
    CHECK(result != NULL);
    CHECK(result->profile_tone_curve_point_count == 3u);
    mobile_stack_raw_metadata_result_release(result);
  }
  CHECK(remove(path) == 0);
  return 0;
}

static int check_profile_tone_curve_rejection(
    MobileStackRawDecoder* decoder) {
  enum { kFileLength = kMinimalFileLength + 24u };
  static const char path[] =
      "mobile_stack_raw_hardening_bad_profile_tone_curve.dng";
  static const float valid[6] = {0.0f, 0.0f, 0.5f, 0.25f, 1.0f, 1.0f};
  uint8_t bytes[kFileLength];
  MobileStackRawMetadataProbeResult* result = NULL;

  build_profile_tone_curve_dng(bytes, valid, 5u);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);

  const float duplicate_x[6] = {0.0f, 0.0f, 0.5f, 0.25f, 0.5f, 1.0f};
  build_profile_tone_curve_dng(bytes, duplicate_x, 6u);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);

  const float out_of_range[6] = {0.0f, 0.0f, 0.5f, 1.1f, 1.0f, 1.0f};
  build_profile_tone_curve_dng(bytes, out_of_range, 6u);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);

  const float bad_start[6] = {0.0f, 0.1f, 0.5f, 0.25f, 1.0f, 1.0f};
  build_profile_tone_curve_dng(bytes, bad_start, 6u);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);

  const float bad_sdr_end[6] = {0.0f, 0.0f, 0.5f, 0.25f, 0.9f, 0.9f};
  build_profile_tone_curve_dng(bytes, bad_sdr_end, 6u);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);

  build_profile_tone_curve_dng(bytes, valid, 16386u);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static void build_profile_hue_sat_map_dng(uint8_t* bytes,
                                          int skip_sat_zero) {
  enum {
    kDimsOffset = kMinimalFileLength,
    kMapOffset = kMinimalFileLength + 12u,
  };
  static const float full_map[12] = {
      0.0f, 1.0f, 1.0f, 10.0f, 1.2f, 0.9f,
      0.0f, 1.0f, 1.0f, -10.0f, 0.8f, 1.1f,
  };
  static const float skipped_map[6] = {
      10.0f, 1.2f, 0.9f, -10.0f, 0.8f, 1.1f,
  };
  memset(bytes, 0, kMinimalFileLength + 60u);
  build_minimal_dng(bytes, 1, kMinimalActiveOffset);
  write_u16(bytes, entry_offset(8u, 15u), 50721u, 1);
  write_u16(bytes, entry_offset(8u, 16u), 50778u, 1);
  write_offset_entry(bytes, 8u, 5u, 50937u, kTiffTypeLong, 3u,
                     kDimsOffset, 1);
  write_offset_entry(bytes, 8u, 6u, 50938u, kTiffTypeFloat,
                     skip_sat_zero ? 6u : 12u, kMapOffset, 1);
  write_u32(bytes, kDimsOffset, 2u, 1);
  write_u32(bytes, kDimsOffset + 4u, 2u, 1);
  write_u32(bytes, kDimsOffset + 8u, 1u, 1);
  const float* const map = skip_sat_zero ? skipped_map : full_map;
  const uint32_t count = skip_sat_zero ? 6u : 12u;
  for (uint32_t index = 0; index < count; index++) {
    write_float32(bytes, kMapOffset + index * 4u, map[index], 1);
  }
}

static void build_profile_look_table_dng(uint8_t* bytes,
                                         int skip_sat_zero,
                                         int two_dimension_tag) {
  enum {
    kDimsOffset = kMinimalFileLength,
    kMapOffset = kMinimalFileLength + 12u,
  };
  static const float full_table[12] = {
      2.0f, 1.1f, 1.0f, 20.0f, 1.2f, 0.9f,
      -2.0f, 0.9f, 1.0f, -20.0f, 0.8f, 1.1f,
  };
  static const float skipped_table[6] = {
      20.0f, 1.2f, 0.9f, -20.0f, 0.8f, 1.1f,
  };
  memset(bytes, 0, kMinimalFileLength + 60u);
  build_minimal_dng(bytes, 1, kMinimalActiveOffset);
  write_u16(bytes, entry_offset(8u, 15u), 50721u, 1);
  write_u16(bytes, entry_offset(8u, 16u), 50778u, 1);
  write_long_entry(bytes, 8u, 0u, 51108u, 1u, 1u, 1);
  write_offset_entry(bytes, 8u, 5u, 50981u, kTiffTypeLong,
                     two_dimension_tag ? 2u : 3u, kDimsOffset, 1);
  write_offset_entry(bytes, 8u, 6u, 50982u, kTiffTypeFloat,
                     skip_sat_zero ? 6u : 12u, kMapOffset, 1);
  write_u32(bytes, kDimsOffset, 2u, 1);
  write_u32(bytes, kDimsOffset + 4u, 2u, 1);
  write_u32(bytes, kDimsOffset + 8u, 1u, 1);
  const float* const table = skip_sat_zero ? skipped_table : full_table;
  const uint32_t count = skip_sat_zero ? 6u : 12u;
  for (uint32_t index = 0; index < count; index++) {
    write_float32(bytes, kMapOffset + index * 4u, table[index], 1);
  }
}

static void build_dual_profile_hue_sat_map_dng(uint8_t* bytes) {
  enum {
    kIfdOffset = 8,
    kBlackOffset = 290,
    kNeutralOffset = 298,
    kActiveOffset = 314,
    kMatrix1Offset = 330,
    kMatrix2Offset = 402,
    kDimsOffset = 474,
    kMap1Offset = 486,
    kMap2Offset = 510,
  };
  uint8_t original[kDualColorFileLength];
  build_dual_color_dng(original, 17u, 21u);
  memset(bytes, 0, 534u);
  memcpy(bytes, original, entry_offset(kIfdOffset, 19u));
  write_u16(bytes, kIfdOffset, 22u, 1);
  write_u32(bytes, entry_offset(kIfdOffset, 22u), 0u, 1);
  memcpy(bytes + kBlackOffset, original + 242u, 8u);
  memcpy(bytes + kNeutralOffset, original + 250u, 16u);
  memcpy(bytes + kActiveOffset, original + 274u, 16u);
  memcpy(bytes + kMatrix1Offset, original + 290u, 72u);
  memcpy(bytes + kMatrix2Offset, original + 362u, 72u);
  write_u32(bytes, entry_offset(kIfdOffset, 11u) + 8u, kBlackOffset, 1);
  write_offset_entry(bytes, kIfdOffset, 13u, 50729u, kTiffTypeRational,
                     2u, kNeutralOffset, 1);
  write_u32(bytes, kNeutralOffset, 40u, 1);
  write_u32(bytes, kNeutralOffset + 4u, 100u, 1);
  write_u32(bytes, kNeutralOffset + 8u, 35u, 1);
  write_u32(bytes, kNeutralOffset + 12u, 100u, 1);
  write_u32(bytes, entry_offset(kIfdOffset, 14u) + 8u, kActiveOffset, 1);
  write_u32(bytes, entry_offset(kIfdOffset, 15u) + 8u, kMatrix1Offset, 1);
  write_u32(bytes, entry_offset(kIfdOffset, 16u) + 8u, kMatrix2Offset, 1);
  write_offset_entry(bytes, kIfdOffset, 19u, 50937u, kTiffTypeLong, 3u,
                     kDimsOffset, 1);
  write_offset_entry(bytes, kIfdOffset, 20u, 50938u, kTiffTypeFloat, 6u,
                     kMap1Offset, 1);
  write_offset_entry(bytes, kIfdOffset, 21u, 50939u, kTiffTypeFloat, 6u,
                     kMap2Offset, 1);
  write_u32(bytes, kDimsOffset, 1u, 1);
  write_u32(bytes, kDimsOffset + 4u, 2u, 1);
  write_u32(bytes, kDimsOffset + 8u, 1u, 1);
  const float map_1[6] = {0.0f, 1.0f, 1.0f, 0.0f, 1.0f, 1.0f};
  const float map_2[6] = {0.0f, 1.0f, 1.0f, 100.0f, 2.0f, 0.5f};
  for (uint32_t index = 0; index < 6u; index++) {
    write_float32(bytes, kMap1Offset + index * 4u, map_1[index], 1);
    write_float32(bytes, kMap2Offset + index * 4u, map_2[index], 1);
  }
}

static void build_triple_profile_hue_sat_map_dng(uint8_t* bytes) {
  enum {
    kIfdOffset = 8,
    kBlackOffset = 326,
    kNeutralOffset = 334,
    kActiveOffset = 358,
    kMatrix1Offset = 374,
    kMatrix2Offset = 446,
    kMatrix3Offset = 518,
    kIlluminant3Offset = 590,
    kDimsOffset = 608,
    kMap1Offset = 620,
    kMap2Offset = 644,
    kMap3Offset = 668,
  };
  uint8_t original[560];
  build_triple_color_dng(original, 1);
  memset(bytes, 0, 692u);
  memcpy(bytes, original, entry_offset(kIfdOffset, 22u));
  write_u16(bytes, kIfdOffset, 26u, 1);
  write_u32(bytes, entry_offset(kIfdOffset, 26u), 0u, 1);
  memcpy(bytes + kBlackOffset, original + 278u, 8u);
  memcpy(bytes + kNeutralOffset, original + 286u, 16u);
  memcpy(bytes + kActiveOffset, original + 310u, 16u);
  memcpy(bytes + kMatrix1Offset, original + 326u, 72u);
  memcpy(bytes + kMatrix2Offset, original + 398u, 72u);
  memcpy(bytes + kMatrix3Offset, original + 470u, 72u);
  memcpy(bytes + kIlluminant3Offset, original + 542u, 18u);
  write_u32(bytes, entry_offset(kIfdOffset, 11u) + 8u, kBlackOffset, 1);
  write_u32(bytes, entry_offset(kIfdOffset, 13u) + 8u, kNeutralOffset, 1);
  write_u32(bytes, entry_offset(kIfdOffset, 14u) + 8u, kActiveOffset, 1);
  write_u32(bytes, entry_offset(kIfdOffset, 15u) + 8u, kMatrix1Offset, 1);
  write_u32(bytes, entry_offset(kIfdOffset, 16u) + 8u, kMatrix2Offset, 1);
  write_u32(bytes, entry_offset(kIfdOffset, 17u) + 8u, kMatrix3Offset, 1);
  write_u32(bytes, entry_offset(kIfdOffset, 21u) + 8u,
            kIlluminant3Offset, 1);
  write_offset_entry(bytes, kIfdOffset, 22u, 50937u, kTiffTypeLong, 3u,
                     kDimsOffset, 1);
  write_offset_entry(bytes, kIfdOffset, 23u, 50938u, kTiffTypeFloat, 6u,
                     kMap1Offset, 1);
  write_offset_entry(bytes, kIfdOffset, 24u, 50939u, kTiffTypeFloat, 6u,
                     kMap2Offset, 1);
  write_offset_entry(bytes, kIfdOffset, 25u, 52537u, kTiffTypeFloat, 6u,
                     kMap3Offset, 1);
  write_u32(bytes, kDimsOffset, 1u, 1);
  write_u32(bytes, kDimsOffset + 4u, 2u, 1);
  write_u32(bytes, kDimsOffset + 8u, 1u, 1);
  const float hues[3] = {100.0f, 200.0f, 300.0f};
  const uint32_t offsets[3] = {kMap1Offset, kMap2Offset, kMap3Offset};
  for (uint32_t map = 0; map < 3u; map++) {
    const float values[6] = {0.0f, 1.0f, 1.0f,
                             hues[map], 1.0f, 1.0f};
    for (uint32_t index = 0; index < 6u; index++) {
      write_float32(bytes, offsets[map] + index * 4u, values[index], 1);
    }
  }
}

static int check_profile_hue_sat_map(MobileStackRawDecoder* decoder) {
  enum { kFileLength = kMinimalFileLength + 60u };
  static const char path[] =
      "mobile_stack_raw_hardening_profile_hue_sat_map.dng";
  uint8_t bytes[kFileLength];
  build_profile_hue_sat_map_dng(bytes, 0);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->profile_hue_divisions == 2u);
  CHECK(result->profile_sat_divisions == 2u);
  CHECK(result->profile_val_divisions == 1u);
  CHECK(result->profile_hue_sat_map_entry_count == 4u);
  CHECK(result->profile_hue_sat_map != NULL);
  CHECK(result->profile_hue_sat_map[3] == 10.0f);
  CHECK(result->profile_hue_sat_map[4] > 1.19f);
  CHECK(result->profile_hue_sat_map[10] > 0.79f);
  mobile_stack_raw_metadata_result_release(result);

  build_profile_hue_sat_map_dng(bytes, 1);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_OK);
  CHECK(result->profile_hue_sat_map[0] == 10.0f);
  CHECK(result->profile_hue_sat_map[1] > 1.19f);
  CHECK(result->profile_hue_sat_map[2] == 1.0f);
  CHECK(result->profile_hue_sat_map[6] == -10.0f);
  CHECK(result->profile_hue_sat_map[7] > 0.79f);
  CHECK(result->profile_hue_sat_map[7] < 0.81f);
  CHECK(result->profile_hue_sat_map[8] == 1.0f);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_profile_hue_sat_map_rejection(
    MobileStackRawDecoder* decoder) {
  enum {
    kFileLength = kMinimalFileLength + 60u,
    kDimsOffset = kMinimalFileLength,
    kMapOffset = kMinimalFileLength + 12u,
  };
  static const char path[] =
      "mobile_stack_raw_hardening_bad_profile_hue_sat_map.dng";
  uint8_t bytes[kFileLength];
  MobileStackRawMetadataProbeResult* result = NULL;

  build_profile_hue_sat_map_dng(bytes, 0);
  write_u32(bytes, kDimsOffset + 4u, 1u, 1);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);

  build_profile_hue_sat_map_dng(bytes, 0);
  write_u32(bytes, entry_offset(8u, 6u) + 4u, 9u, 1);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);

  build_profile_hue_sat_map_dng(bytes, 0);
  write_float32(bytes, kMapOffset + 4u, -0.1f, 1);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);

  build_profile_hue_sat_map_dng(bytes, 0);
  /* DNG 1.7.1 requires every saturation-zero entry to have Value scale 1. */
  write_float32(bytes, kMapOffset + 8u, 0.5f, 1);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);

  build_profile_hue_sat_map_dng(bytes, 0);
  write_u32(bytes, kDimsOffset, 361u, 1);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_profile_look_table(MobileStackRawDecoder* decoder) {
  enum { kFileLength = kMinimalFileLength + 60u };
  static const char path[] =
      "mobile_stack_raw_hardening_profile_look_table.dng";
  uint8_t bytes[kFileLength];
  build_profile_look_table_dng(bytes, 0, 0);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->profile_look_hue_divisions == 2u);
  CHECK(result->profile_look_sat_divisions == 2u);
  CHECK(result->profile_look_val_divisions == 1u);
  CHECK(result->profile_look_table_encoding == 1u);
  CHECK(result->profile_look_table_entry_count == 4u);
  CHECK(result->profile_look_table != NULL);
  CHECK(result->profile_look_table[0] == 2.0f);
  CHECK(result->profile_look_table[3] == 20.0f);
  mobile_stack_raw_metadata_result_release(result);

  build_profile_look_table_dng(bytes, 1, 1);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_OK);
  CHECK(result->profile_look_val_divisions == 1u);
  CHECK(result->profile_look_table[0] == 20.0f);
  CHECK(result->profile_look_table[1] > 1.19f);
  CHECK(result->profile_look_table[2] == 1.0f);
  CHECK(result->profile_look_table[6] == -20.0f);
  CHECK(result->profile_look_table[7] > 0.79f);
  CHECK(result->profile_look_table[8] == 1.0f);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_profile_look_table_rejection(
    MobileStackRawDecoder* decoder) {
  enum {
    kFileLength = kMinimalFileLength + 60u,
    kDimsOffset = kMinimalFileLength,
    kMapOffset = kMinimalFileLength + 12u,
  };
  static const char path[] =
      "mobile_stack_raw_hardening_bad_profile_look_table.dng";
  uint8_t bytes[kFileLength];
  MobileStackRawMetadataProbeResult* result = NULL;

  build_profile_look_table_dng(bytes, 0, 0);
  write_u32(bytes, entry_offset(8u, 6u) + 4u, 9u, 1);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);

  build_profile_look_table_dng(bytes, 0, 0);
  write_u32(bytes, entry_offset(8u, 0u) + 8u, 2u, 1);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);

  build_profile_look_table_dng(bytes, 0, 0);
  write_float32(bytes, kMapOffset + 4u, -0.1f, 1);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);

  build_profile_look_table_dng(bytes, 0, 0);
  /* ProfileLookTable uses the same saturation-zero Value-scale rule. */
  write_float32(bytes, kMapOffset + 8u, 0.5f, 1);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);

  build_profile_look_table_dng(bytes, 0, 0);
  write_u32(bytes, kDimsOffset, 361u, 1);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);

  build_profile_look_table_dng(bytes, 0, 0);
  write_short_entry(bytes, 8u, 6u, 65000u, 0u, 1);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_profile_hue_sat_map_illuminant_blending(
    MobileStackRawDecoder* decoder) {
  static const char dual_path[] =
      "mobile_stack_raw_hardening_dual_profile_hue_sat_map.dng";
  uint8_t dual_bytes[534];
  build_dual_profile_hue_sat_map_dng(dual_bytes);
  CHECK(write_fixture(dual_path, dual_bytes, sizeof(dual_bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  CHECK(probe_fixture(decoder, dual_path, sizeof(dual_bytes), &result) ==
        MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->profile_hue_sat_map != NULL);
  CHECK(result->profile_hue_sat_map[3] > 0.0f);
  CHECK(result->profile_hue_sat_map[3] < 100.0f);
  CHECK(result->profile_hue_sat_map[4] > 1.0f);
  CHECK(result->profile_hue_sat_map[4] < 2.0f);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(dual_path) == 0);

  static const char triple_path[] =
      "mobile_stack_raw_hardening_triple_profile_hue_sat_map.dng";
  uint8_t triple_bytes[692];
  build_triple_profile_hue_sat_map_dng(triple_bytes);
  CHECK(write_fixture(triple_path, triple_bytes, sizeof(triple_bytes)));
  result = NULL;
  CHECK(probe_fixture(decoder, triple_path, sizeof(triple_bytes), &result) ==
        MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->profile_hue_sat_map != NULL);
  CHECK(fabsf(result->profile_hue_sat_map[3] - 300.0f) < 0.01f);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(triple_path) == 0);
  return 0;
}


static int check_forward_matrix_path(MobileStackRawDecoder* decoder) {
  enum { kFileLength = 422 };
  uint8_t bytes[kFileLength];
  const char* path = "mobile_stack_raw_hardening_forward_matrix.dng";
  build_forward_matrix_dng(bytes, 1);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->has_d65_xyz_to_camera == 1u);
  CHECK(fabsf(result->d65_xyz_to_camera_0 - 1.0371077f) < 1.0e-5f);
  CHECK(fabsf(result->d65_xyz_to_camera_4 - 1.0f) < 1.0e-6f);
  CHECK(fabsf(result->d65_xyz_to_camera_8 - 1.2118127f) < 1.0e-5f);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}


static int check_forward_matrix_as_shot_white_xy_path(
    MobileStackRawDecoder* decoder) {
  enum { kFileLength = 422 };
  uint8_t bytes[kFileLength];
  const char* path =
      "mobile_stack_raw_hardening_forward_matrix_as_shot_white_xy.dng";
  build_forward_matrix_as_shot_white_xy_dng(bytes, 1);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->has_d65_xyz_to_camera == 1u);
  CHECK(result->has_camera_white_balance == 1u);

  /* DNG chapter 6: CameraNeutral = (AB * CC * CM) * XYZ(as-shot white).
   * This fixture uses identity AB/CC/CM and D50 AsShotWhiteXY, so the
   * normalized neutral is approximately (0.96430, 1.0, 0.82510). The
   * published ForwardMatrix path must not re-derive this from D65. */
  const double x = 0.3457;
  const double y = 0.3585;
  const double red_neutral = x / y;
  const double blue_neutral = (1.0 - x - y) / y;
  CHECK(fabs(result->camera_white_balance_0 - 1.0 / red_neutral) < 1.0e-5);
  CHECK(fabs(result->camera_white_balance_1 - 1.0) < 1.0e-6);
  CHECK(fabs(result->camera_white_balance_2 - 1.0) < 1.0e-6);
  CHECK(fabs(result->camera_white_balance_3 - 1.0 / blue_neutral) < 1.0e-5);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_dual_forward_matrix_path(MobileStackRawDecoder* decoder) {
  enum { kFileLength = kDualColorFileLength + 144 };
  uint8_t bytes[kFileLength];
  const char* path = "mobile_stack_raw_hardening_dual_forward_matrix.dng";
  memset(bytes, 0, sizeof(bytes));
  build_dual_forward_matrix_dng(bytes);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->has_d65_xyz_to_camera == 1u);
  CHECK(isfinite(result->d65_xyz_to_camera_0));
  CHECK(isfinite(result->d65_xyz_to_camera_4));
  CHECK(isfinite(result->d65_xyz_to_camera_8));
  CHECK(result->d65_xyz_to_camera_0 > 0.0f);
  CHECK(result->d65_xyz_to_camera_4 > 0.0f);
  CHECK(result->d65_xyz_to_camera_8 > 0.0f);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_triple_forward_matrix_path(MobileStackRawDecoder* decoder) {
  enum { kFileLength = 776 };
  uint8_t bytes[kFileLength];
  const char* path = "mobile_stack_raw_hardening_triple_forward_matrix.dng";
  memset(bytes, 0, sizeof(bytes));
  build_triple_forward_matrix_dng(bytes, 0);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_OK);
  CHECK(result != NULL);
  CHECK(result->has_d65_xyz_to_camera == 1u);
  CHECK(isfinite(result->d65_xyz_to_camera_0));
  CHECK(isfinite(result->d65_xyz_to_camera_4));
  CHECK(isfinite(result->d65_xyz_to_camera_8));
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

static int check_triple_forward_matrix_requires_all_three(
    MobileStackRawDecoder* decoder) {
  enum { kFileLength = 776 };
  uint8_t bytes[kFileLength];
  const char* path =
      "mobile_stack_raw_hardening_triple_forward_matrix_partial.dng";
  memset(bytes, 0, sizeof(bytes));
  build_triple_forward_matrix_dng(bytes, 1);
  CHECK(write_fixture(path, bytes, sizeof(bytes)));
  MobileStackRawMetadataProbeResult* result = NULL;
  CHECK(probe_fixture(decoder, path, sizeof(bytes), &result) ==
        MOBILE_STACK_RAW_CORRUPT_DATA);
  CHECK(result != NULL);
  CHECK(result->status_code == MOBILE_STACK_RAW_CORRUPT_DATA);
  mobile_stack_raw_metadata_result_release(result);
  CHECK(remove(path) == 0);
  return 0;
}

int main(int argc, char** argv) {
  if (argc == 3 && strcmp(argv[1], "--write-fixture") == 0) {
    uint8_t bytes[kMinimalFileLength];
    build_minimal_dng(bytes, 1, kMinimalActiveOffset);
    return write_fixture(argv[2], bytes, sizeof(bytes)) ? 0 : 2;
  }
  CHECK(argc == 1);
  CHECK((mobile_stack_raw_capabilities() &
         MOBILE_STACK_RAW_CAPABILITY_DNG_METADATA) != 0u);
  MobileStackRawDecoder* decoder = mobile_stack_raw_decoder_create();
  CHECK(decoder != NULL);
  CHECK(check_minimal_endian(decoder, 1) == 0);
  CHECK(check_minimal_endian(decoder, 0) == 0);
  CHECK(check_color_matrix_1_d65(decoder) == 0);
  CHECK(check_color_matrix_1_standard_a_is_adapted(decoder) == 0);
  CHECK(check_forward_matrix_path(decoder) == 0);
  CHECK(check_forward_matrix_as_shot_white_xy_path(decoder) == 0);
  CHECK(check_dual_forward_matrix_path(decoder) == 0);
  CHECK(check_triple_forward_matrix_path(decoder) == 0);
  CHECK(check_triple_forward_matrix_requires_all_three(decoder) == 0);
  CHECK(check_as_shot_white_xy(decoder) == 0);
  CHECK(check_invalid_as_shot_white_xy_rejection(decoder) == 0);
  CHECK(check_as_shot_neutral_precedes_white_xy(decoder) == 0);
  CHECK(check_dual_color_selection(
            decoder, 17, 1.0f,
            "mobile_stack_raw_hardening_dual_fallback.dng") == 0);
  CHECK(check_dual_color_selection(
            decoder, 21, 1.0f,
            "mobile_stack_raw_hardening_dual_precedence.dng") == 0);
  CHECK(check_d50_color_selection(
            decoder, 23, 17, 1.0f,
            "mobile_stack_raw_hardening_d50_slot_1.dng") == 0);
  CHECK(check_d50_color_selection(
            decoder, 17, 23, 2.0f,
            "mobile_stack_raw_hardening_d50_slot_2.dng") == 0);
  CHECK(check_dual_calibration_interpolation_order(decoder) == 0);
  CHECK(check_other_illuminant_xy_dual(decoder) == 0);
  CHECK(check_other_illuminant_missing_data_rejection(decoder) == 0);
  CHECK(check_spectral_illuminant_equal_energy(decoder) == 0);
  CHECK(check_spectral_illuminant_bounds_rejection(decoder) == 0);
  CHECK(check_triple_illuminant_explicit_white(decoder) == 0);
  CHECK(check_triple_illuminant_neutral_iteration(decoder) == 0);
  CHECK(check_triple_illuminant_schema_rejection(decoder) == 0);
  CHECK(check_malformed_illuminant_schema_rejection(decoder) == 0);
  CHECK(check_baseline_exposure_tail(decoder) == 0);
  CHECK(check_baseline_exposure_rejection(decoder) == 0);
  CHECK(check_profile_dynamic_range(decoder, 1) == 0);
  CHECK(check_profile_dynamic_range(decoder, 0) == 0);
  CHECK(check_profile_dynamic_range_rejection(decoder) == 0);
  CHECK(check_baseline_exposure_offset_tail(decoder) == 0);
  CHECK(check_baseline_exposure_offset_rejection(decoder) == 0);
  CHECK(check_profile_tone_curve(decoder) == 0);
  CHECK(check_profile_tone_curve_rejection(decoder) == 0);
  CHECK(check_profile_hue_sat_map(decoder) == 0);
  CHECK(check_profile_hue_sat_map_rejection(decoder) == 0);
  CHECK(check_profile_hue_sat_map_illuminant_blending(decoder) == 0);
  CHECK(check_profile_look_table(decoder) == 0);
  CHECK(check_profile_look_table_rejection(decoder) == 0);
  CHECK(check_analog_balance_composition(decoder) == 0);
  CHECK(check_nonpositive_analog_balance_rejection(decoder) == 0);
  CHECK(check_camera_calibration_signature_selection(
            decoder, 'x', 2.0f, -0.2f, 0.5f,
            "mobile_stack_raw_hardening_matching_signatures.dng") == 0);
  CHECK(check_camera_calibration_signature_selection(
            decoder, 'y', 1.0f, -0.1f, 1.0f,
            "mobile_stack_raw_hardening_mismatched_signatures.dng") == 0);
  CHECK(check_nonterminated_calibration_signature_rejection(decoder) == 0);
  CHECK(check_external_camera_calibration_slot_1(
            decoder, kTiffTypeAscii,
            "mobile_stack_raw_hardening_external_ascii_signature.dng") == 0);
  CHECK(check_external_camera_calibration_slot_1(
            decoder, kTiffTypeByte,
            "mobile_stack_raw_hardening_external_byte_signature.dng") == 0);
  CHECK(check_external_calibration_signature_rejection(
            decoder, 257u, kExternalProfileSignatureOffset, 0,
            "mobile_stack_raw_hardening_signature_limit.dng") == 0);
  CHECK(check_external_calibration_signature_rejection(
            decoder, 6u, 0xFFFFFFF0u, 0,
            "mobile_stack_raw_hardening_signature_offset.dng") == 0);
  CHECK(check_external_calibration_signature_rejection(
            decoder, 6u, kExternalProfileSignatureOffset, 1,
            "mobile_stack_raw_hardening_embedded_null_signature.dng") == 0);
  CHECK(check_unsafe_composite_matrix_rejection(
            decoder, 0,
            "mobile_stack_raw_hardening_singular_composite_matrix.dng") == 0);
  CHECK(check_unsafe_composite_matrix_rejection(
            decoder, 1,
            "mobile_stack_raw_hardening_ill_conditioned_matrix.dng") == 0);
  CHECK(check_sub_ifd_metadata(decoder) == 0);
  CHECK(check_external_offset_rejection(decoder) == 0);
  CHECK(check_ifd_chain_resource_limit(decoder) == 0);
  CHECK(check_repeated_probe_release(decoder) == 0);
  mobile_stack_raw_decoder_destroy(decoder);
  return 0;
}
