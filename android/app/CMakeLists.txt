cmake_minimum_required(VERSION 3.22.1)
project(mobile_stack_raw LANGUAGES C CXX)

include(../../native/cmake/libraw.cmake)

add_library(
    mobile_stack_raw
    SHARED
    ../../native/src/mobile_stack_raw_ffi_stub.c
    ../../native/src/mobile_stack_dng_metadata.c
    ../../native/src/mobile_stack_arw_lossless.c
    ../../native/src/mobile_stack_libraw.cpp
    ../../native/src/mobile_stack_demosaic.c
    ../../native/src/mobile_stack_util_sha256.c
)

target_include_directories(
    mobile_stack_raw
    PRIVATE
    ../../native/include
)

target_compile_features(mobile_stack_raw PRIVATE c_std_11 cxx_std_11)
target_link_libraries(mobile_stack_raw PRIVATE m mobile_stack_libraw)
target_compile_definitions(
    mobile_stack_raw
    PRIVATE
    MOBILE_STACK_RAW_ENABLE_DNG_METADATA=1
    MOBILE_STACK_RAW_ENABLE_ARW_LOSSLESS_JPEG=1
    MOBILE_STACK_RAW_ENABLE_LIBRAW=1
)
set_target_properties(
    mobile_stack_raw
    PROPERTIES
    C_VISIBILITY_PRESET hidden
)
target_compile_options(
    mobile_stack_raw
    PRIVATE
  $<$<CONFIG:Debug>:-O3>
    -Wall
    -Wextra
    -Werror
)
