/* Work360: SHA-256 known-answer and file tests. */
#include "mobile_stack_util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int expect(const char *label, const char *got, const char *want) {
  if (strcmp(got, want) != 0) {
    fprintf(stderr, "%s: got %s want %s\n", label, got, want);
    return 1;
  }
  return 0;
}

int main(int argc, char **argv) {
  char hex[65];
  int failures = 0;
  mobile_stack_util_sha256_buffer((const unsigned char *)"", 0, hex);
  failures += expect("empty", hex,
                     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  mobile_stack_util_sha256_buffer((const unsigned char *)"abc", 3, hex);
  failures += expect("abc", hex,
                     "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const char *two_block = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
  mobile_stack_util_sha256_buffer((const unsigned char *)two_block, strlen(two_block), hex);
  failures += expect("448-bit", hex,
                     "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  unsigned char *million = (unsigned char *)malloc(1000000);
  memset(million, 'a', 1000000);
  mobile_stack_util_sha256_buffer(million, 1000000, hex);
  failures += expect("million-a", hex,
                     "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  free(million);
  if (argc == 3) { /* optional: file + expected hex from the host */
    if (mobile_stack_util_sha256_file(argv[1], hex) != 0) {
      fprintf(stderr, "file hash failed\n");
      return 1;
    }
    failures += expect("file", hex, argv[2]);
  }
  if (mobile_stack_util_sha256_file("/nonexistent/mobile_stack", hex) != -2) failures++;
  if (failures == 0) printf("sha256 ok\n");
  return failures == 0 ? 0 : 1;
}
