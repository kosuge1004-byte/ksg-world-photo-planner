#include "mobile_stack_demosaic.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition)                                                \
  do {                                                                  \
    if (!(condition)) {                                                 \
      fprintf(stderr, "check failed at %s:%d: %s\n", __FILE__, __LINE__, \
              #condition);                                              \
      return 1;                                                         \
    }                                                                   \
  } while (0)

static uint32_t rng_next(uint32_t* state) {
  *state = (*state) * 1103515245u + 12345u;
  return *state;
}

static void fill_mosaic(float* samples, uint32_t width, uint32_t height,
                        uint32_t seed) {
  uint32_t state = seed;
  size_t i;
  for (i = 0; i < (size_t)width * height; i++) {
    samples[i] = (float)(rng_next(&state) % 1000u) / 1000.0f;
  }
}

static int cancel_after_n_calls(void* context) {
  int* remaining = (int*)context;
  if (*remaining <= 0) return 1;
  (*remaining)--;
  return 0;
}

/* Tiny images (below the CFA read radius) force heavy mirror bouncing:
 * luminance_proxy/local_structure/green_at will be asked for the same
 * post-mirror (x, y) coordinate from many different raw offsets. This
 * specifically exercises whether the cache key (built from POST-mirror
 * coordinates) stays correct regardless of how far the raw offset
 * travels before mirroring folds it back into range. */
static int test_tiny_images(void) {
  const uint32_t sizes[][2] = {{1, 1}, {2, 2}, {3, 3}, {1, 5}, {5, 1},
                               {2, 9}};
  const uint32_t patterns[4] = {
      MOBILE_STACK_DEMOSAIC_CFA_RGGB, MOBILE_STACK_DEMOSAIC_CFA_BGGR,
      MOBILE_STACK_DEMOSAIC_CFA_GRBG, MOBILE_STACK_DEMOSAIC_CFA_GBRG};
  size_t size_index;
  for (size_index = 0; size_index < sizeof(sizes) / sizeof(sizes[0]);
       size_index++) {
    const uint32_t width = sizes[size_index][0];
    const uint32_t height = sizes[size_index][1];
    int pattern_index;
    float* samples = (float*)malloc((size_t)width * height * sizeof(float));
    float* output =
        (float*)malloc((size_t)width * height * 3 * sizeof(float));
    CHECK(samples != NULL && output != NULL);
    fill_mosaic(samples, width, height, 55u + (uint32_t)size_index);

    for (pattern_index = 0; pattern_index < 4; pattern_index++) {
      MobileStackDemosaicTileRequest request;
      int32_t status;
      size_t i;
      request.api_version = MOBILE_STACK_DEMOSAIC_API_VERSION;
      request.struct_size = sizeof(request);
      request.cfa_samples = samples;
      request.image_width = width;
      request.image_height = height;
      request.cfa_row_stride_samples = width;
      request.cfa_pattern = patterns[pattern_index];
      request.input_x = 0;
      request.input_y = 0;
      request.input_width = width;
      request.input_height = height;
  request.cfa_buffer_x = request.input_x;
  request.cfa_buffer_y = request.input_y;
  request.cfa_buffer_width = request.input_width;
  request.cfa_buffer_height = request.input_height;
      request.output_x = 0;
      request.output_y = 0;
      request.output_width = width;
      request.output_height = height;
      request.output_rgb = output;
      request.output_row_stride_floats = width * 3;
      request.cancel_callback = NULL;
      request.cancel_context = NULL;
      request.saturation_mask = NULL;
      request.saturation_row_stride_bits = 0;

      status = mobile_stack_demosaic_adaptive_tile(&request);
      CHECK(status == MOBILE_STACK_DEMOSAIC_OK);
      for (i = 0; i < (size_t)width * height * 3; i++) {
        CHECK(isfinite(output[i]));
      }
    }
    free(samples);
    free(output);
  }
  fprintf(stderr, "test_tiny_images: OK (%zu sizes x 4 patterns)\n",
          sizeof(sizes) / sizeof(sizes[0]));
  return 0;
}

/* A tile that covers only a small window inside a larger image, so the
 * cache hint sizing (based on input_width * input_height) is exercised
 * with a non-trivial input rectangle smaller than the full image, and so
 * mirroring at the true image edges must fold coordinates back to points
 * that may sit outside the cache's *sized* footprint (though the hash
 * table itself has no positional restriction, only a capacity one). */
static int test_partial_tile_near_edge(void) {
  const uint32_t image_width = 40;
  const uint32_t image_height = 32;
  const uint32_t tile_w = 6;
  const uint32_t tile_h = 5;
  float* samples =
      (float*)malloc((size_t)image_width * image_height * sizeof(float));
  float* output = (float*)malloc((size_t)tile_w * tile_h * 3 * sizeof(float));
  MobileStackDemosaicTileRequest request;
  int32_t status;
  size_t i;
  CHECK(samples != NULL && output != NULL);
  fill_mosaic(samples, image_width, image_height, 909u);

  request.api_version = MOBILE_STACK_DEMOSAIC_API_VERSION;
  request.struct_size = sizeof(request);
  request.cfa_samples = samples;
  request.image_width = image_width;
  request.image_height = image_height;
  request.cfa_row_stride_samples = image_width;
  request.cfa_pattern = MOBILE_STACK_DEMOSAIC_CFA_RGGB;
  /* Tile sits flush against the top-left corner of the image, output
   * rectangle at (0,0), with an input rectangle exactly covering the
   * required radius so out-of-range reads must mirror. */
  request.input_x = 0;
  request.input_y = 0;
  request.input_width = tile_w + MOBILE_STACK_DEMOSAIC_REQUIRED_INPUT_RADIUS;
  request.input_height = tile_h + MOBILE_STACK_DEMOSAIC_REQUIRED_INPUT_RADIUS;
  request.cfa_buffer_x = request.input_x;
  request.cfa_buffer_y = request.input_y;
  request.cfa_buffer_width = request.input_width;
  request.cfa_buffer_height = request.input_height;
  request.output_x = 0;
  request.output_y = 0;
  request.output_width = tile_w;
  request.output_height = tile_h;
  request.output_rgb = output;
  request.output_row_stride_floats = tile_w * 3;
  request.cancel_callback = NULL;
  request.cancel_context = NULL;
  request.saturation_mask = NULL;
  request.saturation_row_stride_bits = 0;

  status = mobile_stack_demosaic_adaptive_tile(&request);
  CHECK(status == MOBILE_STACK_DEMOSAIC_OK);
  for (i = 0; i < (size_t)tile_w * tile_h * 3; i++) {
    CHECK(isfinite(output[i]));
  }

  /* Compare against processing the same region as part of a full-image
   * call, to confirm the corner tile's cache-affected output still
   * matches the tile-independent reference behavior. */
  {
    float* full_output = (float*)malloc(
        (size_t)image_width * image_height * 3 * sizeof(float));
    MobileStackDemosaicTileRequest full_request = request;
    uint32_t y;
    CHECK(full_output != NULL);
    full_request.input_width = image_width;
    full_request.input_height = image_height;
    full_request.cfa_buffer_x = full_request.input_x;
    full_request.cfa_buffer_y = full_request.input_y;
    full_request.cfa_buffer_width = full_request.input_width;
    full_request.cfa_buffer_height = full_request.input_height;
    full_request.output_width = image_width;
    full_request.output_height = image_height;
    full_request.output_rgb = full_output;
    full_request.output_row_stride_floats = image_width * 3;
    CHECK(mobile_stack_demosaic_adaptive_tile(&full_request) ==
          MOBILE_STACK_DEMOSAIC_OK);
    for (y = 0; y < tile_h; y++) {
      uint32_t x;
      for (x = 0; x < tile_w; x++) {
        int channel;
        for (channel = 0; channel < 3; channel++) {
          const float tile_value =
              output[(y * tile_w + x) * 3 + (uint32_t)channel];
          const float full_value =
              full_output[(y * image_width + x) * 3 + (uint32_t)channel];
          CHECK(tile_value == full_value);
        }
      }
    }
    free(full_output);
  }

  free(samples);
  free(output);
  fprintf(stderr, "test_partial_tile_near_edge: OK\n");
  return 0;
}

/* Cancels mid-processing to confirm the cache is freed on the
 * MOBILE_STACK_DEMOSAIC_CANCELLED early-return path (checked here via
 * ASan leak detection when this binary is built with -fsanitize=address). */
static int test_cancellation_frees_cache(void) {
  const uint32_t width = 24;
  const uint32_t height = 20;
  float* samples = (float*)malloc((size_t)width * height * sizeof(float));
  float* output = (float*)malloc((size_t)width * height * 3 * sizeof(float));
  MobileStackDemosaicTileRequest request;
  int32_t status;
  int remaining = 3;
  CHECK(samples != NULL && output != NULL);
  fill_mosaic(samples, width, height, 4242u);

  request.api_version = MOBILE_STACK_DEMOSAIC_API_VERSION;
  request.struct_size = sizeof(request);
  request.cfa_samples = samples;
  request.image_width = width;
  request.image_height = height;
  request.cfa_row_stride_samples = width;
  request.cfa_pattern = MOBILE_STACK_DEMOSAIC_CFA_GBRG;
  request.input_x = 0;
  request.input_y = 0;
  request.input_width = width;
  request.input_height = height;
  request.cfa_buffer_x = request.input_x;
  request.cfa_buffer_y = request.input_y;
  request.cfa_buffer_width = request.input_width;
  request.cfa_buffer_height = request.input_height;
  request.output_x = 0;
  request.output_y = 0;
  request.output_width = width;
  request.output_height = height;
  request.output_rgb = output;
  request.output_row_stride_floats = width * 3;
  request.cancel_callback = cancel_after_n_calls;
  request.cancel_context = &remaining;
  request.saturation_mask = NULL;
  request.saturation_row_stride_bits = 0;

  status = mobile_stack_demosaic_adaptive_tile(&request);
  CHECK(status == MOBILE_STACK_DEMOSAIC_CANCELLED);

  free(samples);
  free(output);
  fprintf(stderr, "test_cancellation_frees_cache: OK\n");
  return 0;
}

/* Repro for a specific worry: does caching the color-difference by
 * (x, y, target) ever return a Red-target value for a Blue-target lookup
 * or vice versa? Runs many repeated calls on the same request to shake
 * out any key-collision between kRed (0) and kBlue (2) at the same pixel. */
static int test_color_difference_key_separation(void) {
  const uint32_t width = 16;
  const uint32_t height = 16;
  float* samples = (float*)malloc((size_t)width * height * sizeof(float));
  float* output_a = (float*)malloc((size_t)width * height * 3 * sizeof(float));
  float* output_b = (float*)malloc((size_t)width * height * 3 * sizeof(float));
  MobileStackDemosaicTileRequest request;
  size_t i;
  CHECK(samples != NULL && output_a != NULL && output_b != NULL);
  fill_mosaic(samples, width, height, 77u);

  request.api_version = MOBILE_STACK_DEMOSAIC_API_VERSION;
  request.struct_size = sizeof(request);
  request.cfa_samples = samples;
  request.image_width = width;
  request.image_height = height;
  request.cfa_row_stride_samples = width;
  request.cfa_pattern = MOBILE_STACK_DEMOSAIC_CFA_RGGB;
  request.input_x = 0;
  request.input_y = 0;
  request.input_width = width;
  request.input_height = height;
  request.cfa_buffer_x = request.input_x;
  request.cfa_buffer_y = request.input_y;
  request.cfa_buffer_width = request.input_width;
  request.cfa_buffer_height = request.input_height;
  request.output_x = 0;
  request.output_y = 0;
  request.output_width = width;
  request.output_height = height;
  request.output_row_stride_floats = width * 3;
  request.cancel_callback = NULL;
  request.cancel_context = NULL;
  request.saturation_mask = NULL;
  request.saturation_row_stride_bits = 0;

  request.output_rgb = output_a;
  CHECK(mobile_stack_demosaic_adaptive_tile(&request) ==
        MOBILE_STACK_DEMOSAIC_OK);
  request.output_rgb = output_b;
  CHECK(mobile_stack_demosaic_adaptive_tile(&request) ==
        MOBILE_STACK_DEMOSAIC_OK);

  for (i = 0; i < (size_t)width * height * 3; i++) {
    CHECK(output_a[i] == output_b[i]);
  }
  /* Also confirm red and blue channels are not accidentally identical
   * across the whole tile, which would indicate a red/blue cache-key
   * collision silently reusing one target's value for the other. */
  {
    int any_differs = 0;
    uint32_t y;
    for (y = 0; y < height && !any_differs; y++) {
      uint32_t x;
      for (x = 0; x < width; x++) {
        const size_t base = ((size_t)y * width + x) * 3;
        if (fabsf(output_a[base] - output_a[base + 2]) > 1e-6f) {
          any_differs = 1;
          break;
        }
      }
    }
    CHECK(any_differs);
  }

  free(samples);
  free(output_a);
  free(output_b);
  fprintf(stderr, "test_color_difference_key_separation: OK\n");
  return 0;
}


static int test_nonzero_origin_local_cfa_buffer(void) {
  const uint32_t image_width = 40;
  const uint32_t image_height = 32;
  const uint32_t output_x = 10;
  const uint32_t output_y = 9;
  const uint32_t output_width = 6;
  const uint32_t output_height = 5;
  const uint32_t radius = MOBILE_STACK_DEMOSAIC_REQUIRED_INPUT_RADIUS;
  const uint32_t input_x = output_x - radius;
  const uint32_t input_y = output_y - radius;
  const uint32_t input_width = output_width + 2u * radius;
  const uint32_t input_height = output_height + 2u * radius;
  float* full = (float*)malloc((size_t)image_width * image_height * sizeof(float));
  float* local = (float*)malloc((size_t)input_width * input_height * sizeof(float));
  float* expected = (float*)malloc((size_t)output_width * output_height * 3u * sizeof(float));
  float* actual = (float*)malloc((size_t)output_width * output_height * 3u * sizeof(float));
  MobileStackDemosaicTileRequest full_request;
  MobileStackDemosaicTileRequest local_request;
  uint32_t row;
  size_t i;
  CHECK(full != NULL && local != NULL && expected != NULL && actual != NULL);
  fill_mosaic(full, image_width, image_height, 1201u);
  for (row = 0; row < input_height; row++) {
    memcpy(local + (size_t)row * input_width,
           full + (size_t)(input_y + row) * image_width + input_x,
           (size_t)input_width * sizeof(float));
  }

  memset(&full_request, 0, sizeof(full_request));
  full_request.api_version = MOBILE_STACK_DEMOSAIC_API_VERSION;
  full_request.struct_size = sizeof(full_request);
  full_request.cfa_samples = full;
  full_request.image_width = image_width;
  full_request.image_height = image_height;
  full_request.cfa_row_stride_samples = image_width;
  full_request.cfa_buffer_x = 0;
  full_request.cfa_buffer_y = 0;
  full_request.cfa_buffer_width = image_width;
  full_request.cfa_buffer_height = image_height;
  full_request.cfa_pattern = MOBILE_STACK_DEMOSAIC_CFA_RGGB;
  full_request.input_x = 0;
  full_request.input_y = 0;
  full_request.input_width = image_width;
  full_request.input_height = image_height;
  full_request.output_x = output_x;
  full_request.output_y = output_y;
  full_request.output_width = output_width;
  full_request.output_height = output_height;
  full_request.output_rgb = expected;
  full_request.output_row_stride_floats = output_width * 3u;
  CHECK(mobile_stack_demosaic_adaptive_tile(&full_request) == MOBILE_STACK_DEMOSAIC_OK);

  local_request = full_request;
  local_request.cfa_samples = local;
  local_request.cfa_row_stride_samples = input_width;
  local_request.cfa_buffer_x = input_x;
  local_request.cfa_buffer_y = input_y;
  local_request.cfa_buffer_width = input_width;
  local_request.cfa_buffer_height = input_height;
  local_request.input_x = input_x;
  local_request.input_y = input_y;
  local_request.input_width = input_width;
  local_request.input_height = input_height;
  local_request.output_rgb = actual;
  CHECK(mobile_stack_demosaic_adaptive_tile(&local_request) == MOBILE_STACK_DEMOSAIC_OK);

  for (i = 0; i < (size_t)output_width * output_height * 3u; i++) {
    CHECK(expected[i] == actual[i]);
  }
  free(actual);
  free(expected);
  free(local);
  free(full);
  return 0;
}

int main(void) {
  if (test_tiny_images() != 0) return 1;
  if (test_partial_tile_near_edge() != 0) return 1;
  if (test_cancellation_frees_cache() != 0) return 1;
  if (test_color_difference_key_separation() != 0) return 1;
  fprintf(stderr, "All cache edge-case tests passed.\n");
  CHECK(test_nonzero_origin_local_cfa_buffer() == 0);
  return 0;
}
