#ifndef MOBILE_STACK_UTIL_H
#define MOBILE_STACK_UTIL_H

#ifdef __cplusplus
extern "C" {
#endif

#define MOBILE_STACK_UTIL_API \
  __attribute__((visibility("default"))) __attribute__((used))

/* Work360: SHA-256 of a whole file, written as 64 lowercase hex characters
 * plus a terminating NUL into out_hex (at least 65 bytes).
 *
 * Exactly the FIPS 180-4 digest the Dart `package:crypto` sha256 produces, so
 * every existing checkpoint/receipt fingerprint stays valid. It replaces the
 * pure-Dart hashing of 100-300 MB decoded caches, which took 10-18 s per
 * frame on device (Work350 log: milkyDecodedCache publish).
 *
 * Returns 0 on success, -1 for invalid arguments, -2 if the file cannot be
 * opened, -3 on a read error. */
MOBILE_STACK_UTIL_API int mobile_stack_util_sha256_file(const char *path,
                                                        char *out_hex);

/* Same digest over a memory buffer (used by tests). */
MOBILE_STACK_UTIL_API int mobile_stack_util_sha256_buffer(
    const unsigned char *data, unsigned long long length, char *out_hex);

#ifdef __cplusplus
}
#endif

#endif
