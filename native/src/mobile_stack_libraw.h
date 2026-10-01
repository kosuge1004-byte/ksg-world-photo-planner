#ifndef MOBILE_STACK_LIBRAW_H_
#define MOBILE_STACK_LIBRAW_H_

#include "mobile_stack_arw_lossless.h"

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Internal LibRaw adapter. The public ABI remains mobile_stack_raw_ffi.h;
 * these functions are deliberately not exported from the shared library.
 */
MobileStackRawStatus mobile_stack_libraw_decode(
    const uint8_t* path_utf8,
    uint32_t path_length,
    uint64_t expected_byte_length,
    uint64_t maximum_pixel_count,
    uint32_t expected_format,
    MobileStackArwDecoded* decoded_out,
    int32_t* error_code_out,
    const char** error_message_out);

MobileStackRawStatus mobile_stack_libraw_decode_to_file(
    const uint8_t* path_utf8,
    uint32_t path_length,
    const uint8_t* output_path_utf8,
    uint32_t output_path_length,
    uint64_t expected_byte_length,
    uint64_t maximum_pixel_count,
    uint32_t expected_format,
    MobileStackArwDecoded* decoded_out,
    int32_t* error_code_out,
    const char** error_message_out);

MobileStackRawStatus mobile_stack_libraw_probe_metadata(
    const uint8_t* path_utf8,
    uint32_t path_length,
    uint64_t expected_byte_length,
    uint64_t maximum_pixel_count,
    uint32_t expected_format,
    MobileStackArwDecoded* metadata_out,
    int32_t* error_code_out,
    const char** error_message_out);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // MOBILE_STACK_LIBRAW_H_
