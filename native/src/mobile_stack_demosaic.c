#include "mobile_stack_demosaic.h"

#include <math.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

#if defined(__ANDROID__) || defined(__APPLE__) || defined(__linux__)
#include <pthread.h>
#define MOBILE_STACK_DEMOSAIC_HAS_PTHREAD 1
#else
#define MOBILE_STACK_DEMOSAIC_HAS_PTHREAD 0
#endif

enum {
  kRed = 0,
  kGreen = 1,
  kBlue = 2,
  /* green_at and its non-recursive local structure analysis read radius 2.
   * raw_color_difference evaluates green one pixel away, and
   * suppressed_color_difference evaluates that over a 3x3 window. The total
   * CFA read radius reaches 5 once the 3x3 chroma-suppression neighborhood
   * calls raw_color_difference one pixel away from the output site. */
  kRequiredRadius = MOBILE_STACK_DEMOSAIC_REQUIRED_INPUT_RADIUS,
};

static uint32_t mirror_coordinate(int64_t coordinate, uint32_t length) {
  int64_t value;
  const int64_t period = 2 * ((int64_t)length - 1);
  if (length <= 1) {
    return 0;
  }
  value = coordinate % period;
  if (value < 0) {
    value += period;
  }
  return (uint32_t)(value < (int64_t)length ? value : period - value);
}

static int color_at(uint32_t pattern, uint32_t x, uint32_t y) {
  const int even_x = (x & 1u) == 0u;
  const int even_y = (y & 1u) == 0u;
  switch (pattern) {
    case MOBILE_STACK_DEMOSAIC_CFA_RGGB:
      return even_x && even_y ? kRed
                              : (!even_x && !even_y ? kBlue : kGreen);
    case MOBILE_STACK_DEMOSAIC_CFA_BGGR:
      return even_x && even_y ? kBlue
                              : (!even_x && !even_y ? kRed : kGreen);
    case MOBILE_STACK_DEMOSAIC_CFA_GRBG:
      return !even_x && even_y ? kRed
                               : (even_x && !even_y ? kBlue : kGreen);
    case MOBILE_STACK_DEMOSAIC_CFA_GBRG:
      return even_x && !even_y ? kRed
                               : (!even_x && even_y ? kBlue : kGreen);
    default:
      return -1;
  }
}

static double sample_at(const MobileStackDemosaicTileRequest* request,
                        uint32_t x,
                        uint32_t y) {
  const uint32_t local_x = x - request->cfa_buffer_x;
  const uint32_t local_y = y - request->cfa_buffer_y;
  return request->cfa_samples[
      (size_t)local_y * request->cfa_row_stride_samples + local_x];
}

static int is_saturated(const MobileStackDemosaicTileRequest* request,
                        uint32_t x,
                        uint32_t y) {
  uint64_t bit_index;
  if (request->saturation_mask == NULL) return 0;
  bit_index = (uint64_t)y * request->saturation_row_stride_bits + x;
  return (request->saturation_mask[bit_index >> 3] &
          (uint8_t)(1u << (bit_index & 7u))) != 0;
}

static double mirrored_sample(
    const MobileStackDemosaicTileRequest* request,
    int64_t x,
    int64_t y) {
  return sample_at(request,
                   mirror_coordinate(x, request->image_width),
                   mirror_coordinate(y, request->image_height));
}

typedef struct LocalStructure {
  double xx;
  double yy;
  double xy;
  double energy;
  double coherence;
  double directed_coherence;
  double bimodality;
} LocalStructure;
/* ---------------------------------------------------------------------
 * Per-tile memoization cache.
 *
 * green_at, local_structure, and raw_color_difference are pure functions
 * of (request, x, y[, target]) that the tile loop and each other end up
 * calling repeatedly for the same coordinates as the output scan and the
 * 3x3 star-protection neighborhood in suppressed_color_difference overlap
 * between adjacent output pixels. This cache memoizes those calls for the
 * duration of a single mobile_stack_demosaic_adaptive_tile invocation and
 * is freed before it returns, so it never changes the computed values and
 * never persists state across tiles, frames, or images.
 *
 * The cache is a simple open-addressing hash table sized from the input
 * rectangle. If allocation fails (e.g. on a memory-constrained device),
 * every cache is left with capacity 0 and every lookup/store becomes a
 * no-op, so processing transparently falls back to the original
 * uncached, always-correct behavior. Lookups and insertions probe at
 * most `capacity` slots and then give up rather than looping forever, so
 * a full table degrades gracefully to "not cached" for the overflow
 * entries instead of risking an infinite loop.
 * ------------------------------------------------------------------- */

#if defined(MOBILE_STACK_DEMOSAIC_HASH_CACHE_WHITEBOX)

#define kDemosaicCacheEmptyKey UINT64_MAX

typedef struct DoubleHashCache {
  uint64_t* keys;
  double* values;
  size_t capacity;
} DoubleHashCache;

typedef struct StructureHashCache {
  uint64_t* keys;
  struct LocalStructure* values;
  size_t capacity;
} StructureHashCache;

static size_t next_pow2_capacity(uint64_t minimum) {
  size_t capacity = 16;
  if (minimum < 16) return capacity;
  while (capacity < minimum && capacity < ((size_t)1 << 24)) {
    capacity <<= 1;
  }
  return capacity;
}

static void double_hash_cache_init(DoubleHashCache* cache, uint64_t hint) {
  cache->capacity = 0;
  cache->keys = NULL;
  cache->values = NULL;
  {
    const size_t capacity = next_pow2_capacity(hint);
    uint64_t* keys = (uint64_t*)malloc(capacity * sizeof(uint64_t));
    double* values = (double*)malloc(capacity * sizeof(double));
    if (keys == NULL || values == NULL) {
      free(keys);
      free(values);
      return;
    }
    {
      size_t i;
      for (i = 0; i < capacity; i++) keys[i] = kDemosaicCacheEmptyKey;
    }
    cache->capacity = capacity;
    cache->keys = keys;
    cache->values = values;
  }
}

static void double_hash_cache_free(DoubleHashCache* cache) {
  free(cache->keys);
  free(cache->values);
  cache->keys = NULL;
  cache->values = NULL;
  cache->capacity = 0;
}

static uint64_t mix64(uint64_t key) {
  key ^= key >> 33;
  key *= 0xff51afd7ed558ccdULL;
  key ^= key >> 33;
  key *= 0xc4ceb9fe1a85ec53ULL;
  key ^= key >> 33;
  return key;
}

static int double_hash_cache_get(const DoubleHashCache* cache, uint64_t key,
                                 double* out_value) {
  size_t slot;
  size_t probes;
  if (cache->capacity == 0) return 0;
  slot = (size_t)(mix64(key) & (cache->capacity - 1));
  for (probes = 0; probes < cache->capacity; probes++) {
    if (cache->keys[slot] == kDemosaicCacheEmptyKey) return 0;
    if (cache->keys[slot] == key) {
      *out_value = cache->values[slot];
      return 1;
    }
    slot = (slot + 1) & (cache->capacity - 1);
  }
  return 0;
}

static void double_hash_cache_put(DoubleHashCache* cache, uint64_t key,
                                  double value) {
  size_t slot;
  size_t probes;
  if (cache->capacity == 0) return;
  slot = (size_t)(mix64(key) & (cache->capacity - 1));
  for (probes = 0; probes < cache->capacity; probes++) {
    if (cache->keys[slot] == kDemosaicCacheEmptyKey ||
        cache->keys[slot] == key) {
      cache->keys[slot] = key;
      cache->values[slot] = value;
      return;
    }
    slot = (slot + 1) & (cache->capacity - 1);
  }
  /* Table is full of distinct keys; skip caching this entry rather than
   * looping forever or growing mid-tile. Correctness is unaffected. */
}

static void structure_hash_cache_init(StructureHashCache* cache,
                                      uint64_t hint) {
  cache->capacity = 0;
  cache->keys = NULL;
  cache->values = NULL;
  {
    const size_t capacity = next_pow2_capacity(hint);
    uint64_t* keys = (uint64_t*)malloc(capacity * sizeof(uint64_t));
    struct LocalStructure* values = (struct LocalStructure*)malloc(
        capacity * sizeof(struct LocalStructure));
    if (keys == NULL || values == NULL) {
      free(keys);
      free(values);
      return;
    }
    {
      size_t i;
      for (i = 0; i < capacity; i++) keys[i] = kDemosaicCacheEmptyKey;
    }
    cache->capacity = capacity;
    cache->keys = keys;
    cache->values = values;
  }
}

static void structure_hash_cache_free(StructureHashCache* cache) {
  free(cache->keys);
  free(cache->values);
  cache->keys = NULL;
  cache->values = NULL;
  cache->capacity = 0;
}

static int structure_hash_cache_get(const StructureHashCache* cache,
                                    uint64_t key,
                                    struct LocalStructure* out_value) {
  size_t slot;
  size_t probes;
  if (cache->capacity == 0) return 0;
  slot = (size_t)(mix64(key) & (cache->capacity - 1));
  for (probes = 0; probes < cache->capacity; probes++) {
    if (cache->keys[slot] == kDemosaicCacheEmptyKey) return 0;
    if (cache->keys[slot] == key) {
      *out_value = cache->values[slot];
      return 1;
    }
    slot = (slot + 1) & (cache->capacity - 1);
  }
  return 0;
}

static void structure_hash_cache_put(StructureHashCache* cache, uint64_t key,
                                     struct LocalStructure value) {
  size_t slot;
  size_t probes;
  if (cache->capacity == 0) return;
  slot = (size_t)(mix64(key) & (cache->capacity - 1));
  for (probes = 0; probes < cache->capacity; probes++) {
    if (cache->keys[slot] == kDemosaicCacheEmptyKey ||
        cache->keys[slot] == key) {
      cache->keys[slot] = key;
      cache->values[slot] = value;
      return;
    }
    slot = (slot + 1) & (cache->capacity - 1);
  }
}

#endif

typedef struct DemosaicCache {
  uint32_t x;
  uint32_t y;
  uint32_t width;
  uint32_t height;
  size_t area;
  double* proxy;
  uint8_t* proxy_valid;
  LocalStructure* structure;
  uint8_t* structure_valid;
  double* green;
  uint8_t* green_valid;
  double* color_difference;
  uint8_t* color_difference_valid;
} DemosaicCache;

static void demosaic_cache_free(DemosaicCache* cache);

static void demosaic_cache_init_for_rows(
    DemosaicCache* cache,
    const MobileStackDemosaicTileRequest* request,
    uint32_t first_local_y,
    uint32_t end_local_y) {
  /* Each pthread worker used to allocate memoization arrays for the *entire*
   * input tile even though it only computes its own output-row range. With
   * two workers that doubled the largest native scratch allocation. Keep the
   * same memoized functions and numeric types, but bound each worker cache to
   * the rows it can actually depend on (the algorithm's proven CFA radius).
   * Reads outside this cache remain correct: cache lookups simply miss and
   * the original function is evaluated directly. */
  const uint32_t output_first = request->output_y + first_local_y;
  const uint32_t output_end = request->output_y + end_local_y;
  const uint32_t desired_top =
      output_first > kRequiredRadius ? output_first - kRequiredRadius : 0u;
  const uint32_t desired_bottom =
      request->image_height - output_end <= kRequiredRadius
          ? request->image_height
          : output_end + kRequiredRadius;
  const uint32_t input_bottom = request->input_y + request->input_height;
  const uint32_t cache_top =
      desired_top > request->input_y ? desired_top : request->input_y;
  const uint32_t cache_bottom =
      desired_bottom < input_bottom ? desired_bottom : input_bottom;
  const uint32_t cache_height =
      cache_bottom > cache_top ? cache_bottom - cache_top : 0u;
  const size_t area = (size_t)request->input_width * cache_height;
  memset(cache, 0, sizeof(*cache));
  cache->x = request->input_x;
  cache->y = cache_top;
  cache->width = request->input_width;
  cache->height = cache_height;
  cache->area = area;
  cache->proxy = (double*)malloc(area * sizeof(double));
  cache->proxy_valid = (uint8_t*)calloc(area, sizeof(uint8_t));
  cache->structure = (LocalStructure*)malloc(
      area * sizeof(LocalStructure));
  cache->structure_valid = (uint8_t*)calloc(area, sizeof(uint8_t));
  cache->green = (double*)malloc(area * sizeof(double));
  cache->green_valid = (uint8_t*)calloc(area, sizeof(uint8_t));
  cache->color_difference = (double*)malloc(area * 2u * sizeof(double));
  cache->color_difference_valid =
      (uint8_t*)calloc(area * 2u, sizeof(uint8_t));
  if (cache->proxy == NULL || cache->proxy_valid == NULL ||
      cache->structure == NULL || cache->structure_valid == NULL ||
      cache->green == NULL || cache->green_valid == NULL ||
      cache->color_difference == NULL ||
      cache->color_difference_valid == NULL) {
    demosaic_cache_free(cache);
  }
}

static void demosaic_cache_free(DemosaicCache* cache) {
  free(cache->proxy);
  free(cache->proxy_valid);
  free(cache->structure);
  free(cache->structure_valid);
  free(cache->green);
  free(cache->green_valid);
  free(cache->color_difference);
  free(cache->color_difference_valid);
  memset(cache, 0, sizeof(*cache));
}

static int dense_cache_index(const DemosaicCache* cache,
                             uint32_t x,
                             uint32_t y,
                             size_t* index_out) {
  if (cache == NULL || cache->area == 0 || x < cache->x || y < cache->y ||
      x - cache->x >= cache->width || y - cache->y >= cache->height) {
    return 0;
  }
  *index_out = (size_t)(y - cache->y) * cache->width + (x - cache->x);
  return 1;
}

static double compute_luminance_proxy(
    const MobileStackDemosaicTileRequest* request,
    uint32_t sample_x,
    uint32_t sample_y) {
  if (color_at(request->cfa_pattern, sample_x, sample_y) == kGreen) {
    return sample_at(request, sample_x, sample_y);
  }
  return (mirrored_sample(request, (int64_t)sample_x - 1, sample_y) +
          mirrored_sample(request, (int64_t)sample_x + 1, sample_y) +
          mirrored_sample(request, sample_x, (int64_t)sample_y - 1) +
          mirrored_sample(request, sample_x, (int64_t)sample_y + 1)) *
         0.25;
}

static double luminance_proxy(
    const MobileStackDemosaicTileRequest* request,
    int64_t x,
    int64_t y,
    DemosaicCache* cache) {
  const uint32_t sample_x = mirror_coordinate(x, request->image_width);
  const uint32_t sample_y = mirror_coordinate(y, request->image_height);
  if (cache != NULL) {
    size_t index;
    if (dense_cache_index(cache, sample_x, sample_y, &index)) {
      if (cache->proxy_valid[index]) return cache->proxy[index];
      cache->proxy[index] =
          compute_luminance_proxy(request, sample_x, sample_y);
      cache->proxy_valid[index] = 1;
      return cache->proxy[index];
    }
  }
  return compute_luminance_proxy(request, sample_x, sample_y);
}

static LocalStructure compute_local_structure(
    const MobileStackDemosaicTileRequest* request,
    uint32_t x,
    uint32_t y,
    DemosaicCache* cache) {
  LocalStructure result;
  double proxies[9];
  double xx = 0.0;
  double yy = 0.0;
  double xy = 0.0;
  double mean_x = 0.0;
  double mean_y = 0.0;
  double local_min = HUGE_VAL;
  double local_max = -HUGE_VAL;
  double two_level_residual = 0.0;
  int count = 0;
  int window_y;
  for (window_y = -1; window_y <= 1; window_y++) {
    int window_x;
    for (window_x = -1; window_x <= 1; window_x++) {
      const int64_t sample_x = (int64_t)x + window_x;
      const int64_t sample_y = (int64_t)y + window_y;
      const double proxy = luminance_proxy(request, sample_x, sample_y, cache);
      const double gx =
          0.5 * (luminance_proxy(request, sample_x + 1, sample_y, cache) -
                 luminance_proxy(request, sample_x - 1, sample_y, cache));
      const double gy =
          0.5 * (luminance_proxy(request, sample_x, sample_y + 1, cache) -
                 luminance_proxy(request, sample_x, sample_y - 1, cache));
      proxies[count++] = proxy;
      local_min = fmin(local_min, proxy);
      local_max = fmax(local_max, proxy);
      xx += gx * gx;
      yy += gy * gy;
      xy += gx * gy;
      mean_x += gx;
      mean_y += gy;
    }
  }
  xx /= 9.0;
  yy /= 9.0;
  xy /= 9.0;
  mean_x /= 9.0;
  mean_y /= 9.0;
  result.xx = xx;
  result.yy = yy;
  result.xy = xy;
  result.energy = xx + yy;
  result.coherence =
      sqrt((xx - yy) * (xx - yy) + 4.0 * xy * xy) /
      (result.energy + 1e-12);
  if (local_max - local_min > 1e-12) {
    int index;
    for (index = 0; index < count; index++) {
      two_level_residual +=
          fmin(proxies[index] - local_min, local_max - proxies[index]);
    }
    two_level_residual /= count * (local_max - local_min);
  }
  result.directed_coherence =
      (mean_x * mean_x + mean_y * mean_y) / (result.energy + 1e-12);
  result.bimodality =
      local_max - local_min <= 1e-12
          ? 0.0
          : fmax(0.0, 1.0 - two_level_residual / 0.22);
  return result;
}

static LocalStructure local_structure(
    const MobileStackDemosaicTileRequest* request,
    uint32_t x,
    uint32_t y,
    DemosaicCache* cache) {
  if (cache != NULL) {
    size_t index;
    if (dense_cache_index(cache, x, y, &index)) {
      if (cache->structure_valid[index]) return cache->structure[index];
      cache->structure[index] =
          compute_local_structure(request, x, y, cache);
      cache->structure_valid[index] = 1;
      return cache->structure[index];
    }
  }
  return compute_local_structure(request, x, y, cache);
}

static double smooth_step(double lower, double upper, double value) {
  double normalized = (value - lower) / (upper - lower);
  normalized = fmax(0.0, fmin(1.0, normalized));
  return normalized * normalized * (3.0 - 2.0 * normalized);
}

static double compute_green_at(const MobileStackDemosaicTileRequest* request,
                               uint32_t x,
                               uint32_t y,
                               DemosaicCache* cache) {
  static const int32_t directions[4][2] = {
      {-1, 0}, {1, 0}, {0, -1}, {0, 1}};
  static const uint32_t quadrant_pairs[4][2] = {
      {0, 2}, {1, 2}, {0, 3}, {1, 3}};
  static const double direction_vectors[8][2] = {
      {-1.0, 0.0},
      {1.0, 0.0},
      {0.0, -1.0},
      {0.0, 1.0},
      {-0.7071067811865476, -0.7071067811865476},
      {0.7071067811865476, -0.7071067811865476},
      {-0.7071067811865476, 0.7071067811865476},
      {0.7071067811865476, 0.7071067811865476},
  };
  double center;
  double estimates[4];
  double residuals[4];
  double candidate_values[8];
  double candidate_residuals[8];
  LocalStructure structure;
  double weighted = 0.0;
  double total_weight = 0.0;
  double horizontal;
  double vertical;
  double horizontal_gradient;
  double vertical_gradient;
  double horizontal_weight;
  double vertical_weight;
  double advanced;
  double conservative;
  double blend;
  uint32_t index;

  if (color_at(request->cfa_pattern, x, y) == kGreen) {
    return sample_at(request, x, y);
  }
  center = sample_at(request, x, y);
  for (index = 0; index < 4; index++) {
    const int32_t dx = directions[index][0];
    const int32_t dy = directions[index][1];
    const double adjacent_green =
        mirrored_sample(request, (int64_t)x + dx, (int64_t)y + dy);
    const double same_color =
        mirrored_sample(request, (int64_t)x + 2 * dx,
                        (int64_t)y + 2 * dy);
    estimates[index] = adjacent_green + 0.5 * (center - same_color);
    residuals[index] =
        fabs(center - same_color) +
        fabs(luminance_proxy(request, x, y, cache) -
             luminance_proxy(request, (int64_t)x + dx,
                             (int64_t)y + dy, cache));
    candidate_values[index] = estimates[index];
    candidate_residuals[index] = residuals[index];
  }
  for (index = 0; index < 4; index++) {
    const uint32_t first = quadrant_pairs[index][0];
    const uint32_t second = quadrant_pairs[index][1];
    candidate_values[index + 4] =
        (estimates[first] + estimates[second]) * 0.5;
    candidate_residuals[index + 4] =
        (residuals[first] + residuals[second]) * 0.5;
  }
  structure = local_structure(request, x, y, cache);
  for (index = 0; index < 8; index++) {
    const double dx = direction_vectors[index][0];
    const double dy = direction_vectors[index][1];
    const double directional_energy =
        fmax(0.0, dx * dx * structure.xx +
                      2.0 * dx * dy * structure.xy +
                      dy * dy * structure.yy);
    const double cost =
        candidate_residuals[index] +
        directional_energy * (0.5 + 1.5 * structure.coherence);
    const double weight = 1.0 / (1e-8 + cost * cost);
    weighted += candidate_values[index] * weight;
    total_weight += weight;
  }
  advanced = weighted / total_weight;
  horizontal = (estimates[0] + estimates[1]) * 0.5;
  vertical = (estimates[2] + estimates[3]) * 0.5;
  horizontal_gradient =
      fabs(mirrored_sample(request, (int64_t)x - 1, y) -
           mirrored_sample(request, (int64_t)x + 1, y)) +
      fabs(2.0 * center -
           mirrored_sample(request, (int64_t)x - 2, y) -
           mirrored_sample(request, (int64_t)x + 2, y));
  vertical_gradient =
      fabs(mirrored_sample(request, x, (int64_t)y - 1) -
           mirrored_sample(request, x, (int64_t)y + 1)) +
      fabs(2.0 * center -
           mirrored_sample(request, x, (int64_t)y - 2) -
           mirrored_sample(request, x, (int64_t)y + 2));
  horizontal_weight = 1.0 / (1e-6 + horizontal_gradient * horizontal_gradient);
  vertical_weight = 1.0 / (1e-6 + vertical_gradient * vertical_gradient);
  conservative =
      (horizontal * horizontal_weight + vertical * vertical_weight) /
      (horizontal_weight + vertical_weight);
  blend =
      smooth_step(0.72, 0.94, structure.coherence) *
      smooth_step(0.18, 0.55, structure.directed_coherence) *
      smooth_step(0.04, 0.1, sqrt(structure.energy)) *
      smooth_step(0.32, 0.72, structure.bimodality);
  return conservative + (advanced - conservative) * blend;
}

static double green_at(const MobileStackDemosaicTileRequest* request,
                       uint32_t x,
                       uint32_t y,
                       DemosaicCache* cache) {
  if (color_at(request->cfa_pattern, x, y) == kGreen) {
    return sample_at(request, x, y);
  }
  if (cache != NULL) {
    size_t index;
    if (dense_cache_index(cache, x, y, &index)) {
      if (cache->green_valid[index]) return cache->green[index];
      cache->green[index] = compute_green_at(request, x, y, cache);
      cache->green_valid[index] = 1;
      return cache->green[index];
    }
  }
  return compute_green_at(request, x, y, cache);
}

static double compute_raw_color_difference(
    const MobileStackDemosaicTileRequest* request,
    uint32_t x,
    uint32_t y,
    int target,
    DemosaicCache* cache) {
  static const int32_t cardinal[4][2] = {
      {-1, 0}, {1, 0}, {0, -1}, {0, 1}};
  static const int32_t diagonal[4][2] = {
      {-1, -1}, {1, -1}, {-1, 1}, {1, 1}};
  const int native_color = color_at(request->cfa_pattern, x, y);
  const int32_t(*offsets)[2] = native_color == kGreen ? cardinal : diagonal;
  uint64_t used[4] = {UINT64_MAX, UINT64_MAX, UINT64_MAX, UINT64_MAX};
  uint32_t used_count = 0;
  double weighted_difference = 0;
  double total_weight = 0;
  double center_green;
  LocalStructure structure;
  double root_energy;
  double edge_adaptation;
  double texture_adaptation;
  uint32_t index;

  if (native_color == target) {
    return sample_at(request, x, y) - green_at(request, x, y, cache);
  }
  center_green = green_at(request, x, y, cache);
  structure = local_structure(request, x, y, cache);
  root_energy = sqrt(structure.energy);
  edge_adaptation =
      smooth_step(0.7, 0.95, structure.coherence) *
      smooth_step(0.025, 0.09, root_energy) *
      smooth_step(0.18, 0.55, structure.directed_coherence) *
      smooth_step(0.32, 0.72, structure.bimodality);
  texture_adaptation =
      (1.0 - structure.coherence) *
      smooth_step(0.02, 0.08, root_energy);

  for (index = 0; index < 4; index++) {
    const uint32_t sample_x =
        mirror_coordinate((int64_t)x + offsets[index][0],
                          request->image_width);
    const uint32_t sample_y =
        mirror_coordinate((int64_t)y + offsets[index][1],
                          request->image_height);
    const uint64_t key =
        (uint64_t)sample_y * request->image_width + sample_x;
    uint32_t previous;
    int duplicate = 0;
    double neighbor_green;
    double difference;
    double length;
    double unit_x;
    double unit_y;
    double directional_energy;
    double cost;
    double exponent;
    double weight;
    for (previous = 0; previous < used_count; previous++) {
      if (used[previous] == key) {
        duplicate = 1;
        break;
      }
    }
    if (duplicate ||
        color_at(request->cfa_pattern, sample_x, sample_y) != target ||
        is_saturated(request, sample_x, sample_y)) {
      continue;
    }
    used[used_count++] = key;
    neighbor_green = green_at(request, sample_x, sample_y, cache);
    difference = sample_at(request, sample_x, sample_y) - neighbor_green;
    length = sqrt((double)(offsets[index][0] * offsets[index][0] +
                           offsets[index][1] * offsets[index][1]));
    unit_x = offsets[index][0] / length;
    unit_y = offsets[index][1] / length;
    directional_energy =
        fmax(0.0, unit_x * unit_x * structure.xx +
                      2.0 * unit_x * unit_y * structure.xy +
                      unit_y * unit_y * structure.yy);
    cost = fabs(center_green - neighbor_green) +
           0.5 * edge_adaptation * sqrt(directional_energy);
    exponent =
        1.0 + 0.45 * edge_adaptation - 0.2 * texture_adaptation;
    /* Highest-quality path: keep the adaptive chroma weight in double
     * precision until the final public FP32 RGB write.  Quantizing both the
     * base and exponent to float before pow() makes the native backend diverge
     * from the Dart mathematical reference and can perturb very small
     * color-difference weights around high-contrast point sources.  The final
     * tile is still FP32, but the non-linear weight that decides how samples
     * are combined is deliberately evaluated in double precision. */
    weight = 1.0 / pow(1e-6 + cost, exponent);
    weighted_difference += difference * weight;
    total_weight += weight;
  }
  return total_weight == 0 ? 0.0 : weighted_difference / total_weight;
}

static double raw_color_difference(
    const MobileStackDemosaicTileRequest* request,
    uint32_t x,
    uint32_t y,
    int target,
    DemosaicCache* cache) {
  if (cache != NULL) {
    size_t index;
    if (dense_cache_index(cache, x, y, &index)) {
      const size_t color_index = index * 2u + (target == kBlue ? 1u : 0u);
      if (cache->color_difference_valid[color_index]) {
        return cache->color_difference[color_index];
      }
      cache->color_difference[color_index] =
          compute_raw_color_difference(request, x, y, target, cache);
      cache->color_difference_valid[color_index] = 1;
      return cache->color_difference[color_index];
    }
  }
  return compute_raw_color_difference(request, x, y, target, cache);
}

static const double kStarProtectionRange = 0.15;

static double median_of_values(double* values, int count) {
  /* A fixed-size insertion sort avoids the indirect comparator calls and
   * general-purpose bookkeeping of qsort. This hot path runs twice for
   * almost every output pixel, while retaining exactly the same ordered
   * median for finite samples. */
  int index;
  for (index = 1; index < count; index++) {
    const double value = values[index];
    int insertion = index;
    while (insertion > 0 && values[insertion - 1] > value) {
      values[insertion] = values[insertion - 1];
      insertion--;
    }
    values[insertion] = value;
  }
  return values[count / 2];
}

static double suppressed_color_difference(
    const MobileStackDemosaicTileRequest* request,
    uint32_t x,
    uint32_t y,
    int target,
    DemosaicCache* cache) {
  double neighborhood[9];
  double local_min = HUGE_VAL;
  double local_max = -HUGE_VAL;
  double center;
  int dy;
  int count = 0;

  for (dy = -1; dy <= 1; dy++) {
    int dx;
    for (dx = -1; dx <= 1; dx++) {
      const uint32_t sample_x =
          mirror_coordinate((int64_t)x + dx, request->image_width);
      const uint32_t sample_y =
          mirror_coordinate((int64_t)y + dy, request->image_height);
      if (color_at(request->cfa_pattern, sample_x, sample_y) == target &&
          is_saturated(request, sample_x, sample_y)) {
        continue;
      }
      const double value =
          raw_color_difference(request, sample_x, sample_y, target, cache);
      neighborhood[count++] = value;
      if (value < local_min) local_min = value;
      if (value > local_max) local_max = value;
    }
  }
  center = raw_color_difference(request, x, y, target, cache);
  if (count == 0) return center;
  if (local_max - local_min > kStarProtectionRange) return center;
  return median_of_values(neighborhood, count);
}

static int valid_rectangle(uint32_t x,
                           uint32_t y,
                           uint32_t width,
                           uint32_t height,
                           uint32_t image_width,
                           uint32_t image_height) {
  return width > 0 && height > 0 && x <= image_width &&
         y <= image_height && width <= image_width - x &&
         height <= image_height - y;
}

static int input_encloses_required_area(
    const MobileStackDemosaicTileRequest* request) {
  const uint32_t required_left =
      request->output_x > kRequiredRadius
          ? request->output_x - kRequiredRadius
          : 0;
  const uint32_t required_top =
      request->output_y > kRequiredRadius
          ? request->output_y - kRequiredRadius
          : 0;
  const uint32_t output_right =
      request->output_x + request->output_width;
  const uint32_t output_bottom =
      request->output_y + request->output_height;
  const uint32_t required_right =
      request->image_width - output_right <= kRequiredRadius
          ? request->image_width
          : output_right + kRequiredRadius;
  const uint32_t required_bottom =
      request->image_height - output_bottom <= kRequiredRadius
          ? request->image_height
          : output_bottom + kRequiredRadius;
  return request->input_x <= required_left &&
         request->input_y <= required_top &&
         request->input_x + request->input_width >= required_right &&
         request->input_y + request->input_height >= required_bottom;
}

uint32_t mobile_stack_demosaic_api_version(void) {
  return MOBILE_STACK_DEMOSAIC_API_VERSION;
}

static int32_t demosaic_output_rows(
    const MobileStackDemosaicTileRequest* request,
    uint32_t first_local_y,
    uint32_t end_local_y) {
  uint32_t local_y;
  DemosaicCache cache;
  demosaic_cache_init_for_rows(
      &cache, request, first_local_y, end_local_y);
  for (local_y = first_local_y; local_y < end_local_y; local_y++) {
    uint32_t local_x;
    const uint32_t y = request->output_y + local_y;
    float* output_row =
        request->output_rgb +
        (size_t)local_y * request->output_row_stride_floats;
    if (request->cancel_callback != NULL &&
        request->cancel_callback(request->cancel_context) != 0) {
      demosaic_cache_free(&cache);
      return MOBILE_STACK_DEMOSAIC_CANCELLED;
    }
    for (local_x = 0; local_x < request->output_width; local_x++) {
      const uint32_t x = request->output_x + local_x;
      const int native_color = color_at(request->cfa_pattern, x, y);
      const double green = green_at(request, x, y, &cache);
      const double red =
          native_color == kRed
              ? sample_at(request, x, y)
              : green + suppressed_color_difference(request, x, y, kRed,
                                                     &cache);
      const double blue =
          native_color == kBlue
              ? sample_at(request, x, y)
              : green + suppressed_color_difference(request, x, y, kBlue,
                                                     &cache);
      if (!isfinite(red) || !isfinite(green) || !isfinite(blue)) {
        demosaic_cache_free(&cache);
        return MOBILE_STACK_DEMOSAIC_NONFINITE;
      }
      output_row[(size_t)local_x * 3u] = (float)red;
      output_row[(size_t)local_x * 3u + 1u] = (float)green;
      output_row[(size_t)local_x * 3u + 2u] = (float)blue;
    }
  }
  demosaic_cache_free(&cache);
  return MOBILE_STACK_DEMOSAIC_OK;
}

#if MOBILE_STACK_DEMOSAIC_HAS_PTHREAD
typedef struct DemosaicWorker {
  const MobileStackDemosaicTileRequest* request;
  uint32_t first_local_y;
  uint32_t end_local_y;
  int32_t status;
} DemosaicWorker;

static void* demosaic_worker_entry(void* opaque) {
  DemosaicWorker* worker = (DemosaicWorker*)opaque;
  worker->status = demosaic_output_rows(
      worker->request, worker->first_local_y, worker->end_local_y);
  return NULL;
}

static int32_t demosaic_output_rows_parallel(
    const MobileStackDemosaicTileRequest* request) {
  /* Mobile Stack performs full-frame RAW jobs in a single outer lane.
   Keep native demosaic parallelism deliberately small so sustained background
   processing does not occupy four cores continuously. Row ranges are
   independent, so this changes scheduling/throughput only, not pixel math. */
  enum { kWorkerCount = 2 };
  pthread_t threads[kWorkerCount];
  DemosaicWorker workers[kWorkerCount];
  uint32_t created = 0;
  uint32_t index;
  int creation_failed = 0;
  for (index = 0; index < kWorkerCount; index++) {
    workers[index].request = request;
    workers[index].first_local_y =
        (request->output_height * index) / kWorkerCount;
    workers[index].end_local_y =
        (request->output_height * (index + 1u)) / kWorkerCount;
    workers[index].status = MOBILE_STACK_DEMOSAIC_OK;
    if (pthread_create(&threads[index], NULL, demosaic_worker_entry,
                       &workers[index]) != 0) {
      creation_failed = 1;
      break;
    }
    created++;
  }
  for (index = 0; index < created; index++) {
    (void)pthread_join(threads[index], NULL);
  }
  if (creation_failed) {
    return demosaic_output_rows(request, 0, request->output_height);
  }
  for (index = 0; index < kWorkerCount; index++) {
    if (workers[index].status != MOBILE_STACK_DEMOSAIC_OK) {
      return workers[index].status;
    }
  }
  return MOBILE_STACK_DEMOSAIC_OK;
}
#endif

int32_t mobile_stack_demosaic_adaptive_tile(
    const MobileStackDemosaicTileRequest* request) {
  if (request == NULL ||
      request->api_version != MOBILE_STACK_DEMOSAIC_API_VERSION ||
      request->struct_size < sizeof(*request) ||
      request->cfa_samples == NULL || request->output_rgb == NULL ||
      request->image_width == 0 || request->image_height == 0 ||
      request->cfa_buffer_width == 0 || request->cfa_buffer_height == 0 ||
      request->cfa_row_stride_samples < request->cfa_buffer_width ||
      request->cfa_buffer_x != request->input_x ||
      request->cfa_buffer_y != request->input_y ||
      request->cfa_buffer_width != request->input_width ||
      request->cfa_buffer_height != request->input_height ||
      (request->saturation_mask != NULL &&
       request->saturation_row_stride_bits < request->image_width) ||
      request->output_width > UINT32_MAX / 3u ||
      request->output_row_stride_floats < request->output_width * 3u ||
      !valid_rectangle(request->input_x, request->input_y,
                       request->input_width, request->input_height,
                       request->image_width, request->image_height) ||
      !valid_rectangle(request->output_x, request->output_y,
                       request->output_width, request->output_height,
                       request->image_width, request->image_height) ||
      !input_encloses_required_area(request)) {
    return MOBILE_STACK_DEMOSAIC_INVALID_ARGUMENT;
  }
  if (color_at(request->cfa_pattern, 0, 0) < 0) {
    return MOBILE_STACK_DEMOSAIC_UNSUPPORTED_CFA;
  }

#if MOBILE_STACK_DEMOSAIC_HAS_PTHREAD
  if (request->cancel_callback == NULL && request->output_height >= 64u) {
    return demosaic_output_rows_parallel(request);
  }
#endif
  return demosaic_output_rows(request, 0, request->output_height);
}
