#ifndef MOBILE_STACK_DEMOSAIC_H_
#define MOBILE_STACK_DEMOSAIC_H_

#include <stdint.h>

#if defined(_WIN32)
#define MOBILE_STACK_DEMOSAIC_EXPORT __declspec(dllexport)
#else
#define MOBILE_STACK_DEMOSAIC_EXPORT \
  __attribute__((visibility("default"))) __attribute__((used))
#endif

#ifdef __cplusplus
extern "C" {
#endif

enum {
  MOBILE_STACK_DEMOSAIC_API_VERSION = 3,
  MOBILE_STACK_DEMOSAIC_CFA_RGGB = 1,
  MOBILE_STACK_DEMOSAIC_CFA_BGGR = 2,
  MOBILE_STACK_DEMOSAIC_CFA_GRBG = 3,
  MOBILE_STACK_DEMOSAIC_CFA_GBRG = 4,
  MOBILE_STACK_DEMOSAIC_REQUIRED_INPUT_RADIUS = 5,
};

typedef enum MobileStackDemosaicStatus {
  MOBILE_STACK_DEMOSAIC_OK = 0,
  MOBILE_STACK_DEMOSAIC_INVALID_ARGUMENT = 1,
  MOBILE_STACK_DEMOSAIC_UNSUPPORTED_CFA = 2,
  MOBILE_STACK_DEMOSAIC_CANCELLED = 3,
  MOBILE_STACK_DEMOSAIC_NONFINITE = 4,
} MobileStackDemosaicStatus;

typedef int32_t (*MobileStackDemosaicCancelCallback)(void* context);

typedef struct MobileStackDemosaicTileRequest {
  uint32_t api_version;
  uint32_t struct_size;
  const float* cfa_samples;
  uint32_t image_width;
  uint32_t image_height;
  uint32_t cfa_row_stride_samples;
  uint32_t cfa_buffer_x;
  uint32_t cfa_buffer_y;
  uint32_t cfa_buffer_width;
  uint32_t cfa_buffer_height;
  uint32_t cfa_pattern;
  uint32_t input_x;
  uint32_t input_y;
  uint32_t input_width;
  uint32_t input_height;
  uint32_t output_x;
  uint32_t output_y;
  uint32_t output_width;
  uint32_t output_height;
  float* output_rgb;
  uint32_t output_row_stride_floats;
  MobileStackDemosaicCancelCallback cancel_callback;
  void* cancel_context;
  const uint8_t* saturation_mask;
  uint32_t saturation_row_stride_bits;
} MobileStackDemosaicTileRequest;

MOBILE_STACK_DEMOSAIC_EXPORT uint32_t
mobile_stack_demosaic_api_version(void);

MOBILE_STACK_DEMOSAIC_EXPORT int32_t
mobile_stack_demosaic_adaptive_tile(
    const MobileStackDemosaicTileRequest* request);

#ifdef __cplusplus
}
#endif

#endif  // MOBILE_STACK_DEMOSAIC_H_
