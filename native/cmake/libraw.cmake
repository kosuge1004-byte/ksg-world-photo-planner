set(MOBILE_STACK_LIBRAW_ROOT
    "${CMAKE_CURRENT_LIST_DIR}/../third_party/libraw")

file(GLOB_RECURSE MOBILE_STACK_LIBRAW_SOURCES CONFIGURE_DEPENDS
     "${MOBILE_STACK_LIBRAW_ROOT}/src/*.cpp")
# LibRaw ships three alternative amalgamation translation units. The official
# per-file build compiles the individual sources and excludes these variants.
list(FILTER MOBILE_STACK_LIBRAW_SOURCES EXCLUDE REGEX
     "/(postprocessing|preprocessing|write)/[^/]*_ph\\.cpp$")

add_library(mobile_stack_libraw STATIC ${MOBILE_STACK_LIBRAW_SOURCES})
if(WIN32)
  # LibRaw uses Winsock's byte-order functions on the Windows host.
  target_link_libraries(mobile_stack_libraw PUBLIC ws2_32)
endif()
target_include_directories(mobile_stack_libraw PUBLIC
                           "${MOBILE_STACK_LIBRAW_ROOT}")
target_compile_features(mobile_stack_libraw PRIVATE cxx_std_11)
target_compile_definitions(
  mobile_stack_libraw
  PRIVATE
  LIBRAW_NOTHREADS=1
  LIBRAW_BUILDLIB=1
  LIBRAW_CALLOC_RAWSTORE=1
)
set_target_properties(
  mobile_stack_libraw
  PROPERTIES
  POSITION_INDEPENDENT_CODE ON
  CXX_VISIBILITY_PRESET hidden
)
if(MSVC)
  target_compile_options(mobile_stack_libraw PRIVATE /w)
else()
  target_compile_options(mobile_stack_libraw PRIVATE -w)
  # The ARW 6 decoder contains several very large reconstruction routines.
  # Clang's default Android Release -O3 pass can consume excessive memory on
  # this translation unit; -O2 preserves optimized production code while
  # keeping release builds bounded.
  set_property(
    SOURCE "${MOBILE_STACK_LIBRAW_ROOT}/src/decoders/sony_arw6.cpp"
    APPEND PROPERTY COMPILE_OPTIONS "$<$<CONFIG:Release>:-O2>"
  )
endif()
