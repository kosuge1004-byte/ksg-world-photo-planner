#include "mobile_stack_dng_metadata.h"

/* This product includes DNG technology under license by Adobe. */

#include <limits.h>
#include <float.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
  kMaximumPathBytes = 32768,
  kMaximumIfdCount = 16,
  kMaximumIfdEntries = 512,
  kMaximumSubIfds = 8,
  kMaximumBlackLevels = 64,
  kMaximumLinearizationEntries = 65536,
  kMaximumBlackLevelDeltas = 200000,
  kMaximumCalibrationSignatureBytes = 256,
  kMaximumProfileToneCurvePoints = 8192,
  kMaximumProfileHueDivisions = 360,
  kMaximumProfileSatDivisions = 256,
  kMaximumProfileValDivisions = 64,
  kMaximumProfileHueSatMapEntries = 262144,
  kMinimumIlluminantSpectrumSamples = 2,
  kMaximumIlluminantSpectrumSamples = 1000,
  kCieObserverFirstNm = 360,
  kCieObserverLastNm = 830,
  kCieObserverSampleCount = 471,
};

enum {
  kTagNewSubFileType = 254,
  kTagImageWidth = 256,
  kTagImageLength = 257,
  kTagBitsPerSample = 258,
  kTagPhotometricInterpretation = 262,
  kTagOrientation = 274,
  kTagSamplesPerPixel = 277,
  kTagSubIfds = 330,
  kTagCfaRepeatPatternDim = 33421,
  kTagCfaPattern = 33422,
  kTagDngVersion = 50706,
  kTagCfaPlaneColor = 50710,
  kTagLinearizationTable = 50712,
  kTagBlackLevelRepeatDim = 50713,
  kTagBlackLevel = 50714,
  kTagBlackLevelDeltaH = 50715,
  kTagBlackLevelDeltaV = 50716,
  kTagWhiteLevel = 50717,
  kTagColorMatrix1 = 50721,
  kTagColorMatrix2 = 50722,
  kTagCameraCalibration1 = 50723,
  kTagCameraCalibration2 = 50724,
  kTagAnalogBalance = 50727,
  kTagAsShotNeutral = 50728,
  kTagAsShotWhiteXY = 50729,
  kTagBaselineExposure = 50730,
  kTagCalibrationIlluminant1 = 50778,
  kTagCalibrationIlluminant2 = 50779,
  kTagActiveArea = 50829,
  kTagCameraCalibrationSignature = 50931,
  kTagProfileCalibrationSignature = 50932,
  kTagProfileHueSatMapDims = 50937,
  kTagProfileHueSatMapData1 = 50938,
  kTagProfileHueSatMapData2 = 50939,
  kTagProfileToneCurve = 50940,
  kTagForwardMatrix1 = 50964,
  kTagForwardMatrix2 = 50965,
  kTagProfileLookTableDims = 50981,
  kTagProfileLookTableData = 50982,
  kTagProfileHueSatMapEncoding = 51107,
  kTagProfileLookTableEncoding = 51108,
  kTagBaselineExposureOffset = 51109,
  kTagCalibrationIlluminant3 = 52529,
  kTagCameraCalibration3 = 52530,
  kTagColorMatrix3 = 52531,
  kTagForwardMatrix3 = 52532,
  kTagIlluminantData1 = 52533,
  kTagIlluminantData2 = 52534,
  kTagIlluminantData3 = 52535,
  kTagProfileHueSatMapData3 = 52537,
  kTagProfileDynamicRange = 52551,
};

enum {
  kTiffTypeByte = 1,
  kTiffTypeAscii = 2,
  kTiffTypeShort = 3,
  kTiffTypeLong = 4,
  kTiffTypeRational = 5,
  kTiffTypeUndefined = 7,
  kTiffTypeSignedRational = 10,
  kTiffTypeFloat = 11,
  kTiffTypeIfd = 13,
  kPhotometricCfa = 32803,
  kLightSourceStandardA = 17,
  kLightSourceD55 = 20,
  kLightSourceD65 = 21,
  kLightSourceD75 = 22,
  kLightSourceD50 = 23,
  kLightSourceOther = 255,
};

typedef struct DngReader {
  FILE* file;
  uint64_t file_size;
  int little_endian;
} DngReader;

typedef struct TiffEntry {
  uint16_t tag;
  uint16_t type;
  uint32_t count;
  uint8_t raw[12];
} TiffEntry;

typedef struct DngIfd {
  uint32_t width;
  uint32_t height;
  uint32_t bits_per_sample;
  uint32_t orientation;
  uint32_t new_subfile_type;
  uint32_t samples_per_pixel;
  uint32_t photometric;
  uint32_t cfa_repeat[2];
  uint32_t cfa_values[4];
  uint32_t cfa_plane_colors[3];
  uint32_t active_area[4];
  uint32_t black_repeat[2];
  double black_levels[kMaximumBlackLevels];
  uint32_t black_level_count;
  uint16_t* linearization_table;
  uint32_t linearization_table_count;
  double* black_level_delta_h;
  uint32_t black_level_delta_h_count;
  double* black_level_delta_v;
  uint32_t black_level_delta_v_count;
  double white_level;
  uint32_t sub_ifds[kMaximumSubIfds];
  uint32_t sub_ifd_count;
  uint32_t next_ifd;
  int has_width;
  int has_height;
  int has_bits_per_sample;
  int has_orientation;
  int has_new_subfile_type;
  int has_samples_per_pixel;
  int has_photometric;
  int has_cfa_repeat;
  int has_cfa_pattern;
  int has_cfa_plane_colors;
  int has_active_area;
  int has_black_repeat;
  int has_black_levels;
  int has_linearization_table;
  int has_black_level_delta_h;
  int has_black_level_delta_v;
  int has_white_level;
} DngIfd;

typedef struct DngParseState {
  int saw_dng_version;
  int has_orientation;
  uint32_t orientation;
  int has_neutral;
  double neutral[3];
  int has_as_shot_white_xy;
  double as_shot_white_xy[2];
  int has_baseline_exposure;
  double baseline_exposure;
  int has_baseline_exposure_offset;
  double baseline_exposure_offset;
  int has_profile_dynamic_range;
  uint32_t profile_dynamic_range;
  double profile_hint_max_output_value;
  uint32_t profile_tone_curve_point_count;
  float* profile_tone_curve_xy;
  int has_profile_hue_sat_map_dims;
  uint32_t profile_hue_divisions;
  uint32_t profile_sat_divisions;
  uint32_t profile_val_divisions;
  uint32_t profile_hue_sat_map_encoding;
  float* profile_hue_sat_map_1;
  float* profile_hue_sat_map_2;
  float* profile_hue_sat_map_3;
  int has_profile_look_table_dims;
  uint32_t profile_look_hue_divisions;
  uint32_t profile_look_sat_divisions;
  uint32_t profile_look_val_divisions;
  uint32_t profile_look_table_encoding;
  float* profile_look_table;
  int has_color_matrix_1;
  double color_matrix_1[9];
  int has_color_matrix_2;
  double color_matrix_2[9];
  int has_color_matrix_3;
  double color_matrix_3[9];
  int has_forward_matrix_1;
  double forward_matrix_1[9];
  int has_forward_matrix_2;
  double forward_matrix_2[9];
  int has_forward_matrix_3;
  double forward_matrix_3[9];
  int has_camera_calibration_1;
  double camera_calibration_1[9];
  int has_camera_calibration_2;
  double camera_calibration_2[9];
  int has_camera_calibration_3;
  double camera_calibration_3[9];
  int has_calibration_illuminant_1;
  uint32_t calibration_illuminant_1;
  int has_calibration_illuminant_2;
  uint32_t calibration_illuminant_2;
  int has_calibration_illuminant_3;
  uint32_t calibration_illuminant_3;
  int has_illuminant_data_1;
  double illuminant_data_1_xy[2];
  int has_illuminant_data_2;
  double illuminant_data_2_xy[2];
  int has_illuminant_data_3;
  double illuminant_data_3_xy[2];
  int has_analog_balance;
  double analog_balance[3];
  uint32_t camera_calibration_signature_length;
  uint8_t camera_calibration_signature[kMaximumCalibrationSignatureBytes];
  uint32_t profile_calibration_signature_length;
  uint8_t profile_calibration_signature[kMaximumCalibrationSignatureBytes];
  int has_best;
  uint64_t best_area;
  MobileStackDngMetadata best;
} DngParseState;

static const double kCie1931StandardObserver2Degree
    [kCieObserverSampleCount][3] = {
#include "mobile_stack_cie_1931_2deg.inc"
};

static uint16_t read_u16(const DngReader* reader, const uint8_t* bytes) {
  if (reader->little_endian) {
    return (uint16_t)((uint16_t)bytes[0] |
                      ((uint16_t)bytes[1] << 8));
  }
  return (uint16_t)(((uint16_t)bytes[0] << 8) |
                    (uint16_t)bytes[1]);
}

static uint32_t read_u32(const DngReader* reader, const uint8_t* bytes) {
  if (reader->little_endian) {
    return (uint32_t)bytes[0] |
           ((uint32_t)bytes[1] << 8) |
           ((uint32_t)bytes[2] << 16) |
           ((uint32_t)bytes[3] << 24);
  }
  return ((uint32_t)bytes[0] << 24) |
         ((uint32_t)bytes[1] << 16) |
         ((uint32_t)bytes[2] << 8) |
         (uint32_t)bytes[3];
}

static int read_at(DngReader* reader,
                   uint64_t offset,
                   uint8_t* bytes,
                   size_t length) {
  if (reader == NULL || bytes == NULL ||
      offset > reader->file_size ||
      (uint64_t)length > reader->file_size - offset ||
      offset > (uint64_t)LONG_MAX) {
    return 0;
  }
  if (fseek(reader->file, (long)offset, SEEK_SET) != 0) {
    return 0;
  }
  return fread(bytes, 1, length, reader->file) == length;
}

static uint32_t tiff_type_size(uint16_t type) {
  switch (type) {
    case kTiffTypeByte:
    case kTiffTypeAscii:
    case kTiffTypeUndefined:
      return 1;
    case kTiffTypeShort:
      return 2;
    case kTiffTypeLong:
    case kTiffTypeIfd:
    case kTiffTypeFloat:
      return 4;
    case kTiffTypeRational:
    case kTiffTypeSignedRational:
      return 8;
    default:
      return 0;
  }
}

static int entry_element_bytes(DngReader* reader,
                               const TiffEntry* entry,
                               uint32_t index,
                               uint8_t* bytes,
                               uint32_t length) {
  const uint32_t type_size = tiff_type_size(entry->type);
  if (type_size == 0 || length != type_size || index >= entry->count ||
      entry->count > UINT32_MAX / type_size) {
    return 0;
  }
  const uint32_t total_size = entry->count * type_size;
  const uint64_t element_offset = (uint64_t)index * type_size;
  if (total_size <= 4) {
    if (element_offset + type_size > 4) {
      return 0;
    }
    memcpy(bytes, entry->raw + 8 + element_offset, type_size);
    return 1;
  }
  const uint32_t value_offset = read_u32(reader, entry->raw + 8);
  return read_at(reader, (uint64_t)value_offset + element_offset, bytes,
                 type_size);
}

static int entry_unsigned(DngReader* reader,
                          const TiffEntry* entry,
                          uint32_t index,
                          uint32_t* value_out) {
  uint8_t bytes[4] = {0, 0, 0, 0};
  const uint32_t type_size = tiff_type_size(entry->type);
  if (value_out == NULL ||
      (entry->type != kTiffTypeByte &&
       entry->type != kTiffTypeShort &&
       entry->type != kTiffTypeLong &&
       entry->type != kTiffTypeIfd) ||
      !entry_element_bytes(reader, entry, index, bytes, type_size)) {
    return 0;
  }
  switch (entry->type) {
    case kTiffTypeByte:
      *value_out = bytes[0];
      return 1;
    case kTiffTypeShort:
      *value_out = read_u16(reader, bytes);
      return 1;
    case kTiffTypeLong:
    case kTiffTypeIfd:
      *value_out = read_u32(reader, bytes);
      return 1;
    default:
      return 0;
  }
}

static int entry_number(DngReader* reader,
                        const TiffEntry* entry,
                        uint32_t index,
                        double* value_out) {
  if (value_out == NULL) {
    return 0;
  }
  if (entry->type == kTiffTypeByte ||
      entry->type == kTiffTypeShort ||
      entry->type == kTiffTypeLong) {
    uint32_t value = 0;
    if (!entry_unsigned(reader, entry, index, &value)) {
      return 0;
    }
    *value_out = (double)value;
    return 1;
  }
  if (entry->type == kTiffTypeRational) {
    uint8_t bytes[8];
    if (!entry_element_bytes(reader, entry, index, bytes, 8)) {
      return 0;
    }
    const uint32_t numerator = read_u32(reader, bytes);
    const uint32_t denominator = read_u32(reader, bytes + 4);
    if (denominator == 0) {
      return 0;
    }
    *value_out = (double)numerator / (double)denominator;
    return isfinite(*value_out);
  }
  if (entry->type == kTiffTypeSignedRational) {
    uint8_t bytes[8];
    if (!entry_element_bytes(reader, entry, index, bytes, 8)) {
      return 0;
    }
    const uint32_t raw_numerator = read_u32(reader, bytes);
    const uint32_t raw_denominator = read_u32(reader, bytes + 4);
    const int64_t numerator = raw_numerator <= INT32_MAX
        ? (int64_t)raw_numerator
        : -((int64_t)(~raw_numerator) + 1);
    const int64_t denominator = raw_denominator <= INT32_MAX
        ? (int64_t)raw_denominator
        : -((int64_t)(~raw_denominator) + 1);
    if (denominator == 0) {
      return 0;
    }
    *value_out = (double)numerator / (double)denominator;
    return isfinite(*value_out);
  }
  if (entry->type == kTiffTypeFloat) {
    uint8_t bytes[4];
    if (!entry_element_bytes(reader, entry, index, bytes, 4u)) {
      return 0;
    }
    const uint32_t bits = read_u32(reader, bytes);
    float value = 0.0f;
    memcpy(&value, &bits, sizeof(value));
    *value_out = (double)value;
    return isfinite(*value_out);
  }
  return 0;
}

static int read_entry(DngReader* reader,
                      uint64_t offset,
                      TiffEntry* entry_out) {
  if (entry_out == NULL ||
      !read_at(reader, offset, entry_out->raw, sizeof(entry_out->raw))) {
    return 0;
  }
  entry_out->tag = read_u16(reader, entry_out->raw);
  entry_out->type = read_u16(reader, entry_out->raw + 2);
  entry_out->count = read_u32(reader, entry_out->raw + 4);
  return 1;
}

static int read_unsigned_values(DngReader* reader,
                                const TiffEntry* entry,
                                uint32_t expected_count,
                                uint32_t* values_out) {
  if (entry->count != expected_count || values_out == NULL) {
    return 0;
  }
  for (uint32_t index = 0; index < expected_count; index++) {
    if (!entry_unsigned(reader, entry, index, values_out + index)) {
      return 0;
    }
  }
  return 1;
}

static int read_number_values(DngReader* reader,
                              const TiffEntry* entry,
                              uint32_t count,
                              double* values_out) {
  if (entry->count < count || values_out == NULL) {
    return 0;
  }
  for (uint32_t index = 0; index < count; index++) {
    if (!entry_number(reader, entry, index, values_out + index)) {
      return 0;
    }
  }
  return 1;
}

static int read_calibration_signature(
    DngReader* reader,
    const TiffEntry* entry,
    uint8_t* signature_out,
    uint32_t* length_out) {
  if ((entry->type != kTiffTypeAscii && entry->type != kTiffTypeByte) ||
      entry->count == 0 ||
      entry->count > kMaximumCalibrationSignatureBytes ||
      signature_out == NULL || length_out == NULL) {
    return 0;
  }
  for (uint32_t index = 0; index < entry->count; index++) {
    uint8_t value = 0;
    if (!entry_element_bytes(reader, entry, index, &value, 1)) {
      return 0;
    }
    if (index + 1u < entry->count && value == 0) {
      return 0;
    }
    signature_out[index] = value;
  }
  if (signature_out[entry->count - 1u] != 0) {
    return 0;
  }
  *length_out = entry->count - 1u;
  return 1;
}

static int validate_profile_tone_curve_endpoints(
    const DngParseState* state) {
  if (state == NULL || state->profile_tone_curve_xy == NULL ||
      state->profile_tone_curve_point_count == 0u) {
    return 1;
  }
  const float* const points = state->profile_tone_curve_xy;
  const uint32_t count = state->profile_tone_curve_point_count;
  if (points[0] != 0.0f || points[1] != 0.0f) {
    return 0;
  }
  /* DNG 1.7.1: omitted ProfileDynamicRange means SDR. SDR curves must
   * terminate at (1,1). HDR curves need only start at (0,0) and use final
   * slope extension for values beyond their final point. */
  const int is_hdr =
      state->has_profile_dynamic_range && state->profile_dynamic_range == 1u;
  if (!is_hdr) {
    const uint32_t last = (count - 1u) * 2u;
    if (points[last] != 1.0f || points[last + 1u] != 1.0f) {
      return 0;
    }
  }
  return 1;
}

static int read_profile_tone_curve(DngReader* reader,
                                   const TiffEntry* entry,
                                   DngParseState* state) {
  if (reader == NULL || entry == NULL || state == NULL ||
      entry->type != kTiffTypeFloat || entry->count < 4u ||
      (entry->count & 1u) != 0u) {
    return 0;
  }
  const uint32_t point_count = entry->count / 2u;
  if (point_count < 2u || point_count > kMaximumProfileToneCurvePoints) {
    return 0;
  }
  float* const points =
      (float*)malloc((size_t)point_count * 2u * sizeof(float));
  if (points == NULL) {
    return 0;
  }
  int valid = 1;
  double previous_x = -1.0;
  for (uint32_t point = 0; point < point_count; point++) {
    double x = 0.0;
    double y = 0.0;
    if (!entry_number(reader, entry, point * 2u, &x) ||
        !entry_number(reader, entry, point * 2u + 1u, &y) ||
        x < 0.0 || x > 1.0 || y < 0.0 || y > 1.0 ||
        (point > 0u && x <= previous_x)) {
      valid = 0;
      break;
    }
    points[point * 2u] = (float)x;
    points[point * 2u + 1u] = (float)y;
    previous_x = x;
  }
  if (!valid) {
    free(points);
    return 0;
  }
  free(state->profile_tone_curve_xy);
  state->profile_tone_curve_xy = points;
  state->profile_tone_curve_point_count = point_count;
  return 1;
}

static int read_profile_hue_sat_map_dims(DngReader* reader,
                                         const TiffEntry* entry,
                                         DngParseState* state) {
  uint32_t dimensions[3] = {0u, 0u, 1u};
  if (reader == NULL || entry == NULL || state == NULL ||
      entry->type != kTiffTypeLong ||
      (entry->count != 2u && entry->count != 3u) ||
      !read_unsigned_values(reader, entry, entry->count, dimensions) ||
      dimensions[0] == 0u ||
      dimensions[0] > kMaximumProfileHueDivisions ||
      dimensions[1] < 2u ||
      dimensions[1] > kMaximumProfileSatDivisions ||
      dimensions[2] == 0u ||
      dimensions[2] > kMaximumProfileValDivisions) {
    return 0;
  }
  const uint64_t entry_count = (uint64_t)dimensions[0] * dimensions[1] *
      dimensions[2];
  if (entry_count > kMaximumProfileHueSatMapEntries) {
    return 0;
  }
  if (state->has_profile_hue_sat_map_dims &&
      (state->profile_hue_divisions != dimensions[0] ||
       state->profile_sat_divisions != dimensions[1] ||
       state->profile_val_divisions != dimensions[2])) {
    return 0;
  }
  state->has_profile_hue_sat_map_dims = 1;
  state->profile_hue_divisions = dimensions[0];
  state->profile_sat_divisions = dimensions[1];
  state->profile_val_divisions = dimensions[2];
  return 1;
}

static int read_profile_hue_sat_map(DngReader* reader,
                                    const TiffEntry* entry,
                                    DngParseState* state,
                                    uint32_t slot) {
  if (reader == NULL || entry == NULL || state == NULL ||
      slot < 1u || slot > 3u ||
      !state->has_profile_hue_sat_map_dims ||
      entry->type != kTiffTypeFloat) {
    return 0;
  }
  const uint32_t hues = state->profile_hue_divisions;
  const uint32_t sats = state->profile_sat_divisions;
  const uint32_t vals = state->profile_val_divisions;
  const uint32_t map_entries = hues * sats * vals;
  const uint32_t full_value_count = map_entries * 3u;
  const uint32_t skipped_value_count = hues * (sats - 1u) * vals * 3u;
  const int skip_sat_zero = entry->count == skipped_value_count;
  if (!skip_sat_zero && entry->count != full_value_count) {
    return 0;
  }
  float* const map =
      (float*)malloc((size_t)map_entries * 3u * sizeof(float));
  if (map == NULL) {
    return 0;
  }
  for (uint32_t index = 0; index < map_entries; index++) {
    map[index * 3u] = 0.0f;
    map[index * 3u + 1u] = 1.0f;
    map[index * 3u + 2u] = 1.0f;
  }
  uint32_t source = 0u;
  int valid = 1;
  for (uint32_t val = 0; val < vals && valid; val++) {
    for (uint32_t hue = 0; hue < hues && valid; hue++) {
      for (uint32_t sat = skip_sat_zero ? 1u : 0u;
           sat < sats; sat++) {
        double hue_shift = 0.0;
        double sat_scale = 0.0;
        double val_scale = 0.0;
        if (!entry_number(reader, entry, source++, &hue_shift) ||
            !entry_number(reader, entry, source++, &sat_scale) ||
            !entry_number(reader, entry, source++, &val_scale) ||
            hue_shift < -3600.0 || hue_shift > 3600.0 ||
            sat_scale < 0.0 || sat_scale > 64.0 ||
            val_scale < 0.0 || val_scale > 64.0 ||
            (sat == 0u && val_scale != 1.0)) {
          valid = 0;
          break;
        }
        const uint32_t destination =
            ((val * hues + hue) * sats + sat) * 3u;
        map[destination] = (float)hue_shift;
        map[destination + 1u] = (float)sat_scale;
        map[destination + 2u] = (float)val_scale;
      }
    }
  }
  if (!valid || source != entry->count) {
    free(map);
    return 0;
  }
  if (skip_sat_zero) {
    /* Adobe DNG SDK ReadHueSatMap/SetDelta extrapolates the first stored
       saturation entry into saturation zero. Value scale alone is forced to
       one so gray remains gray while hue/saturation changes stay continuous
       as saturation approaches zero. */
    for (uint32_t val = 0; val < vals; val++) {
      for (uint32_t hue = 0; hue < hues; hue++) {
        const uint32_t zero = ((val * hues + hue) * sats) * 3u;
        const uint32_t first = zero + 3u;
        map[zero] = map[first];
        map[zero + 1u] = map[first + 1u];
        map[zero + 2u] = 1.0f;
      }
    }
  }
  float** destination = slot == 1u
      ? &state->profile_hue_sat_map_1
      : (slot == 2u ? &state->profile_hue_sat_map_2
                    : &state->profile_hue_sat_map_3);
  free(*destination);
  *destination = map;
  return 1;
}

static int read_profile_look_table_dims(DngReader* reader,
                                        const TiffEntry* entry,
                                        DngParseState* state) {
  uint32_t dimensions[3] = {0u, 0u, 1u};
  if (reader == NULL || entry == NULL || state == NULL ||
      entry->type != kTiffTypeLong ||
      (entry->count != 2u && entry->count != 3u) ||
      !read_unsigned_values(reader, entry, entry->count, dimensions) ||
      dimensions[0] == 0u ||
      dimensions[0] > kMaximumProfileHueDivisions ||
      dimensions[1] < 2u ||
      dimensions[1] > kMaximumProfileSatDivisions ||
      dimensions[2] == 0u ||
      dimensions[2] > kMaximumProfileValDivisions) {
    return 0;
  }
  const uint64_t entry_count = (uint64_t)dimensions[0] * dimensions[1] *
      dimensions[2];
  if (entry_count > kMaximumProfileHueSatMapEntries) {
    return 0;
  }
  if (state->has_profile_look_table_dims &&
      (state->profile_look_hue_divisions != dimensions[0] ||
       state->profile_look_sat_divisions != dimensions[1] ||
       state->profile_look_val_divisions != dimensions[2])) {
    return 0;
  }
  state->has_profile_look_table_dims = 1;
  state->profile_look_hue_divisions = dimensions[0];
  state->profile_look_sat_divisions = dimensions[1];
  state->profile_look_val_divisions = dimensions[2];
  return 1;
}

static int read_profile_look_table(DngReader* reader,
                                   const TiffEntry* entry,
                                   DngParseState* state) {
  if (reader == NULL || entry == NULL || state == NULL ||
      !state->has_profile_look_table_dims ||
      entry->type != kTiffTypeFloat) {
    return 0;
  }
  const uint32_t hues = state->profile_look_hue_divisions;
  const uint32_t sats = state->profile_look_sat_divisions;
  const uint32_t vals = state->profile_look_val_divisions;
  const uint32_t map_entries = hues * sats * vals;
  const uint32_t full_value_count = map_entries * 3u;
  const uint32_t skipped_value_count = hues * (sats - 1u) * vals * 3u;
  const int skip_sat_zero = entry->count == skipped_value_count;
  if (!skip_sat_zero && entry->count != full_value_count) {
    return 0;
  }
  float* const table =
      (float*)malloc((size_t)map_entries * 3u * sizeof(float));
  if (table == NULL) {
    return 0;
  }
  memset(table, 0, (size_t)map_entries * 3u * sizeof(float));
  uint32_t source = 0u;
  int valid = 1;
  for (uint32_t val = 0; val < vals && valid; val++) {
    for (uint32_t hue = 0; hue < hues && valid; hue++) {
      for (uint32_t sat = skip_sat_zero ? 1u : 0u;
           sat < sats; sat++) {
        double hue_shift = 0.0;
        double sat_scale = 0.0;
        double val_scale = 0.0;
        if (!entry_number(reader, entry, source++, &hue_shift) ||
            !entry_number(reader, entry, source++, &sat_scale) ||
            !entry_number(reader, entry, source++, &val_scale) ||
            hue_shift < -3600.0 || hue_shift > 3600.0 ||
            sat_scale < 0.0 || sat_scale > 64.0 ||
            val_scale < 0.0 || val_scale > 64.0 ||
            (sat == 0u && val_scale != 1.0)) {
          valid = 0;
          break;
        }
        const uint32_t destination =
            ((val * hues + hue) * sats + sat) * 3u;
        table[destination] = (float)hue_shift;
        table[destination + 1u] = (float)sat_scale;
        table[destination + 2u] = (float)val_scale;
      }
    }
  }
  if (!valid || source != entry->count) {
    free(table);
    return 0;
  }
  if (skip_sat_zero) {
    for (uint32_t val = 0; val < vals; val++) {
      for (uint32_t hue = 0; hue < hues; hue++) {
        const uint32_t zero = ((val * hues + hue) * sats) * 3u;
        const uint32_t first = zero + 3u;
        table[zero] = table[first];
        table[zero + 1u] = table[first + 1u];
        table[zero + 2u] = 1.0f;
      }
    }
  }
  free(state->profile_look_table);
  state->profile_look_table = table;
  return 1;
}

static int read_illuminant_bytes(DngReader* reader,
                                 const TiffEntry* entry,
                                 uint32_t offset,
                                 uint8_t* bytes_out,
                                 uint32_t length) {
  if (reader == NULL || entry == NULL || bytes_out == NULL ||
      offset > entry->count || length > entry->count - offset) {
    return 0;
  }
  for (uint32_t index = 0; index < length; index++) {
    if (!entry_element_bytes(reader, entry, offset + index,
                             bytes_out + index, 1u)) {
      return 0;
    }
  }
  return 1;
}

static int read_illuminant_rational(DngReader* reader,
                                    const TiffEntry* entry,
                                    uint32_t offset,
                                    double* value_out) {
  uint8_t bytes[8];
  if (value_out == NULL ||
      !read_illuminant_bytes(reader, entry, offset, bytes,
                             sizeof(bytes))) {
    return 0;
  }
  const uint32_t numerator = read_u32(reader, bytes);
  const uint32_t denominator = read_u32(reader, bytes + 4u);
  if (denominator == 0u) {
    return 0;
  }
  *value_out = (double)numerator / (double)denominator;
  return isfinite(*value_out);
}

static double sample_piecewise_linear_spectrum(const double* samples,
                                                uint32_t sample_count,
                                                double min_lambda,
                                                double spacing,
                                                double lambda) {
  const double max_lambda =
      min_lambda + spacing * (double)(sample_count - 1u);
  if (lambda <= min_lambda) {
    return samples[0];
  }
  if (lambda >= max_lambda) {
    return samples[sample_count - 1u];
  }
  const double position = (lambda - min_lambda) / spacing;
  uint32_t lower = (uint32_t)floor(position);
  if (lower >= sample_count - 1u) {
    return samples[sample_count - 1u];
  }
  const double fraction = position - (double)lower;
  return samples[lower] * (1.0 - fraction) +
         samples[lower + 1u] * fraction;
}

static int spectrum_to_white_xy(const double* samples,
                                uint32_t sample_count,
                                double min_lambda,
                                double spacing,
                                double xy_out[2]) {
  if (samples == NULL || xy_out == NULL ||
      sample_count < kMinimumIlluminantSpectrumSamples ||
      sample_count > kMaximumIlluminantSpectrumSamples ||
      !isfinite(min_lambda) || min_lambda <= 0.0 ||
      !isfinite(spacing) || spacing <= 0.0) {
    return 0;
  }
  const double max_lambda =
      min_lambda + spacing * (double)(sample_count - 1u);
  if (!isfinite(max_lambda) || max_lambda <= min_lambda) {
    return 0;
  }

  double xyz[3] = {0.0, 0.0, 0.0};
  double observer_sum[3] = {0.0, 0.0, 0.0};
  for (uint32_t index = 0; index < kCieObserverSampleCount; index++) {
    const double lambda = (double)(kCieObserverFirstNm + index);
    const double light = sample_piecewise_linear_spectrum(
        samples, sample_count, min_lambda, spacing, lambda);
    if (!isfinite(light) || light < 0.0) {
      return 0;
    }
    for (uint32_t channel = 0; channel < 3u; channel++) {
      const double observer =
          kCie1931StandardObserver2Degree[index][channel];
      observer_sum[channel] += observer;
      xyz[channel] += observer * light;
    }
  }
  for (uint32_t channel = 0; channel < 3u; channel++) {
    if (!isfinite(observer_sum[channel]) || observer_sum[channel] <= 0.0) {
      return 0;
    }
    xyz[channel] /= observer_sum[channel];
    if (!isfinite(xyz[channel]) || xyz[channel] <= 0.0) {
      return 0;
    }
  }
  const double total = xyz[0] + xyz[1] + xyz[2];
  if (!isfinite(total) || total <= 0.0) {
    return 0;
  }
  xy_out[0] = xyz[0] / total;
  xy_out[1] = xyz[1] / total;
  return isfinite(xy_out[0]) && isfinite(xy_out[1]) &&
         xy_out[0] > 0.0 && xy_out[1] > 0.0 &&
         xy_out[0] + xy_out[1] < 1.0;
}

static int read_illuminant_xy(DngReader* reader,
                              const TiffEntry* entry,
                              double xy_out[2]) {
  uint8_t header[6];
  if (reader == NULL || entry == NULL || xy_out == NULL ||
      entry->type != kTiffTypeUndefined || entry->count < 2u ||
      !read_illuminant_bytes(reader, entry, 0u, header, 2u)) {
    return 0;
  }
  const uint16_t data_type = read_u16(reader, header);
  if (data_type == 0u) {
    double x = 0.0;
    double y = 0.0;
    if (entry->count < 18u ||
        !read_illuminant_rational(reader, entry, 2u, &x) ||
        !read_illuminant_rational(reader, entry, 10u, &y) ||
        x <= 0.0 || y <= 0.0 || x + y >= 1.0) {
      return 0;
    }
    xy_out[0] = x;
    xy_out[1] = y;
    return 1;
  }
  if (data_type != 1u || entry->count < 22u ||
      !read_illuminant_bytes(reader, entry, 2u, header + 2u, 4u)) {
    return 0;
  }
  const uint32_t sample_count = read_u32(reader, header + 2u);
  if (sample_count < kMinimumIlluminantSpectrumSamples ||
      sample_count > kMaximumIlluminantSpectrumSamples ||
      sample_count > (UINT32_MAX - 22u) / 8u) {
    return 0;
  }
  const uint32_t required_bytes = 22u + sample_count * 8u;
  if (entry->count < required_bytes) {
    return 0;
  }
  double min_lambda = 0.0;
  double spacing = 0.0;
  if (!read_illuminant_rational(reader, entry, 6u, &min_lambda) ||
      !read_illuminant_rational(reader, entry, 14u, &spacing) ||
      min_lambda <= 0.0 || spacing <= 0.0) {
    return 0;
  }
  double* const samples =
      (double*)malloc((size_t)sample_count * sizeof(double));
  if (samples == NULL) {
    return 0;
  }
  int valid = 1;
  for (uint32_t index = 0; index < sample_count; index++) {
    if (!read_illuminant_rational(reader, entry,
                                  22u + index * 8u,
                                  samples + index) ||
        samples[index] < 0.0) {
      valid = 0;
      break;
    }
  }
  if (valid) {
    valid = spectrum_to_white_xy(samples, sample_count, min_lambda,
                                 spacing, xy_out);
  }
  free(samples);
  return valid;
}

static int calibration_signatures_match(const DngParseState* state) {
  if (state->camera_calibration_signature_length !=
      state->profile_calibration_signature_length) {
    return 0;
  }
  return memcmp(state->camera_calibration_signature,
                state->profile_calibration_signature,
                state->camera_calibration_signature_length) == 0;
}

static int matrix3_is_safely_invertible(const double matrix[9]) {
  double scale = 0.0;
  for (uint32_t index = 0; index < 9; index++) {
    if (!isfinite(matrix[index])) {
      return 0;
    }
    const double magnitude = fabs(matrix[index]);
    if (magnitude > scale) {
      scale = magnitude;
    }
  }
  const double determinant =
      matrix[0] * (matrix[4] * matrix[8] - matrix[5] * matrix[7]) +
      matrix[1] * (matrix[5] * matrix[6] - matrix[3] * matrix[8]) +
      matrix[2] * (matrix[3] * matrix[7] - matrix[4] * matrix[6]);
  const double relative_threshold = scale * scale * scale * 1e-12;
  return isfinite(determinant) && isfinite(relative_threshold) &&
         fabs(determinant) > relative_threshold;
}

static int matrix3_inverse(const double matrix[9], double inverse_out[9]) {
  const double a = matrix[0];
  const double b = matrix[1];
  const double c = matrix[2];
  const double d = matrix[3];
  const double e = matrix[4];
  const double f = matrix[5];
  const double g = matrix[6];
  const double h = matrix[7];
  const double i = matrix[8];
  const double determinant =
      a * (e * i - f * h) + b * (f * g - d * i) +
      c * (d * h - e * g);
  if (!isfinite(determinant) || fabs(determinant) <= 1e-15 ||
      inverse_out == NULL) {
    return 0;
  }
  const double reciprocal = 1.0 / determinant;
  const double inverse[9] = {
      (e * i - f * h) * reciprocal,
      (c * h - b * i) * reciprocal,
      (b * f - c * e) * reciprocal,
      (f * g - d * i) * reciprocal,
      (a * i - c * g) * reciprocal,
      (c * d - a * f) * reciprocal,
      (d * h - e * g) * reciprocal,
      (b * g - a * h) * reciprocal,
      (a * e - b * d) * reciprocal,
  };
  memcpy(inverse_out, inverse, sizeof(inverse));
  return 1;
}

static void matrix3_multiply(const double left[9],
                             const double right[9],
                             double product_out[9]) {
  for (uint32_t row = 0; row < 3; row++) {
    for (uint32_t column = 0; column < 3; column++) {
      double value = 0.0;
      for (uint32_t inner = 0; inner < 3; inner++) {
        value += left[row * 3u + inner] *
                 right[inner * 3u + column];
      }
      product_out[row * 3u + column] = value;
    }
  }
}

static void matrix3_vector_multiply(const double matrix[9],
                                    const double vector[3],
                                    double product_out[3]) {
  for (uint32_t row = 0; row < 3; row++) {
    product_out[row] = matrix[row * 3u] * vector[0] +
                       matrix[row * 3u + 1u] * vector[1] +
                       matrix[row * 3u + 2u] * vector[2];
  }
}

static int light_source_white(uint32_t illuminant,
                              double* temperature_out,
                              double xy_out[2]) {
  double temperature = 0.0;
  double x = 0.0;
  double y = 0.0;
  switch (illuminant) {
    case kLightSourceStandardA:
      temperature = 2850.0;
      x = 0.4476;
      y = 0.4074;
      break;
    case kLightSourceD50:
      temperature = 5000.0;
      x = 0.3457;
      y = 0.3585;
      break;
    case kLightSourceD55:
      temperature = 5500.0;
      x = 0.3324;
      y = 0.3474;
      break;
    case kLightSourceD65:
      temperature = 6500.0;
      x = 0.3127;
      y = 0.3290;
      break;
    case kLightSourceD75:
      temperature = 7500.0;
      x = 0.2990;
      y = 0.3149;
      break;
    default:
      return 0;
  }
  if (temperature_out != NULL) {
    *temperature_out = temperature;
  }
  if (xy_out != NULL) {
    xy_out[0] = x;
    xy_out[1] = y;
  }
  return 1;
}

/* Robertson reciprocal-temperature and tint model used by Adobe DNG SDK. */
static int color_temperature_and_tint(double x,
                                      double y,
                                      double* temperature_out,
                                      double* tint_out) {
  static const double table[31][4] = {
      {0, .18006, .26352, -.24341}, {10, .18066, .26589, -.25479},
      {20, .18133, .26846, -.26876}, {30, .18208, .27119, -.28539},
      {40, .18293, .27407, -.30470}, {50, .18388, .27709, -.32675},
      {60, .18494, .28021, -.35156}, {70, .18611, .28342, -.37915},
      {80, .18740, .28668, -.40955}, {90, .18880, .28997, -.44278},
      {100, .19032, .29326, -.47888}, {125, .19462, .30141, -.58204},
      {150, .19962, .30921, -.70471}, {175, .20525, .31647, -.84901},
      {200, .21142, .32312, -1.0182}, {225, .21807, .32909, -1.2168},
      {250, .22511, .33439, -1.4512}, {275, .23247, .33904, -1.7298},
      {300, .24010, .34308, -2.0637}, {325, .24702, .34655, -2.4681},
      {350, .25591, .34951, -2.9641}, {375, .26400, .35200, -3.5814},
      {400, .27218, .35407, -4.3633}, {425, .28039, .35577, -5.3762},
      {450, .28863, .35714, -6.7262}, {475, .29685, .35823, -8.5955},
      {500, .30505, .35907, -11.324}, {525, .31320, .35968, -15.628},
      {550, .32129, .36011, -23.325}, {575, .32931, .36038, -40.770},
      {600, .33724, .36051, -116.45},
  };
  const double denominator = 1.5 - x + 6.0 * y;
  if (!isfinite(x) || !isfinite(y) || denominator <= 0.0) {
    return 0;
  }
  const double u = 2.0 * x / denominator;
  const double v = 3.0 * y / denominator;
  double last_distance = 0.0;
  double last_du = 0.0;
  double last_dv = 0.0;
  for (uint32_t index = 1; index <= 30; index++) {
    double du = 1.0;
    double dv = table[index][3];
    const double length = sqrt(1.0 + dv * dv);
    du /= length;
    dv /= length;
    double distance = -(u - table[index][1]) * dv +
                      (v - table[index][2]) * du;
    if (distance <= 0.0 || index == 30u) {
      if (distance > 0.0) {
        distance = 0.0;
      }
      distance = -distance;
      const double fraction = index == 1u
          ? 0.0
          : distance / (last_distance + distance);
      const double reciprocal = table[index - 1u][0] * fraction +
                                table[index][0] * (1.0 - fraction);
      const double temperature = reciprocal > 0.0
          ? 1.0e6 / reciprocal
          : 1.0e12;
      const double uu = u - (table[index - 1u][1] * fraction +
                             table[index][1] * (1.0 - fraction));
      const double vv = v - (table[index - 1u][2] * fraction +
                             table[index][2] * (1.0 - fraction));
      du = du * (1.0 - fraction) + last_du * fraction;
      dv = dv * (1.0 - fraction) + last_dv * fraction;
      const double direction_length = sqrt(du * du + dv * dv);
      if (!isfinite(temperature) || temperature <= 0.0 ||
          !isfinite(direction_length) || direction_length <= 0.0) {
        return 0;
      }
      du /= direction_length;
      dv /= direction_length;
      const double tint = (uu * du + vv * dv) * -3000.0;
      if (!isfinite(tint)) {
        return 0;
      }
      if (temperature_out != NULL) {
        *temperature_out = temperature;
      }
      if (tint_out != NULL) {
        *tint_out = tint;
      }
      return 1;
    }
    last_distance = distance;
    last_du = du;
    last_dv = dv;
  }
  return 0;
}

static double correlated_color_temperature(double x, double y) {
  double temperature = 0.0;
  return color_temperature_and_tint(x, y, &temperature, NULL)
      ? temperature
      : 0.0;
}

static int build_linear_bradford_d65_to_xy(const double xy[2],
                                            double matrix_out[9]) {
  static const double bradford[9] = {
      0.8951, 0.2664, -0.1614,
      -0.7502, 1.7135, 0.0367,
      0.0389, -0.0685, 1.0296,
  };
  static const double d65_xyz[3] = {
      0.3127 / 0.3290,
      1.0,
      (1.0 - 0.3127 - 0.3290) / 0.3290,
  };
  double destination_xyz[3];
  double inverse_bradford[9];
  double source_cone[3] = {0.0, 0.0, 0.0};
  double destination_cone[3] = {0.0, 0.0, 0.0};
  double scaled_bradford[9];
  if (matrix_out == NULL || xy == NULL || !isfinite(xy[0]) ||
      !isfinite(xy[1]) || xy[1] <= 0.0 || xy[0] <= 0.0 ||
      xy[0] + xy[1] >= 1.0 ||
      !matrix3_inverse(bradford, inverse_bradford)) {
    return 0;
  }
  destination_xyz[0] = xy[0] / xy[1];
  destination_xyz[1] = 1.0;
  destination_xyz[2] = (1.0 - xy[0] - xy[1]) / xy[1];
  for (uint32_t row = 0; row < 3; row++) {
    for (uint32_t column = 0; column < 3; column++) {
      source_cone[row] += bradford[row * 3u + column] * d65_xyz[column];
      destination_cone[row] +=
          bradford[row * 3u + column] * destination_xyz[column];
    }
    if (!isfinite(source_cone[row]) || source_cone[row] <= 0.0 ||
        !isfinite(destination_cone[row]) ||
        destination_cone[row] < 0.0) {
      return 0;
    }
    double scale = destination_cone[row] / source_cone[row];
    if (scale < 0.1) {
      scale = 0.1;
    } else if (scale > 10.0) {
      scale = 10.0;
    }
    for (uint32_t column = 0; column < 3; column++) {
      scaled_bradford[row * 3u + column] =
          scale * bradford[row * 3u + column];
    }
  }
  matrix3_multiply(inverse_bradford, scaled_bradford, matrix_out);
  return 1;
}

static int profile_illuminant_white(const DngParseState* state,
                                    uint32_t slot,
                                    double* temperature_out,
                                    double xy_out[2]) {
  uint32_t illuminant = 0u;
  int has_data = 0;
  const double* xy = NULL;
  switch (slot) {
    case 1u:
      illuminant = state->calibration_illuminant_1;
      has_data = state->has_illuminant_data_1;
      xy = state->illuminant_data_1_xy;
      break;
    case 2u:
      illuminant = state->calibration_illuminant_2;
      has_data = state->has_illuminant_data_2;
      xy = state->illuminant_data_2_xy;
      break;
    case 3u:
      illuminant = state->calibration_illuminant_3;
      has_data = state->has_illuminant_data_3;
      xy = state->illuminant_data_3_xy;
      break;
    default:
      return 0;
  }
  if (illuminant != kLightSourceOther) {
    return light_source_white(illuminant, temperature_out, xy_out);
  }
  if (!has_data) {
    return 0;
  }
  const double temperature = correlated_color_temperature(xy[0], xy[1]);
  if (!isfinite(temperature) || temperature <= 0.0) {
    return 0;
  }
  if (temperature_out != NULL) {
    *temperature_out = temperature;
  }
  if (xy_out != NULL) {
    xy_out[0] = xy[0];
    xy_out[1] = xy[1];
  }
  return 1;
}

static int profile_illuminants_equivalent(const DngParseState* state) {
  if (!state->has_calibration_illuminant_1 ||
      !state->has_calibration_illuminant_2 ||
      state->calibration_illuminant_1 !=
          state->calibration_illuminant_2) {
    return 0;
  }
  if (state->calibration_illuminant_1 != kLightSourceOther) {
    return 1;
  }
  return state->has_illuminant_data_1 &&
         state->has_illuminant_data_2 &&
         state->illuminant_data_1_xy[0] ==
             state->illuminant_data_2_xy[0] &&
         state->illuminant_data_1_xy[1] ==
             state->illuminant_data_2_xy[1];
}

static int triple_profile_illuminants_are_distinct(
    const DngParseState* state) {
  double xy[3][2];
  for (uint32_t slot = 1u; slot <= 3u; slot++) {
    if (!profile_illuminant_white(state, slot, NULL, xy[slot - 1u])) {
      return 0;
    }
  }
  for (uint32_t left = 0; left < 3u; left++) {
    for (uint32_t right = left + 1u; right < 3u; right++) {
      if (xy[left][0] == xy[right][0] &&
          xy[left][1] == xy[right][1]) {
        return 0;
      }
    }
  }
  return 1;
}

static int compose_profile_matrix(const DngParseState* state,
                                  uint32_t slot,
                                  double matrix_out[9]) {
  int has_color = 0;
  int has_illuminant = 0;
  int has_camera_calibration = 0;
  uint32_t illuminant = 0u;
  const double* color = NULL;
  const double* calibration = NULL;
  switch (slot) {
    case 1u:
      has_color = state->has_color_matrix_1;
      has_illuminant = state->has_calibration_illuminant_1;
      has_camera_calibration = state->has_camera_calibration_1;
      illuminant = state->calibration_illuminant_1;
      color = state->color_matrix_1;
      calibration = state->camera_calibration_1;
      break;
    case 2u:
      has_color = state->has_color_matrix_2;
      has_illuminant = state->has_calibration_illuminant_2;
      has_camera_calibration = state->has_camera_calibration_2;
      illuminant = state->calibration_illuminant_2;
      color = state->color_matrix_2;
      calibration = state->camera_calibration_2;
      break;
    case 3u:
      has_color = state->has_color_matrix_3;
      has_illuminant = state->has_calibration_illuminant_3;
      has_camera_calibration = state->has_camera_calibration_3;
      illuminant = state->calibration_illuminant_3;
      color = state->color_matrix_3;
      calibration = state->camera_calibration_3;
      break;
    default:
      return 0;
  }
  const int has_calibration = has_camera_calibration &&
      calibration_signatures_match(state);
  if (!has_color || !has_illuminant) {
    return 0;
  }
  if (!profile_illuminant_white(state, slot, NULL, NULL)) {
    return illuminant == kLightSourceOther ? -1 : 0;
  }
  for (uint32_t row = 0; row < 3; row++) {
    for (uint32_t column = 0; column < 3; column++) {
      double value = color[row * 3u + column];
      if (has_calibration) {
        value = 0.0;
        for (uint32_t inner = 0; inner < 3; inner++) {
          value += calibration[row * 3u + inner] *
                   color[inner * 3u + column];
        }
      }
      const double analog_gain = state->has_analog_balance
          ? state->analog_balance[row]
          : 1.0;
      matrix_out[row * 3u + column] = analog_gain * value;
    }
  }
  return matrix3_is_safely_invertible(matrix_out) ? 1 : -1;
}

static void interpolate_profile_matrix(const double matrix_1[9],
                                       const double matrix_2[9],
                                       double temperature_1,
                                       double temperature_2,
                                       double white_temperature,
                                       double matrix_out[9]) {
  double weight_1 = (1.0 / white_temperature - 1.0 / temperature_2) /
                    (1.0 / temperature_1 - 1.0 / temperature_2);
  if (weight_1 < 0.0) {
    weight_1 = 0.0;
  } else if (weight_1 > 1.0) {
    weight_1 = 1.0;
  }
  for (uint32_t index = 0; index < 9; index++) {
    matrix_out[index] = weight_1 * matrix_1[index] +
                        (1.0 - weight_1) * matrix_2[index];
  }
}


static int profile_components(const DngParseState* state,
                              uint32_t slot,
                              double color_out[9],
                              double calibration_out[9]) {
  int has_color = 0;
  int has_illuminant = 0;
  int has_camera_calibration = 0;
  uint32_t illuminant = 0u;
  const double* color = NULL;
  const double* calibration = NULL;
  switch (slot) {
    case 1u:
      has_color = state->has_color_matrix_1;
      has_illuminant = state->has_calibration_illuminant_1;
      has_camera_calibration = state->has_camera_calibration_1;
      illuminant = state->calibration_illuminant_1;
      color = state->color_matrix_1;
      calibration = state->camera_calibration_1;
      break;
    case 2u:
      has_color = state->has_color_matrix_2;
      has_illuminant = state->has_calibration_illuminant_2;
      has_camera_calibration = state->has_camera_calibration_2;
      illuminant = state->calibration_illuminant_2;
      color = state->color_matrix_2;
      calibration = state->camera_calibration_2;
      break;
    case 3u:
      has_color = state->has_color_matrix_3;
      has_illuminant = state->has_calibration_illuminant_3;
      has_camera_calibration = state->has_camera_calibration_3;
      illuminant = state->calibration_illuminant_3;
      color = state->color_matrix_3;
      calibration = state->camera_calibration_3;
      break;
    default:
      return 0;
  }
  if (!has_color || !has_illuminant) {
    return 0;
  }
  if (!profile_illuminant_white(state, slot, NULL, NULL)) {
    return illuminant == kLightSourceOther ? -1 : 0;
  }
  memcpy(color_out, color, sizeof(double) * 9u);
  const int use_calibration = has_camera_calibration &&
      calibration_signatures_match(state);
  for (uint32_t row = 0; row < 3u; row++) {
    for (uint32_t column = 0; column < 3u; column++) {
      calibration_out[row * 3u + column] = use_calibration
          ? calibration[row * 3u + column]
          : (row == column ? 1.0 : 0.0);
    }
  }
  return 1;
}

static int compose_interpolated_profile_matrix(
    const DngParseState* state,
    const double color[9],
    const double calibration[9],
    double matrix_out[9]) {
  double calibrated[9];
  matrix3_multiply(calibration, color, calibrated);
  for (uint32_t row = 0; row < 3u; row++) {
    const double analog_gain = state->has_analog_balance
        ? state->analog_balance[row]
        : 1.0;
    for (uint32_t column = 0; column < 3u; column++) {
      matrix_out[row * 3u + column] =
          analog_gain * calibrated[row * 3u + column];
    }
  }
  return matrix3_is_safely_invertible(matrix_out);
}

static int interpolate_dual_profile_components(
    const DngParseState* state,
    double temperature_1,
    double temperature_2,
    double white_temperature,
    double matrix_out[9]) {
  double color_1[9], color_2[9];
  double calibration_1[9], calibration_2[9];
  double color[9], calibration[9];
  if (profile_components(state, 1u, color_1, calibration_1) <= 0 ||
      profile_components(state, 2u, color_2, calibration_2) <= 0) {
    return 0;
  }
  interpolate_profile_matrix(color_1, color_2, temperature_1, temperature_2,
                             white_temperature, color);
  interpolate_profile_matrix(calibration_1, calibration_2, temperature_1,
                             temperature_2, white_temperature, calibration);
  return compose_interpolated_profile_matrix(state, color, calibration,
                                              matrix_out);
}

static int dual_illuminant_matrix(const DngParseState* state,
                                  double temperature_1,
                                  double temperature_2,
                                  double matrix_out[9],
                                  double white_xy_out[2]) {
  double last_xy[2] = {0.3457, 0.3585};
  if (!state->has_neutral || temperature_1 <= 0.0 ||
      temperature_2 <= 0.0 || temperature_1 == temperature_2) {
    return 0;
  }
  for (uint32_t pass = 0; pass < 30; pass++) {
    const double temperature = correlated_color_temperature(
        last_xy[0], last_xy[1]);
    double current[9];
    double inverse[9];
    double xyz[3];
    if (temperature <= 0.0) {
      return 0;
    }
    if (!interpolate_dual_profile_components(
            state, temperature_1, temperature_2, temperature, current)) {
      return 0;
    }
    if (!matrix3_is_safely_invertible(current) ||
        !matrix3_inverse(current, inverse)) {
      return 0;
    }
    matrix3_vector_multiply(inverse, state->neutral, xyz);
    const double sum = xyz[0] + xyz[1] + xyz[2];
    if (!isfinite(sum) || sum <= 0.0) {
      return 0;
    }
    double next_xy[2] = {xyz[0] / sum, xyz[1] / sum};
    if (!isfinite(next_xy[0]) || !isfinite(next_xy[1]) ||
        next_xy[0] <= 0.0 || next_xy[1] <= 0.0 ||
        next_xy[0] + next_xy[1] >= 1.0) {
      return 0;
    }
    if (fabs(next_xy[0] - last_xy[0]) +
        fabs(next_xy[1] - last_xy[1]) < 1.0e-7) {
      last_xy[0] = next_xy[0];
      last_xy[1] = next_xy[1];
      break;
    }
    if (pass == 29u) {
      next_xy[0] = 0.5 * (last_xy[0] + next_xy[0]);
      next_xy[1] = 0.5 * (last_xy[1] + next_xy[1]);
    }
    last_xy[0] = next_xy[0];
    last_xy[1] = next_xy[1];
  }
  const double final_temperature = correlated_color_temperature(
      last_xy[0], last_xy[1]);
  if (final_temperature <= 0.0) {
    return 0;
  }
  if (!interpolate_dual_profile_components(
          state, temperature_1, temperature_2, final_temperature,
          matrix_out)) {
    return 0;
  }
  white_xy_out[0] = last_xy[0];
  white_xy_out[1] = last_xy[1];
  return matrix3_is_safely_invertible(matrix_out);
}

static int triple_illuminant_weights(const DngParseState* state,
                                     const double white_xy[2],
                                     double weights_out[3]) {
  double points[4][2];
  double xy[2];
  if (state == NULL || white_xy == NULL || weights_out == NULL ||
      !color_temperature_and_tint(white_xy[0], white_xy[1],
                                  &points[0][0], &points[0][1])) {
    return 0;
  }
  for (uint32_t slot = 1u; slot <= 3u; slot++) {
    if (!profile_illuminant_white(state, slot, NULL, xy) ||
        !color_temperature_and_tint(xy[0], xy[1],
                                    &points[slot][0],
                                    &points[slot][1])) {
      return 0;
    }
  }
  for (uint32_t index = 0; index < 4u; index++) {
    points[index][0] = 1500.0 / points[index][0];
    if (points[index][0] > 1.0) {
      points[index][0] = 1.0;
    }
    points[index][1] /= 200.0;
  }
  double sum = 0.0;
  for (uint32_t index = 0; index < 3u; index++) {
    const double delta_temperature =
        points[0][0] - points[index + 1u][0];
    const double delta_tint = points[0][1] - points[index + 1u][1];
    const double distance_squared =
        delta_temperature * delta_temperature + delta_tint * delta_tint;
    weights_out[index] = 1.0 / (distance_squared + 1.0e-8);
    sum += weights_out[index];
  }
  if (!isfinite(sum) || sum <= 0.0) {
    return 0;
  }
  const double raw_sum = sum;
  sum = 0.0;
  for (uint32_t index = 0; index < 3u; index++) {
    double weight = weights_out[index] / raw_sum;
    weight = weight * weight * (3.0 - 2.0 * weight);
    weight = (weight - 0.02) / 0.98;
    if (weight < 0.0) {
      weight = 0.0;
    } else if (weight > 1.0) {
      weight = 1.0;
    }
    weights_out[index] = weight;
    sum += weight;
  }
  if (!isfinite(sum) || sum <= 0.0) {
    return 0;
  }
  weights_out[0] /= sum;
  weights_out[1] /= sum;
  weights_out[2] = 1.0 - weights_out[0] - weights_out[1];
  if (weights_out[2] < 0.0) {
    weights_out[2] = 0.0;
  }
  return isfinite(weights_out[0]) && isfinite(weights_out[1]) &&
         isfinite(weights_out[2]);
}

static int interpolate_triple_profile_components(
    const DngParseState* state,
    const double white_xy[2],
    double matrix_out[9]) {
  double weights[3];
  double colors[3][9];
  double calibrations[3][9];
  double color[9];
  double calibration[9];
  if (!triple_illuminant_weights(state, white_xy, weights)) {
    return 0;
  }
  for (uint32_t slot = 0u; slot < 3u; slot++) {
    if (profile_components(state, slot + 1u, colors[slot],
                           calibrations[slot]) <= 0) {
      return 0;
    }
  }
  for (uint32_t index = 0; index < 9u; index++) {
    color[index] = weights[0] * colors[0][index] +
                   weights[1] * colors[1][index] +
                   weights[2] * colors[2][index];
    calibration[index] = weights[0] * calibrations[0][index] +
                         weights[1] * calibrations[1][index] +
                         weights[2] * calibrations[2][index];
  }
  return compose_interpolated_profile_matrix(state, color, calibration,
                                              matrix_out);
}


static int forward_profile_components(const DngParseState* state,
                                      uint32_t slot,
                                      double forward_out[9],
                                      double calibration_out[9]) {
  const double* forward = NULL;
  const double* calibration = NULL;
  int has_forward = 0;
  int has_calibration = 0;
  switch (slot) {
    case 1u:
      has_forward = state->has_forward_matrix_1;
      forward = state->forward_matrix_1;
      has_calibration = state->has_camera_calibration_1;
      calibration = state->camera_calibration_1;
      break;
    case 2u:
      has_forward = state->has_forward_matrix_2;
      forward = state->forward_matrix_2;
      has_calibration = state->has_camera_calibration_2;
      calibration = state->camera_calibration_2;
      break;
    case 3u:
      has_forward = state->has_forward_matrix_3;
      forward = state->forward_matrix_3;
      has_calibration = state->has_camera_calibration_3;
      calibration = state->camera_calibration_3;
      break;
    default:
      return 0;
  }
  if (!has_forward) return 0;
  memcpy(forward_out, forward, sizeof(double) * 9u);
  const int use_calibration = has_calibration &&
      calibration_signatures_match(state);
  for (uint32_t row = 0u; row < 3u; row++) {
    for (uint32_t column = 0u; column < 3u; column++) {
      calibration_out[row * 3u + column] = use_calibration
          ? calibration[row * 3u + column]
          : (row == column ? 1.0 : 0.0);
    }
  }
  return 1;
}

/* Build the DNG 1.2+ ForwardMatrix camera-to-XYZ(D50) transform for the
 * selected white. The DNG formula is:
 *   CameraToXYZ_D50 = FM * D * Inverse(AB * CC)
 * where D is derived from the selected CameraNeutral. */
static int build_forward_camera_to_d50(
    const DngParseState* state,
    const double white_xy[2],
    const double xyz_to_camera_at_white[9],
    double camera_to_d50_out[9]) {
  const int any_forward = state->has_forward_matrix_1 ||
      state->has_forward_matrix_2 || state->has_forward_matrix_3;
  if (!any_forward) return 0;

  const int triple = state->has_color_matrix_3 ||
      state->has_camera_calibration_3 ||
      state->has_calibration_illuminant_3 ||
      state->has_illuminant_data_3 ||
      state->has_forward_matrix_3;
  if (triple && !(state->has_forward_matrix_1 &&
                  state->has_forward_matrix_2 &&
                  state->has_forward_matrix_3)) {
    return -1;
  }

  double fm[9];
  double cc[9];
  int have = 0;
  if (triple) {
    double weights[3];
    double fms[3][9];
    double ccs[3][9];
    if (!triple_illuminant_weights(state, white_xy, weights)) return -1;
    for (uint32_t slot = 0u; slot < 3u; slot++) {
      if (!forward_profile_components(state, slot + 1u,
                                      fms[slot], ccs[slot])) {
        return -1;
      }
    }
    for (uint32_t i = 0u; i < 9u; i++) {
      fm[i] = weights[0] * fms[0][i] +
              weights[1] * fms[1][i] +
              weights[2] * fms[2][i];
      cc[i] = weights[0] * ccs[0][i] +
              weights[1] * ccs[1][i] +
              weights[2] * ccs[2][i];
    }
    have = 1;
  } else if (state->has_forward_matrix_1 && state->has_forward_matrix_2) {
    double t1 = 0.0, t2 = 0.0;
    double fm1[9], fm2[9], cc1[9], cc2[9];
    if (!forward_profile_components(state, 1u, fm1, cc1) ||
        !forward_profile_components(state, 2u, fm2, cc2)) return -1;
    if (profile_illuminant_white(state, 1u, &t1, NULL) &&
        profile_illuminant_white(state, 2u, &t2, NULL) &&
        t1 > 0.0 && t2 > 0.0 && t1 != t2) {
      const double tw = correlated_color_temperature(white_xy[0], white_xy[1]);
      if (!(tw > 0.0)) return -1;
      interpolate_profile_matrix(fm1, fm2, t1, t2, tw, fm);
      interpolate_profile_matrix(cc1, cc2, t1, t2, tw, cc);
    } else {
      memcpy(fm, fm1, sizeof(fm));
      memcpy(cc, cc1, sizeof(cc));
    }
    have = 1;
  } else if (state->has_forward_matrix_1) {
    have = forward_profile_components(state, 1u, fm, cc);
  } else if (state->has_forward_matrix_2) {
    have = forward_profile_components(state, 2u, fm, cc);
  }
  if (!have) return 0;

  double abcc[9];
  for (uint32_t row = 0u; row < 3u; row++) {
    const double analog = state->has_analog_balance
        ? state->analog_balance[row] : 1.0;
    for (uint32_t column = 0u; column < 3u; column++) {
      abcc[row * 3u + column] = analog * cc[row * 3u + column];
    }
  }
  double inv_abcc[9];
  if (!matrix3_is_safely_invertible(abcc) ||
      !matrix3_inverse(abcc, inv_abcc)) return -1;

  double camera_neutral[3];
  if (state->has_neutral) {
    memcpy(camera_neutral, state->neutral, sizeof(camera_neutral));
  } else {
    const double xyz_white[3] = {
      white_xy[0] / white_xy[1],
      1.0,
      (1.0 - white_xy[0] - white_xy[1]) / white_xy[1],
    };
    matrix3_vector_multiply(xyz_to_camera_at_white, xyz_white,
                            camera_neutral);
  }
  for (uint32_t i = 0u; i < 3u; i++) {
    if (!isfinite(camera_neutral[i]) || camera_neutral[i] <= 0.0) return -1;
  }

  double reference_neutral[3];
  matrix3_vector_multiply(inv_abcc, camera_neutral, reference_neutral);
  for (uint32_t i = 0u; i < 3u; i++) {
    if (!isfinite(reference_neutral[i]) || reference_neutral[i] <= 0.0) {
      return -1;
    }
  }

  double fm_times_d[9];
  for (uint32_t row = 0u; row < 3u; row++) {
    for (uint32_t column = 0u; column < 3u; column++) {
      fm_times_d[row * 3u + column] =
          fm[row * 3u + column] / reference_neutral[column];
    }
  }
  matrix3_multiply(fm_times_d, inv_abcc, camera_to_d50_out);
  return matrix3_is_safely_invertible(camera_to_d50_out) ? 1 : -1;
}

static int triple_illuminant_matrix(const DngParseState* state,
                                    double matrix_out[9],
                                    double white_xy_out[2]) {
  double last_xy[2] = {0.3457, 0.3585};
  if (state == NULL || !state->has_neutral) {
    return 0;
  }
  for (uint32_t pass = 0; pass < 30u; pass++) {
    double current[9];
    double inverse[9];
    double xyz[3];
    if (!interpolate_triple_profile_components(state, last_xy, current) ||
        !matrix3_inverse(current, inverse)) {
      return 0;
    }
    matrix3_vector_multiply(inverse, state->neutral, xyz);
    const double sum = xyz[0] + xyz[1] + xyz[2];
    if (!isfinite(sum) || sum <= 0.0) {
      return 0;
    }
    double next_xy[2] = {xyz[0] / sum, xyz[1] / sum};
    if (!isfinite(next_xy[0]) || !isfinite(next_xy[1]) ||
        next_xy[0] <= 0.0 || next_xy[1] <= 0.0 ||
        next_xy[0] + next_xy[1] >= 1.0) {
      return 0;
    }
    if (fabs(next_xy[0] - last_xy[0]) +
        fabs(next_xy[1] - last_xy[1]) < 1.0e-7) {
      last_xy[0] = next_xy[0];
      last_xy[1] = next_xy[1];
      break;
    }
    if (pass == 29u) {
      next_xy[0] = 0.5 * (last_xy[0] + next_xy[0]);
      next_xy[1] = 0.5 * (last_xy[1] + next_xy[1]);
    }
    last_xy[0] = next_xy[0];
    last_xy[1] = next_xy[1];
  }
  if (!interpolate_triple_profile_components(state, last_xy, matrix_out)) {
    return 0;
  }
  white_xy_out[0] = last_xy[0];
  white_xy_out[1] = last_xy[1];
  return 1;
}

static void initialize_ifd(DngIfd* ifd) {
  memset(ifd, 0, sizeof(*ifd));
  ifd->orientation = 1;
  ifd->samples_per_pixel = 1;
  ifd->cfa_plane_colors[0] = 0;
  ifd->cfa_plane_colors[1] = 1;
  ifd->cfa_plane_colors[2] = 2;
  ifd->black_repeat[0] = 1;
  ifd->black_repeat[1] = 1;
}

static void release_ifd(DngIfd* ifd) {
  if (ifd == NULL) return;
  free(ifd->linearization_table);
  free(ifd->black_level_delta_h);
  free(ifd->black_level_delta_v);
  ifd->linearization_table = NULL;
  ifd->black_level_delta_h = NULL;
  ifd->black_level_delta_v = NULL;
}

static int parse_ifd_entry(DngReader* reader,
                           const TiffEntry* entry,
                           DngIfd* ifd,
                           DngParseState* state) {
  uint32_t value = 0;
  switch (entry->tag) {
    case kTagNewSubFileType:
      if (!entry_unsigned(reader, entry, 0, &ifd->new_subfile_type)) {
        return 0;
      }
      ifd->has_new_subfile_type = 1;
      return 1;
    case kTagImageWidth:
      if (!entry_unsigned(reader, entry, 0, &ifd->width)) {
        return 0;
      }
      ifd->has_width = 1;
      return 1;
    case kTagImageLength:
      if (!entry_unsigned(reader, entry, 0, &ifd->height)) {
        return 0;
      }
      ifd->has_height = 1;
      return 1;
    case kTagBitsPerSample:
      if (!entry_unsigned(reader, entry, 0, &ifd->bits_per_sample)) {
        return 0;
      }
      ifd->has_bits_per_sample = 1;
      return 1;
    case kTagPhotometricInterpretation:
      if (!entry_unsigned(reader, entry, 0, &ifd->photometric)) {
        return 0;
      }
      ifd->has_photometric = 1;
      return 1;
    case kTagOrientation:
      if (!entry_unsigned(reader, entry, 0, &value) ||
          value < 1 || value > 8) {
        return 0;
      }
      ifd->orientation = value;
      ifd->has_orientation = 1;
      if (!state->has_orientation) {
        state->has_orientation = 1;
        state->orientation = value;
      }
      return 1;
    case kTagSamplesPerPixel:
      if (!entry_unsigned(reader, entry, 0, &ifd->samples_per_pixel)) {
        return 0;
      }
      ifd->has_samples_per_pixel = 1;
      return 1;
    case kTagSubIfds:
      if ((entry->type != kTiffTypeLong &&
           entry->type != kTiffTypeIfd) ||
          entry->count > kMaximumSubIfds) {
        return 0;
      }
      ifd->sub_ifd_count = entry->count;
      for (uint32_t index = 0; index < entry->count; index++) {
        if (!entry_unsigned(reader, entry, index,
                            ifd->sub_ifds + index)) {
          return 0;
        }
      }
      return 1;
    case kTagCfaRepeatPatternDim:
      if (!read_unsigned_values(reader, entry, 2, ifd->cfa_repeat)) {
        return 0;
      }
      ifd->has_cfa_repeat = 1;
      return 1;
    case kTagCfaPattern:
      if (!read_unsigned_values(reader, entry, 4, ifd->cfa_values)) {
        return 0;
      }
      ifd->has_cfa_pattern = 1;
      return 1;
    case kTagDngVersion: {
      uint32_t version[4];
      if (entry->type != kTiffTypeByte ||
          !read_unsigned_values(reader, entry, 4, version) ||
          version[0] == 0) {
        return 0;
      }
      state->saw_dng_version = 1;
      return 1;
    }
    case kTagCfaPlaneColor:
      if (!read_unsigned_values(reader, entry, 3,
                                ifd->cfa_plane_colors)) {
        return 0;
      }
      ifd->has_cfa_plane_colors = 1;
      return 1;
    case kTagLinearizationTable: {
      if (entry->type != kTiffTypeShort || entry->count == 0 ||
          entry->count > kMaximumLinearizationEntries) {
        return 0;
      }
      uint16_t* table =
          (uint16_t*)malloc((size_t)entry->count * sizeof(uint16_t));
      if (table == NULL) return 0;
      for (uint32_t index = 0; index < entry->count; index++) {
        uint32_t value = 0;
        if (!entry_unsigned(reader, entry, index, &value) || value > 65535u) {
          free(table);
          return 0;
        }
        table[index] = (uint16_t)value;
      }
      free(ifd->linearization_table);
      ifd->linearization_table = table;
      ifd->linearization_table_count = entry->count;
      ifd->has_linearization_table = 1;
      return 1;
    }
    case kTagBlackLevelRepeatDim:
      if (!read_unsigned_values(reader, entry, 2, ifd->black_repeat) ||
          ifd->black_repeat[0] == 0 || ifd->black_repeat[0] > 2 ||
          ifd->black_repeat[1] == 0 || ifd->black_repeat[1] > 2) {
        return 0;
      }
      ifd->has_black_repeat = 1;
      return 1;
    case kTagBlackLevel:
      if (entry->count > kMaximumBlackLevels ||
          !read_number_values(reader, entry, entry->count,
                              ifd->black_levels)) {
        return 0;
      }
      ifd->black_level_count = entry->count;
      ifd->has_black_levels = 1;
      return 1;
    case kTagBlackLevelDeltaH:
    case kTagBlackLevelDeltaV: {
      if (entry->type != kTiffTypeSignedRational || entry->count == 0 ||
          entry->count > kMaximumBlackLevelDeltas) {
        return 0;
      }
      double* values =
          (double*)malloc((size_t)entry->count * sizeof(double));
      if (values == NULL) return 0;
      if (!read_number_values(reader, entry, entry->count, values)) {
        free(values);
        return 0;
      }
      for (uint32_t index = 0; index < entry->count; index++) {
        if (!isfinite(values[index])) {
          free(values);
          return 0;
        }
      }
      if (entry->tag == kTagBlackLevelDeltaH) {
        free(ifd->black_level_delta_h);
        ifd->black_level_delta_h = values;
        ifd->black_level_delta_h_count = entry->count;
        ifd->has_black_level_delta_h = 1;
      } else {
        free(ifd->black_level_delta_v);
        ifd->black_level_delta_v = values;
        ifd->black_level_delta_v_count = entry->count;
        ifd->has_black_level_delta_v = 1;
      }
      return 1;
    }
    case kTagWhiteLevel:
      if (!entry_number(reader, entry, 0, &ifd->white_level) ||
          !isfinite(ifd->white_level) || ifd->white_level <= 0) {
        return 0;
      }
      ifd->has_white_level = 1;
      return 1;
    case kTagColorMatrix1:
    case kTagColorMatrix2:
    case kTagColorMatrix3: {
      double* const destination = entry->tag == kTagColorMatrix1
          ? state->color_matrix_1
          : (entry->tag == kTagColorMatrix2
              ? state->color_matrix_2
              : state->color_matrix_3);
      if (entry->type != kTiffTypeSignedRational || entry->count != 9 ||
          !read_number_values(reader, entry, 9, destination)) {
        return 0;
      }
      if (entry->tag == kTagColorMatrix1) {
        state->has_color_matrix_1 = 1;
      } else if (entry->tag == kTagColorMatrix2) {
        state->has_color_matrix_2 = 1;
      } else {
        state->has_color_matrix_3 = 1;
      }
      return 1;
    }
    case kTagForwardMatrix1:
    case kTagForwardMatrix2:
    case kTagForwardMatrix3: {
      double* const destination = entry->tag == kTagForwardMatrix1
          ? state->forward_matrix_1
          : (entry->tag == kTagForwardMatrix2
              ? state->forward_matrix_2
              : state->forward_matrix_3);
      if (entry->type != kTiffTypeSignedRational || entry->count != 9 ||
          !read_number_values(reader, entry, 9, destination)) {
        return 0;
      }
      if (entry->tag == kTagForwardMatrix1) {
        state->has_forward_matrix_1 = 1;
      } else if (entry->tag == kTagForwardMatrix2) {
        state->has_forward_matrix_2 = 1;
      } else {
        state->has_forward_matrix_3 = 1;
      }
      return 1;
    }
    case kTagCameraCalibration1:
    case kTagCameraCalibration2:
    case kTagCameraCalibration3: {
      double* const destination = entry->tag == kTagCameraCalibration1
          ? state->camera_calibration_1
          : (entry->tag == kTagCameraCalibration2
              ? state->camera_calibration_2
              : state->camera_calibration_3);
      if (entry->type != kTiffTypeSignedRational || entry->count != 9 ||
          !read_number_values(reader, entry, 9, destination)) {
        return 0;
      }
      if (entry->tag == kTagCameraCalibration1) {
        state->has_camera_calibration_1 = 1;
      } else if (entry->tag == kTagCameraCalibration2) {
        state->has_camera_calibration_2 = 1;
      } else {
        state->has_camera_calibration_3 = 1;
      }
      return 1;
    }
    case kTagAnalogBalance:
      if (entry->type != kTiffTypeRational || entry->count != 3 ||
          !read_number_values(reader, entry, 3, state->analog_balance) ||
          state->analog_balance[0] <= 0 ||
          state->analog_balance[1] <= 0 ||
          state->analog_balance[2] <= 0) {
        return 0;
      }
      state->has_analog_balance = 1;
      return 1;
    case kTagAsShotNeutral:
      if (entry->count < 3 ||
          !read_number_values(reader, entry, 3, state->neutral) ||
          state->neutral[0] <= 0 || state->neutral[1] <= 0 ||
          state->neutral[2] <= 0) {
        return 0;
      }
      state->has_neutral = 1;
      return 1;
    case kTagAsShotWhiteXY:
      if (entry->type != kTiffTypeRational || entry->count != 2 ||
          !read_number_values(reader, entry, 2,
                              state->as_shot_white_xy) ||
          state->as_shot_white_xy[0] <= 0.0 ||
          state->as_shot_white_xy[1] <= 0.0 ||
          state->as_shot_white_xy[0] +
                  state->as_shot_white_xy[1] >=
              1.0) {
        return 0;
      }
      state->has_as_shot_white_xy = 1;
      return 1;
    case kTagBaselineExposure:
      if (entry->type != kTiffTypeSignedRational || entry->count != 1u ||
          !entry_number(reader, entry, 0u, &state->baseline_exposure) ||
          !isfinite(state->baseline_exposure) ||
          state->baseline_exposure < -32.0 ||
          state->baseline_exposure > 32.0) {
        return 0;
      }
      state->has_baseline_exposure = 1;
      return 1;
    case kTagBaselineExposureOffset:
      if (entry->type != kTiffTypeSignedRational || entry->count != 1u ||
          !entry_number(reader, entry, 0u,
                        &state->baseline_exposure_offset) ||
          !isfinite(state->baseline_exposure_offset) ||
          state->baseline_exposure_offset < -32.0 ||
          state->baseline_exposure_offset > 32.0) {
        return 0;
      }
      state->has_baseline_exposure_offset = 1;
      return 1;
    case kTagProfileHueSatMapDims:
      return read_profile_hue_sat_map_dims(reader, entry, state);
    case kTagProfileHueSatMapData1:
      return read_profile_hue_sat_map(reader, entry, state, 1u);
    case kTagProfileHueSatMapData2:
      return read_profile_hue_sat_map(reader, entry, state, 2u);
    case kTagProfileHueSatMapData3:
      return read_profile_hue_sat_map(reader, entry, state, 3u);
    case kTagProfileHueSatMapEncoding:
      if (entry->type != kTiffTypeLong || entry->count != 1u ||
          !entry_unsigned(reader, entry, 0u, &value) || value > 1u) {
        return 0;
      }
      state->profile_hue_sat_map_encoding = value;
      return 1;
    case kTagProfileLookTableDims:
      return read_profile_look_table_dims(reader, entry, state);
    case kTagProfileLookTableData:
      return read_profile_look_table(reader, entry, state);
    case kTagProfileLookTableEncoding:
      if (entry->type != kTiffTypeLong || entry->count != 1u ||
          !entry_unsigned(reader, entry, 0u, &value) || value > 1u) {
        return 0;
      }
      state->profile_look_table_encoding = value;
      return 1;
    case kTagProfileToneCurve:
      return read_profile_tone_curve(reader, entry, state);
    case kTagProfileDynamicRange: {
      uint8_t bytes[8];
      if (entry->type != kTiffTypeUndefined || entry->count != 8u) {
        return 0;
      }
      for (uint32_t index = 0; index < 8u; index++) {
        if (!entry_element_bytes(reader, entry, index, bytes + index, 1u)) {
          return 0;
        }
      }
      const uint32_t version = read_u16(reader, bytes);
      const uint32_t dynamic_range = read_u16(reader, bytes + 2);
      const uint32_t hint_bits = read_u32(reader, bytes + 4);
      float hint = 0.0f;
      memcpy(&hint, &hint_bits, sizeof(hint));
      if (version != 1u || dynamic_range > 1u || !isfinite(hint) ||
          (dynamic_range == 0u && hint > 1.0f)) {
        return 0;
      }
      state->has_profile_dynamic_range = 1;
      state->profile_dynamic_range = dynamic_range;
      state->profile_hint_max_output_value = (double)hint;
      return 1;
    }
    case kTagActiveArea:
      if (!read_unsigned_values(reader, entry, 4, ifd->active_area)) {
        return 0;
      }
      ifd->has_active_area = 1;
      return 1;
    case kTagCalibrationIlluminant1:
    case kTagCalibrationIlluminant2:
    case kTagCalibrationIlluminant3: {
      if (entry->type != kTiffTypeShort || entry->count != 1) {
        return 0;
      }
      uint32_t* const destination =
          entry->tag == kTagCalibrationIlluminant1
              ? &state->calibration_illuminant_1
              : (entry->tag == kTagCalibrationIlluminant2
                  ? &state->calibration_illuminant_2
                  : &state->calibration_illuminant_3);
      if (!entry_unsigned(reader, entry, 0, destination)) {
        return 0;
      }
      if (entry->tag == kTagCalibrationIlluminant1) {
        state->has_calibration_illuminant_1 = 1;
      } else if (entry->tag == kTagCalibrationIlluminant2) {
        state->has_calibration_illuminant_2 = 1;
      } else {
        state->has_calibration_illuminant_3 = 1;
      }
      return 1;
    }
    case kTagIlluminantData1:
    case kTagIlluminantData2:
    case kTagIlluminantData3: {
      double* const destination = entry->tag == kTagIlluminantData1
          ? state->illuminant_data_1_xy
          : (entry->tag == kTagIlluminantData2
              ? state->illuminant_data_2_xy
              : state->illuminant_data_3_xy);
      if (!read_illuminant_xy(reader, entry, destination)) {
        return 0;
      }
      if (entry->tag == kTagIlluminantData1) {
        state->has_illuminant_data_1 = 1;
      } else if (entry->tag == kTagIlluminantData2) {
        state->has_illuminant_data_2 = 1;
      } else {
        state->has_illuminant_data_3 = 1;
      }
      return 1;
    }
    case kTagCameraCalibrationSignature:
      return read_calibration_signature(
          reader, entry, state->camera_calibration_signature,
          &state->camera_calibration_signature_length);
    case kTagProfileCalibrationSignature:
      return read_calibration_signature(
          reader, entry, state->profile_calibration_signature,
          &state->profile_calibration_signature_length);
    default:
      return 1;
  }
}

static uint32_t cfa_pattern_from_ifd(const DngIfd* ifd) {
  uint32_t colors[4];
  for (uint32_t index = 0; index < 4; index++) {
    if (ifd->cfa_values[index] >= 3) {
      return MOBILE_STACK_RAW_CFA_UNKNOWN;
    }
    colors[index] = ifd->cfa_plane_colors[ifd->cfa_values[index]];
  }
  if (colors[0] == 0 && colors[1] == 1 &&
      colors[2] == 1 && colors[3] == 2) {
    return MOBILE_STACK_RAW_CFA_RGGB;
  }
  if (colors[0] == 2 && colors[1] == 1 &&
      colors[2] == 1 && colors[3] == 0) {
    return MOBILE_STACK_RAW_CFA_BGGR;
  }
  if (colors[0] == 1 && colors[1] == 0 &&
      colors[2] == 2 && colors[3] == 1) {
    return MOBILE_STACK_RAW_CFA_GRBG;
  }
  if (colors[0] == 1 && colors[1] == 2 &&
      colors[2] == 0 && colors[3] == 1) {
    return MOBILE_STACK_RAW_CFA_GBRG;
  }
  return MOBILE_STACK_RAW_CFA_UNKNOWN;
}

static int copy_candidate(const DngIfd* ifd,
                          const DngParseState* state,
                          MobileStackDngMetadata* metadata_out) {
  if (!ifd->has_width || !ifd->has_height ||
      ifd->width == 0 || ifd->height == 0 ||
      !ifd->has_cfa_repeat || !ifd->has_cfa_pattern ||
      ifd->cfa_repeat[0] != 2 || ifd->cfa_repeat[1] != 2 ||
      (ifd->has_new_subfile_type && ifd->new_subfile_type != 0) ||
      (ifd->has_samples_per_pixel && ifd->samples_per_pixel != 1) ||
      (ifd->has_photometric && ifd->photometric != kPhotometricCfa)) {
    return 0;
  }

  const uint32_t cfa_pattern = cfa_pattern_from_ifd(ifd);
  if (cfa_pattern == MOBILE_STACK_RAW_CFA_UNKNOWN) {
    return 0;
  }

  uint32_t top = 0;
  uint32_t left = 0;
  uint32_t bottom = ifd->height;
  uint32_t right = ifd->width;
  if (ifd->has_active_area) {
    top = ifd->active_area[0];
    left = ifd->active_area[1];
    bottom = ifd->active_area[2];
    right = ifd->active_area[3];
  }
  if (bottom <= top || right <= left ||
      bottom > ifd->height || right > ifd->width) {
    return 0;
  }

  double white_level = ifd->white_level;
  if (!ifd->has_white_level) {
    if (!ifd->has_bits_per_sample ||
        ifd->bits_per_sample == 0 || ifd->bits_per_sample > 31) {
      return 0;
    }
    white_level =
        (double)(((uint32_t)1 << ifd->bits_per_sample) - 1u);
  }
  if (!isfinite(white_level) || white_level <= 0) {
    return 0;
  }

  memset(metadata_out, 0, sizeof(*metadata_out));
  metadata_out->width = ifd->width;
  metadata_out->height = ifd->height;
  metadata_out->active_left = left;
  metadata_out->active_top = top;
  metadata_out->active_width = right - left;
  metadata_out->active_height = bottom - top;
  metadata_out->cfa_pattern = cfa_pattern;
  metadata_out->orientation =
      ifd->has_orientation
          ? ifd->orientation
          : (state->has_orientation ? state->orientation : 1u);
  metadata_out->white_level = (float)white_level;
  if (state->has_baseline_exposure) {
    metadata_out->has_baseline_exposure = 1u;
    metadata_out->baseline_exposure = (float)state->baseline_exposure;
  }
  if (state->has_baseline_exposure_offset) {
    metadata_out->has_baseline_exposure_offset = 1u;
    metadata_out->baseline_exposure_offset =
        (float)state->baseline_exposure_offset;
  }
  if (state->has_profile_dynamic_range) {
    metadata_out->has_profile_dynamic_range = 1u;
    metadata_out->profile_dynamic_range = state->profile_dynamic_range;
    metadata_out->profile_hint_max_output_value =
        (float)state->profile_hint_max_output_value;
  }

  if (ifd->has_black_levels) {
    const uint32_t rows =
        ifd->has_black_repeat ? ifd->black_repeat[0] : 1u;
    const uint32_t columns =
        ifd->has_black_repeat ? ifd->black_repeat[1] : 1u;
    if (rows * columns > ifd->black_level_count) {
      return 0;
    }
    for (uint32_t y = 0; y < 2; y++) {
      for (uint32_t x = 0; x < 2; x++) {
        const uint32_t source_index =
            (y % rows) * columns + (x % columns);
        const double value = ifd->black_levels[source_index];
        if (!isfinite(value) || value < 0 || value >= white_level) {
          return 0;
        }
        metadata_out->black_levels[y * 2 + x] = (float)value;
      }
    }
  }
  double profile_matrix_1[9];
  double profile_matrix_2[9];
  double profile_matrix_3[9];
  const int profile_1_status =
      compose_profile_matrix(state, 1u, profile_matrix_1);
  const int profile_2_status =
      compose_profile_matrix(state, 2u, profile_matrix_2);
  const int profile_3_status =
      compose_profile_matrix(state, 3u, profile_matrix_3);
  if (profile_1_status < 0 || profile_2_status < 0 ||
      profile_3_status < 0) {
    return 0;
  }
  const int has_profile_1 = profile_1_status > 0;
  const int has_profile_2 = profile_2_status > 0;
  const int has_profile_3 = profile_3_status > 0;
  const int has_third_profile_metadata = state->has_color_matrix_3 ||
      state->has_forward_matrix_3 ||
      state->has_camera_calibration_3 ||
      state->has_calibration_illuminant_3 ||
      state->has_illuminant_data_3;
  if (has_third_profile_metadata &&
      (!has_profile_1 || !has_profile_2 || !has_profile_3 ||
       !triple_profile_illuminants_are_distinct(state))) {
    return 0;
  }
  if (has_profile_1 || has_profile_2 || has_profile_3) {
    double calibrated_matrix[9];
    double published_matrix[9];
    double white_xy[2];
    double temperature_1 = 0.0;
    double temperature_2 = 0.0;
    const int has_explicit_white = !state->has_neutral &&
        state->has_as_shot_white_xy;
    const int can_interpolate = has_profile_1 && has_profile_2 &&
        profile_illuminant_white(state, 1u, &temperature_1, NULL) &&
        profile_illuminant_white(state, 2u, &temperature_2, NULL) &&
        temperature_1 != temperature_2 &&
        (state->has_neutral || has_explicit_white);
    if (has_profile_3) {
      if (has_explicit_white) {
        white_xy[0] = state->as_shot_white_xy[0];
        white_xy[1] = state->as_shot_white_xy[1];
        if (!interpolate_triple_profile_components(
                state, white_xy, calibrated_matrix)) {
          return 0;
        }
      } else if (state->has_neutral) {
        if (!triple_illuminant_matrix(
                state, calibrated_matrix, white_xy)) {
          return 0;
        }
      } else {
        white_xy[0] = 0.3324;
        white_xy[1] = 0.3474;
        if (!interpolate_triple_profile_components(
                state, white_xy, calibrated_matrix)) {
          return 0;
        }
      }
    } else if (can_interpolate) {
      if (has_explicit_white) {
        const double white_temperature = correlated_color_temperature(
            state->as_shot_white_xy[0],
            state->as_shot_white_xy[1]);
        if (white_temperature <= 0.0) {
          return 0;
        }
        if (!interpolate_dual_profile_components(
                state, temperature_1, temperature_2, white_temperature,
                calibrated_matrix)) {
          return 0;
        }
        white_xy[0] = state->as_shot_white_xy[0];
        white_xy[1] = state->as_shot_white_xy[1];
      } else if (!dual_illuminant_matrix(
                     state, temperature_1, temperature_2,
                     calibrated_matrix, white_xy)) {
        return 0;
      }
      /* The matrix is calibrated at the recovered as-shot white. */
    } else {
      uint32_t selected_slot;
      if (has_profile_1 && has_profile_2 &&
          profile_illuminants_equivalent(state)) {
        memcpy(calibrated_matrix, profile_matrix_1,
               sizeof(calibrated_matrix));
        selected_slot = 1u;
      } else if (has_profile_2 &&
          state->calibration_illuminant_2 == kLightSourceD65) {
        memcpy(calibrated_matrix, profile_matrix_2,
               sizeof(calibrated_matrix));
        selected_slot = 2u;
      } else if (has_profile_1 &&
                 state->calibration_illuminant_1 == kLightSourceD65) {
        memcpy(calibrated_matrix, profile_matrix_1,
               sizeof(calibrated_matrix));
        selected_slot = 1u;
      } else if (has_profile_2) {
        memcpy(calibrated_matrix, profile_matrix_2,
               sizeof(calibrated_matrix));
        selected_slot = 2u;
      } else {
        memcpy(calibrated_matrix, profile_matrix_1,
               sizeof(calibrated_matrix));
        selected_slot = 1u;
      }
      if (has_explicit_white) {
        white_xy[0] = state->as_shot_white_xy[0];
        white_xy[1] = state->as_shot_white_xy[1];
      } else if (!profile_illuminant_white(state, selected_slot, NULL,
                                           white_xy)) {
        return 0;
      }
    }
    metadata_out->has_profile_white_xy = 1u;
    metadata_out->profile_white_xy[0] = white_xy[0];
    metadata_out->profile_white_xy[1] = white_xy[1];
    double publish_xyz_to_camera[9];
    double forward_camera_to_d50[9];
    const int forward_status = build_forward_camera_to_d50(
        state, white_xy, calibrated_matrix, forward_camera_to_d50);
    if (forward_status < 0) {
      return 0;
    }
    if (forward_status > 0) {
      /* Existing Dart render code consumes an XYZ->camera matrix and derives
       * the selected white from CameraNeutral. Publishing the inverse of the
       * DNG ForwardMatrix camera->XYZ(D50) transform is algebraically
       * equivalent: the derived white is D50, so no extra chromatic
       * adaptation is introduced before ProPhoto processing. */
      if (!matrix3_inverse(forward_camera_to_d50,
                           publish_xyz_to_camera)) {
        return 0;
      }
    } else {
      double d65_to_as_shot[9];
      if (!build_linear_bradford_d65_to_xy(white_xy,
                                           d65_to_as_shot)) {
        return 0;
      }
      matrix3_multiply(calibrated_matrix, d65_to_as_shot,
                       publish_xyz_to_camera);
    }
    for (uint32_t index = 0; index < 9; index++) {
      const double value = publish_xyz_to_camera[index];
      if (!isfinite(value) || value < -(double)FLT_MAX ||
          value > (double)FLT_MAX) {
        return 0;
      }
      const float published_value = (float)value;
      if (!isfinite(published_value)) {
        return 0;
      }
      published_matrix[index] = (double)published_value;
    }
    if (!matrix3_is_safely_invertible(published_matrix)) {
      return 0;
    }
    for (uint32_t index = 0; index < 9; index++) {
      metadata_out->d65_xyz_to_camera[index] =
          (float)published_matrix[index];
    }
    metadata_out->has_d65_xyz_to_camera = 1u;
  }

  if (ifd->has_linearization_table) {
    metadata_out->linearization_table = (uint16_t*)malloc(
        (size_t)ifd->linearization_table_count * sizeof(uint16_t));
    if (metadata_out->linearization_table == NULL) {
      mobile_stack_dng_metadata_release(metadata_out);
      return 0;
    }
    memcpy(metadata_out->linearization_table, ifd->linearization_table,
           (size_t)ifd->linearization_table_count * sizeof(uint16_t));
    metadata_out->linearization_table_count = ifd->linearization_table_count;
  }
  if (ifd->has_black_level_delta_h) {
    if (ifd->black_level_delta_h_count != metadata_out->active_width) {
      mobile_stack_dng_metadata_release(metadata_out);
      return 0;
    }
    metadata_out->black_level_delta_h = (float*)malloc(
        (size_t)ifd->black_level_delta_h_count * sizeof(float));
    if (metadata_out->black_level_delta_h == NULL) {
      mobile_stack_dng_metadata_release(metadata_out);
      return 0;
    }
    metadata_out->black_level_delta_h_count = ifd->black_level_delta_h_count;
    for (uint32_t index = 0; index < ifd->black_level_delta_h_count; index++) {
      const double value = ifd->black_level_delta_h[index];
      if (value < -(double)FLT_MAX || value > (double)FLT_MAX) {
        mobile_stack_dng_metadata_release(metadata_out);
        return 0;
      }
      metadata_out->black_level_delta_h[index] = (float)value;
    }
  }
  if (ifd->has_black_level_delta_v) {
    if (ifd->black_level_delta_v_count != metadata_out->active_height) {
      mobile_stack_dng_metadata_release(metadata_out);
      return 0;
    }
    metadata_out->black_level_delta_v = (float*)malloc(
        (size_t)ifd->black_level_delta_v_count * sizeof(float));
    if (metadata_out->black_level_delta_v == NULL) {
      mobile_stack_dng_metadata_release(metadata_out);
      return 0;
    }
    metadata_out->black_level_delta_v_count = ifd->black_level_delta_v_count;
    for (uint32_t index = 0; index < ifd->black_level_delta_v_count; index++) {
      const double value = ifd->black_level_delta_v[index];
      if (value < -(double)FLT_MAX || value > (double)FLT_MAX) {
        mobile_stack_dng_metadata_release(metadata_out);
        return 0;
      }
      metadata_out->black_level_delta_v[index] = (float)value;
    }
  }

  /* DNG normalization uses WhiteLevel minus the maximum computed black level
   * over the sample plane.  Validate the combined 2x2 BlackLevel and the
   * separable H/V deltas here so impossible normalization metadata never
   * crosses the native/Dart ABI boundary. */
  double maximum_h[2] = {-INFINITY, -INFINITY};
  double maximum_v[2] = {-INFINITY, -INFINITY};
  for (uint32_t x = 0; x < metadata_out->active_width; x++) {
    const double value = metadata_out->black_level_delta_h != NULL
                             ? metadata_out->black_level_delta_h[x]
                             : 0.0;
    const uint32_t phase = x & 1u;
    if (value > maximum_h[phase]) maximum_h[phase] = value;
  }
  for (uint32_t y = 0; y < metadata_out->active_height; y++) {
    const double value = metadata_out->black_level_delta_v != NULL
                             ? metadata_out->black_level_delta_v[y]
                             : 0.0;
    const uint32_t phase = y & 1u;
    if (value > maximum_v[phase]) maximum_v[phase] = value;
  }
  double maximum_computed_black = -INFINITY;
  for (uint32_t y_phase = 0; y_phase < 2u; y_phase++) {
    if (!isfinite(maximum_v[y_phase])) continue;
    for (uint32_t x_phase = 0; x_phase < 2u; x_phase++) {
      if (!isfinite(maximum_h[x_phase])) continue;
      const uint32_t phase = y_phase * 2u + x_phase;
      const double computed =
          (double)metadata_out->black_levels[phase] +
          maximum_h[x_phase] + maximum_v[y_phase];
      if (!isfinite(computed)) {
        mobile_stack_dng_metadata_release(metadata_out);
        return 0;
      }
      if (computed > maximum_computed_black) {
        maximum_computed_black = computed;
      }
    }
  }
  if (!isfinite(maximum_computed_black) ||
      maximum_computed_black >= white_level) {
    mobile_stack_dng_metadata_release(metadata_out);
    return 0;
  }
  return 1;
}

static int selected_xyz_to_camera_for_white(
    const DngParseState* state,
    const double white_xy[2],
    double matrix_out[9]) {
  double profile_matrix_1[9];
  double profile_matrix_2[9];
  double profile_matrix_3[9];
  const int status_1 = compose_profile_matrix(state, 1u, profile_matrix_1);
  const int status_2 = compose_profile_matrix(state, 2u, profile_matrix_2);
  const int status_3 = compose_profile_matrix(state, 3u, profile_matrix_3);
  if (status_1 < 0 || status_2 < 0 || status_3 < 0) return 0;
  const int has_1 = status_1 > 0;
  const int has_2 = status_2 > 0;
  const int has_3 = status_3 > 0;

  if (has_3) {
    return interpolate_triple_profile_components(state, white_xy, matrix_out);
  }

  if (has_1 && has_2) {
    double temperature_1 = 0.0;
    double temperature_2 = 0.0;
    const double white_temperature =
        correlated_color_temperature(white_xy[0], white_xy[1]);
    if (white_temperature > 0.0 &&
        profile_illuminant_white(state, 1u, &temperature_1, NULL) &&
        profile_illuminant_white(state, 2u, &temperature_2, NULL) &&
        temperature_1 > 0.0 && temperature_2 > 0.0 &&
        temperature_1 != temperature_2) {
      return interpolate_dual_profile_components(
          state, temperature_1, temperature_2, white_temperature, matrix_out);
    }
    if (profile_illuminants_equivalent(state)) {
      memcpy(matrix_out, profile_matrix_1, sizeof(profile_matrix_1));
      return 1;
    }
  }

  if (has_2 && state->calibration_illuminant_2 == kLightSourceD65) {
    memcpy(matrix_out, profile_matrix_2, sizeof(profile_matrix_2));
    return 1;
  }
  if (has_1 && state->calibration_illuminant_1 == kLightSourceD65) {
    memcpy(matrix_out, profile_matrix_1, sizeof(profile_matrix_1));
    return 1;
  }
  if (has_2) {
    memcpy(matrix_out, profile_matrix_2, sizeof(profile_matrix_2));
    return 1;
  }
  if (has_1) {
    memcpy(matrix_out, profile_matrix_1, sizeof(profile_matrix_1));
    return 1;
  }
  return 0;
}

static int apply_white_balance(const DngParseState* state,
                               MobileStackDngMetadata* metadata) {
  double neutral[3];
  if (state->has_neutral) {
    memcpy(neutral, state->neutral, sizeof(neutral));
  } else if (state->has_as_shot_white_xy &&
             metadata->has_profile_white_xy) {
    /* DNG 1.7.1 chapter 6 defines CameraNeutral from an explicit white xy
     * using XYZtoCamera = AB * CC * CM at that selected white. Do not derive
     * it from metadata->d65_xyz_to_camera: the published matrix can be the
     * inverse ForwardMatrix CameraToXYZ_D50 transform, whose reference white
     * is D50 rather than D65. Using D65 there gives the wrong WB whenever a
     * DNG provides AsShotWhiteXY without AsShotNeutral. */
    const double x = state->as_shot_white_xy[0];
    const double y = state->as_shot_white_xy[1];
    if (!isfinite(x) || !isfinite(y) || y <= 0.0 ||
        x <= 0.0 || x + y >= 1.0) {
      return 0;
    }
    const double xyz[3] = {
        x / y,
        1.0,
        (1.0 - x - y) / y,
    };
    double xyz_to_camera[9];
    if (!selected_xyz_to_camera_for_white(
            state, metadata->profile_white_xy, xyz_to_camera)) {
      return 0;
    }
    matrix3_vector_multiply(xyz_to_camera, xyz, neutral);
    double maximum = neutral[0];
    if (neutral[1] > maximum) maximum = neutral[1];
    if (neutral[2] > maximum) maximum = neutral[2];
    if (!isfinite(maximum) || maximum <= 0.0) {
      return 0;
    }
    for (uint32_t index = 0; index < 3; index++) {
      neutral[index] /= maximum;
      if (!isfinite(neutral[index]) || neutral[index] <= 0.0) {
        return 0;
      }
      if (neutral[index] < 0.001) neutral[index] = 0.001;
      if (neutral[index] > 1.0) neutral[index] = 1.0;
    }
  } else {
    return 1;
  }
  const float gains[3] = {
      (float)(1.0 / neutral[0]),
      (float)(1.0 / neutral[1]),
      (float)(1.0 / neutral[2]),
  };
  const uint32_t colors[4] = {
      metadata->cfa_pattern == MOBILE_STACK_RAW_CFA_RGGB ? 0u :
          metadata->cfa_pattern == MOBILE_STACK_RAW_CFA_BGGR ? 2u : 1u,
      metadata->cfa_pattern == MOBILE_STACK_RAW_CFA_GRBG ? 0u :
          metadata->cfa_pattern == MOBILE_STACK_RAW_CFA_GBRG ? 2u : 1u,
      metadata->cfa_pattern == MOBILE_STACK_RAW_CFA_GRBG ? 2u :
          metadata->cfa_pattern == MOBILE_STACK_RAW_CFA_GBRG ? 0u : 1u,
      metadata->cfa_pattern == MOBILE_STACK_RAW_CFA_RGGB ? 2u :
          metadata->cfa_pattern == MOBILE_STACK_RAW_CFA_BGGR ? 0u : 1u,
  };
  for (uint32_t index = 0; index < 4; index++) {
    metadata->camera_white_balance[index] = gains[colors[index]];
  }
  metadata->has_camera_white_balance = 1;
  return 1;
}

static int select_profile_hue_sat_map(DngParseState* state,
                                      MobileStackDngMetadata* metadata) {
  const int has_map_1 = state->profile_hue_sat_map_1 != NULL;
  const int has_map_2 = state->profile_hue_sat_map_2 != NULL;
  const int has_map_3 = state->profile_hue_sat_map_3 != NULL;
  const int has_any_map = has_map_1 || has_map_2 || has_map_3;
  const int is_triple_profile = state->has_color_matrix_3 ||
      state->has_forward_matrix_3 ||
      state->has_camera_calibration_3 ||
      state->has_calibration_illuminant_3 ||
      state->has_illuminant_data_3;
  if (!has_any_map) {
    return !state->has_profile_hue_sat_map_dims;
  }
  if (!state->has_profile_hue_sat_map_dims || !has_map_1 ||
      !state->has_color_matrix_1 ||
      (has_map_2 && !state->has_color_matrix_2) ||
      (has_map_3 && !is_triple_profile) ||
      (is_triple_profile && (!has_map_1 || !has_map_2 || !has_map_3))) {
    return 0;
  }
  const uint32_t entry_count = state->profile_hue_divisions *
      state->profile_sat_divisions * state->profile_val_divisions;
  metadata->profile_hue_divisions = state->profile_hue_divisions;
  metadata->profile_sat_divisions = state->profile_sat_divisions;
  metadata->profile_val_divisions = state->profile_val_divisions;
  metadata->profile_hue_sat_map_encoding =
      state->profile_hue_sat_map_encoding;
  metadata->profile_hue_sat_map_entry_count = entry_count;

  if (!has_map_2) {
    metadata->profile_hue_sat_map = state->profile_hue_sat_map_1;
    state->profile_hue_sat_map_1 = NULL;
    return 1;
  }
  double weights[3] = {1.0, 0.0, 0.0};
  if (is_triple_profile) {
    if (!metadata->has_profile_white_xy ||
        !triple_illuminant_weights(state, metadata->profile_white_xy,
                                   weights)) {
      return 0;
    }
  } else {
    double temperature_1 = 0.0;
    double temperature_2 = 0.0;
    const double white_temperature = metadata->has_profile_white_xy
        ? correlated_color_temperature(metadata->profile_white_xy[0],
                                       metadata->profile_white_xy[1])
        : 0.0;
    if (white_temperature > 0.0 &&
        profile_illuminant_white(state, 1u, &temperature_1, NULL) &&
        profile_illuminant_white(state, 2u, &temperature_2, NULL) &&
        temperature_1 > 0.0 && temperature_2 > 0.0 &&
        temperature_1 != temperature_2) {
      weights[0] =
          (1.0 / white_temperature - 1.0 / temperature_2) /
          (1.0 / temperature_1 - 1.0 / temperature_2);
      if (weights[0] < 0.0) weights[0] = 0.0;
      if (weights[0] > 1.0) weights[0] = 1.0;
      weights[1] = 1.0 - weights[0];
    }
  }
  float* const selected =
      (float*)malloc((size_t)entry_count * 3u * sizeof(float));
  if (selected == NULL) {
    return 0;
  }
  for (uint32_t index = 0; index < entry_count * 3u; index++) {
    const double value = weights[0] * state->profile_hue_sat_map_1[index] +
        weights[1] * state->profile_hue_sat_map_2[index] +
        (is_triple_profile
             ? weights[2] * state->profile_hue_sat_map_3[index]
             : 0.0);
    if (!isfinite(value) || value < -(double)FLT_MAX ||
        value > (double)FLT_MAX) {
      free(selected);
      return 0;
    }
    selected[index] = (float)value;
  }
  metadata->profile_hue_sat_map = selected;
  return 1;
}

static int select_profile_look_table(DngParseState* state,
                                     MobileStackDngMetadata* metadata) {
  const int has_dims = state->has_profile_look_table_dims;
  const int has_data = state->profile_look_table != NULL;
  if (!has_dims && !has_data) {
    return 1;
  }
  if (!has_dims || !has_data || !state->has_color_matrix_1) {
    return 0;
  }
  metadata->profile_look_hue_divisions =
      state->profile_look_hue_divisions;
  metadata->profile_look_sat_divisions =
      state->profile_look_sat_divisions;
  metadata->profile_look_val_divisions =
      state->profile_look_val_divisions;
  metadata->profile_look_table_encoding =
      state->profile_look_table_encoding;
  metadata->profile_look_table_entry_count =
      state->profile_look_hue_divisions *
      state->profile_look_sat_divisions *
      state->profile_look_val_divisions;
  metadata->profile_look_table = state->profile_look_table;
  state->profile_look_table = NULL;
  return 1;
}

static MobileStackRawStatus parse_ifd(DngReader* reader,
                                     uint32_t ifd_offset,
                                     DngIfd* ifd,
                                     DngParseState* state) {
  initialize_ifd(ifd);
  uint8_t count_bytes[2];
  if (!read_at(reader, ifd_offset, count_bytes, sizeof(count_bytes))) {
    return MOBILE_STACK_RAW_CORRUPT_DATA;
  }
  const uint32_t entry_count = read_u16(reader, count_bytes);
  if (entry_count > kMaximumIfdEntries) {
    return MOBILE_STACK_RAW_RESOURCE_LIMIT;
  }
  const uint64_t entries_start = (uint64_t)ifd_offset + 2u;
  const uint64_t entries_size = (uint64_t)entry_count * 12u;
  if (entries_start > reader->file_size ||
      entries_size + 4u > reader->file_size - entries_start) {
    return MOBILE_STACK_RAW_CORRUPT_DATA;
  }

  for (uint32_t index = 0; index < entry_count; index++) {
    TiffEntry entry;
    if (!read_entry(reader, entries_start + (uint64_t)index * 12u,
                    &entry) ||
        !parse_ifd_entry(reader, &entry, ifd, state)) {
      return MOBILE_STACK_RAW_CORRUPT_DATA;
    }
  }
  uint8_t next_bytes[4];
  if (!read_at(reader, entries_start + entries_size, next_bytes,
               sizeof(next_bytes))) {
    return MOBILE_STACK_RAW_CORRUPT_DATA;
  }
  ifd->next_ifd = read_u32(reader, next_bytes);
  return MOBILE_STACK_RAW_OK;
}

static int append_ifd(uint32_t* queue,
                      uint32_t* count,
                      uint32_t offset) {
  if (offset == 0) {
    return 1;
  }
  for (uint32_t index = 0; index < *count; index++) {
    if (queue[index] == offset) {
      return 1;
    }
  }
  if (*count >= kMaximumIfdCount) {
    return 0;
  }
  queue[*count] = offset;
  *count += 1;
  return 1;
}

static MobileStackRawStatus parse_dng(DngReader* reader,
                                     MobileStackDngMetadata* metadata_out) {
  uint8_t header[8];
  if (!read_at(reader, 0, header, sizeof(header))) {
    return MOBILE_STACK_RAW_CORRUPT_DATA;
  }
  if (header[0] == 'I' && header[1] == 'I') {
    reader->little_endian = 1;
  } else if (header[0] == 'M' && header[1] == 'M') {
    reader->little_endian = 0;
  } else {
    return MOBILE_STACK_RAW_CORRUPT_DATA;
  }
  if (read_u16(reader, header + 2) != 42) {
    return MOBILE_STACK_RAW_UNSUPPORTED_FORMAT;
  }

  uint32_t queue[kMaximumIfdCount] = {0};
  uint32_t queue_count = 0;
  uint32_t queue_index = 0;
  if (!append_ifd(queue, &queue_count, read_u32(reader, header + 4))) {
    return MOBILE_STACK_RAW_RESOURCE_LIMIT;
  }

  DngParseState state;
  memset(&state, 0, sizeof(state));
  MobileStackRawStatus final_status = MOBILE_STACK_RAW_OK;
  while (queue_index < queue_count) {
    DngIfd ifd;
    const MobileStackRawStatus status =
        parse_ifd(reader, queue[queue_index], &ifd, &state);
    queue_index += 1;
    if (status != MOBILE_STACK_RAW_OK) {
      release_ifd(&ifd);
      final_status = status;
      goto cleanup;
    }
    if (!append_ifd(queue, &queue_count, ifd.next_ifd)) {
      release_ifd(&ifd);
      final_status = MOBILE_STACK_RAW_RESOURCE_LIMIT;
      goto cleanup;
    }
    for (uint32_t index = 0; index < ifd.sub_ifd_count; index++) {
      if (!append_ifd(queue, &queue_count, ifd.sub_ifds[index])) {
        release_ifd(&ifd);
        final_status = MOBILE_STACK_RAW_RESOURCE_LIMIT;
        goto cleanup;
      }
    }

    MobileStackDngMetadata candidate;
    memset(&candidate, 0, sizeof(candidate));
    if (copy_candidate(&ifd, &state, &candidate)) {
      const uint64_t area =
          (uint64_t)candidate.width * candidate.height;
      if (!state.has_best || area > state.best_area) {
        if (state.has_best) {
          mobile_stack_dng_metadata_release(&state.best);
        }
        state.has_best = 1;
        state.best_area = area;
        state.best = candidate;
        memset(&candidate, 0, sizeof(candidate));
      }
    }
    mobile_stack_dng_metadata_release(&candidate);
    release_ifd(&ifd);
  }

  if (!state.saw_dng_version || !state.has_best) {
    final_status = MOBILE_STACK_RAW_CORRUPT_DATA;
    goto cleanup;
  }
  if (!validate_profile_tone_curve_endpoints(&state)) {
    final_status = MOBILE_STACK_RAW_CORRUPT_DATA;
    goto cleanup;
  }
  if (!apply_white_balance(&state, &state.best)) {
    final_status = MOBILE_STACK_RAW_CORRUPT_DATA;
    goto cleanup;
  }
  if (!select_profile_hue_sat_map(&state, &state.best)) {
    final_status = MOBILE_STACK_RAW_CORRUPT_DATA;
    goto cleanup;
  }
  if (!select_profile_look_table(&state, &state.best)) {
    final_status = MOBILE_STACK_RAW_CORRUPT_DATA;
    goto cleanup;
  }
  state.best.profile_tone_curve_point_count =
      state.profile_tone_curve_point_count;
  state.best.profile_tone_curve_xy = state.profile_tone_curve_xy;
  state.profile_tone_curve_point_count = 0u;
  state.profile_tone_curve_xy = NULL;
  *metadata_out = state.best;
cleanup:
  if (final_status != MOBILE_STACK_RAW_OK) {
    mobile_stack_dng_metadata_release(&state.best);
  }
  free(state.profile_tone_curve_xy);
  free(state.profile_hue_sat_map_1);
  free(state.profile_hue_sat_map_2);
  free(state.profile_hue_sat_map_3);
  free(state.profile_look_table);
  return final_status;
}

void mobile_stack_dng_metadata_release(MobileStackDngMetadata* metadata) {
  if (metadata == NULL) {
    return;
  }
  free(metadata->linearization_table);
  metadata->linearization_table = NULL;
  metadata->linearization_table_count = 0u;
  free(metadata->black_level_delta_h);
  metadata->black_level_delta_h = NULL;
  metadata->black_level_delta_h_count = 0u;
  free(metadata->black_level_delta_v);
  metadata->black_level_delta_v = NULL;
  metadata->black_level_delta_v_count = 0u;
  free(metadata->profile_tone_curve_xy);
  metadata->profile_tone_curve_xy = NULL;
  metadata->profile_tone_curve_point_count = 0u;
  free(metadata->profile_hue_sat_map);
  metadata->profile_hue_sat_map = NULL;
  metadata->profile_hue_sat_map_entry_count = 0u;
  free(metadata->profile_look_table);
  metadata->profile_look_table = NULL;
  metadata->profile_look_table_entry_count = 0u;
}

MobileStackRawStatus mobile_stack_dng_probe_metadata(
    const uint8_t* path_utf8,
    uint32_t path_length,
    uint64_t expected_byte_length,
    MobileStackDngMetadata* metadata_out,
    int32_t* error_code_out,
    const char** error_message_out) {
  if (metadata_out != NULL) {
    memset(metadata_out, 0, sizeof(*metadata_out));
  }
  if (error_code_out != NULL) {
    *error_code_out = 0;
  }
  if (error_message_out != NULL) {
    *error_message_out = NULL;
  }
  if (path_utf8 == NULL || path_length == 0 ||
      path_length > kMaximumPathBytes || metadata_out == NULL ||
      error_code_out == NULL || error_message_out == NULL ||
      memchr(path_utf8, '\0', path_length) != NULL) {
    if (error_code_out != NULL) {
      *error_code_out = 2001;
    }
    if (error_message_out != NULL) {
      *error_message_out = "Invalid DNG metadata request.";
    }
    return MOBILE_STACK_RAW_INVALID_ARGUMENT;
  }

  char* path = (char*)malloc((size_t)path_length + 1u);
  if (path == NULL) {
    *error_code_out = 2002;
    *error_message_out = "Unable to allocate the DNG path.";
    return MOBILE_STACK_RAW_OUT_OF_MEMORY;
  }
  memcpy(path, path_utf8, path_length);
  path[path_length] = '\0';

  FILE* file = fopen(path, "rb");
  free(path);
  if (file == NULL) {
    *error_code_out = 2003;
    *error_message_out = "Unable to open the DNG file.";
    return MOBILE_STACK_RAW_FILE_IO;
  }

  MobileStackRawStatus status = MOBILE_STACK_RAW_OK;
  if (fseek(file, 0, SEEK_END) != 0) {
    status = MOBILE_STACK_RAW_FILE_IO;
  }
  const long length = status == MOBILE_STACK_RAW_OK ? ftell(file) : -1;
  if (length < 0) {
    status = MOBILE_STACK_RAW_FILE_IO;
  }
  if (status == MOBILE_STACK_RAW_OK &&
      (uint64_t)length != expected_byte_length) {
    status = MOBILE_STACK_RAW_CORRUPT_DATA;
  }

  if (status == MOBILE_STACK_RAW_OK) {
    DngReader reader = {
        file,
        (uint64_t)length,
        1,
    };
    status = parse_dng(&reader, metadata_out);
  }
  fclose(file);

  if (status != MOBILE_STACK_RAW_OK) {
    switch (status) {
      case MOBILE_STACK_RAW_UNSUPPORTED_FORMAT:
        *error_code_out = 2004;
        *error_message_out = "The file is not a classic TIFF/DNG container.";
        break;
      case MOBILE_STACK_RAW_RESOURCE_LIMIT:
        *error_code_out = 2005;
        *error_message_out = "The DNG metadata exceeds safety limits.";
        break;
      case MOBILE_STACK_RAW_FILE_IO:
        *error_code_out = 2006;
        *error_message_out = "Unable to read the DNG file.";
        break;
      default:
        *error_code_out = 2007;
        *error_message_out = "The DNG metadata is truncated or inconsistent.";
        status = MOBILE_STACK_RAW_CORRUPT_DATA;
        break;
    }
  }
  return status;
}
