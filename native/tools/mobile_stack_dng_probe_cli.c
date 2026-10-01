#include "mobile_stack_raw_ffi.h"

#include <inttypes.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static const char* cfa_name(uint32_t cfa_pattern) {
  switch (cfa_pattern) {
    case MOBILE_STACK_RAW_CFA_RGGB:
      return "RGGB";
    case MOBILE_STACK_RAW_CFA_BGGR:
      return "BGGR";
    case MOBILE_STACK_RAW_CFA_GRBG:
      return "GRBG";
    case MOBILE_STACK_RAW_CFA_GBRG:
      return "GBRG";
    default:
      return "UNKNOWN";
  }
}

static void print_json_bytes(const uint8_t* bytes, uint32_t length) {
  putchar('"');
  if (bytes != NULL) {
    for (uint32_t index = 0; index < length; index++) {
      const uint8_t value = bytes[index];
      switch (value) {
        case '"':
          fputs("\\\"", stdout);
          break;
        case '\\':
          fputs("\\\\", stdout);
          break;
        case '\b':
          fputs("\\b", stdout);
          break;
        case '\f':
          fputs("\\f", stdout);
          break;
        case '\n':
          fputs("\\n", stdout);
          break;
        case '\r':
          fputs("\\r", stdout);
          break;
        case '\t':
          fputs("\\t", stdout);
          break;
        default:
          if (value < 0x20u) {
            printf("\\u%04x", (unsigned int)value);
          } else {
            putchar((int)value);
          }
          break;
      }
    }
  }
  putchar('"');
}

static int read_file_length(const char* path, uint64_t* length_out) {
  FILE* file = fopen(path, "rb");
  if (file == NULL) {
    return 0;
  }
  const int seek_status = fseek(file, 0, SEEK_END);
  const long length = seek_status == 0 ? ftell(file) : -1;
  const int close_status = fclose(file);
  if (length < 0 || close_status != 0) {
    return 0;
  }
  *length_out = (uint64_t)length;
  return 1;
}

static void print_success(
    uint64_t byte_length,
    const MobileStackRawMetadataProbeResult* result) {
  printf(
      "{\"schemaVersion\":1,\"status\":\"ok\","
      "\"byteLength\":%" PRIu64 ",\"width\":%" PRIu32
      ",\"height\":%" PRIu32 ",\"cfa\":\"%s\","
      "\"activeArea\":{\"left\":%" PRIu32 ",\"top\":%" PRIu32
      ",\"width\":%" PRIu32 ",\"height\":%" PRIu32 "},"
      "\"orientation\":%" PRIu32 ","
      "\"blackLevels\":[%.9g,%.9g,%.9g,%.9g],"
      "\"whiteLevel\":%.9g,\"cameraWhiteBalance\":",
      byte_length,
      result->width,
      result->height,
      cfa_name(result->cfa_pattern),
      result->active_left,
      result->active_top,
      result->active_width,
      result->active_height,
      result->orientation,
      (double)result->black_level_0,
      (double)result->black_level_1,
      (double)result->black_level_2,
      (double)result->black_level_3,
      (double)result->white_level);
  if (result->has_camera_white_balance == 0u) {
    fputs("null", stdout);
  } else {
    printf(
        "[%.9g,%.9g,%.9g,%.9g]",
        (double)result->camera_white_balance_0,
        (double)result->camera_white_balance_1,
        (double)result->camera_white_balance_2,
        (double)result->camera_white_balance_3);
  }
  fputs("}\n", stdout);
}

static void print_error(int32_t status,
                        int32_t native_code,
                        const uint8_t* message,
                        uint32_t message_length) {
  printf(
      "{\"schemaVersion\":1,\"status\":\"error\","
      "\"statusCode\":%" PRId32 ",\"nativeCode\":%" PRId32
      ",\"message\":",
      status,
      native_code);
  print_json_bytes(message, message_length);
  fputs("}\n", stdout);
}

int main(int argc, char** argv) {
  if (argc != 2) {
    fputs("usage: mobile_stack_dng_probe_cli <file.dng>\n", stderr);
    return 2;
  }

  const char* path = argv[1];
  const size_t path_length = strlen(path);
  if (path_length == 0 || path_length > UINT32_MAX) {
    fputs("invalid DNG path\n", stderr);
    return 2;
  }

  uint64_t byte_length = 0;
  if (!read_file_length(path, &byte_length)) {
    print_error(MOBILE_STACK_RAW_FILE_IO, 0, NULL, 0);
    return 2;
  }

  const uint64_t capabilities = mobile_stack_raw_capabilities();
  if ((capabilities & MOBILE_STACK_RAW_CAPABILITY_DNG_METADATA) == 0u) {
    print_error(MOBILE_STACK_RAW_UNSUPPORTED_FORMAT, 0, NULL, 0);
    return 3;
  }

  MobileStackRawDecoder* decoder = mobile_stack_raw_decoder_create();
  if (decoder == NULL) {
    print_error(MOBILE_STACK_RAW_OUT_OF_MEMORY, 0, NULL, 0);
    return 3;
  }

  const MobileStackRawMetadataProbeRequest request = {
      MOBILE_STACK_RAW_ABI_VERSION,
      (uint32_t)sizeof(MobileStackRawMetadataProbeRequest),
      MOBILE_STACK_RAW_FORMAT_DNG,
      0u,
      byte_length,
  };
  MobileStackRawMetadataProbeResult* result = NULL;
  const int32_t status = mobile_stack_raw_probe_metadata(
      decoder,
      (const uint8_t*)path,
      (uint32_t)path_length,
      &request,
      &result);

  int exit_code = 1;
  if (status == MOBILE_STACK_RAW_OK && result != NULL &&
      result->status_code == MOBILE_STACK_RAW_OK) {
    print_success(byte_length, result);
    exit_code = 0;
  } else if (result != NULL) {
    print_error(
        status == MOBILE_STACK_RAW_OK ? result->status_code : status,
        result->error_code,
        result->error_message,
        result->error_message_length);
  } else {
    print_error(status, 0, NULL, 0);
  }

  mobile_stack_raw_metadata_result_release(result);
  mobile_stack_raw_decoder_destroy(decoder);
  return exit_code;
}
