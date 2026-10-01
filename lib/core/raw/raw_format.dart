enum RawFormat {
  arw,
  cr2,
  cr3,
  nef,
  nrw,
  raf,
  rw2,
  dng,
  orf,
  pef,
  unknown,
}

extension RawFormatLabel on RawFormat {
  String get label => switch (this) {
        RawFormat.arw => 'Sony ARW',
        RawFormat.cr2 => 'Canon CR2',
        RawFormat.cr3 => 'Canon CR3',
        RawFormat.nef => 'Nikon NEF',
        RawFormat.nrw => 'Nikon NRW',
        RawFormat.raf => 'Fujifilm RAF',
        RawFormat.rw2 => 'Panasonic RW2',
        RawFormat.dng => 'Adobe DNG',
        RawFormat.orf => 'OM SYSTEM ORF',
        RawFormat.pef => 'Pentax PEF',
        RawFormat.unknown => '不明',
      };
}
