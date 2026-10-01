Pod::Spec.new do |s|
  s.name                  = 'MobileStackRaw'
  s.version               = '0.2.0'
  s.summary               = 'Mobile Stack RAW ABI with Sony ARW and Nikon NEF/NRW support.'
  s.description           = <<-DESC
ABI conformance implementation with a bounded, read-only DNG metadata parser,
the Work245 Sony decoder, and a LibRaw sensor-plane fallback for supported
single-plane Bayer Sony ARW and Nikon NEF/NRW files.
                            DESC
  s.homepage              = 'https://example.invalid/mobile-stack'
  s.license               = {
    :type => 'Proprietary with bundled LibRaw CDDL-1.0/LGPL-2.1',
    :file => 'THIRD_PARTY_NOTICES.md'
  }
  s.author                = { 'Mobile Stack' => 'development@localhost' }
  s.source                = {
    :git => 'https://example.invalid/mobile-stack.git',
    :tag => s.version.to_s
  }
  s.source_files          = 'src/**/*.{c,h,cpp}', 'include/**/*.h',
                            'third_party/libraw/internal/**/*.h',
                            'third_party/libraw/libraw/**/*.h',
                            'third_party/libraw/src/**/*.cpp'
  s.exclude_files         = 'third_party/libraw/src/postprocessing/postprocessing_ph.cpp',
                            'third_party/libraw/src/preprocessing/preprocessing_ph.cpp',
                            'third_party/libraw/src/write/write_ph.cpp'
  s.preserve_paths        = 'THIRD_PARTY_NOTICES.md',
                            'third_party/libraw/COPYRIGHT',
                            'third_party/libraw/LICENSE.CDDL',
                            'third_party/libraw/LICENSE.LGPL'
  s.public_header_files   = 'include/**/*.h'
  s.module_name           = 'MobileStackRaw'
  s.static_framework      = true
  s.libraries             = 'm', 'c++'
  s.ios.deployment_target = '13.0'
  s.pod_target_xcconfig   = {
    'DEFINES_MODULE' => 'YES',
    'GCC_C_LANGUAGE_STANDARD' => 'c11',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++11',
    'HEADER_SEARCH_PATHS' => '$(inherited) "$(PODS_TARGET_SRCROOT)/third_party/libraw"',
    'GCC_WARN_INHIBIT_ALL_WARNINGS' => 'NO',
    'GCC_PREPROCESSOR_DEFINITIONS' =>
      '$(inherited) MOBILE_STACK_RAW_ENABLE_DNG_METADATA=1 ' \
      'MOBILE_STACK_RAW_ENABLE_ARW_LOSSLESS_JPEG=1 ' \
      'MOBILE_STACK_RAW_ENABLE_LIBRAW=1 LIBRAW_NOTHREADS=1 ' \
      'LIBRAW_BUILDLIB=1 LIBRAW_CALLOC_RAWSTORE=1'
  }
end
