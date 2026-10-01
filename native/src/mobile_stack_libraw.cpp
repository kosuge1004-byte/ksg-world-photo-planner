#include "mobile_stack_libraw.h"

#include "libraw/libraw.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <new>

namespace {

constexpr uint32_t kMaximumPathBytes = 32768u;
constexpr int32_t kInvalidRequestError = 4001;
constexpr int32_t kPathAllocationError = 4002;
constexpr int32_t kFileValidationError = 4003;
constexpr int32_t kUnsupportedCameraError = 4004;
constexpr int32_t kGeometryError = 4005;
constexpr int32_t kOpenError = 4006;
constexpr int32_t kUnpackError = 4007;
constexpr int32_t kSensorBufferError = 4008;
constexpr int32_t kMetadataError = 4009;

class MobileStackLibRaw final : public LibRaw {};

void set_error(int32_t code,
               const char* message,
               int32_t* error_code_out,
               const char** error_message_out) {
  *error_code_out = code;
  *error_message_out = message;
}

MobileStackRawStatus status_from_libraw(int status) {
  switch (status) {
    case LIBRAW_FILE_UNSUPPORTED:
    case LIBRAW_NOT_IMPLEMENTED:
      return MOBILE_STACK_RAW_UNSUPPORTED_FORMAT;
    case LIBRAW_IO_ERROR:
    case LIBRAW_INPUT_CLOSED:
      return MOBILE_STACK_RAW_FILE_IO;
    case LIBRAW_UNSUFFICIENT_MEMORY:
      return MOBILE_STACK_RAW_OUT_OF_MEMORY;
    case LIBRAW_TOO_BIG:
    case LIBRAW_MEMPOOL_OVERFLOW:
      return MOBILE_STACK_RAW_RESOURCE_LIMIT;
    case LIBRAW_CANCELLED_BY_CALLBACK:
      return MOBILE_STACK_RAW_CANCELLED;
    case LIBRAW_DATA_ERROR:
    case LIBRAW_BAD_CROP:
      return MOBILE_STACK_RAW_CORRUPT_DATA;
    default:
      return MOBILE_STACK_RAW_DECODE_FAILURE;
  }
}

const char* message_for_libraw_status(int status, bool unpacking) {
  if (status == LIBRAW_FILE_UNSUPPORTED || status == LIBRAW_NOT_IMPLEMENTED) {
    return "LibRaw does not support this Sony/Nikon RAW layout.";
  }
  if (status == LIBRAW_IO_ERROR || status == LIBRAW_INPUT_CLOSED) {
    return "LibRaw could not read the RAW file.";
  }
  if (status == LIBRAW_UNSUFFICIENT_MEMORY) {
    return "LibRaw could not allocate RAW decode memory.";
  }
  if (status == LIBRAW_TOO_BIG || status == LIBRAW_MEMPOOL_OVERFLOW) {
    return "The RAW file exceeds a LibRaw safety limit.";
  }
  if (status == LIBRAW_DATA_ERROR || status == LIBRAW_BAD_CROP) {
    return "LibRaw found inconsistent RAW metadata or sensor data.";
  }
  return unpacking ? "LibRaw could not unpack the RAW sensor plane."
                   : "LibRaw could not identify the RAW file.";
}

MobileStackRawStatus copy_path_and_validate_length(
    const uint8_t* path_utf8,
    uint32_t path_length,
    uint64_t expected_byte_length,
    std::unique_ptr<char[]>* path_out,
    int32_t* error_code_out,
    const char** error_message_out) {
  std::unique_ptr<char[]> path(new (std::nothrow) char[path_length + 1u]);
  if (!path) {
    set_error(kPathAllocationError, "Unable to allocate the RAW path.",
              error_code_out, error_message_out);
    return MOBILE_STACK_RAW_OUT_OF_MEMORY;
  }
  std::memcpy(path.get(), path_utf8, path_length);
  path[path_length] = '\0';

  FILE* file = std::fopen(path.get(), "rb");
  if (file == nullptr) {
    set_error(kFileValidationError, "Unable to open the RAW file.",
              error_code_out, error_message_out);
    return MOBILE_STACK_RAW_FILE_IO;
  }
  int seek_status = std::fseek(file, 0, SEEK_END);
  const long length = seek_status == 0 ? std::ftell(file) : -1;
  std::fclose(file);
  if (length < 0) {
    set_error(kFileValidationError, "Unable to measure the RAW file.",
              error_code_out, error_message_out);
    return MOBILE_STACK_RAW_FILE_IO;
  }
  if (static_cast<uint64_t>(length) != expected_byte_length) {
    set_error(kFileValidationError,
              "The RAW file length changed after file selection.",
              error_code_out, error_message_out);
    return MOBILE_STACK_RAW_CORRUPT_DATA;
  }
  *path_out = std::move(path);
  return MOBILE_STACK_RAW_OK;
}

bool expected_maker(const libraw_iparams_t& identity,
                    uint32_t expected_format) {
  if (expected_format == MOBILE_STACK_RAW_FORMAT_ARW) {
    return identity.maker_index == LIBRAW_CAMERAMAKER_Sony;
  }
  if (expected_format == MOBILE_STACK_RAW_FORMAT_NEF ||
      expected_format == MOBILE_STACK_RAW_FORMAT_NRW) {
    return identity.maker_index == LIBRAW_CAMERAMAKER_Nikon;
  }
  return false;
}

uint32_t cfa_from_colors(const int colors[4]) {
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

int normalized_color(MobileStackLibRaw& processor, int row, int column) {
  const int color = processor.COLOR(row, column);
  return color == 3 ? 1 : color;
}

uint32_t exif_orientation_from_libraw_flip(int flip) {
  if (flip > 89 || flip < -89) {
    flip = (flip + 720) % 360;
    if (flip == 90) return 6u;
    if (flip == 180) return 3u;
    if (flip == 270) return 8u;
    return 1u;
  }
  static const uint32_t kExifByFlip[8] = {1u, 2u, 4u, 3u,
                                          5u, 8u, 6u, 7u};
  return flip >= 0 && flip < 8 ? kExifByFlip[flip] : 1u;
}

bool finite_positive(float value) {
  return std::isfinite(value) && value > 0.0f;
}

bool copy_color_matrix(const libraw_colordata_t& color,
                       MobileStackArwDecoded* output) {
  float matrix[9];
  double magnitude = 0.0;
  for (int row = 0; row < 3; ++row) {
    for (int column = 0; column < 3; ++column) {
      const float value = color.cam_xyz[row][column];
      if (!std::isfinite(value)) return false;
      matrix[row * 3 + column] = value;
      magnitude += std::fabs(static_cast<double>(value));
    }
  }
  const double determinant =
      static_cast<double>(matrix[0]) *
          (static_cast<double>(matrix[4]) * matrix[8] -
           static_cast<double>(matrix[5]) * matrix[7]) -
      static_cast<double>(matrix[1]) *
          (static_cast<double>(matrix[3]) * matrix[8] -
           static_cast<double>(matrix[5]) * matrix[6]) +
      static_cast<double>(matrix[2]) *
          (static_cast<double>(matrix[3]) * matrix[7] -
           static_cast<double>(matrix[4]) * matrix[6]);
  if (magnitude <= 1.0e-6 || !std::isfinite(determinant) ||
      std::fabs(determinant) <= 1.0e-9) {
    return false;
  }
  std::memcpy(output->d65_xyz_to_camera, matrix, sizeof(matrix));
  output->has_d65_xyz_to_camera = 1u;
  return true;
}

MobileStackRawStatus fill_metadata(MobileStackLibRaw& processor,
                                   uint64_t maximum_pixel_count,
                                   MobileStackArwDecoded* output,
                                   int32_t* error_code_out,
                                   const char** error_message_out) {
  const libraw_image_sizes_t& sizes = processor.imgdata.sizes;
  const libraw_iparams_t& identity = processor.imgdata.idata;
  libraw_colordata_t& color = processor.imgdata.color;
  if (identity.filters == 0u || identity.colors < 3 ||
      sizes.width < 2u || sizes.height < 2u ||
      sizes.raw_width < sizes.width || sizes.raw_height < sizes.height ||
      sizes.left_margin > sizes.raw_width - sizes.width ||
      sizes.top_margin > sizes.raw_height - sizes.height) {
    set_error(kUnsupportedCameraError,
              "Only single-plane 2x2 Bayer Sony/Nikon RAW files are supported.",
              error_code_out, error_message_out);
    return MOBILE_STACK_RAW_UNSUPPORTED_FORMAT;
  }
  const uint64_t pixel_count =
      static_cast<uint64_t>(sizes.width) * sizes.height;
  if (pixel_count == 0u || pixel_count > maximum_pixel_count ||
      pixel_count > std::numeric_limits<size_t>::max() / sizeof(float)) {
    set_error(kGeometryError, "The active RAW sensor exceeds the pixel limit.",
              error_code_out, error_message_out);
    return MOBILE_STACK_RAW_RESOURCE_LIMIT;
  }

  int phase_colors[4] = {
      normalized_color(processor, 0, 0),
      normalized_color(processor, 0, 1),
      normalized_color(processor, 1, 0),
      normalized_color(processor, 1, 1),
  };
  const uint32_t cfa = cfa_from_colors(phase_colors);
  if (cfa == MOBILE_STACK_RAW_CFA_UNKNOWN) {
    set_error(kUnsupportedCameraError,
              "The RAW file does not expose a supported 2x2 Bayer CFA.",
              error_code_out, error_message_out);
    return MOBILE_STACK_RAW_UNSUPPORTED_FORMAT;
  }

  const uint32_t black_rows = color.cblack[4];
  const uint32_t black_columns = color.cblack[5];
  if ((black_rows == 0u) != (black_columns == 0u) ||
      (black_rows != 0u &&
       (black_rows > (LIBRAW_CBLACK_SIZE - 6u) / black_columns))) {
    set_error(kMetadataError, "LibRaw returned an invalid black-level pattern.",
              error_code_out, error_message_out);
    return MOBILE_STACK_RAW_CORRUPT_DATA;
  }
  if (black_rows != 0u) {
    for (uint32_t phase_row = 0; phase_row < 2u; ++phase_row) {
      for (uint32_t phase_column = 0; phase_column < 2u; ++phase_column) {
        const uint32_t reference = color.cblack[
            6u + (phase_row % black_rows) * black_columns +
            phase_column % black_columns];
        for (uint32_t row = phase_row; row < black_rows; row += 2u) {
          for (uint32_t column = phase_column;
               column < black_columns; column += 2u) {
            if (color.cblack[6u + row * black_columns + column] != reference) {
              set_error(
                  kMetadataError,
                  "The RAW black-level pattern is not 2x2-periodic for ABI v1.",
                  error_code_out, error_message_out);
              return MOBILE_STACK_RAW_UNSUPPORTED_FORMAT;
            }
          }
        }
      }
    }
  }
  const float white_level = static_cast<float>(color.maximum);
  if (!finite_positive(white_level)) {
    set_error(kMetadataError, "LibRaw returned an invalid white level.",
              error_code_out, error_message_out);
    return MOBILE_STACK_RAW_CORRUPT_DATA;
  }

  std::memset(output, 0, sizeof(*output));
  output->width = sizes.width;
  output->height = sizes.height;
  output->active_left = 0u;
  output->active_top = 0u;
  output->active_width = sizes.width;
  output->active_height = sizes.height;
  output->cfa_pattern = cfa;
  output->orientation = exif_orientation_from_libraw_flip(sizes.flip);
  output->white_level = white_level;

  int native_phase_channels[4] = {
      processor.COLOR(0, 0),
      processor.COLOR(0, 1),
      processor.COLOR(1, 0),
      processor.COLOR(1, 1),
  };
  for (int phase = 0; phase < 4; ++phase) {
    int channel = native_phase_channels[phase];
    if (channel < 0 || channel > 3) {
      set_error(kMetadataError, "LibRaw returned an invalid CFA channel.",
                error_code_out, error_message_out);
      return MOBILE_STACK_RAW_CORRUPT_DATA;
    }
    const uint32_t phase_row = static_cast<uint32_t>(phase >> 1);
    const uint32_t phase_column = static_cast<uint32_t>(phase & 1);
    const uint32_t repeat_black = black_rows == 0u
        ? 0u
        : color.cblack[6u + (phase_row % black_rows) * black_columns +
                       phase_column % black_columns];
    const uint64_t black = static_cast<uint64_t>(color.black) +
                           color.cblack[channel] + repeat_black;
    if (black >= color.maximum) {
      set_error(kMetadataError,
                "LibRaw returned an invalid black/white level range.",
                error_code_out, error_message_out);
      return MOBILE_STACK_RAW_CORRUPT_DATA;
    }
    output->black_levels[phase] = static_cast<float>(black);
  }

  float phase_wb[4];
  bool has_wb = true;
  float green_sum = 0.0f;
  uint32_t green_count = 0u;
  for (int phase = 0; phase < 4; ++phase) {
    int channel = native_phase_channels[phase];
    float multiplier = color.cam_mul[channel];
    if (channel == 3 && !finite_positive(multiplier)) {
      multiplier = color.cam_mul[1];
    }
    if (!finite_positive(multiplier)) {
      has_wb = false;
      break;
    }
    phase_wb[phase] = multiplier;
    if (normalized_color(processor, phase >> 1, phase & 1) == 1) {
      green_sum += multiplier;
      green_count += 1u;
    }
  }
  if (has_wb && green_count == 2u && finite_positive(green_sum)) {
    const float green = green_sum * 0.5f;
    output->has_camera_white_balance = 1u;
    for (int phase = 0; phase < 4; ++phase) {
      output->camera_white_balance[phase] = phase_wb[phase] / green;
    }
  }
  copy_color_matrix(color, output);
  return MOBILE_STACK_RAW_OK;
}

MobileStackRawStatus open_and_validate(
    const uint8_t* path_utf8,
    uint32_t path_length,
    uint64_t expected_byte_length,
    uint64_t maximum_pixel_count,
    uint32_t expected_format,
    std::unique_ptr<MobileStackLibRaw>* processor_out,
    MobileStackArwDecoded* metadata_out,
    int32_t* error_code_out,
    const char** error_message_out) {
  std::unique_ptr<char[]> path;
  MobileStackRawStatus status = copy_path_and_validate_length(
      path_utf8, path_length, expected_byte_length, &path,
      error_code_out, error_message_out);
  if (status != MOBILE_STACK_RAW_OK) return status;

  std::unique_ptr<MobileStackLibRaw> processor(
      new (std::nothrow) MobileStackLibRaw());
  if (!processor) {
    set_error(kPathAllocationError, "Unable to allocate the LibRaw decoder.",
              error_code_out, error_message_out);
    return MOBILE_STACK_RAW_OUT_OF_MEMORY;
  }
  const int open_status = processor->open_file(path.get());
  if (open_status != LIBRAW_SUCCESS) {
    set_error(kOpenError, message_for_libraw_status(open_status, false),
              error_code_out, error_message_out);
    return status_from_libraw(open_status);
  }
  if (!expected_maker(processor->imgdata.idata, expected_format)) {
    set_error(kUnsupportedCameraError,
              "The RAW maker does not match the requested Sony/Nikon format.",
              error_code_out, error_message_out);
    return MOBILE_STACK_RAW_UNSUPPORTED_FORMAT;
  }
  status = fill_metadata(*processor, maximum_pixel_count, metadata_out,
                         error_code_out, error_message_out);
  if (status != MOBILE_STACK_RAW_OK) return status;
  *processor_out = std::move(processor);
  return MOBILE_STACK_RAW_OK;
}

bool valid_request(const uint8_t* path_utf8,
                   uint32_t path_length,
                   uint64_t maximum_pixel_count,
                   uint32_t expected_format,
                   const MobileStackArwDecoded* output,
                   const int32_t* error_code_out,
                   const char* const* error_message_out) {
  const bool supported_format =
      expected_format == MOBILE_STACK_RAW_FORMAT_ARW ||
      expected_format == MOBILE_STACK_RAW_FORMAT_NEF ||
      expected_format == MOBILE_STACK_RAW_FORMAT_NRW;
  return path_utf8 != nullptr && path_length > 0u &&
         path_length <= kMaximumPathBytes &&
         std::memchr(path_utf8, '\0', path_length) == nullptr &&
         maximum_pixel_count > 0u && supported_format && output != nullptr &&
         error_code_out != nullptr && error_message_out != nullptr;
}

}  // namespace

extern "C" MobileStackRawStatus mobile_stack_libraw_probe_metadata(
    const uint8_t* path_utf8,
    uint32_t path_length,
    uint64_t expected_byte_length,
    uint64_t maximum_pixel_count,
    uint32_t expected_format,
    MobileStackArwDecoded* metadata_out,
    int32_t* error_code_out,
    const char** error_message_out) {
  if (error_code_out != nullptr) *error_code_out = 0;
  if (error_message_out != nullptr) *error_message_out = nullptr;
  if (!valid_request(path_utf8, path_length, maximum_pixel_count,
                     expected_format, metadata_out, error_code_out,
                     error_message_out)) {
    if (error_code_out != nullptr && error_message_out != nullptr) {
      set_error(kInvalidRequestError, "Invalid LibRaw metadata request.",
                error_code_out, error_message_out);
    }
    return MOBILE_STACK_RAW_INVALID_ARGUMENT;
  }
  std::memset(metadata_out, 0, sizeof(*metadata_out));
  try {
    std::unique_ptr<MobileStackLibRaw> processor;
    return open_and_validate(
        path_utf8, path_length, expected_byte_length, maximum_pixel_count,
        expected_format, &processor, metadata_out, error_code_out,
        error_message_out);
  } catch (const std::bad_alloc&) {
    set_error(kPathAllocationError, "LibRaw metadata allocation failed.",
              error_code_out, error_message_out);
    return MOBILE_STACK_RAW_OUT_OF_MEMORY;
  } catch (...) {
    set_error(kMetadataError, "Unexpected LibRaw metadata failure.",
              error_code_out, error_message_out);
    return MOBILE_STACK_RAW_INTERNAL;
  }
}

extern "C" MobileStackRawStatus mobile_stack_libraw_decode_to_file(
    const uint8_t* path_utf8,
    uint32_t path_length,
    const uint8_t* output_path_utf8,
    uint32_t output_path_length,
    uint64_t expected_byte_length,
    uint64_t maximum_pixel_count,
    uint32_t expected_format,
    MobileStackArwDecoded* decoded_out,
    int32_t* error_code_out,
    const char** error_message_out) {
  if (error_code_out != nullptr) *error_code_out = 0;
  if (error_message_out != nullptr) *error_message_out = nullptr;
  if (!valid_request(path_utf8, path_length, maximum_pixel_count,
                     expected_format, decoded_out, error_code_out,
                     error_message_out) ||
      output_path_utf8 == nullptr || output_path_length == 0u ||
      output_path_length > kMaximumPathBytes ||
      std::memchr(output_path_utf8, '\0', output_path_length) != nullptr) {
    if (error_code_out != nullptr && error_message_out != nullptr) {
      set_error(kInvalidRequestError, "Invalid LibRaw file decode request.",
                error_code_out, error_message_out);
    }
    return MOBILE_STACK_RAW_INVALID_ARGUMENT;
  }
  std::memset(decoded_out, 0, sizeof(*decoded_out));
  std::unique_ptr<char[]> output_path(new (std::nothrow) char[output_path_length + 1u]);
  if (!output_path) {
    set_error(kPathAllocationError, "Unable to allocate output path.",
              error_code_out, error_message_out);
    return MOBILE_STACK_RAW_OUT_OF_MEMORY;
  }
  std::memcpy(output_path.get(), output_path_utf8, output_path_length);
  output_path[output_path_length] = '\0';
  std::FILE* file = nullptr;
  try {
    std::unique_ptr<MobileStackLibRaw> processor;
    MobileStackRawStatus status = open_and_validate(
        path_utf8, path_length, expected_byte_length, maximum_pixel_count,
        expected_format, &processor, decoded_out, error_code_out,
        error_message_out);
    if (status != MOBILE_STACK_RAW_OK) return status;

    const int unpack_status = processor->unpack();
    if (unpack_status != LIBRAW_SUCCESS) {
      std::memset(decoded_out, 0, sizeof(*decoded_out));
      set_error(kUnpackError, message_for_libraw_status(unpack_status, true),
                error_code_out, error_message_out);
      return status_from_libraw(unpack_status);
    }
    status = fill_metadata(*processor, maximum_pixel_count, decoded_out,
                           error_code_out, error_message_out);
    if (status != MOBILE_STACK_RAW_OK) return status;
    const libraw_image_sizes_t& sizes = processor->imgdata.sizes;
    const libraw_rawdata_t& raw = processor->imgdata.rawdata;
    const uint64_t pixel_count =
        static_cast<uint64_t>(sizes.width) * sizes.height;
    if (raw.raw_image == nullptr ||
        static_cast<uint64_t>(sizes.raw_pitch) <
            static_cast<uint64_t>(sizes.raw_width) * 2u ||
        (sizes.raw_pitch & 1u) != 0u) {
      std::memset(decoded_out, 0, sizeof(*decoded_out));
      set_error(kSensorBufferError,
                "LibRaw did not return a single-plane Bayer sensor buffer.",
                error_code_out, error_message_out);
      return MOBILE_STACK_RAW_UNSUPPORTED_FORMAT;
    }

    file = std::fopen(output_path.get(), "wb");
    if (file == nullptr) {
      std::memset(decoded_out, 0, sizeof(*decoded_out));
      set_error(kFileValidationError, "Unable to create streamed RAW output.",
                error_code_out, error_message_out);
      return MOBILE_STACK_RAW_FILE_IO;
    }
    std::unique_ptr<float[]> row(new (std::nothrow) float[sizes.width]);
    if (!row) {
      std::fclose(file);
      file = nullptr;
      std::remove(output_path.get());
      std::memset(decoded_out, 0, sizeof(*decoded_out));
      set_error(kSensorBufferError, "Unable to allocate streamed RAW row.",
                error_code_out, error_message_out);
      return MOBILE_STACK_RAW_OUT_OF_MEMORY;
    }
    const size_t pitch_samples = sizes.raw_pitch / 2u;
    for (uint32_t y = 0; y < sizes.height; ++y) {
      const ushort* source = raw.raw_image +
          (static_cast<size_t>(y) + sizes.top_margin) * pitch_samples +
          sizes.left_margin;
      for (uint32_t x = 0; x < sizes.width; ++x) {
        row[x] = static_cast<float>(source[x]);
      }
      if (std::fwrite(row.get(), sizeof(float), sizes.width, file) != sizes.width) {
        std::fclose(file);
        file = nullptr;
        std::remove(output_path.get());
        std::memset(decoded_out, 0, sizeof(*decoded_out));
        set_error(kFileValidationError, "Failed while writing streamed RAW output.",
                  error_code_out, error_message_out);
        return MOBILE_STACK_RAW_FILE_IO;
      }
    }
    if (std::fflush(file) != 0 || std::fclose(file) != 0) {
      file = nullptr;
      std::remove(output_path.get());
      std::memset(decoded_out, 0, sizeof(*decoded_out));
      set_error(kFileValidationError, "Failed to finalize streamed RAW output.",
                error_code_out, error_message_out);
      return MOBILE_STACK_RAW_FILE_IO;
    }
    file = nullptr;
    decoded_out->samples = nullptr;
    decoded_out->sample_count = pixel_count;
    decoded_out->row_stride_samples = sizes.width;
    return MOBILE_STACK_RAW_OK;
  } catch (const std::bad_alloc&) {
    if (file != nullptr) std::fclose(file);
    std::remove(output_path.get());
    std::memset(decoded_out, 0, sizeof(*decoded_out));
    set_error(kSensorBufferError, "LibRaw streamed decode allocation failed.",
              error_code_out, error_message_out);
    return MOBILE_STACK_RAW_OUT_OF_MEMORY;
  } catch (...) {
    if (file != nullptr) std::fclose(file);
    std::remove(output_path.get());
    std::memset(decoded_out, 0, sizeof(*decoded_out));
    set_error(kSensorBufferError, "Unexpected LibRaw streamed decode failure.",
              error_code_out, error_message_out);
    return MOBILE_STACK_RAW_INTERNAL;
  }
}

extern "C" MobileStackRawStatus mobile_stack_libraw_decode(
    const uint8_t* path_utf8,
    uint32_t path_length,
    uint64_t expected_byte_length,
    uint64_t maximum_pixel_count,
    uint32_t expected_format,
    MobileStackArwDecoded* decoded_out,
    int32_t* error_code_out,
    const char** error_message_out) {
  if (error_code_out != nullptr) *error_code_out = 0;
  if (error_message_out != nullptr) *error_message_out = nullptr;
  if (!valid_request(path_utf8, path_length, maximum_pixel_count,
                     expected_format, decoded_out, error_code_out,
                     error_message_out)) {
    if (error_code_out != nullptr && error_message_out != nullptr) {
      set_error(kInvalidRequestError, "Invalid LibRaw decode request.",
                error_code_out, error_message_out);
    }
    return MOBILE_STACK_RAW_INVALID_ARGUMENT;
  }
  std::memset(decoded_out, 0, sizeof(*decoded_out));
  try {
    std::unique_ptr<MobileStackLibRaw> processor;
    MobileStackRawStatus status = open_and_validate(
        path_utf8, path_length, expected_byte_length, maximum_pixel_count,
        expected_format, &processor, decoded_out, error_code_out,
        error_message_out);
    if (status != MOBILE_STACK_RAW_OK) return status;

    const int unpack_status = processor->unpack();
    if (unpack_status != LIBRAW_SUCCESS) {
      std::memset(decoded_out, 0, sizeof(*decoded_out));
      set_error(kUnpackError, message_for_libraw_status(unpack_status, true),
                error_code_out, error_message_out);
      return status_from_libraw(unpack_status);
    }
    status = fill_metadata(*processor, maximum_pixel_count, decoded_out,
                           error_code_out, error_message_out);
    if (status != MOBILE_STACK_RAW_OK) return status;
    const libraw_image_sizes_t& sizes = processor->imgdata.sizes;
    const libraw_rawdata_t& raw = processor->imgdata.rawdata;
    const uint64_t pixel_count =
        static_cast<uint64_t>(sizes.width) * sizes.height;
    if (raw.raw_image == nullptr ||
        static_cast<uint64_t>(sizes.raw_pitch) <
            static_cast<uint64_t>(sizes.raw_width) * 2u ||
        (sizes.raw_pitch & 1u) != 0u) {
      std::memset(decoded_out, 0, sizeof(*decoded_out));
      set_error(kSensorBufferError,
                "LibRaw did not return a single-plane Bayer sensor buffer.",
                error_code_out, error_message_out);
      return MOBILE_STACK_RAW_UNSUPPORTED_FORMAT;
    }
    float* samples = static_cast<float*>(
        std::malloc(static_cast<size_t>(pixel_count) * sizeof(float)));
    if (samples == nullptr) {
      std::memset(decoded_out, 0, sizeof(*decoded_out));
      set_error(kSensorBufferError, "Unable to allocate decoded RAW samples.",
                error_code_out, error_message_out);
      return MOBILE_STACK_RAW_OUT_OF_MEMORY;
    }
    const size_t pitch_samples = sizes.raw_pitch / 2u;
    for (uint32_t row = 0; row < sizes.height; ++row) {
      const ushort* source = raw.raw_image +
          (static_cast<size_t>(row) + sizes.top_margin) * pitch_samples +
          sizes.left_margin;
      float* target = samples + static_cast<size_t>(row) * sizes.width;
      for (uint32_t column = 0; column < sizes.width; ++column) {
        target[column] = static_cast<float>(source[column]);
      }
    }
    decoded_out->samples = samples;
    decoded_out->sample_count = pixel_count;
    decoded_out->row_stride_samples = sizes.width;
    return MOBILE_STACK_RAW_OK;
  } catch (const std::bad_alloc&) {
    std::free(decoded_out->samples);
    std::memset(decoded_out, 0, sizeof(*decoded_out));
    set_error(kSensorBufferError, "LibRaw decode allocation failed.",
              error_code_out, error_message_out);
    return MOBILE_STACK_RAW_OUT_OF_MEMORY;
  } catch (...) {
    std::free(decoded_out->samples);
    std::memset(decoded_out, 0, sizeof(*decoded_out));
    set_error(kSensorBufferError, "Unexpected LibRaw decode failure.",
              error_code_out, error_message_out);
    return MOBILE_STACK_RAW_INTERNAL;
  }
}
