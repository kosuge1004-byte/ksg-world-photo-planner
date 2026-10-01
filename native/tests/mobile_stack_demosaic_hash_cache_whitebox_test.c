/* White-box test: includes mobile_stack_demosaic.c directly to reach its
 * static hash-cache functions and force a small table to fill up, proving
 * the "skip caching, never loop forever" degradation path is safe.
 *
 * Release builds define NDEBUG, which would compile every assert() below out
 * of the test and can also turn assertion-only variables/helpers into
 * -Werror failures. This is a test binary, so keep assertions active in every
 * build configuration. */
#ifdef NDEBUG
#undef NDEBUG
#endif
#define MOBILE_STACK_DEMOSAIC_HASH_CACHE_WHITEBOX 1
#include "mobile_stack_demosaic.c"

#include <assert.h>
#include <stdio.h>

int main(void) {
  DoubleHashCache cache;
  int i;
  int found_count = 0;
  int not_found_count = 0;

  /* Force capacity down to the minimum (16) regardless of hint, by
   * calling init with hint=0. */
  double_hash_cache_init(&cache, 0);
  assert(cache.capacity == 16);

  /* Insert more distinct keys than capacity. Every insertion or lookup
   * must terminate (each probes at most `capacity` slots) and must never
   * corrupt memory (checked by whoever compiles this with ASan/UBSan). */
  for (i = 0; i < 200; i++) {
    double_hash_cache_put(&cache, (uint64_t)i, (double)i * 1.5);
  }

  /* Every key that *is* present must return its correct value; a key
   * that was displaced by the full table must be reported as absent
   * (not silently return a wrong value for a different key). */
  for (i = 0; i < 200; i++) {
    double value;
    if (double_hash_cache_get(&cache, (uint64_t)i, &value)) {
      if (value != (double)i * 1.5) {
        fprintf(stderr, "wrong value for key %d: got %f\n", i, value);
        return 1;
      }
      found_count++;
    } else {
      not_found_count++;
    }
  }

  fprintf(stderr,
          "hash_cache_full_table_test: capacity=%zu inserted=200 "
          "found=%d not_found=%d\n",
          cache.capacity, found_count, not_found_count);

  /* With a 16-slot table and 200 distinct keys, most must have been
   * skipped (graceful degradation), and none must have returned wrong
   * data. Some are expected to be found since early insertions succeed
   * before the table fills. */
  assert(found_count > 0);
  assert(found_count <= (int)cache.capacity);
  assert(not_found_count > 0);

  double_hash_cache_free(&cache);
  assert(cache.capacity == 0);
  assert(cache.keys == NULL);
  assert(cache.values == NULL);

  /* A zero-capacity cache (e.g. simulating an OOM allocation) must make
   * every get a clean "not found" and every put a safe no-op. */
  {
    DoubleHashCache empty_cache = {0};
    double value;
    assert(double_hash_cache_get(&empty_cache, 42, &value) == 0);
    double_hash_cache_put(&empty_cache, 42, 3.14); /* must not crash */
    assert(double_hash_cache_get(&empty_cache, 42, &value) == 0);
  }

  {
    StructureHashCache structure_cache;
    LocalStructure input = {1, 2, 3, 4, 5, 6, 7};
    LocalStructure output = {0};
    structure_hash_cache_init(&structure_cache, 0);
    structure_hash_cache_put(&structure_cache, 7, input);
    assert(structure_hash_cache_get(&structure_cache, 7, &output) == 1);
    assert(output.bimodality == 7);
    structure_hash_cache_free(&structure_cache);
  }

  fprintf(stderr, "hash_cache_full_table_test: OK\n");
  return 0;
}
