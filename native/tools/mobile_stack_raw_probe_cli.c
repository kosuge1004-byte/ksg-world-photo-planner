#include "mobile_stack_raw_ffi.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

static uint32_t format_code(const char* name) {
  if (strcmp(name, "arw") == 0) return MOBILE_STACK_RAW_FORMAT_ARW;
  if (strcmp(name, "nef") == 0) return MOBILE_STACK_RAW_FORMAT_NEF;
  if (strcmp(name, "nrw") == 0) return MOBILE_STACK_RAW_FORMAT_NRW;
  return MOBILE_STACK_RAW_FORMAT_UNKNOWN;
}

static uint64_t fnv1a_float_samples(const float* samples, uint64_t count) {
  const uint8_t* bytes = (const uint8_t*)samples;
  const uint64_t byte_count = count * sizeof(float);
  uint64_t hash = UINT64_C(1469598103934665603);
  for (uint64_t index = 0; index < byte_count; index++) {
    hash ^= bytes[index];
    hash *= UINT64_C(1099511628211);
  }
  return hash;
}

int main(int argc, char** argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: mobile_stack_raw_probe_cli arw|nef|nrw FILE\n");
    return 64;
  }
  const uint32_t format = format_code(argv[1]);
  if (format == MOBILE_STACK_RAW_FORMAT_UNKNOWN) return 64;
  struct stat file_stat;
  if (stat(argv[2], &file_stat) != 0 || file_stat.st_size <= 0) return 66;

  MobileStackRawDecoder* decoder = mobile_stack_raw_decoder_create();
  if (decoder == NULL) return 70;
  const MobileStackRawMetadataProbeRequest metadata_request = {
      MOBILE_STACK_RAW_ABI_VERSION,
      (uint32_t)sizeof(MobileStackRawMetadataProbeRequest),
      format,
      0u,
      (uint64_t)file_stat.st_size,
  };
  MobileStackRawMetadataProbeResult* metadata = NULL;
  const int32_t metadata_status = mobile_stack_raw_probe_metadata(
      decoder, (const uint8_t*)argv[2], (uint32_t)strlen(argv[2]),
      &metadata_request, &metadata);
  if (metadata_status != MOBILE_STACK_RAW_OK || metadata == NULL) {
    fprintf(stderr, "metadata status=%d error=%d message=%.*s\n",
            metadata_status, metadata == NULL ? 0 : metadata->error_code,
            metadata == NULL ? 0 : (int)metadata->error_message_length,
            metadata == NULL ? "" : (const char*)metadata->error_message);
    mobile_stack_raw_metadata_result_release(metadata);
    mobile_stack_raw_decoder_destroy(decoder);
    return 1;
  }
  const MobileStackRawDecodeRequest request = {
      MOBILE_STACK_RAW_ABI_VERSION,
      (uint32_t)sizeof(MobileStackRawDecodeRequest),
      format,
      MOBILE_STACK_RAW_PRECISION_FLOAT32,
      MOBILE_STACK_RAW_FLAG_PRESERVE_SENSOR_VALUES,
      (uint64_t)file_stat.st_size,
      UINT64_C(100000000),
  };
  MobileStackRawDecodeResult* result = NULL;
  const int32_t status = mobile_stack_raw_decode(
      decoder, (const uint8_t*)argv[2], (uint32_t)strlen(argv[2]), &request,
      &result);
  if (status != MOBILE_STACK_RAW_OK || result == NULL) {
    fprintf(stderr, "decode status=%d error=%d message=%.*s\n", status,
            result == NULL ? 0 : result->error_code,
            result == NULL ? 0 : (int)result->error_message_length,
            result == NULL ? "" : (const char*)result->error_message);
    mobile_stack_raw_decode_result_release(result);
    mobile_stack_raw_metadata_result_release(metadata);
    mobile_stack_raw_decoder_destroy(decoder);
    return 1;
  }

  double sum = 0.0;
  float minimum = INFINITY;
  float maximum = -INFINITY;
  uint64_t non_finite = 0;
  for (uint64_t index = 0; index < result->sample_count; index++) {
    const float value = result->samples[index];
    if (!isfinite(value)) {
      non_finite++;
      continue;
    }
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
    sum += value;
  }
  const uint64_t hash =
      fnv1a_float_samples(result->samples, result->sample_count);
  printf("{\"status\":0,\"metadataStatus\":%d,\"hasD65Matrix\":%u,"
         "\"capabilities\":%llu,\"format\":%u,\"width\":%u,\"height\":%u,"
         "\"sampleCount\":%llu,\"rowStride\":%u,\"cfa\":%u,"
         "\"orientation\":%u,\"black\":[%.0f,%.0f,%.0f,%.0f],"
         "\"white\":%.0f,\"minimum\":%.0f,\"maximum\":%.0f,"
         "\"mean\":%.9g,\"nonFinite\":%llu,"
         "\"fnv1aFloatBytes\":\"%016llx\"}\n",
         metadata_status, metadata->has_d65_xyz_to_camera,
         (unsigned long long)mobile_stack_raw_capabilities(), result->format,
         result->width, result->height,
         (unsigned long long)result->sample_count, result->row_stride_samples,
         result->cfa_pattern, result->orientation, result->black_level_0,
         result->black_level_1, result->black_level_2, result->black_level_3,
         result->white_level, minimum, maximum,
         sum / (double)result->sample_count, (unsigned long long)non_finite,
         (unsigned long long)hash);

  mobile_stack_raw_decode_result_release(result);
  mobile_stack_raw_metadata_result_release(metadata);
  mobile_stack_raw_decoder_destroy(decoder);
  return non_finite == 0 ? 0 : 1;
}
