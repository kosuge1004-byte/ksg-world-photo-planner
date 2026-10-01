cmake_minimum_required(VERSION 3.22.1)
project(mobile_stack_raw_abi_checks LANGUAGES C CXX)

include(CTest)

option(
  MOBILE_STACK_RAW_ENABLE_DNG_METADATA
  "Build the read-only production DNG metadata parser."
  ON
)

include(cmake/libraw.cmake)
option(
  MOBILE_STACK_RAW_ENABLE_SANITIZERS
  "Enable AddressSanitizer and UndefinedBehaviorSanitizer for host tests."
  OFF
)

add_library(
  mobile_stack_raw
  SHARED
  src/mobile_stack_raw_ffi_stub.c
  src/mobile_stack_arw_lossless.c
  src/mobile_stack_libraw.cpp
  src/mobile_stack_demosaic.c
  src/mobile_stack_util_sha256.c
)
target_compile_definitions(
  mobile_stack_raw
  PRIVATE
  MOBILE_STACK_RAW_ENABLE_ARW_LOSSLESS_JPEG=1
  MOBILE_STACK_RAW_ENABLE_LIBRAW=1
)
if(MOBILE_STACK_RAW_ENABLE_DNG_METADATA)
  target_sources(
    mobile_stack_raw
    PRIVATE
    src/mobile_stack_dng_metadata.c
  )
  target_compile_definitions(
    mobile_stack_raw
    PRIVATE
    MOBILE_STACK_RAW_ENABLE_DNG_METADATA=1
  )
endif()
target_include_directories(
  mobile_stack_raw
  PUBLIC
  include
)
target_compile_features(mobile_stack_raw PRIVATE c_std_11 cxx_std_11)
target_link_libraries(mobile_stack_raw PRIVATE mobile_stack_libraw)
if(UNIX)
  target_link_libraries(mobile_stack_raw PRIVATE m)
endif()
set_target_properties(
  mobile_stack_raw
  PROPERTIES
  C_VISIBILITY_PRESET hidden
)

add_executable(
  mobile_stack_raw_abi_layout_test
  tests/mobile_stack_raw_abi_layout_test.c
)
target_include_directories(
  mobile_stack_raw_abi_layout_test
  PRIVATE
  include
)
target_compile_features(
  mobile_stack_raw_abi_layout_test
  PRIVATE
  c_std_11
)

add_executable(
  mobile_stack_raw_c_contract_test
  tests/mobile_stack_raw_c_contract_test.c
)
target_link_libraries(
  mobile_stack_raw_c_contract_test
  PRIVATE
  mobile_stack_raw
)
target_compile_features(
  mobile_stack_raw_c_contract_test
  PRIVATE
  c_std_11
)

add_executable(
  mobile_stack_dng_hardening_test
  tests/mobile_stack_dng_hardening_test.c
)
target_link_libraries(
  mobile_stack_dng_hardening_test
  PRIVATE
  mobile_stack_raw
)
target_compile_features(
  mobile_stack_dng_hardening_test
  PRIVATE
  c_std_11
)

add_executable(
  mobile_stack_dng_probe_cli
  tools/mobile_stack_dng_probe_cli.c
)

add_executable(
  mobile_stack_raw_probe_cli
  tools/mobile_stack_raw_probe_cli.c
)
target_link_libraries(
  mobile_stack_raw_probe_cli
  PRIVATE
  mobile_stack_raw
)
target_compile_features(
  mobile_stack_raw_probe_cli
  PRIVATE
  c_std_11
)

add_executable(
  mobile_stack_arw_lossless_test
  tests/mobile_stack_arw_lossless_test.c
)
target_link_libraries(
  mobile_stack_arw_lossless_test
  PRIVATE
  mobile_stack_raw
)
target_compile_features(
  mobile_stack_arw_lossless_test
  PRIVATE
  c_std_11
)

add_executable(
  mobile_stack_demosaic_test
  tests/mobile_stack_demosaic_test.c
)
target_link_libraries(
  mobile_stack_demosaic_test
  PRIVATE
  mobile_stack_raw
)
target_compile_features(
  mobile_stack_demosaic_test
  PRIVATE
  c_std_11
)

add_executable(
  mobile_stack_demosaic_cache_test
  tests/mobile_stack_demosaic_cache_test.c
)
target_link_libraries(
  mobile_stack_demosaic_cache_test
  PRIVATE
  mobile_stack_raw
)
target_compile_features(
  mobile_stack_demosaic_cache_test
  PRIVATE
  c_std_11
)

# This target #includes mobile_stack_demosaic.c directly to reach the
# translation unit's static hash-cache helpers, so it is compiled from
# source rather than linked against the mobile_stack_raw library, and it
# is not added to the shared -Wall/-Wextra/-Werror/-Wpedantic/sanitizer
# loop below (it sets its own flags) to avoid a duplicate-symbol/ODR
# conflict with mobile_stack_raw's copy of the same translation unit.
add_executable(
  mobile_stack_demosaic_hash_cache_whitebox_test
  tests/mobile_stack_demosaic_hash_cache_whitebox_test.c
)
target_include_directories(
  mobile_stack_demosaic_hash_cache_whitebox_test
  PRIVATE
  src
  include
)
if(UNIX)
  target_link_libraries(
    mobile_stack_demosaic_hash_cache_whitebox_test
    PRIVATE
    m
  )
endif()
target_compile_features(
  mobile_stack_demosaic_hash_cache_whitebox_test
  PRIVATE
  c_std_11
)
if(CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
  target_compile_options(
    mobile_stack_demosaic_hash_cache_whitebox_test
    PRIVATE
    -Wall
    -Wextra
    -Werror
    -Wpedantic
  )
  if(MOBILE_STACK_RAW_ENABLE_SANITIZERS)
    target_compile_options(
      mobile_stack_demosaic_hash_cache_whitebox_test
      PRIVATE
      -fsanitize=address,undefined
      -fno-omit-frame-pointer
    )
    target_link_options(
      mobile_stack_demosaic_hash_cache_whitebox_test
      PRIVATE
      -fsanitize=address,undefined
    )
  endif()
endif()
target_link_libraries(
  mobile_stack_dng_probe_cli
  PRIVATE
  mobile_stack_raw
)
target_compile_features(
  mobile_stack_dng_probe_cli
  PRIVATE
  c_std_11
)

if(CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
  if(MOBILE_STACK_RAW_ENABLE_SANITIZERS)
    target_compile_options(
      mobile_stack_libraw
      PRIVATE
      -fsanitize=address,undefined
      -fno-omit-frame-pointer
    )
  endif()
  foreach(
    target
    mobile_stack_raw
    mobile_stack_raw_abi_layout_test
    mobile_stack_raw_c_contract_test
    mobile_stack_dng_hardening_test
    mobile_stack_dng_probe_cli
    mobile_stack_raw_probe_cli
    mobile_stack_arw_lossless_test
    mobile_stack_demosaic_test
    mobile_stack_demosaic_cache_test
  )
    target_compile_options(
      ${target}
      PRIVATE
      -Wall
      -Wextra
      -Werror
      -Wpedantic
    )
    if(MOBILE_STACK_RAW_ENABLE_SANITIZERS)
      target_compile_options(
        ${target}
        PRIVATE
        -fsanitize=address,undefined
        -fno-omit-frame-pointer
      )
      target_link_options(
        ${target}
        PRIVATE
        -fsanitize=address,undefined
      )
    endif()
  endforeach()
  if(MOBILE_STACK_RAW_ENABLE_SANITIZERS)
    # WORK350: mobile_stack_raw contains C++ (LibRaw wrapper) instrumented
    # with UBSan's vptr check. Clang only adds the C++ UBSan runtime
    # (__ubsan_vptr_type_cache, __ubsan_handle_dynamic_type_cache_miss) when
    # the C++ driver links, so C executables that link the library failed to
    # link under sanitizers. Link them with the C++ driver in sanitizer builds
    # only; normal builds keep their existing C link unchanged.
    foreach(
      target
      mobile_stack_raw_c_contract_test
      mobile_stack_dng_hardening_test
      mobile_stack_dng_probe_cli
      mobile_stack_raw_probe_cli
      mobile_stack_arw_lossless_test
      mobile_stack_demosaic_test
      mobile_stack_demosaic_cache_test
    )
      set_target_properties(${target} PROPERTIES LINKER_LANGUAGE CXX)
    endforeach()
  endif()
elseif(MOBILE_STACK_RAW_ENABLE_SANITIZERS)
  message(
    FATAL_ERROR
    "MOBILE_STACK_RAW_ENABLE_SANITIZERS requires Clang or GCC."
  )
endif()

add_test(
  NAME mobile_stack_raw_abi_layout
  COMMAND mobile_stack_raw_abi_layout_test
)
add_test(
  NAME mobile_stack_raw_c_contract
  COMMAND mobile_stack_raw_c_contract_test
)
add_test(
  NAME mobile_stack_dng_hardening
  COMMAND mobile_stack_dng_hardening_test
)
add_test(
  NAME mobile_stack_dng_cli_contract
  COMMAND
    ${CMAKE_COMMAND}
    -DDNG_GENERATOR=$<TARGET_FILE:mobile_stack_dng_hardening_test>
    -DDNG_PROBE=$<TARGET_FILE:mobile_stack_dng_probe_cli>
    -DDNG_FIXTURE=${CMAKE_CURRENT_BINARY_DIR}/mobile_stack_cli_fixture.dng
    -P
    ${CMAKE_CURRENT_SOURCE_DIR}/tests/run_dng_cli_contract.cmake
)
add_test(
  NAME mobile_stack_arw_lossless
  COMMAND mobile_stack_arw_lossless_test
)
add_test(
  NAME mobile_stack_demosaic
  COMMAND mobile_stack_demosaic_test
)
add_test(
  NAME mobile_stack_demosaic_cache
  COMMAND mobile_stack_demosaic_cache_test
)
add_test(
  NAME mobile_stack_demosaic_hash_cache_whitebox
  COMMAND mobile_stack_demosaic_hash_cache_whitebox_test
)

# Work360: native SHA-256 used for durable-cache fingerprints.
add_executable(
  mobile_stack_util_sha256_test
  tests/mobile_stack_util_sha256_test.c
  src/mobile_stack_util_sha256.c
)
target_include_directories(mobile_stack_util_sha256_test PRIVATE include)
target_compile_features(mobile_stack_util_sha256_test PRIVATE c_std_11)
add_test(NAME mobile_stack_util_sha256_test COMMAND mobile_stack_util_sha256_test)
