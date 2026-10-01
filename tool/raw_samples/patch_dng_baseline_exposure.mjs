import { copyFile, open } from 'node:fs/promises';

const [sourcePath, destinationPath, evText = '0'] = process.argv.slice(2);
if (!sourcePath || !destinationPath) {
  throw new Error(
    'Usage: node patch_dng_baseline_exposure.mjs <source.dng> <destination.dng> [integer-ev]',
  );
}
const ev = Number(evText);
if (!Number.isSafeInteger(ev) || ev < -32 || ev > 32) {
  throw new Error('EV must be a safe integer in the range -32..32.');
}

await copyFile(sourcePath, destinationPath);
const handle = await open(destinationPath, 'r+');
try {
  const header = Buffer.alloc(8);
  await handle.read(header, 0, header.length, 0);
  if (header.toString('ascii', 0, 2) !== 'II' || header.readUInt16LE(2) !== 42) {
    throw new Error('Only little-endian Classic TIFF/DNG is supported.');
  }
  const ifdOffset = header.readUInt32LE(4);
  const countBuffer = Buffer.alloc(2);
  await handle.read(countBuffer, 0, 2, ifdOffset);
  const entryCount = countBuffer.readUInt16LE(0);
  const entries = Buffer.alloc(entryCount * 12);
  await handle.read(entries, 0, entries.length, ifdOffset + 2);
  let rationalOffset;
  for (let index = 0; index < entryCount; index += 1) {
    const base = index * 12;
    if (entries.readUInt16LE(base) !== 50730) continue;
    const type = entries.readUInt16LE(base + 2);
    const count = entries.readUInt32LE(base + 4);
    if (type !== 10 || count !== 1) {
      throw new Error(`Unexpected BaselineExposure encoding: type=${type}, count=${count}`);
    }
    rationalOffset = entries.readUInt32LE(base + 8);
    break;
  }
  if (rationalOffset === undefined) {
    throw new Error('BaselineExposure tag 50730 was not found.');
  }
  const rational = Buffer.alloc(8);
  rational.writeInt32LE(ev, 0);
  rational.writeInt32LE(1, 4);
  await handle.write(rational, 0, rational.length, rationalOffset);
  await handle.sync();
  process.stdout.write(
    `PATCH_PASS destination=${destinationPath} baselineExposureEv=${ev} offset=${rationalOffset}\n`,
  );
} finally {
  await handle.close();
}
