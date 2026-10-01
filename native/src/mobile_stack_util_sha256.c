/* Work360: portable FIPS 180-4 SHA-256 (see include/mobile_stack_util.h). */
#include "mobile_stack_util.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  uint32_t state[8];
  uint64_t bit_length;
  unsigned char block[64];
  size_t block_used;
} ms_sha256_ctx;

static const uint32_t k_round[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu,
    0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u, 0xd807aa98u, 0x12835b01u,
    0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u,
    0xc19bf174u, 0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
    0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau, 0x983e5152u,
    0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u,
    0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu,
    0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u,
    0xd6990624u, 0xf40e3585u, 0x106aa070u, 0x19a4c116u, 0x1e376c08u,
    0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu,
    0x682e6ff3u, 0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
};

static uint32_t rotr(uint32_t x, unsigned n) { return (x >> n) | (x << (32u - n)); }

static void ms_sha256_init(ms_sha256_ctx *ctx) {
  static const uint32_t initial[8] = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u,
                                      0xa54ff53au, 0x510e527fu, 0x9b05688cu,
                                      0x1f83d9abu, 0x5be0cd19u};
  memcpy(ctx->state, initial, sizeof(initial));
  ctx->bit_length = 0;
  ctx->block_used = 0;
}

static void ms_sha256_compress(uint32_t state[8], const unsigned char *block) {
  uint32_t w[64];
  for (int i = 0; i < 16; ++i) {
    w[i] = ((uint32_t)block[i * 4] << 24) | ((uint32_t)block[i * 4 + 1] << 16) |
           ((uint32_t)block[i * 4 + 2] << 8) | (uint32_t)block[i * 4 + 3];
  }
  for (int i = 16; i < 64; ++i) {
    const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
    const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
  uint32_t e = state[4], f = state[5], g = state[6], h = state[7];
  for (int i = 0; i < 64; ++i) {
    const uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const uint32_t ch = (e & f) ^ (~e & g);
    const uint32_t t1 = h + s1 + ch + k_round[i] + w[i];
    const uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    const uint32_t t2 = s0 + maj;
    h = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }
  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
  state[5] += f;
  state[6] += g;
  state[7] += h;
}

static void ms_sha256_update(ms_sha256_ctx *ctx, const unsigned char *data,
                             size_t length) {
  ctx->bit_length += (uint64_t)length * 8u;
  if (ctx->block_used > 0) {
    const size_t take = 64 - ctx->block_used < length ? 64 - ctx->block_used : length;
    memcpy(ctx->block + ctx->block_used, data, take);
    ctx->block_used += take;
    data += take;
    length -= take;
    if (ctx->block_used == 64) {
      ms_sha256_compress(ctx->state, ctx->block);
      ctx->block_used = 0;
    }
  }
  while (length >= 64) {
    ms_sha256_compress(ctx->state, data);
    data += 64;
    length -= 64;
  }
  if (length > 0) {
    memcpy(ctx->block, data, length);
    ctx->block_used = length;
  }
}

static void ms_sha256_final_hex(ms_sha256_ctx *ctx, char *out_hex) {
  static const char hex[] = "0123456789abcdef";
  const uint64_t bits = ctx->bit_length;
  unsigned char pad[72];
  size_t pad_length = (ctx->block_used < 56) ? 56 - ctx->block_used
                                             : 120 - ctx->block_used;
  memset(pad, 0, sizeof(pad));
  pad[0] = 0x80;
  for (int i = 0; i < 8; ++i) {
    pad[pad_length + (size_t)i] = (unsigned char)(bits >> (56 - 8 * i));
  }
  /* ms_sha256_update would add the padding to bit_length; that no longer
   * matters because the length field is already encoded in pad. */
  ms_sha256_update(ctx, pad, pad_length + 8);
  for (int i = 0; i < 8; ++i) {
    for (int b = 0; b < 4; ++b) {
      const unsigned char byte = (unsigned char)(ctx->state[i] >> (24 - 8 * b));
      out_hex[(i * 4 + b) * 2] = hex[byte >> 4];
      out_hex[(i * 4 + b) * 2 + 1] = hex[byte & 0x0f];
    }
  }
  out_hex[64] = '\0';
}

int mobile_stack_util_sha256_buffer(const unsigned char *data,
                                    unsigned long long length, char *out_hex) {
  if (out_hex == NULL || (data == NULL && length != 0)) return -1;
  ms_sha256_ctx ctx;
  ms_sha256_init(&ctx);
  if (length > 0) ms_sha256_update(&ctx, data, (size_t)length);
  ms_sha256_final_hex(&ctx, out_hex);
  return 0;
}

int mobile_stack_util_sha256_file(const char *path, char *out_hex) {
  if (path == NULL || out_hex == NULL) return -1;
  FILE *file = fopen(path, "rb");
  if (file == NULL) return -2;
  enum { kBufferSize = 1 << 20 };
  unsigned char *buffer = (unsigned char *)malloc(kBufferSize);
  if (buffer == NULL) {
    fclose(file);
    return -3;
  }
  ms_sha256_ctx ctx;
  ms_sha256_init(&ctx);
  int status = 0;
  for (;;) {
    const size_t got = fread(buffer, 1, kBufferSize, file);
    if (got > 0) ms_sha256_update(&ctx, buffer, got);
    if (got < kBufferSize) {
      if (ferror(file)) status = -3;
      break;
    }
  }
  free(buffer);
  fclose(file);
  if (status != 0) return status;
  ms_sha256_final_hex(&ctx, out_hex);
  return 0;
}
