import assert from 'node:assert/strict';
import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  probeTiffRaw,
  TiffRawProbeError,
} from '../probe_tiff_raw.mjs';

function tiffWithPreview({jpegLength = 23} = {}) {
  const bytes = Buffer.alloc(160);
  const ifdOffset = 8;
  const jpegOffset = 96;
  const jpeg = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    0x00, 0x02,
    0x00, 0x04,
    0x03, 0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  bytes.write('II', 0, 'ascii');
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(ifdOffset, 4);
  bytes.writeUInt16LE(2, ifdOffset);
  let entry = ifdOffset + 2;
  bytes.writeUInt16LE(0x0201, entry);
  bytes.writeUInt16LE(4, entry + 2);
  bytes.writeUInt32LE(1, entry + 4);
  bytes.writeUInt32LE(jpegOffset, entry + 8);
  entry += 12;
  bytes.writeUInt16LE(0x0202, entry);
  bytes.writeUInt16LE(4, entry + 2);
  bytes.writeUInt32LE(1, entry + 4);
  bytes.writeUInt32LE(jpegLength, entry + 8);
  bytes.writeUInt32LE(0, ifdOffset + 2 + 24);
  jpeg.copy(bytes, jpegOffset);
  return bytes;
}

test('probes a TIFF RAW and hashes its embedded JPEG', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-tiff-probe-'));
  const filePath = path.join(directory, 'sample.ARW');
  try {
    await writeFile(filePath, tiffWithPreview());
    const result = await probeTiffRaw(filePath);

    assert.equal(result.status, 'ok');
    assert.equal(result.format, 'ARW');
    assert.equal(result.container.byteOrder, 'little-endian');
    assert.equal(result.ifdsVisited, 1);
    assert.equal(result.candidatesFound, 1);
    assert.equal(result.preview.offset, 96);
    assert.equal(result.preview.width, 4);
    assert.equal(result.preview.height, 2);
    assert.match(result.preview.sha256, /^[0-9a-f]{64}$/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('ignores an out-of-range JPEG candidate', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-tiff-range-'));
  const filePath = path.join(directory, 'sample.arw');
  try {
    await writeFile(filePath, tiffWithPreview({jpegLength: 1000}));
    const result = await probeTiffRaw(filePath);
    assert.equal(result.candidatesFound, 0);
    assert.equal(result.preview, null);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('does not load a JPEG above the configured preview limit', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-tiff-limit-'));
  const filePath = path.join(directory, 'sample.arw');
  try {
    await writeFile(filePath, tiffWithPreview());
    const result = await probeTiffRaw(
        filePath,
        {maximumPreviewBytes: 8});
    assert.equal(result.candidatesFound, 1);
    assert.equal(result.preview, null);
    await assert.rejects(
        probeTiffRaw(
            filePath,
            {maximumPreviewBytes: 8 * 1024 * 1024 + 1}),
        TiffRawProbeError);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('rejects a non-TIFF file', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-not-tiff-'));
  const filePath = path.join(directory, 'sample.arw');
  try {
    await writeFile(filePath, Buffer.alloc(32));
    await assert.rejects(
        probeTiffRaw(filePath),
        TiffRawProbeError);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
