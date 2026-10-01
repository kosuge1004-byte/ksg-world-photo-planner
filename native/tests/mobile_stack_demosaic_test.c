#include "mobile_stack_demosaic.h"

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

enum { kWidth = 8, kHeight = 6 };

static int color_at(uint32_t x, uint32_t y) {
  if ((x & 1u) == 0u && (y & 1u) == 0u) {
    return 0;
  }
  if ((x & 1u) != 0u && (y & 1u) != 0u) {
    return 2;
  }
  return 1;
}

static void fill_constant_cfa(float* samples,
                              uint32_t width,
                              uint32_t height) {
  static const float channels[3] = {0.8f, 0.5f, 0.2f};
  uint32_t y;
  for (y = 0; y < height; y++) {
    uint32_t x;
    for (x = 0; x < width; x++) {
      samples[(size_t)y * width + x] = channels[color_at(x, y)];
    }
  }
}

static MobileStackDemosaicTileRequest make_request(
    const float* samples,
    float* output,
    uint32_t output_x,
    uint32_t output_y,
    uint32_t output_width,
    uint32_t output_height) {
  MobileStackDemosaicTileRequest request;
  memset(&request, 0, sizeof(request));
  request.api_version = MOBILE_STACK_DEMOSAIC_API_VERSION;
  request.struct_size = (uint32_t)sizeof(request);
  request.cfa_samples = samples;
  request.image_width = kWidth;
  request.image_height = kHeight;
  request.cfa_row_stride_samples = kWidth;
  request.cfa_pattern = MOBILE_STACK_DEMOSAIC_CFA_RGGB;
  request.input_x = 0;
  request.input_y = 0;
  request.input_width = kWidth;
  request.input_height = kHeight;
  request.cfa_buffer_x = request.input_x;
  request.cfa_buffer_y = request.input_y;
  request.cfa_buffer_width = request.input_width;
  request.cfa_buffer_height = request.input_height;
  request.output_x = output_x;
  request.output_y = output_y;
  request.output_width = output_width;
  request.output_height = output_height;
  request.output_rgb = output;
  request.output_row_stride_floats = output_width * 3u;
  return request;
}

static int cancel_now(void* context) {
  const int* cancelled = (const int*)context;
  return *cancelled;
}

static int test_constant_and_native_values(void) {
  float samples[kWidth * kHeight];
  float output[kWidth * kHeight * 3u];
  MobileStackDemosaicTileRequest request;
  uint32_t y;
  fill_constant_cfa(samples, kWidth, kHeight);
  samples[2u * kWidth + 2u] = 2.0f;
  samples[3u * kWidth + 3u] = -0.25f;
  request = make_request(samples, output, 0, 0, kWidth, kHeight);
  CHECK(mobile_stack_demosaic_api_version() ==
        MOBILE_STACK_DEMOSAIC_API_VERSION);
  CHECK(mobile_stack_demosaic_adaptive_tile(&request) ==
        MOBILE_STACK_DEMOSAIC_OK);
  CHECK(output[(2u * kWidth + 2u) * 3u] == 2.0f);
  CHECK(output[(3u * kWidth + 3u) * 3u + 2u] == -0.25f);
  for (y = 0; y < kHeight; y++) {
    uint32_t x;
    for (x = 0; x < kWidth; x++) {
      const size_t base = ((size_t)y * kWidth + x) * 3u;
      CHECK(isfinite(output[base]));
      CHECK(isfinite(output[base + 1u]));
      CHECK(isfinite(output[base + 2u]));
    }
  }
  return 0;
}

static int test_constant_color_exactness(void) {
  float samples[kWidth * kHeight];
  float output[kWidth * kHeight * 3u];
  MobileStackDemosaicTileRequest request;
  uint32_t index;
  fill_constant_cfa(samples, kWidth, kHeight);
  request = make_request(samples, output, 0, 0, kWidth, kHeight);
  CHECK(mobile_stack_demosaic_adaptive_tile(&request) ==
        MOBILE_STACK_DEMOSAIC_OK);
  for (index = 0; index < kWidth * kHeight; index++) {
    CHECK(fabsf(output[index * 3u] - 0.8f) < 1e-6f);
    CHECK(fabsf(output[index * 3u + 1u] - 0.5f) < 1e-6f);
    CHECK(fabsf(output[index * 3u + 2u] - 0.2f) < 1e-6f);
  }
  return 0;
}

static int test_tile_equivalence(void) {
  float samples[kWidth * kHeight];
  float full[kWidth * kHeight * 3u];
  float left[4u * kHeight * 3u];
  float right[4u * kHeight * 3u];
  MobileStackDemosaicTileRequest request;
  uint32_t y;
  uint32_t x;
  for (y = 0; y < kHeight; y++) {
    for (x = 0; x < kWidth; x++) {
      const float luminance = 0.05f + 0.02f * x + 0.01f * y;
      static const float scale[3] = {1.2f, 1.0f, 0.7f};
      samples[(size_t)y * kWidth + x] =
          luminance * scale[color_at(x, y)];
    }
  }
  request = make_request(samples, full, 0, 0, kWidth, kHeight);
  CHECK(mobile_stack_demosaic_adaptive_tile(&request) ==
        MOBILE_STACK_DEMOSAIC_OK);
  request = make_request(samples, left, 0, 0, 4, kHeight);
  CHECK(mobile_stack_demosaic_adaptive_tile(&request) ==
        MOBILE_STACK_DEMOSAIC_OK);
  request = make_request(samples, right, 4, 0, 4, kHeight);
  CHECK(mobile_stack_demosaic_adaptive_tile(&request) ==
        MOBILE_STACK_DEMOSAIC_OK);
  for (y = 0; y < kHeight; y++) {
    for (x = 0; x < kWidth; x++) {
      const float* part =
          x < 4 ? &left[((size_t)y * 4u + x) * 3u]
                : &right[((size_t)y * 4u + (x - 4u)) * 3u];
      const float* expected = &full[((size_t)y * kWidth + x) * 3u];
      CHECK(memcmp(part, expected, 3u * sizeof(float)) == 0);
    }
  }
  return 0;
}

static int test_rejections_and_cancellation(void) {
  float samples[kWidth * kHeight];
  float output[kWidth * kHeight * 3u];
  MobileStackDemosaicTileRequest request;
  int cancelled = 1;
  fill_constant_cfa(samples, kWidth, kHeight);
  CHECK(MOBILE_STACK_DEMOSAIC_REQUIRED_INPUT_RADIUS == 5);

  request = make_request(samples, output, 2, 2, 2, 2);
  request.input_x = 2;
  request.input_y = 2;
  request.input_width = 2;
  request.input_height = 2;
  request.cfa_buffer_x = request.input_x;
  request.cfa_buffer_y = request.input_y;
  request.cfa_buffer_width = request.input_width;
  request.cfa_buffer_height = request.input_height;
  CHECK(mobile_stack_demosaic_adaptive_tile(&request) ==
        MOBILE_STACK_DEMOSAIC_INVALID_ARGUMENT);

  /* The suppression pass makes the true source radius four. A radius-three
   * input window would have passed the older, underspecified contract. */
  request = make_request(samples, output, 4, 3, 1, 1);
  request.input_x = 1;
  request.input_y = 0;
  request.input_width = 7;
  request.input_height = kHeight;
  request.cfa_buffer_x = request.input_x;
  request.cfa_buffer_y = request.input_y;
  request.cfa_buffer_width = request.input_width;
  request.cfa_buffer_height = request.input_height;
  CHECK(mobile_stack_demosaic_adaptive_tile(&request) ==
        MOBILE_STACK_DEMOSAIC_INVALID_ARGUMENT);

  request = make_request(samples, output, 0, 0, kWidth, kHeight);
  request.cfa_pattern = 99;
  CHECK(mobile_stack_demosaic_adaptive_tile(&request) ==
        MOBILE_STACK_DEMOSAIC_UNSUPPORTED_CFA);

  request = make_request(samples, output, 0, 0, kWidth, kHeight);
  request.cancel_callback = cancel_now;
  request.cancel_context = &cancelled;
  CHECK(mobile_stack_demosaic_adaptive_tile(&request) ==
        MOBILE_STACK_DEMOSAIC_CANCELLED);

  request = make_request(samples, output, 0, 0, kWidth, kHeight);
  samples[0] = NAN;
  CHECK(mobile_stack_demosaic_adaptive_tile(&request) ==
        MOBILE_STACK_DEMOSAIC_NONFINITE);
  return 0;
}

static int test_false_color_suppression(void) {
  enum { kW = 12, kH = 10 };
  float samples[kW * kH];
  float output[kW * kH * 3u];
  MobileStackDemosaicTileRequest request;
  uint32_t x;
  uint32_t y;
  for (y = 0; y < kH; y++) {
    for (x = 0; x < kW; x++) {
      samples[(size_t)y * kW + x] = 0.5f;
    }
  }
  samples[(size_t)4 * kW + 5] = 0.8f;

  memset(&request, 0, sizeof(request));
  request.api_version = MOBILE_STACK_DEMOSAIC_API_VERSION;
  request.struct_size = (uint32_t)sizeof(request);
  request.cfa_samples = samples;
  request.image_width = kW;
  request.image_height = kH;
  request.cfa_row_stride_samples = kW;
  request.cfa_pattern = MOBILE_STACK_DEMOSAIC_CFA_RGGB;
  request.input_width = kW;
  request.input_height = kH;
  request.cfa_buffer_x = request.input_x;
  request.cfa_buffer_y = request.input_y;
  request.cfa_buffer_width = request.input_width;
  request.cfa_buffer_height = request.input_height;
  request.output_width = kW;
  request.output_height = kH;
  request.output_rgb = output;
  request.output_row_stride_floats = kW * 3u;

  CHECK(mobile_stack_demosaic_adaptive_tile(&request) ==
        MOBILE_STACK_DEMOSAIC_OK);
  CHECK(fabs((double)output[((size_t)4 * kW + 4) * 3u] - 0.5) < 1e-3);
  CHECK(fabs((double)output[((size_t)4 * kW + 4) * 3u + 2u] - 0.5) <
        1e-3);
  return 0;
}

static int test_star_protection(void) {
  enum { kW = 14, kH = 10 };
  float samples[kW * kH];
  float output[kW * kH * 3u];
  MobileStackDemosaicTileRequest request;
  uint32_t x;
  uint32_t y;
  for (y = 0; y < kH; y++) {
    for (x = 0; x < kW; x++) {
      samples[(size_t)y * kW + x] =
          x == 6 && y == 5 ? 1.0f : 0.05f;
    }
  }

  memset(&request, 0, sizeof(request));
  request.api_version = MOBILE_STACK_DEMOSAIC_API_VERSION;
  request.struct_size = (uint32_t)sizeof(request);
  request.cfa_samples = samples;
  request.image_width = kW;
  request.image_height = kH;
  request.cfa_row_stride_samples = kW;
  request.cfa_pattern = MOBILE_STACK_DEMOSAIC_CFA_RGGB;
  request.input_width = kW;
  request.input_height = kH;
  request.cfa_buffer_x = request.input_x;
  request.cfa_buffer_y = request.input_y;
  request.cfa_buffer_width = request.input_width;
  request.cfa_buffer_height = request.input_height;
  request.output_width = kW;
  request.output_height = kH;
  request.output_rgb = output;
  request.output_row_stride_floats = kW * 3u;

  CHECK(mobile_stack_demosaic_adaptive_tile(&request) ==
        MOBILE_STACK_DEMOSAIC_OK);
  CHECK((double)output[((size_t)5 * kW + 6) * 3u] > 0.95);
  CHECK((double)output[((size_t)5 * kW + 6) * 3u + 2u] > 0.95);
  return 0;
}

static int test_diagonal_edge_quality(void) {
  enum { kW = 32, kH = 32 };
  float samples[kW * kH];
  float output[kW * kH * 3u];
  MobileStackDemosaicTileRequest request;
  double squared_error = 0.0;
  uint32_t compared = 0;
  uint32_t x;
  uint32_t y;
  for (y = 0; y < kH; y++) {
    for (x = 0; x < kW; x++) {
      samples[(size_t)y * kW + x] =
          x + y < 31 ? 0.08f : 0.88f;
    }
  }

  memset(&request, 0, sizeof(request));
  request.api_version = MOBILE_STACK_DEMOSAIC_API_VERSION;
  request.struct_size = (uint32_t)sizeof(request);
  request.cfa_samples = samples;
  request.image_width = kW;
  request.image_height = kH;
  request.cfa_row_stride_samples = kW;
  request.cfa_pattern = MOBILE_STACK_DEMOSAIC_CFA_RGGB;
  request.input_width = kW;
  request.input_height = kH;
  request.cfa_buffer_x = request.input_x;
  request.cfa_buffer_y = request.input_y;
  request.cfa_buffer_width = request.input_width;
  request.cfa_buffer_height = request.input_height;
  request.output_width = kW;
  request.output_height = kH;
  request.output_rgb = output;
  request.output_row_stride_floats = kW * 3u;
  CHECK(mobile_stack_demosaic_adaptive_tile(&request) ==
        MOBILE_STACK_DEMOSAIC_OK);

  for (y = 4; y < kH - 4; y++) {
    for (x = 4; x < kW - 4; x++) {
      const double expected = x + y < 31 ? 0.08 : 0.88;
      uint32_t channel;
      for (channel = 0; channel < 3; channel++) {
        const double difference =
            output[((size_t)y * kW + x) * 3u + channel] - expected;
        squared_error += difference * difference;
        compared++;
      }
    }
  }
  CHECK(squared_error / compared < 0.002);
  return 0;
}

static int test_saturation_aware_color_difference(void) {
  float samples[kWidth * kHeight];
  float output[kWidth * kHeight * 3u];
  uint8_t saturation_mask[(kWidth * kHeight + 7u) / 8u];
  MobileStackDemosaicTileRequest request;
  const uint32_t clipped_x = 4u;
  const uint32_t clipped_y = 4u;
  const uint32_t clipped_index = clipped_y * kWidth + clipped_x;
  const uint32_t target_x = 5u;
  const uint32_t target_y = 4u;
  fill_constant_cfa(samples, kWidth, kHeight);
  memset(saturation_mask, 0, sizeof(saturation_mask));
  samples[clipped_index] = 1.0f;
  saturation_mask[clipped_index >> 3] |=
      (uint8_t)(1u << (clipped_index & 7u));
  request = make_request(samples, output, 0, 0, kWidth, kHeight);
  request.saturation_mask = saturation_mask;
  request.saturation_row_stride_bits = kWidth;

  CHECK(mobile_stack_demosaic_adaptive_tile(&request) ==
        MOBILE_STACK_DEMOSAIC_OK);
  CHECK(fabsf(output[((size_t)target_y * kWidth + target_x) * 3u] - 0.8f) <
        2e-6f);
  CHECK(output[((size_t)clipped_y * kWidth + clipped_x) * 3u] == 1.0f);
  return 0;
}

int main(void) {
  CHECK(test_constant_color_exactness() == 0);
  CHECK(test_constant_and_native_values() == 0);
  CHECK(test_tile_equivalence() == 0);
  CHECK(test_rejections_and_cancellation() == 0);
  CHECK(test_false_color_suppression() == 0);
  CHECK(test_star_protection() == 0);
  CHECK(test_diagonal_edge_quality() == 0);
  CHECK(test_saturation_aware_color_difference() == 0);
  return 0;
}
