#include "mobile_stack_arw_lossless.h"

#include <limits.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
  kMaximumPathBytes = 32768,
  kMaximumIfdCount = 16,
  kMaximumIfdEntries = 4096,
  kMaximumTileCount = 4096,
  kMaximumCompressedTileBytes = 8 * 1024 * 1024,
  kMaximumCameraModelBytes = 64,
};

enum {
  kTagImageWidth = 0x0100,
  kTagImageLength = 0x0101,
  kTagBitsPerSample = 0x0102,
  kTagCompression = 0x0103,
  kTagPhotometric = 0x0106,
  kTagModel = 0x0110,
  kTagStripOffsets = 0x0111,
  kTagOrientation = 0x0112,
  kTagSamplesPerPixel = 0x0115,
  kTagRowsPerStrip = 0x0116,
  kTagStripByteCounts = 0x0117,
  kTagSubIfds = 0x014A,
  kTagTileWidth = 0x0142,
  kTagTileLength = 0x0143,
  kTagTileOffsets = 0x0144,
  kTagTileByteCounts = 0x0145,
  kTagExifIfd = 0x8769,
  kTagSonyCurve = 0x7010,
  kTagCfaRepeatPatternDim = 0x828D,
  kTagCfaPattern = 0x828E,
  kTagSonyBlackLevel = 0x7310,
  kTagSonyWbRggbLevels = 0x7313,
  kTagWhiteLevel = 0xC61D,
  kTagDefaultCropOrigin = 0xC61F,
  kTagDefaultCropSize = 0xC620,
  kPhotometricCfa = 32803,
  kCompressionNone = 1,
  kCompressionJpeg = 7,
  kCompressionSonyArw2 = 32767,
};

enum {
  kTiffTypeByte = 1,
  kTiffTypeAscii = 2,
  kTiffTypeShort = 3,
  kTiffTypeLong = 4,
  kTiffTypeSignedShort = 8,
  kTiffTypeIfd = 13,
};

typedef struct ArwReader {
  FILE* file;
  uint64_t file_size;
  int little_endian;
} ArwReader;

typedef struct TiffEntry {
  uint16_t tag;
  uint16_t type;
  uint32_t count;
  uint8_t raw[12];
} TiffEntry;

typedef struct ArwIfd {
  uint32_t width;
  uint32_t height;
  uint32_t bits_per_sample;
  uint32_t compression;
  uint32_t photometric;
  uint32_t samples_per_pixel;
  uint32_t orientation;
  uint32_t tile_width;
  uint32_t tile_height;
  uint32_t tile_offsets[kMaximumTileCount];
  uint32_t tile_byte_counts[kMaximumTileCount];
  uint32_t tile_offset_count;
  uint32_t tile_byte_count_count;
  uint32_t strip_offsets[kMaximumTileCount];
  uint32_t strip_byte_counts[kMaximumTileCount];
  uint32_t strip_offset_count;
  uint32_t strip_byte_count_count;
  uint32_t rows_per_strip;
  uint32_t cfa_repeat[2];
  uint32_t cfa_values[4];
  uint32_t crop_origin[2];
  uint32_t crop_size[2];
  uint32_t black_levels[4];
  uint32_t camera_white_balance[4];
  char camera_model[kMaximumCameraModelBytes];
  uint32_t sony_curve[4];
  uint32_t white_level;
  uint32_t sub_ifds[kMaximumIfdCount];
  uint32_t sub_ifd_count;
  uint32_t exif_ifd;
  uint32_t next_ifd;
  int has_width;
  int has_height;
  int has_bits_per_sample;
  int has_compression;
  int has_photometric;
  int has_samples_per_pixel;
  int has_orientation;
  int has_tile_width;
  int has_tile_height;
  int has_tile_offsets;
  int has_tile_byte_counts;
  int has_strip_offsets;
  int has_strip_byte_counts;
  int has_rows_per_strip;
  int has_cfa_repeat;
  int has_cfa_pattern;
  int has_crop_origin;
  int has_crop_size;
  int has_black_levels;
  int has_camera_white_balance;
  int has_camera_model;
  int has_sony_curve;
  int has_white_level;
} ArwIfd;

typedef struct ArwSensor {
  uint32_t width;
  uint32_t height;
  uint32_t bits_per_sample;
  uint32_t compression;
  uint32_t tile_width;
  uint32_t tile_height;
  uint32_t tile_columns;
  uint32_t tile_rows;
  uint32_t tile_count;
  uint32_t tile_offsets[kMaximumTileCount];
  uint32_t tile_byte_counts[kMaximumTileCount];
  uint32_t cfa_pattern;
  uint32_t orientation;
  uint32_t active_left;
  uint32_t active_top;
  uint32_t active_width;
  uint32_t active_height;
  uint32_t black_levels[4];
  uint32_t camera_white_balance[4];
  char camera_model[kMaximumCameraModelBytes];
  float d65_xyz_to_camera[9];
  uint32_t sony_curve[4];
  uint32_t white_level;
  int has_camera_white_balance;
  int has_camera_model;
  int has_d65_xyz_to_camera;
  int has_sony_curve;
} ArwSensor;

typedef struct HuffmanTable {
  int32_t minimum_code[17];
  int32_t maximum_code[17];
  int32_t value_index[17];
  uint8_t symbols[256];
  uint32_t symbol_count;
  int valid;
} HuffmanTable;

typedef struct EntropyReader {
  const uint8_t* bytes;
  size_t length;
  size_t offset;
  uint8_t current;
  uint32_t remaining_bits;
} EntropyReader;

static uint16_t read_u16(const ArwReader* reader, const uint8_t* bytes) {
  if (reader->little_endian) {
    return (uint16_t)((uint16_t)bytes[0] |
                      ((uint16_t)bytes[1] << 8));
  }
  return (uint16_t)(((uint16_t)bytes[0] << 8) |
                    (uint16_t)bytes[1]);
}

static uint32_t read_u32(const ArwReader* reader, const uint8_t* bytes) {
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

static uint16_t read_be_u16(const uint8_t* bytes) {
  return (uint16_t)(((uint16_t)bytes[0] << 8) |
                    (uint16_t)bytes[1]);
}

static int read_at(ArwReader* reader,
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
      return 1;
    case kTiffTypeShort:
    case kTiffTypeSignedShort:
      return 2;
    case kTiffTypeLong:
    case kTiffTypeIfd:
      return 4;
    default:
      return 0;
  }
}

static int read_entry(ArwReader* reader,
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

static int entry_unsigned(ArwReader* reader,
                          const TiffEntry* entry,
                          uint32_t index,
                          uint32_t* value_out) {
  const uint32_t size = tiff_type_size(entry->type);
  if (value_out == NULL || size == 0 || index >= entry->count ||
      entry->count > UINT32_MAX / size) {
    return 0;
  }
  const uint32_t total_size = entry->count * size;
  const uint64_t element_offset = (uint64_t)index * size;
  uint8_t bytes[4] = {0, 0, 0, 0};
  if (total_size <= 4) {
    if (element_offset + size > 4) {
      return 0;
    }
    memcpy(bytes, entry->raw + 8 + element_offset, size);
  } else {
    const uint32_t value_offset = read_u32(reader, entry->raw + 8);
    if (!read_at(reader, (uint64_t)value_offset + element_offset,
                 bytes, size)) {
      return 0;
    }
  }
  if (entry->type == kTiffTypeByte) {
    *value_out = bytes[0];
  } else if (entry->type == kTiffTypeShort ||
             entry->type == kTiffTypeSignedShort) {
    *value_out = read_u16(reader, bytes);
  } else {
    *value_out = read_u32(reader, bytes);
  }
  return 1;
}

static int read_values(ArwReader* reader,
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

static int read_ascii(ArwReader* reader,
                      const TiffEntry* entry,
                      char* value_out,
                      size_t capacity) {
  if (entry->type != kTiffTypeAscii || entry->count == 0 ||
      entry->count >= capacity) {
    return 0;
  }
  const uint32_t count = entry->count;
  if (count <= 4u) {
    memcpy(value_out, entry->raw + 8, count);
  } else {
    const uint32_t value_offset = read_u32(reader, entry->raw + 8);
    if (!read_at(reader, value_offset, (uint8_t*)value_out, count)) {
      return 0;
    }
  }
  value_out[count] = '\0';
  size_t length = 0;
  while (length < count && value_out[length] != '\0') {
    const unsigned char byte = (unsigned char)value_out[length];
    if (byte < 0x20u || byte > 0x7eu) return 0;
    length++;
  }
  while (length > 0 && value_out[length - 1u] == ' ') length--;
  value_out[length] = '\0';
  return length > 0;
}

static void initialize_ifd(ArwIfd* ifd) {
  memset(ifd, 0, sizeof(*ifd));
  ifd->samples_per_pixel = 1;
  ifd->orientation = 1;
}

static int parse_entry(ArwReader* reader,
                       const TiffEntry* entry,
                       ArwIfd* ifd) {
  uint32_t value = 0;
  switch (entry->tag) {
    case kTagImageWidth:
      if (!entry_unsigned(reader, entry, 0, &ifd->width)) return 0;
      ifd->has_width = 1;
      return 1;
    case kTagImageLength:
      if (!entry_unsigned(reader, entry, 0, &ifd->height)) return 0;
      ifd->has_height = 1;
      return 1;
    case kTagBitsPerSample:
      if (!entry_unsigned(reader, entry, 0, &ifd->bits_per_sample)) return 0;
      ifd->has_bits_per_sample = 1;
      return 1;
    case kTagCompression:
      if (!entry_unsigned(reader, entry, 0, &ifd->compression)) return 0;
      ifd->has_compression = 1;
      return 1;
    case kTagPhotometric:
      if (!entry_unsigned(reader, entry, 0, &ifd->photometric)) return 0;
      ifd->has_photometric = 1;
      return 1;
    case kTagModel:
      if (!read_ascii(reader, entry, ifd->camera_model,
                      sizeof(ifd->camera_model))) {
        return 0;
      }
      ifd->has_camera_model = 1;
      return 1;
    case kTagOrientation:
      if (!entry_unsigned(reader, entry, 0, &value) ||
          value < 1 || value > 8) {
        return 0;
      }
      ifd->orientation = value;
      ifd->has_orientation = 1;
      return 1;
    case kTagSamplesPerPixel:
      if (!entry_unsigned(reader, entry, 0, &ifd->samples_per_pixel)) {
        return 0;
      }
      ifd->has_samples_per_pixel = 1;
      return 1;
    case kTagStripOffsets:
      if (entry->count == 0 || entry->count > kMaximumTileCount ||
          !read_values(reader, entry, entry->count, ifd->strip_offsets)) {
        return 0;
      }
      ifd->strip_offset_count = entry->count;
      ifd->has_strip_offsets = 1;
      return 1;
    case kTagRowsPerStrip:
      if (!entry_unsigned(reader, entry, 0, &ifd->rows_per_strip)) return 0;
      ifd->has_rows_per_strip = 1;
      return 1;
    case kTagStripByteCounts:
      if (entry->count == 0 || entry->count > kMaximumTileCount ||
          !read_values(reader, entry, entry->count,
                       ifd->strip_byte_counts)) {
        return 0;
      }
      ifd->strip_byte_count_count = entry->count;
      ifd->has_strip_byte_counts = 1;
      return 1;
    case kTagTileWidth:
      if (!entry_unsigned(reader, entry, 0, &ifd->tile_width)) return 0;
      ifd->has_tile_width = 1;
      return 1;
    case kTagTileLength:
      if (!entry_unsigned(reader, entry, 0, &ifd->tile_height)) return 0;
      ifd->has_tile_height = 1;
      return 1;
    case kTagTileOffsets:
      if (entry->count == 0 || entry->count > kMaximumTileCount ||
          !read_values(reader, entry, entry->count, ifd->tile_offsets)) {
        return 0;
      }
      ifd->tile_offset_count = entry->count;
      ifd->has_tile_offsets = 1;
      return 1;
    case kTagTileByteCounts:
      if (entry->count == 0 || entry->count > kMaximumTileCount ||
          !read_values(reader, entry, entry->count,
                       ifd->tile_byte_counts)) {
        return 0;
      }
      ifd->tile_byte_count_count = entry->count;
      ifd->has_tile_byte_counts = 1;
      return 1;
    case kTagSubIfds:
      if (entry->count > kMaximumIfdCount ||
          !read_values(reader, entry, entry->count, ifd->sub_ifds)) {
        return 0;
      }
      ifd->sub_ifd_count = entry->count;
      return 1;
    case kTagExifIfd:
      return entry_unsigned(reader, entry, 0, &ifd->exif_ifd);
    case kTagCfaRepeatPatternDim:
      if (!read_values(reader, entry, 2, ifd->cfa_repeat)) return 0;
      ifd->has_cfa_repeat = 1;
      return 1;
    case kTagCfaPattern:
      if (!read_values(reader, entry, 4, ifd->cfa_values)) return 0;
      ifd->has_cfa_pattern = 1;
      return 1;
    case kTagDefaultCropOrigin:
      if (!read_values(reader, entry, 2, ifd->crop_origin)) return 0;
      ifd->has_crop_origin = 1;
      return 1;
    case kTagDefaultCropSize:
      if (!read_values(reader, entry, 2, ifd->crop_size)) return 0;
      ifd->has_crop_size = 1;
      return 1;
    case kTagSonyBlackLevel:
      if (!read_values(reader, entry, 4, ifd->black_levels)) return 0;
      ifd->has_black_levels = 1;
      return 1;
    case kTagSonyCurve:
      if (!read_values(reader, entry, 4, ifd->sony_curve)) return 0;
      for (uint32_t index = 0; index < 4; index++) {
        ifd->sony_curve[index] =
            (ifd->sony_curve[index] >> 2) & 0x0fffu;
      }
      ifd->has_sony_curve = 1;
      return 1;
    case kTagSonyWbRggbLevels:
      if (entry->type != kTiffTypeSignedShort ||
          !read_values(reader, entry, 4,
                       ifd->camera_white_balance)) {
        return 0;
      }
      ifd->has_camera_white_balance = 1;
      return 1;
    case kTagWhiteLevel:
      if (!entry_unsigned(reader, entry, 0, &ifd->white_level)) return 0;
      ifd->has_white_level = 1;
      return 1;
    default:
      return 1;
  }
}

static MobileStackRawStatus parse_ifd(ArwReader* reader,
                                     uint32_t ifd_offset,
                                     ArwIfd* ifd) {
  uint8_t count_bytes[2];
  if (!read_at(reader, ifd_offset, count_bytes, sizeof(count_bytes))) {
    return MOBILE_STACK_RAW_CORRUPT_DATA;
  }
  const uint32_t entry_count = read_u16(reader, count_bytes);
  if (entry_count == 0 || entry_count > kMaximumIfdEntries) {
    return MOBILE_STACK_RAW_RESOURCE_LIMIT;
  }
  const uint64_t entries_start = (uint64_t)ifd_offset + 2u;
  const uint64_t entries_size = (uint64_t)entry_count * 12u;
  if (entries_start > reader->file_size ||
      entries_size + 4u > reader->file_size - entries_start) {
    return MOBILE_STACK_RAW_CORRUPT_DATA;
  }

  initialize_ifd(ifd);
  for (uint32_t index = 0; index < entry_count; index++) {
    TiffEntry entry;
    if (!read_entry(reader, entries_start + (uint64_t)index * 12u,
                    &entry) ||
        !parse_entry(reader, &entry, ifd)) {
      return MOBILE_STACK_RAW_CORRUPT_DATA;
    }
  }
  uint8_t next_bytes[4];
  if (!read_at(reader, entries_start + entries_size,
               next_bytes, sizeof(next_bytes))) {
    return MOBILE_STACK_RAW_CORRUPT_DATA;
  }
  ifd->next_ifd = read_u32(reader, next_bytes);
  return MOBILE_STACK_RAW_OK;
}

static uint32_t cfa_pattern(const ArwIfd* ifd) {
  const uint32_t* values = ifd->cfa_values;
  if (values[0] == 0 && values[1] == 1 &&
      values[2] == 1 && values[3] == 2) {
    return MOBILE_STACK_RAW_CFA_RGGB;
  }
  if (values[0] == 2 && values[1] == 1 &&
      values[2] == 1 && values[3] == 0) {
    return MOBILE_STACK_RAW_CFA_BGGR;
  }
  if (values[0] == 1 && values[1] == 0 &&
      values[2] == 2 && values[3] == 1) {
    return MOBILE_STACK_RAW_CFA_GRBG;
  }
  if (values[0] == 1 && values[1] == 2 &&
      values[2] == 0 && values[3] == 1) {
    return MOBILE_STACK_RAW_CFA_GBRG;
  }
  return MOBILE_STACK_RAW_CFA_UNKNOWN;
}

static int append_ifd(uint32_t* queue,
                      uint32_t* count,
                      uint32_t offset) {
  if (offset == 0) return 1;
  for (uint32_t index = 0; index < *count; index++) {
    if (queue[index] == offset) return 1;
  }
  if (*count >= kMaximumIfdCount) return 0;
  queue[*count] = offset;
  *count += 1;
  return 1;
}

static void assign_camera_color_matrix(ArwSensor* sensor) {
  if (!sensor->has_camera_model ||
      strcmp(sensor->camera_model, "ILCE-7M3") != 0) {
    return;
  }
  /* Adobe DNG Converter matrix published by LibRaw colordata.cpp. */
  static const float kIlce7m3D65XyzToCamera[9] = {
      0.7374f, -0.2389f, -0.0551f,
     -0.5435f,  1.3162f,  0.2519f,
     -0.1006f,  0.1795f,  0.6552f,
  };
  memcpy(sensor->d65_xyz_to_camera, kIlce7m3D65XyzToCamera,
         sizeof(kIlce7m3D65XyzToCamera));
  sensor->has_d65_xyz_to_camera = 1;
}

static int copy_sensor(const ArwReader* reader,
                       const ArwIfd* ifd,
                       uint32_t inherited_orientation,
                       const uint32_t inherited_sony_curve[4],
                       int has_inherited_sony_curve,
                       const char inherited_camera_model[
                           kMaximumCameraModelBytes],
                       int has_inherited_camera_model,
                       ArwSensor* sensor_out) {
  if (!ifd->has_width || !ifd->has_height ||
      !ifd->has_bits_per_sample || !ifd->has_compression ||
      !ifd->has_photometric || !ifd->has_cfa_repeat ||
      !ifd->has_cfa_pattern ||
      ifd->photometric != kPhotometricCfa ||
      ifd->samples_per_pixel != 1 ||
      ifd->width == 0 || ifd->height == 0 ||
      (ifd->width & 1u) != 0 || (ifd->height & 1u) != 0 ||
      ifd->bits_per_sample < 2 || ifd->bits_per_sample > 16 ||
      ifd->cfa_repeat[0] != 2 || ifd->cfa_repeat[1] != 2) {
    return 0;
  }
  const uint32_t pattern = cfa_pattern(ifd);
  if (pattern != MOBILE_STACK_RAW_CFA_RGGB) return 0;

  uint32_t storage_width = 0;
  uint32_t storage_height = 0;
  uint32_t columns = 0;
  uint32_t rows = 0;
  uint32_t tile_count = 0;
  const uint32_t* offsets = NULL;
  const uint32_t* byte_counts = NULL;
  if (ifd->compression == kCompressionJpeg) {
    if (!ifd->has_tile_width || !ifd->has_tile_height ||
        !ifd->has_tile_offsets || !ifd->has_tile_byte_counts ||
        ifd->tile_width == 0 || ifd->tile_height == 0 ||
        (ifd->tile_width & 1u) != 0 || (ifd->tile_height & 1u) != 0) {
      return 0;
    }
    const uint64_t computed_columns =
        ((uint64_t)ifd->width + ifd->tile_width - 1u) / ifd->tile_width;
    const uint64_t computed_rows =
        ((uint64_t)ifd->height + ifd->tile_height - 1u) / ifd->tile_height;
    const uint64_t computed_count = computed_columns * computed_rows;
    if (computed_columns == 0 || computed_rows == 0 ||
        computed_columns > UINT32_MAX || computed_rows > UINT32_MAX ||
        computed_count == 0 || computed_count > kMaximumTileCount ||
        ifd->tile_offset_count != computed_count ||
        ifd->tile_byte_count_count != computed_count) {
      return 0;
    }
    storage_width = ifd->tile_width;
    storage_height = ifd->tile_height;
    columns = (uint32_t)computed_columns;
    rows = (uint32_t)computed_rows;
    tile_count = (uint32_t)computed_count;
    offsets = ifd->tile_offsets;
    byte_counts = ifd->tile_byte_counts;
  } else if (ifd->compression == kCompressionNone) {
    if (!ifd->has_rows_per_strip || !ifd->has_strip_offsets ||
        !ifd->has_strip_byte_counts || ifd->rows_per_strip == 0 ||
        ifd->bits_per_sample > 16) {
      return 0;
    }
    const uint64_t computed_rows =
        ((uint64_t)ifd->height + ifd->rows_per_strip - 1u) /
        ifd->rows_per_strip;
    if (computed_rows == 0 || computed_rows > kMaximumTileCount ||
        ifd->strip_offset_count != computed_rows ||
        ifd->strip_byte_count_count != computed_rows) {
      return 0;
    }
    storage_width = ifd->width;
    storage_height = ifd->rows_per_strip;
    columns = 1;
    rows = (uint32_t)computed_rows;
    tile_count = rows;
    offsets = ifd->strip_offsets;
    byte_counts = ifd->strip_byte_counts;
  } else if (ifd->compression == kCompressionSonyArw2) {
    if (!reader->little_endian || !ifd->has_rows_per_strip ||
        !ifd->has_strip_offsets || !ifd->has_strip_byte_counts ||
        ifd->rows_per_strip == 0 || (ifd->width & 31u) != 0 ||
        (ifd->bits_per_sample != 12 && ifd->bits_per_sample != 14)) {
      return 0;
    }
    const uint64_t computed_rows =
        ((uint64_t)ifd->height + ifd->rows_per_strip - 1u) /
        ifd->rows_per_strip;
    if (computed_rows == 0 || computed_rows > kMaximumTileCount ||
        ifd->strip_offset_count != computed_rows ||
        ifd->strip_byte_count_count != computed_rows) {
      return 0;
    }
    storage_width = ifd->width;
    storage_height = ifd->rows_per_strip;
    columns = 1;
    rows = (uint32_t)computed_rows;
    tile_count = rows;
    offsets = ifd->strip_offsets;
    byte_counts = ifd->strip_byte_counts;
  } else {
    return 0;
  }
  for (uint32_t index = 0; index < tile_count; index++) {
    const uint64_t offset = offsets[index];
    const uint64_t length = byte_counts[index];
    const uint64_t first_row = (uint64_t)index * storage_height;
    const uint64_t row_count = first_row >= ifd->height ? 0 :
        ((uint64_t)ifd->height - first_row < storage_height ?
         (uint64_t)ifd->height - first_row : storage_height);
    const uint64_t expected_arw2 = row_count * ifd->width;
    const uint64_t expected_uncompressed = row_count * ifd->width * 2u;
    if ((ifd->compression == kCompressionJpeg &&
         (length < 4 || length > kMaximumCompressedTileBytes)) ||
        (ifd->compression == kCompressionNone &&
         length != expected_uncompressed) ||
        (ifd->compression == kCompressionSonyArw2 &&
         length != expected_arw2) ||
        offset > reader->file_size || length > reader->file_size - offset) {
      return 0;
    }
  }

  uint32_t left = 0;
  uint32_t top = 0;
  uint32_t active_width = ifd->width;
  uint32_t active_height = ifd->height;
  if (ifd->has_crop_origin) {
    left = ifd->crop_origin[0];
    top = ifd->crop_origin[1];
  }
  if (ifd->has_crop_size) {
    active_width = ifd->crop_size[0];
    active_height = ifd->crop_size[1];
  }
  if (active_width == 0 || active_height == 0 ||
      left > ifd->width || top > ifd->height ||
      active_width > ifd->width - left ||
      active_height > ifd->height - top) {
    return 0;
  }

  uint32_t white_level = ifd->white_level;
  if (!ifd->has_white_level) {
    white_level = ifd->bits_per_sample == 16
        ? 65535u
        : ((uint32_t)1u << ifd->bits_per_sample) - 1u;
  }
  if (white_level == 0) return 0;
  if (ifd->has_black_levels) {
    for (uint32_t index = 0; index < 4; index++) {
      if (ifd->black_levels[index] >= white_level) return 0;
    }
  }
  if (ifd->has_camera_white_balance) {
    for (uint32_t index = 0; index < 4; index++) {
      if (ifd->camera_white_balance[index] == 0 ||
          ifd->camera_white_balance[index] > INT16_MAX) {
        return 0;
      }
    }
  }

  memset(sensor_out, 0, sizeof(*sensor_out));
  if (ifd->has_camera_model) {
    memcpy(sensor_out->camera_model, ifd->camera_model,
           sizeof(sensor_out->camera_model));
    sensor_out->has_camera_model = 1;
  } else if (has_inherited_camera_model) {
    memcpy(sensor_out->camera_model, inherited_camera_model,
           sizeof(sensor_out->camera_model));
    sensor_out->has_camera_model = 1;
  }
  sensor_out->width = ifd->width;
  sensor_out->height = ifd->height;
  sensor_out->bits_per_sample = ifd->bits_per_sample;
  sensor_out->compression = ifd->compression;
  sensor_out->tile_width = storage_width;
  sensor_out->tile_height = storage_height;
  sensor_out->tile_columns = columns;
  sensor_out->tile_rows = rows;
  sensor_out->tile_count = tile_count;
  memcpy(sensor_out->tile_offsets, offsets,
         (size_t)tile_count * sizeof(uint32_t));
  memcpy(sensor_out->tile_byte_counts, byte_counts,
         (size_t)tile_count * sizeof(uint32_t));
  sensor_out->cfa_pattern = pattern;
  sensor_out->orientation =
      ifd->has_orientation ? ifd->orientation : inherited_orientation;
  sensor_out->active_left = left;
  sensor_out->active_top = top;
  sensor_out->active_width = active_width;
  sensor_out->active_height = active_height;
  if (ifd->has_black_levels) {
    memcpy(sensor_out->black_levels, ifd->black_levels,
           sizeof(sensor_out->black_levels));
  }
  if (ifd->has_camera_white_balance) {
    memcpy(sensor_out->camera_white_balance,
           ifd->camera_white_balance,
           sizeof(sensor_out->camera_white_balance));
    sensor_out->has_camera_white_balance = 1;
  }
  if (ifd->has_sony_curve) {
    memcpy(sensor_out->sony_curve, ifd->sony_curve,
           sizeof(sensor_out->sony_curve));
    sensor_out->has_sony_curve = 1;
  } else if (has_inherited_sony_curve) {
    memcpy(sensor_out->sony_curve, inherited_sony_curve,
           sizeof(sensor_out->sony_curve));
    sensor_out->has_sony_curve = 1;
  }
  sensor_out->white_level = white_level;
  assign_camera_color_matrix(sensor_out);
  return 1;
}

static MobileStackRawStatus find_sensor(ArwReader* reader,
                                       ArwSensor* sensor_out) {
  uint8_t header[8];
  if (!read_at(reader, 0, header, sizeof(header))) {
    return MOBILE_STACK_RAW_CORRUPT_DATA;
  }
  if (header[0] == 'I' && header[1] == 'I') {
    reader->little_endian = 1;
  } else if (header[0] == 'M' && header[1] == 'M') {
    reader->little_endian = 0;
  } else {
    return MOBILE_STACK_RAW_UNSUPPORTED_FORMAT;
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
  uint32_t inherited_orientation = 1;
  uint32_t inherited_sony_curve[4] = {0};
  int has_inherited_sony_curve = 0;
  char inherited_camera_model[kMaximumCameraModelBytes] = {0};
  int has_inherited_camera_model = 0;
  uint64_t best_area = 0;
  int has_best = 0;
  while (queue_index < queue_count) {
    ArwIfd* ifd = (ArwIfd*)calloc(1, sizeof(ArwIfd));
    if (ifd == NULL) return MOBILE_STACK_RAW_OUT_OF_MEMORY;
    const MobileStackRawStatus status =
        parse_ifd(reader, queue[queue_index], ifd);
    queue_index += 1;
    if (status != MOBILE_STACK_RAW_OK) {
      free(ifd);
      return status;
    }
    if (ifd->has_orientation) inherited_orientation = ifd->orientation;
    if (ifd->has_sony_curve) {
      memcpy(inherited_sony_curve, ifd->sony_curve,
             sizeof(inherited_sony_curve));
      has_inherited_sony_curve = 1;
    }
    if (ifd->has_camera_model) {
      memcpy(inherited_camera_model, ifd->camera_model,
             sizeof(inherited_camera_model));
      has_inherited_camera_model = 1;
    }
    if (!append_ifd(queue, &queue_count, ifd->next_ifd) ||
        !append_ifd(queue, &queue_count, ifd->exif_ifd)) {
      free(ifd);
      return MOBILE_STACK_RAW_RESOURCE_LIMIT;
    }
    for (uint32_t index = 0; index < ifd->sub_ifd_count; index++) {
      if (!append_ifd(queue, &queue_count, ifd->sub_ifds[index])) {
        free(ifd);
        return MOBILE_STACK_RAW_RESOURCE_LIMIT;
      }
    }

    ArwSensor* candidate = (ArwSensor*)calloc(1, sizeof(ArwSensor));
    if (candidate == NULL) {
      free(ifd);
      return MOBILE_STACK_RAW_OUT_OF_MEMORY;
    }
    if (copy_sensor(reader, ifd, inherited_orientation,
                    inherited_sony_curve, has_inherited_sony_curve,
                    inherited_camera_model, has_inherited_camera_model,
                    candidate)) {
      const uint64_t area =
          (uint64_t)candidate->width * candidate->height;
      if (!has_best || area > best_area) {
        *sensor_out = *candidate;
        best_area = area;
        has_best = 1;
      }
    }
    free(candidate);
    free(ifd);
  }
  return has_best ? MOBILE_STACK_RAW_OK : MOBILE_STACK_RAW_UNSUPPORTED_FORMAT;
}

static int build_huffman_table(const uint8_t* counts,
                               const uint8_t* symbols,
                               uint32_t symbol_count,
                               HuffmanTable* table) {
  memset(table, 0, sizeof(*table));
  int32_t code = 0;
  uint32_t symbol_index = 0;
  for (uint32_t length = 1; length <= 16; length++) {
    const uint32_t count = counts[length - 1u];
    table->minimum_code[length] = -1;
    table->maximum_code[length] = -1;
    table->value_index[length] = (int32_t)symbol_index;
    if (count > 0) {
      if (symbol_index + count > symbol_count ||
          code + (int32_t)count > (1 << length)) {
        return 0;
      }
      table->minimum_code[length] = code;
      table->maximum_code[length] = code + (int32_t)count - 1;
      code += (int32_t)count;
      symbol_index += count;
    }
    code <<= 1;
  }
  if (symbol_index != symbol_count || symbol_count == 0) return 0;
  memcpy(table->symbols, symbols, symbol_count);
  table->symbol_count = symbol_count;
  table->valid = 1;
  return 1;
}

static int entropy_byte(EntropyReader* reader, uint8_t* byte_out) {
  if (reader->offset >= reader->length) return 0;
  uint8_t value = reader->bytes[reader->offset++];
  if (value == 0xFFu) {
    if (reader->offset >= reader->length) return 0;
    const uint8_t following = reader->bytes[reader->offset++];
    if (following != 0x00u) return 0;
    value = 0xFFu;
  }
  *byte_out = value;
  return 1;
}

static int entropy_bit(EntropyReader* reader, uint32_t* bit_out) {
  if (reader->remaining_bits == 0) {
    if (!entropy_byte(reader, &reader->current)) return 0;
    reader->remaining_bits = 8;
  }
  reader->remaining_bits -= 1;
  *bit_out = (reader->current >> reader->remaining_bits) & 1u;
  return 1;
}

static int entropy_bits(EntropyReader* reader,
                        uint32_t count,
                        uint32_t* value_out) {
  uint32_t value = 0;
  for (uint32_t index = 0; index < count; index++) {
    uint32_t bit = 0;
    if (!entropy_bit(reader, &bit)) return 0;
    value = (value << 1) | bit;
  }
  *value_out = value;
  return 1;
}

static int huffman_symbol(EntropyReader* reader,
                          const HuffmanTable* table,
                          uint32_t* symbol_out) {
  int32_t code = 0;
  for (uint32_t length = 1; length <= 16; length++) {
    uint32_t bit = 0;
    if (!entropy_bit(reader, &bit)) return 0;
    code = (code << 1) | (int32_t)bit;
    if (table->maximum_code[length] >= 0 &&
        code >= table->minimum_code[length] &&
        code <= table->maximum_code[length]) {
      const int32_t index =
          table->value_index[length] +
          code - table->minimum_code[length];
      if (index < 0 || (uint32_t)index >= table->symbol_count) return 0;
      *symbol_out = table->symbols[index];
      return 1;
    }
  }
  return 0;
}

static int decode_difference(EntropyReader* reader,
                             uint32_t category,
                             int32_t* difference_out) {
  if (category == 0) {
    *difference_out = 0;
    return 1;
  }
  if (category > 16) return 0;
  uint32_t value = 0;
  if (!entropy_bits(reader, category, &value)) return 0;
  const uint32_t threshold = (uint32_t)1u << (category - 1u);
  if (value < threshold) {
    *difference_out =
        (int32_t)value - (int32_t)(((uint32_t)1u << category) - 1u);
  } else {
    *difference_out = (int32_t)value;
  }
  return 1;
}

static int finish_entropy(const EntropyReader* reader) {
  if (reader->remaining_bits > 0) {
    const uint32_t mask =
        ((uint32_t)1u << reader->remaining_bits) - 1u;
    if (((uint32_t)reader->current & mask) != mask) return 0;
  }
  size_t offset = reader->offset;
  if (offset >= reader->length || reader->bytes[offset] != 0xFFu) return 0;
  while (offset < reader->length && reader->bytes[offset] == 0xFFu) {
    offset += 1;
  }
  return offset < reader->length && reader->bytes[offset] == 0xD9u;
}

static int decode_scan(const uint8_t* bytes,
                       size_t length,
                       size_t entropy_offset,
                       uint32_t precision,
                       uint32_t component_width,
                       uint32_t component_height,
                       const HuffmanTable* const tables[4],
                       const ArwSensor* sensor,
                       uint32_t tile_index,
                       float* samples) {
  if (component_width * 2u != sensor->tile_width ||
      component_height * 2u != sensor->tile_height) {
    return 0;
  }
#if SIZE_MAX <= UINT32_MAX
  if (component_width > SIZE_MAX / (4u * sizeof(uint16_t))) return 0;
#endif
  uint16_t* previous =
      (uint16_t*)calloc((size_t)component_width * 4u, sizeof(uint16_t));
  uint16_t* current =
      (uint16_t*)calloc((size_t)component_width * 4u, sizeof(uint16_t));
  if (previous == NULL || current == NULL) {
    free(previous);
    free(current);
    return -1;
  }

  EntropyReader entropy = {
      bytes,
      length,
      entropy_offset,
      0,
      0,
  };
  const int32_t initial = (int32_t)((uint32_t)1u << (precision - 1u));
  const int32_t maximum =
      precision == 16
          ? 65535
          : (int32_t)(((uint32_t)1u << precision) - 1u);
  const uint32_t tile_column = tile_index % sensor->tile_columns;
  const uint32_t tile_row = tile_index / sensor->tile_columns;
  int valid = 1;
  for (uint32_t y = 0; y < component_height && valid; y++) {
    for (uint32_t x = 0; x < component_width && valid; x++) {
      for (uint32_t component = 0; component < 4; component++) {
        const size_t component_offset =
            (size_t)component * component_width + x;
        int32_t predictor = initial;
        if (y == 0 && x > 0) {
          predictor = current[component_offset - 1u];
        } else if (y > 0 && x == 0) {
          predictor = previous[component_offset];
        } else if (y > 0 && x > 0) {
          predictor = current[component_offset - 1u];
        }
        uint32_t category = 0;
        int32_t delta = 0;
        if (!huffman_symbol(&entropy, tables[component], &category) ||
            !decode_difference(&entropy, category, &delta)) {
          valid = 0;
          break;
        }
        const int32_t sample = predictor + delta;
        if (sample < 0 || sample > maximum) {
          valid = 0;
          break;
        }
        current[component_offset] = (uint16_t)sample;
        const uint32_t local_x = x * 2u + (component & 1u);
        const uint32_t local_y = y * 2u + (component >> 1u);
        const uint64_t global_x =
            (uint64_t)tile_column * sensor->tile_width + local_x;
        const uint64_t global_y =
            (uint64_t)tile_row * sensor->tile_height + local_y;
        if (global_x < sensor->width && global_y < sensor->height) {
          const uint64_t output_index =
              global_y * sensor->width + global_x;
          samples[output_index] = (float)sample;
        }
      }
    }
    if (valid) {
      memcpy(previous, current,
             (size_t)component_width * 4u * sizeof(uint16_t));
    }
  }
  if (valid && !finish_entropy(&entropy)) valid = 0;
  free(previous);
  free(current);
  return valid;
}

static int decode_jpeg_tile(const uint8_t* bytes,
                            size_t length,
                            const ArwSensor* sensor,
                            uint32_t tile_index,
                            float* samples) {
  if (bytes == NULL || length < 4 ||
      bytes[0] != 0xFFu || bytes[1] != 0xD8u) {
    return 0;
  }
  size_t offset = 2;
  uint32_t precision = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  uint8_t component_ids[4] = {0, 0, 0, 0};
  int has_frame = 0;
  HuffmanTable huffman[4];
  memset(huffman, 0, sizeof(huffman));

  while (offset < length) {
    if (bytes[offset] != 0xFFu) return 0;
    while (offset < length && bytes[offset] == 0xFFu) offset += 1;
    if (offset >= length) return 0;
    const uint8_t marker = bytes[offset++];
    if (marker == 0xD9u) return 0;
    if (marker == 0xD8u || marker == 0x01u ||
        (marker >= 0xD0u && marker <= 0xD7u)) {
      continue;
    }
    if (offset + 2u > length) return 0;
    const uint32_t segment_length = read_be_u16(bytes + offset);
    if (segment_length < 2u ||
        segment_length > length - offset) {
      return 0;
    }
    const size_t start = offset + 2u;
    const size_t end = offset + segment_length;

    if (marker == 0xC3u) {
      if (segment_length != 20u) return 0;
      precision = bytes[start];
      height = read_be_u16(bytes + start + 1u);
      width = read_be_u16(bytes + start + 3u);
      if (precision < 2u || precision > 16u ||
          precision != sensor->bits_per_sample ||
          width == 0 || height == 0 ||
          bytes[start + 5u] != 4u) {
        return 0;
      }
      for (uint32_t index = 0; index < 4; index++) {
        const size_t component_offset = start + 6u + index * 3u;
        component_ids[index] = bytes[component_offset];
        if (component_ids[index] != index + 1u ||
            bytes[component_offset + 1u] != 0x11u ||
            bytes[component_offset + 2u] != 0u) {
          return 0;
        }
      }
      has_frame = 1;
    } else if (marker == 0xC4u) {
      size_t cursor = start;
      while (cursor < end) {
        const uint8_t selector = bytes[cursor++];
        if ((selector >> 4) != 0u ||
            (selector & 0x0Fu) >= 4u ||
            cursor + 16u > end) {
          return 0;
        }
        const uint8_t* counts = bytes + cursor;
        cursor += 16u;
        uint32_t symbol_count = 0;
        for (uint32_t index = 0; index < 16; index++) {
          symbol_count += counts[index];
        }
        if (symbol_count == 0 || symbol_count > 256u ||
            symbol_count > end - cursor ||
            !build_huffman_table(
                counts, bytes + cursor, symbol_count,
                &huffman[selector & 0x0Fu])) {
          return 0;
        }
        cursor += symbol_count;
      }
      if (cursor != end) return 0;
    } else if (marker == 0xDDu) {
      if (segment_length != 4u ||
          read_be_u16(bytes + start) != 0u) {
        return 0;
      }
    } else if (marker == 0xDAu) {
      if (!has_frame || segment_length != 14u ||
          bytes[start] != 4u) {
        return 0;
      }
      const HuffmanTable* tables[4] = {NULL, NULL, NULL, NULL};
      for (uint32_t index = 0; index < 4; index++) {
        const size_t scan_offset = start + 1u + index * 2u;
        const uint8_t selector = bytes[scan_offset + 1u];
        const uint32_t table_index = selector >> 4;
        if (bytes[scan_offset] != component_ids[index] ||
            (selector & 0x0Fu) != 0u ||
            table_index >= 4u || !huffman[table_index].valid) {
          return 0;
        }
        tables[index] = &huffman[table_index];
      }
      if (bytes[start + 9u] != 1u ||
          bytes[start + 10u] != 0u ||
          bytes[start + 11u] != 0u) {
        return 0;
      }
      return decode_scan(bytes, length, end, precision, width, height,
                         tables, sensor, tile_index, samples);
    }
    offset = end;
  }
  return 0;
}

static uint32_t read_lsb_bits(const uint8_t* bytes,
                              uint32_t position,
                              uint32_t count) {
  uint32_t value = 0;
  for (uint32_t bit = 0; bit < count; bit++) {
    value |= (uint32_t)(((bytes[(position + bit) >> 3] >>
                              ((position + bit) & 7u)) & 1u) << bit);
  }
  return value;
}

static int decode_arw2_block(const uint8_t* block,
                             const uint32_t curve[4096],
                             float* output) {
  const uint32_t high = read_lsb_bits(block, 0, 11);
  const uint32_t low = read_lsb_bits(block, 11, 11);
  const uint32_t high_index = read_lsb_bits(block, 22, 4);
  const uint32_t low_index = read_lsb_bits(block, 26, 4);
  if (high < low || high_index == low_index) return 0;
  uint32_t shift = 0;
  while (((high - low) >> shift) > 127u) shift++;
  uint32_t position = 30;
  for (uint32_t index = 0; index < 16; index++) {
    uint32_t value;
    if (index == high_index) {
      value = high;
    } else if (index == low_index) {
      value = low;
    } else {
      value = low + (read_lsb_bits(block, position, 7) << shift);
      position += 7;
      if (value > 2047u) value = 2047u;
    }
    output[index * 2u] = (float)curve[value << 1u];
  }
  return position == 128u;
}

static MobileStackRawStatus decode_arw2_strips(ArwReader* reader,
                                               const ArwSensor* sensor,
                                               float* samples) {
  uint8_t* row = (uint8_t*)malloc(sensor->width);
  if (row == NULL) return MOBILE_STACK_RAW_OUT_OF_MEMORY;
  MobileStackRawStatus status = MOBILE_STACK_RAW_OK;
  uint32_t curve[4096];
  for (uint32_t index = 0; index < 4096; index++) curve[index] = index;
  if (sensor->has_sony_curve) {
    uint32_t points[6] = {0, sensor->sony_curve[0],
                         sensor->sony_curve[1], sensor->sony_curve[2],
                         sensor->sony_curve[3], 4095};
    for (uint32_t index = 0; index < 5; index++) {
      if (points[index] > points[index + 1]) {
        free(row);
        return MOBILE_STACK_RAW_CORRUPT_DATA;
      }
      for (uint32_t value = points[index] + 1;
           value <= points[index + 1]; value++) {
        curve[value] = curve[value - 1] + (1u << index);
      }
    }
  }
  uint32_t output_row = 0;
  for (uint32_t strip = 0; strip < sensor->tile_count; strip++) {
    const uint32_t rows = sensor->height - output_row < sensor->tile_height ?
        sensor->height - output_row : sensor->tile_height;
    for (uint32_t row_index = 0; row_index < rows; row_index++) {
      const uint64_t offset = (uint64_t)sensor->tile_offsets[strip] +
          (uint64_t)row_index * sensor->width;
      if (!read_at(reader, offset, row, sensor->width)) {
        status = MOBILE_STACK_RAW_FILE_IO;
        break;
      }
      float* output = samples + (size_t)output_row * sensor->width;
      for (uint32_t x = 0; x < sensor->width; x += 16) {
        const uint32_t block = x >> 4;
        const uint32_t output_x = (block >> 1) * 32u + (block & 1u);
        if (!decode_arw2_block(row + x, curve, output + output_x)) {
          status = MOBILE_STACK_RAW_DECODE_FAILURE;
          break;
        }
      }
      if (status != MOBILE_STACK_RAW_OK) break;
      output_row++;
    }
    if (status != MOBILE_STACK_RAW_OK) break;
  }
  free(row);
  if (status == MOBILE_STACK_RAW_OK && output_row != sensor->height) {
    return MOBILE_STACK_RAW_DECODE_FAILURE;
  }
  return status;
}

static void fill_decoded_metadata(const ArwSensor* sensor,
                                  MobileStackArwDecoded* decoded_out) {
  memset(decoded_out, 0, sizeof(*decoded_out));
  decoded_out->width = sensor->width;
  decoded_out->height = sensor->height;
  decoded_out->active_left = sensor->active_left;
  decoded_out->active_top = sensor->active_top;
  decoded_out->active_width = sensor->active_width;
  decoded_out->active_height = sensor->active_height;
  decoded_out->cfa_pattern = sensor->cfa_pattern;
  decoded_out->orientation = sensor->orientation;
  for (uint32_t index = 0; index < 4; index++) {
    decoded_out->black_levels[index] =
        (float)sensor->black_levels[index];
  }
  decoded_out->white_level = (float)sensor->white_level;
  if (sensor->has_camera_white_balance) {
    const float green =
        ((float)sensor->camera_white_balance[1] +
         (float)sensor->camera_white_balance[2]) * 0.5f;
    decoded_out->has_camera_white_balance = 1;
    for (uint32_t index = 0; index < 4; index++) {
      decoded_out->camera_white_balance[index] =
          (float)sensor->camera_white_balance[index] / green;
    }
  }
  if (sensor->has_d65_xyz_to_camera) {
    decoded_out->has_d65_xyz_to_camera = 1;
    memcpy(decoded_out->d65_xyz_to_camera,
           sensor->d65_xyz_to_camera,
           sizeof(decoded_out->d65_xyz_to_camera));
  }
}

static MobileStackRawStatus decode_uncompressed_strips(
    ArwReader* reader,
    const ArwSensor* sensor,
    float* samples) {
  const uint32_t maximum_value = sensor->bits_per_sample == 16
      ? 65535u
      : (((uint32_t)1u << sensor->bits_per_sample) - 1u);
  for (uint32_t strip = 0; strip < sensor->tile_count; strip++) {
    const uint32_t length = sensor->tile_byte_counts[strip];
    uint8_t* bytes = (uint8_t*)malloc(length);
    if (bytes == NULL) return MOBILE_STACK_RAW_OUT_OF_MEMORY;
    if (!read_at(reader, sensor->tile_offsets[strip], bytes, length)) {
      free(bytes);
      return MOBILE_STACK_RAW_FILE_IO;
    }
    const uint64_t first_row = (uint64_t)strip * sensor->tile_height;
    const uint64_t row_count =
        first_row >= sensor->height ? 0 :
        ((uint64_t)sensor->height - first_row < sensor->tile_height
             ? (uint64_t)sensor->height - first_row
             : sensor->tile_height);
    const uint64_t sample_count = row_count * sensor->width;
    if (sample_count * 2u != length) {
      free(bytes);
      return MOBILE_STACK_RAW_DECODE_FAILURE;
    }
    for (uint64_t i = 0; i < sample_count; i++) {
      const uint32_t value = read_u16(reader, bytes + i * 2u);
      if (value > maximum_value) {
        free(bytes);
        return MOBILE_STACK_RAW_DECODE_FAILURE;
      }
      samples[first_row * sensor->width + i] = (float)value;
    }
    free(bytes);
  }
  return MOBILE_STACK_RAW_OK;
}

static MobileStackRawStatus decode_tiles(ArwReader* reader,
                                         const ArwSensor* sensor,
                                         uint64_t maximum_pixel_count,
                                         MobileStackArwDecoded* decoded_out) {
  const uint64_t pixel_count =
      (uint64_t)sensor->width * sensor->height;
  if (pixel_count == 0 || pixel_count > maximum_pixel_count ||
      pixel_count > SIZE_MAX / sizeof(float)) {
    return MOBILE_STACK_RAW_RESOURCE_LIMIT;
  }
  float* samples = (float*)calloc((size_t)pixel_count, sizeof(float));
  if (samples == NULL) return MOBILE_STACK_RAW_OUT_OF_MEMORY;

  MobileStackRawStatus status = MOBILE_STACK_RAW_OK;
  if (sensor->compression == kCompressionNone) {
    status = decode_uncompressed_strips(reader, sensor, samples);
  } else if (sensor->compression == kCompressionSonyArw2) {
    status = decode_arw2_strips(reader, sensor, samples);
  }
  if (status != MOBILE_STACK_RAW_OK ||
      sensor->compression == kCompressionNone ||
      sensor->compression == kCompressionSonyArw2) {
    if (status != MOBILE_STACK_RAW_OK) free(samples);
    if (status != MOBILE_STACK_RAW_OK) return status;
    goto decoded_metadata;
  }
  for (uint32_t index = 0; index < sensor->tile_count; index++) {
    const uint32_t length = sensor->tile_byte_counts[index];
    uint8_t* bytes = (uint8_t*)malloc(length);
    if (bytes == NULL) {
      status = MOBILE_STACK_RAW_OUT_OF_MEMORY;
      break;
    }
    if (!read_at(reader, sensor->tile_offsets[index], bytes, length)) {
      status = MOBILE_STACK_RAW_FILE_IO;
      free(bytes);
      break;
    }
    const int decoded =
        decode_jpeg_tile(bytes, length, sensor, index, samples);
    free(bytes);
    if (decoded < 0) {
      status = MOBILE_STACK_RAW_OUT_OF_MEMORY;
      break;
    }
    if (!decoded) {
      status = MOBILE_STACK_RAW_DECODE_FAILURE;
      break;
    }
  }
  if (status != MOBILE_STACK_RAW_OK) {
    free(samples);
    return status;
  }

decoded_metadata:
  fill_decoded_metadata(sensor, decoded_out);
  decoded_out->samples = samples;
  decoded_out->sample_count = pixel_count;
  decoded_out->row_stride_samples = sensor->width;
  return MOBILE_STACK_RAW_OK;
}

static void describe_error(MobileStackRawStatus* status,
                           int32_t* error_code_out,
                           const char** error_message_out) {
  switch (*status) {
    case MOBILE_STACK_RAW_UNSUPPORTED_FORMAT:
      *error_code_out = 3004;
      *error_message_out =
          "ARW is not a supported uncompressed, JPEG Lossless, or Sony ARW2 CFA file.";
      break;
    case MOBILE_STACK_RAW_FILE_IO:
      *error_code_out = 3005;
      *error_message_out = "Unable to read the ARW file.";
      break;
    case MOBILE_STACK_RAW_RESOURCE_LIMIT:
      *error_code_out = 3006;
      *error_message_out = "ARW exceeds a configured safety limit.";
      break;
    case MOBILE_STACK_RAW_OUT_OF_MEMORY:
      *error_code_out = 3007;
      *error_message_out = "Unable to allocate ARW decode memory.";
      break;
    case MOBILE_STACK_RAW_DECODE_FAILURE:
      *error_code_out = 3008;
      *error_message_out =
          "ARW compressed sensor data is unsupported or inconsistent.";
      break;
    default:
      *status = MOBILE_STACK_RAW_CORRUPT_DATA;
      *error_code_out = 3009;
      *error_message_out = "ARW TIFF metadata is truncated or inconsistent.";
      break;
  }
}

MobileStackRawStatus mobile_stack_arw_probe_metadata(
    const uint8_t* path_utf8,
    uint32_t path_length,
    uint64_t expected_byte_length,
    uint64_t maximum_pixel_count,
    MobileStackArwDecoded* metadata_out,
    int32_t* error_code_out,
    const char** error_message_out) {
  if (error_code_out != NULL) *error_code_out = 0;
  if (error_message_out != NULL) *error_message_out = NULL;
  if (path_utf8 == NULL || path_length == 0 ||
      path_length > kMaximumPathBytes || metadata_out == NULL ||
      error_code_out == NULL || error_message_out == NULL ||
      maximum_pixel_count == 0 ||
      memchr(path_utf8, '\0', path_length) != NULL) {
    if (error_code_out != NULL) *error_code_out = 3001;
    if (error_message_out != NULL) {
      *error_message_out = "Invalid ARW metadata request.";
    }
    return MOBILE_STACK_RAW_INVALID_ARGUMENT;
  }
  memset(metadata_out, 0, sizeof(*metadata_out));

  char* path = (char*)malloc((size_t)path_length + 1u);
  if (path == NULL) {
    *error_code_out = 3002;
    *error_message_out = "Unable to allocate the ARW path.";
    return MOBILE_STACK_RAW_OUT_OF_MEMORY;
  }
  memcpy(path, path_utf8, path_length);
  path[path_length] = '\0';
  FILE* file = fopen(path, "rb");
  free(path);
  if (file == NULL) {
    *error_code_out = 3003;
    *error_message_out = "Unable to open the ARW file.";
    return MOBILE_STACK_RAW_FILE_IO;
  }

  MobileStackRawStatus status = MOBILE_STACK_RAW_OK;
  if (fseek(file, 0, SEEK_END) != 0) status = MOBILE_STACK_RAW_FILE_IO;
  const long length = status == MOBILE_STACK_RAW_OK ? ftell(file) : -1;
  if (length < 0) status = MOBILE_STACK_RAW_FILE_IO;
  if (status == MOBILE_STACK_RAW_OK &&
      (uint64_t)length != expected_byte_length) {
    status = MOBILE_STACK_RAW_CORRUPT_DATA;
  }

  if (status == MOBILE_STACK_RAW_OK) {
    ArwReader reader = {file, (uint64_t)length, 1};
    ArwSensor* sensor = (ArwSensor*)calloc(1, sizeof(ArwSensor));
    if (sensor == NULL) {
      status = MOBILE_STACK_RAW_OUT_OF_MEMORY;
    } else {
      status = find_sensor(&reader, sensor);
      if (status == MOBILE_STACK_RAW_OK) {
        const uint64_t pixel_count =
            (uint64_t)sensor->width * sensor->height;
        if (pixel_count == 0 || pixel_count > maximum_pixel_count) {
          status = MOBILE_STACK_RAW_RESOURCE_LIMIT;
        } else {
          fill_decoded_metadata(sensor, metadata_out);
        }
      }
      free(sensor);
    }
  }
  fclose(file);

  if (status != MOBILE_STACK_RAW_OK) {
    memset(metadata_out, 0, sizeof(*metadata_out));
    describe_error(&status, error_code_out, error_message_out);
  }
  return status;
}

MobileStackRawStatus mobile_stack_arw_decode_lossless(
    const uint8_t* path_utf8,
    uint32_t path_length,
    uint64_t expected_byte_length,
    uint64_t maximum_pixel_count,
    MobileStackArwDecoded* decoded_out,
    int32_t* error_code_out,
    const char** error_message_out) {
  if (error_code_out != NULL) *error_code_out = 0;
  if (error_message_out != NULL) *error_message_out = NULL;
  if (path_utf8 == NULL || path_length == 0 ||
      path_length > kMaximumPathBytes || decoded_out == NULL ||
      error_code_out == NULL || error_message_out == NULL ||
      maximum_pixel_count == 0 ||
      memchr(path_utf8, '\0', path_length) != NULL) {
    if (error_code_out != NULL) *error_code_out = 3001;
    if (error_message_out != NULL) {
      *error_message_out = "Invalid ARW decode request.";
    }
    return MOBILE_STACK_RAW_INVALID_ARGUMENT;
  }
  memset(decoded_out, 0, sizeof(*decoded_out));

  char* path = (char*)malloc((size_t)path_length + 1u);
  if (path == NULL) {
    *error_code_out = 3002;
    *error_message_out = "Unable to allocate the ARW path.";
    return MOBILE_STACK_RAW_OUT_OF_MEMORY;
  }
  memcpy(path, path_utf8, path_length);
  path[path_length] = '\0';
  FILE* file = fopen(path, "rb");
  free(path);
  if (file == NULL) {
    *error_code_out = 3003;
    *error_message_out = "Unable to open the ARW file.";
    return MOBILE_STACK_RAW_FILE_IO;
  }

  MobileStackRawStatus status = MOBILE_STACK_RAW_OK;
  if (fseek(file, 0, SEEK_END) != 0) status = MOBILE_STACK_RAW_FILE_IO;
  const long length = status == MOBILE_STACK_RAW_OK ? ftell(file) : -1;
  if (length < 0) status = MOBILE_STACK_RAW_FILE_IO;
  if (status == MOBILE_STACK_RAW_OK &&
      (uint64_t)length != expected_byte_length) {
    status = MOBILE_STACK_RAW_CORRUPT_DATA;
  }

  if (status == MOBILE_STACK_RAW_OK) {
    ArwReader reader = {
        file,
        (uint64_t)length,
        1,
    };
    ArwSensor* sensor = (ArwSensor*)calloc(1, sizeof(ArwSensor));
    if (sensor == NULL) {
      status = MOBILE_STACK_RAW_OUT_OF_MEMORY;
    } else {
      status = find_sensor(&reader, sensor);
      if (status == MOBILE_STACK_RAW_OK) {
        status = decode_tiles(
            &reader, sensor, maximum_pixel_count, decoded_out);
      }
      free(sensor);
    }
  }
  fclose(file);

  if (status != MOBILE_STACK_RAW_OK) {
    free(decoded_out->samples);
    memset(decoded_out, 0, sizeof(*decoded_out));
    describe_error(&status, error_code_out, error_message_out);
  }
  return status;
}
