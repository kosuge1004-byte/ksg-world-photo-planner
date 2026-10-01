import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cameraList = readFileSync(
  join(root, 'native', 'third_party', 'libraw', 'src', 'tables', 'cameralist.cpp'),
  'utf8',
);

function modelsFor(brand) {
  return [...cameraList.matchAll(new RegExp(`"${brand} ([^"]+)"`, 'g'))]
    .map((match) => match[1]
      .replace(/ \(HE\/HE\* formats are not supported yet\)$/, '')
      .trim())
    .filter((model, index, all) => model && all.indexOf(model) === index);
}

const samples = [
  {
    brand: 'Sony', model: 'ILCE-7M3 (A7 III)', container: 'ARW',
    rawMode: 'Full-frame compressed', bitDepth: '14', crop: 'full-frame',
    status: 'VERIFIED_DECODE', width: 6048, height: 4024, cfa: 'RGGB',
    decoder: 'Work245 Sony ARW2 first path',
    file: 'sony_ilce7m3_compressed.arw', bytes: 25639680,
    sha256: '250784580ea527442c09004417bb0eead484f2bf3ee8f9121a776ac65bb50d0f',
    fnv1a: '9063ff2b691f153a', minimum: 0, maximum: 16628,
    black: [512, 512, 512, 512], white: 16383,
    url: 'https://raw.pixls.us/data/Sony/ILCE-7M3/_DSC0009.ARW',
    notes: 'Full sensor plane, finite FP32 copy, D65 matrix present.',
  },
  {
    brand: 'Sony', model: 'ILCE-7M4 (A7 IV)', container: 'ARW',
    rawMode: 'Full-frame uncompressed', bitDepth: '14', crop: 'full-frame',
    status: 'VERIFIED_DECODE', width: 7040, height: 4688, cfa: 'RGGB',
    decoder: 'Work245 Sony first path',
    file: 'sony_ilce7m4_uncompressed.arw', bytes: 73457664,
    sha256: '626e1f3235e28f2c642814e0aefad404ea767c06943934db87d2b0072ba8e8b9',
    fnv1a: '8efbfbadbd5c65f1', minimum: 491, maximum: 16383,
    black: [512, 512, 512, 512], white: 16383,
    url: 'https://raw.pixls.us/data/Sony/ILCE-7M4/ILCE-7M4_DSC06673_FullFrame-Raw-Uncompressed.ARW',
    notes: 'Full sensor plane, finite FP32 copy, D65 matrix present.',
  },
  {
    brand: 'Sony', model: 'ILCE-7M4 (A7 IV)', container: 'ARW',
    rawMode: 'Full-frame lossless compressed Large', bitDepth: '14', crop: 'full-frame',
    status: 'VERIFIED_DECODE', width: 7168, height: 5120, cfa: 'RGGB',
    decoder: 'Work245 Sony SOF3 first path',
    file: 'sony_ilce7m4_lossless_large.arw', bytes: 49184768,
    sha256: '851b43c2116c4139104a5036f83ac3b6a148789b2142214dd7192c13972b25b6',
    fnv1a: '3237e8b3a3e88dbd', minimum: 0, maximum: 16383,
    black: [512, 512, 512, 512], white: 16383,
    url: 'https://raw.pixls.us/data/Sony/ILCE-7M4/ILCE-7M4_DSC06674_FullFrame-LossLess-Compressed-Large.ARW',
    notes: 'Full decoded tile plane; active-area crop remains metadata-driven; D65 matrix supplemented by LibRaw.',
  },
  {
    brand: 'Sony', model: 'ILCE-7M4 (A7 IV)', container: 'ARW',
    rawMode: 'Full-frame compressed', bitDepth: '14', crop: 'full-frame',
    status: 'VERIFIED_DECODE', width: 7040, height: 4688, cfa: 'RGGB',
    decoder: 'Work245 Sony ARW2 first path',
    file: 'sony_ilce7m4_compressed.arw', bytes: 40665088,
    sha256: '73c79fd9fbd73dff89548b611aaedc3c5a7e3412ec190c23881ea8434ff2214c',
    fnv1a: 'f28755bf61e6ec0d', minimum: 496, maximum: 16628,
    black: [512, 512, 512, 512], white: 16383,
    url: 'https://raw.pixls.us/data/Sony/ILCE-7M4/ILCE-7M4_DSC06677_FullFrame-Raw-Compressed.ARW',
    notes: 'Full sensor plane, finite FP32 copy, D65 matrix present.',
  },
  {
    brand: 'Sony', model: 'ILCE-7M4 (A7 IV)', container: 'ARW',
    rawMode: 'APS-C compressed', bitDepth: '14', crop: 'APS-C',
    status: 'VERIFIED_DECODE', width: 4736, height: 3132, cfa: 'RGGB',
    decoder: 'Work245 Sony ARW2 first path',
    file: 'sony_ilce7m4_apsc_compressed.arw', bytes: 19636224,
    sha256: '639a6d4db881f1359e3ea7e1137b314e59417d24e6d4d862b7202111a2c823b2',
    fnv1a: 'fc138c3f9c96f6a8', minimum: 492, maximum: 16628,
    black: [512, 512, 512, 512], white: 16383,
    url: 'https://raw.pixls.us/data/Sony/ILCE-7M4/ILCE-7M4_DSC06681_APS-C-Raw-Compressed.ARW',
    notes: 'Crop mode verified; full finite sensor plane and D65 matrix present.',
  },
  {
    brand: 'Sony', model: 'ILCE-7M4 (A7 IV)', container: 'ARW',
    rawMode: 'Lossless compressed Medium', bitDepth: 'pseudo-RAW', crop: 'full-frame',
    status: 'UNSUPPORTED', width: '', height: '', cfa: 'non-Bayer',
    decoder: 'Rejected before pixel decode',
    file: 'sony_ilce7m4_lossless_medium.arw', bytes: 32804864,
    sha256: 'd453005714327addd75bcb99c1c6223173dc92f2a59542d82e6761ef0e0e7571',
    url: 'https://raw.pixls.us/data/Sony/ILCE-7M4/ILCE-7M4_DSC06675_FullFrame-LossLess-Compressed-Medium.ARW',
    notes: 'Native status 2/error 4004: not a single-plane 2x2 Bayer source.',
  },
  {
    brand: 'Sony', model: 'ILCE-7M5 (A7 V)', container: 'ARW',
    rawMode: 'APS-C compressed HQ', bitDepth: '14', crop: 'APS-C',
    status: 'VERIFIED_DECODE', width: 4640, height: 3088, cfa: 'RGGB',
    decoder: 'LibRaw ARW 6.0 sensor path',
    file: 'apcs_compressed_hq.ARW', bytes: 11481088,
    sha256: 'c16cae99d26a2f8ad183d31a23823310a994aa058d55cfe56e4f82ba56865f57',
    minimum: 1048, maximum: 20424,
    black: [1024, 1024, 1024, 1024], white: 39002,
    url: 'https://raw.pixls.us/data/SONY/ILCE-7M5/apcs_compressed_hq.ARW',
    notes: 'Work266 Android x86_64 real-file decode; finite non-negative preserved Bayer sensor plane.',
  },
  {
    brand: 'Sony', model: 'ILCE-7M5 (A7 V)', container: 'ARW',
    rawMode: 'APS-C compressed', bitDepth: '14', crop: 'APS-C',
    status: 'VERIFIED_DECODE', width: 4640, height: 3088, cfa: 'RGGB',
    decoder: 'LibRaw ARW 6.0 sensor path',
    file: 'apsc_compressed.ARW', bytes: 12103680,
    sha256: '8315af2a9889709f4c836dbaadc23d226847e5a0630fda212a9f896d5fe0569f',
    minimum: 1045, maximum: 16901,
    black: [1024, 1024, 1024, 1024], white: 39002,
    url: 'https://raw.pixls.us/data/SONY/ILCE-7M5/apsc_compressed.ARW',
    notes: 'Work266 Android x86_64 real-file decode; finite non-negative preserved Bayer sensor plane.',
  },
  {
    brand: 'Sony', model: 'ILCE-7M5 (A7 V)', container: 'ARW',
    rawMode: 'APS-C lossless compressed', bitDepth: '14', crop: 'APS-C',
    status: 'VERIFIED_DECODE', width: 5120, height: 3584, cfa: 'RGGB',
    decoder: 'Work245 Sony SOF3 first path',
    file: 'apsc_compressed_lossless.ARW', bytes: 22233088,
    sha256: '51ad709cba01a5f05e3c723b779f6b5fda8fa7b378494dbb40b4d3d3aa5494a4',
    minimum: 0, maximum: 11344,
    black: [512, 512, 512, 512], white: 16383,
    url: 'https://raw.pixls.us/data/SONY/ILCE-7M5/apsc_compressed_lossless.ARW',
    notes: 'Work266 Android x86_64 real-file decode; finite non-negative preserved Bayer sensor plane.',
  },
  {
    brand: 'Sony', model: 'ILCE-7M5 (A7 V)', container: 'ARW',
    rawMode: 'Full-frame compressed', bitDepth: '14', crop: 'full-frame',
    status: 'VERIFIED_DECODE', width: 7028, height: 4688, cfa: 'RGGB',
    decoder: 'LibRaw ARW 6.0 sensor path',
    file: 'full_compressed.ARW', bytes: 23314432,
    sha256: '46d73475dfd8f96fd7e2f4d4a721a36cbbaba3d6ea95a4851809cd9d252b2a80',
    minimum: 1036, maximum: 22629,
    black: [1024, 1024, 1024, 1024], white: 39002,
    url: 'https://raw.pixls.us/data/SONY/ILCE-7M5/full_compressed.ARW',
    notes: 'Work266 Android x86_64 real-file decode; finite non-negative preserved Bayer sensor plane.',
  },
  {
    brand: 'Sony', model: 'ILCE-7M5 (A7 V)', container: 'ARW',
    rawMode: 'Full-frame compressed HQ', bitDepth: '14', crop: 'full-frame',
    status: 'VERIFIED_DECODE', width: 7028, height: 4688, cfa: 'RGGB',
    decoder: 'LibRaw ARW 6.0 sensor path',
    file: 'full_compressed_HQ.ARW', bytes: 23232512,
    sha256: '4e3a99cbcf2a348decaf3ca68c5de22b7a05eaa590f4e9184735c1f9c45213a7',
    minimum: 1030, maximum: 39002,
    black: [1024, 1024, 1024, 1024], white: 39002,
    url: 'https://raw.pixls.us/data/SONY/ILCE-7M5/full_compressed_HQ.ARW',
    notes: 'Work266 Android x86_64 real-file decode; finite non-negative preserved Bayer sensor plane.',
  },
  {
    brand: 'Sony', model: 'ILCE-7M5 (A7 V)', container: 'ARW',
    rawMode: 'Full-frame lossless compressed', bitDepth: '14', crop: 'full-frame',
    status: 'VERIFIED_DECODE', width: 7168, height: 5120, cfa: 'RGGB',
    decoder: 'Work245 Sony SOF3 first path',
    file: 'full_compressed_lossless.ARW', bytes: 44195840,
    sha256: '8c35cd1ab0ca36b487ae50ae5e0333a8e967122700fce5678e1e5b97561896a4',
    minimum: 0, maximum: 11941,
    black: [512, 512, 512, 512], white: 16383,
    url: 'https://raw.pixls.us/data/SONY/ILCE-7M5/full_compressed_lossless.ARW',
    notes: 'Work266 Android x86_64 real-file decode; finite non-negative preserved Bayer sensor plane.',
  },
  {
    brand: 'Nikon', model: 'D750', container: 'NEF', rawMode: 'Compressed',
    bitDepth: '12', crop: 'full-frame', status: 'VERIFIED_DECODE',
    width: 6032, height: 4032, cfa: 'RGGB', decoder: 'LibRaw 0.22.2 sensor path',
    file: 'nikon_d750_compressed_12.nef', bytes: 18031834,
    sha256: 'e4a3f85e014275fc0a47600a373af95ec850872a5f6cf87649bcaa42b77ef2e4',
    fnv1a: '86d185833b07250f', minimum: 150, maximum: 4087,
    black: [150, 150, 150, 150], white: 4095,
    url: 'https://raw.pixls.us/data/Nikon/D750/compressed_12_bit.NEF',
    notes: 'Full finite Bayer plane and D65 matrix present.',
  },
  {
    brand: 'Nikon', model: 'D750', container: 'NEF', rawMode: 'Lossless compressed',
    bitDepth: '14', crop: 'full-frame', status: 'VERIFIED_DECODE',
    width: 6032, height: 4032, cfa: 'RGGB', decoder: 'LibRaw 0.22.2 sensor path',
    file: 'nikon_d750_lossless_14.nef', bytes: 26336302,
    sha256: 'f90deb2819863f5a6ca9913c255fdd83a94963f4284eb88df9d389da7a6c7665',
    fnv1a: '8e8b6ae0328ca4e9', minimum: 600, maximum: 16383,
    black: [600, 600, 600, 600], white: 16383,
    url: 'https://raw.pixls.us/data/Nikon/D750/lossless_compressed_14_bit.NEF',
    notes: 'Full finite Bayer plane and D65 matrix present.',
  },
  {
    brand: 'Nikon', model: 'D800', container: 'NEF', rawMode: 'Compressed',
    bitDepth: '14', crop: 'full-frame', status: 'VERIFIED_DECODE',
    width: 7378, height: 4924, cfa: 'RGGB', decoder: 'LibRaw 0.22.2 sensor path',
    file: 'nikon_d800_compressed_14.nef', bytes: 36419684,
    sha256: 'f5b7906869da3e48cb85ec08c5fa97c4c3ff8ab491825a89ac5ed0fff11fef5d',
    fnv1a: 'eee1f5a40c96da01', minimum: 8, maximum: 16383,
    black: [0, 0, 0, 0], white: 16383,
    url: 'https://raw.pixls.us/data/Nikon/D800/D800-14b-comp.NEF',
    notes: 'Full finite Bayer plane and D65 matrix present.',
  },
  {
    brand: 'Nikon', model: 'D800', container: 'NEF', rawMode: 'Uncompressed',
    bitDepth: '12', crop: 'full-frame', status: 'VERIFIED_DECODE',
    width: 7378, height: 4924, cfa: 'RGGB', decoder: 'LibRaw 0.22.2 sensor path',
    file: 'nikon_d800_uncompressed_12.nef', bytes: 58750976,
    sha256: 'e096d28a860f8b7afe3abde4ccc5cec5bcda229d137b4919cd821a2fc9bf87b2',
    fnv1a: '1d839e464e26a5fc', minimum: 4, maximum: 4095,
    black: [0, 0, 0, 0], white: 4095,
    url: 'https://raw.pixls.us/data/Nikon/D800/D800-12b-no-comp.NEF',
    notes: 'Full finite Bayer plane and D65 matrix present.',
  },
  {
    brand: 'Nikon', model: 'Z 8', container: 'NEF', rawMode: 'Lossless compressed',
    bitDepth: '14', crop: 'full-frame', status: 'VERIFIED_DECODE',
    width: 8280, height: 5520, cfa: 'RGGB', decoder: 'LibRaw 0.22.2 sensor path',
    file: 'nikon_z8_lossless_14.nef', bytes: 60842580,
    sha256: 'c13a8675294456b9c979e6c1e556951654f35377b2870af2874bfb556f21ce40',
    fnv1a: '0620769927d11251', minimum: 832, maximum: 16383,
    black: [1008, 1008, 1008, 1008], white: 16383,
    url: 'https://raw.pixls.us/data/Nikon/Z%208/Nikon_Z8_raw_14_bit_lossless_compression.NEF',
    notes: 'Modern Z body standard lossless mode; full finite Bayer plane and D65 matrix present.',
  },
  {
    brand: 'Nikon', model: 'Z 8', container: 'NEF', rawMode: 'High Efficiency low',
    bitDepth: 'HE', crop: 'full-frame', status: 'UNSUPPORTED',
    width: '', height: '', cfa: 'not unpacked', decoder: 'Rejected by LibRaw 0.22.2',
    file: 'nikon_z8_high_efficiency_low.nef', bytes: 24384512,
    sha256: '82df041542b8d328738443bb5ff3373b396e406ecc8cbe7dc3b35252790c53e7',
    url: 'https://raw.pixls.us/data/Nikon/Z%208/Nikon_Z8_high_efficiency_low.NEF',
    notes: 'Native status 2/error 4007. Nikon HE/HE* is deliberately not claimed.',
  },
  {
    brand: 'Nikon', model: 'Z f', container: 'NEF', rawMode: 'Lossless compressed',
    bitDepth: '14', crop: 'full-frame', status: 'VERIFIED_DECODE',
    width: 6064, height: 4040, cfa: 'RGGB', decoder: 'LibRaw 0.22.2 sensor path',
    file: 'Nikon_Z_f_14bit_lossless.NEF', bytes: 31109991,
    sha256: '83c82be0be8865d796096dfbcc8ef2abf5af1bd37db44dfad6715070b0c99d15',
    minimum: 1027, maximum: 8438,
    black: [1008, 1008, 1008, 1008], white: 16383,
    url: 'https://raw.pixls.us/getfile.php/6885/nice/Nikon%20-%20Z%20f%20-%2014bit%2014bit%20compressed%20(3%3A2).NEF',
    notes: 'Work268 Android x86_64 real-file decode; full finite non-negative Bayer sensor plane and D65 matrix present.',
  },
  {
    brand: 'Nikon', model: 'Z f', container: 'NEF', rawMode: 'High Efficiency',
    bitDepth: 'HE', crop: 'full-frame', status: 'UNSUPPORTED',
    width: '', height: '', cfa: 'not unpacked', decoder: 'Rejected by LibRaw 0.22.2',
    file: 'Nikon_Z_f_HE_sample.NEF', bytes: 19627008,
    sha256: 'c888f109dc420e359853a2ce768d8a6274b8ba0109b2f5cb6e0c982981d5a624',
    url: 'https://raw.pixls.us/getfile.php/6886/nice/Nikon%20-%20Z%20f%20-%208bit%208bit%20lossy%20compressed%20(3%3A2).NEF',
    notes: 'Work268 Android x86_64 real-file rejection: native status 2/error 4007. Nikon HE/HE* is deliberately not claimed.',
  },
  {
    brand: 'Nikon', model: 'Coolpix P7000', container: 'NRW', rawMode: 'Standard',
    bitDepth: '12', crop: 'fixed-lens sensor', status: 'VERIFIED_DECODE',
    width: 3664, height: 2742, cfa: 'RGGB', decoder: 'LibRaw 0.22.2 sensor path',
    file: 'nikon_p7000.nrw', bytes: 16058749,
    sha256: '09165ec1031b36e6ae43f2263b4400ec4d9c3444ae252d258d002f7e96dbea25',
    fnv1a: '9cfabbd1ad7f4bf9', minimum: 0, maximum: 3840,
    black: [0, 0, 0, 0], white: 4095,
    url: 'https://raw.pixls.us/data/Nikon/Coolpix%20P7000/RAW_NIKON_P7000.NRW',
    notes: 'NRW factory registration verified with a full finite Bayer plane and D65 matrix.',
  },
];

function csvValue(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const columns = [
  'brand', 'model', 'container', 'rawMode', 'bitDepth', 'crop', 'status',
  'width', 'height', 'cfa', 'decoder', 'notes',
];

function rowsFor(brand) {
  const verifiedModels = new Set(samples.filter((row) => row.brand === brand).map((row) => row.model));
  const rows = samples.filter((row) => row.brand === brand).map((row) => ({ ...row }));
  for (const model of modelsFor(brand)) {
    if (verifiedModels.has(model)) continue;
    rows.push({
      brand,
      model,
      container: brand === 'Sony' ? 'ARW' : 'NEF/NRW',
      rawMode: 'standard single-plane Bayer modes',
      bitDepth: 'model-dependent',
      crop: 'model-dependent',
      status: 'SAMPLE_MISSING',
      width: '', height: '', cfa: '2x2 Bayer required',
      decoder: 'LibRaw 0.22.2 candidate',
      notes: 'Listed by bundled LibRaw; app-level full decode is not claimed until a hash-pinned sample passes.',
    });
  }
  return rows;
}

for (const brand of ['Sony', 'Nikon']) {
  const rows = rowsFor(brand);
  const csv = [columns.join(','), ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(','))].join('\n') + '\n';
  writeFileSync(join(root, `${brand.toUpperCase()}_RAW_COMPATIBILITY_MATRIX.csv`), csv);

  const verified = rows.filter((row) => row.status === 'VERIFIED_DECODE');
  const unsupported = rows.filter((row) => row.status === 'UNSUPPORTED');
  const markdown = `# ${brand} RAW compatibility — Work268\n\n` +
    `Generated from the bundled LibRaw model inventory plus official ARW 6 support and hash-pinned CC0 samples. ` +
    `A model-list entry alone is **SAMPLE_MISSING**, not a support claim.\n\n` +
    `- LibRaw inventory candidates: ${modelsFor(brand).length}\n` +
    `- VERIFIED_DECODE rows: ${verified.length}\n` +
    `- Explicit UNSUPPORTED rows: ${unsupported.length}\n` +
    `- ABI rule: a preserved, single-plane 2x2 Bayer sensor plane is required.\n\n` +
    `| Model | Mode | Bits | Crop | Status | Output |\n|---|---|---:|---|---|---|\n` +
    [...verified, ...unsupported].map((row) =>
      `| ${row.model} | ${row.rawMode} | ${row.bitDepth} | ${row.crop} | ${row.status} | ${row.width && row.height ? `${row.width}×${row.height} ${row.cfa}` : row.notes} |`,
    ).join('\n') + '\n\n' +
    (brand === 'Sony'
      ? `Known exclusion: Medium/Small YCC/pseudo-RAW modes are not treated as Bayer RAW.\n`
      : `Known exclusion: Nikon High Efficiency / High Efficiency* NEF is not supported by LibRaw 0.22.2.\n`) +
    `\nSee the CSV for every candidate model and the JSON manifest for hashes and numeric decode evidence.\n`;
  writeFileSync(join(root, `${brand.toUpperCase()}_RAW_COMPATIBILITY_MATRIX.md`), markdown);
}

const manifest = {
  schema: 'mobile-stack-raw-verification/v1',
  work: 268,
  generatedAt: '2026-08-30T00:00:00+09:00',
  backend: {
    primarySony: 'Work245 bounded Sony decoder',
    fallbackSonyNikon: 'LibRaw 0.22.2 plus official ARW 6 decoder; open_file + unpack sensor plane only',
    librawLicenseSelection: 'CDDL-1.0',
    processingForbidden: ['dcraw_process', 'demosaic', 'white-balance application', 'gamma', 'tone mapping'],
  },
  verification: {
    target: 'Android x86_64 emulator, native ABI executable',
    compiler: 'Android NDK 28.2.13676358 Clang 19.0.1',
    capabilities: 255,
    requirements: ['status=0', 'metadataStatus=0', 'nonFinite=0', 'sampleCount=width*height', 'hasD65Matrix=1'],
  },
  sourceCorpus: {
    provider: 'raw.pixls.us',
    terms: 'CC0 samples as stated by provider',
    samples,
  },
};
writeFileSync(
  join(root, 'SONY_NIKON_RAW_VERIFICATION_MANIFEST.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
