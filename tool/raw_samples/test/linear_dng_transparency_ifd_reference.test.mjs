import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeLinearDngReference,
  encodeBigLinearDngReference,
  appendClassicTransparencyMask,
  appendBigTransparencyMask,
} from '../linear_dng_reference.mjs';

const pixels = Float32Array.from([
  0,0,0, 1,1,1,
  0.5,0.5,0.5, 2,2,2,
]);
const mask = Uint8Array.from([255, 0, 255, 0]);

test('classic DNG links transparency mask through SubIFDs and leaves NextIFD zero', () => {
  const base = encodeLinearDngReference({width:2,height:2,pixels});
  const file = appendClassicTransparencyMask(base,{width:2,height:2,mask});
  const ifd0 = file.readUInt32LE(4);
  const count0 = file.readUInt16LE(ifd0);
  let subIfd;
  for (let i=0;i<count0;i++) {
    const off=ifd0+2+i*12;
    if (file.readUInt16LE(off)===330) {
      assert.equal(file.readUInt16LE(off+2),13); // TIFF_IFD
      assert.equal(file.readUInt32LE(off+4),1);
      subIfd=file.readUInt32LE(off+8);
    }
  }
  assert.ok(subIfd > 0);
  assert.equal(file.readUInt32LE(ifd0 + 2 + count0*12),0);
  assert.equal(file.readUInt16LE(subIfd),10);

  const tags=new Map();
  for(let i=0;i<10;i++){
    const off=subIfd+2+i*12;
    tags.set(file.readUInt16LE(off),{
      type:file.readUInt16LE(off+2),
      count:file.readUInt32LE(off+4),
      value:file.readUInt32LE(off+8),
    });
  }
  assert.equal(tags.get(254).value,4);
  assert.equal(tags.get(262).value & 0xffff,4);
  assert.deepEqual(
    Array.from(file.subarray(tags.get(273).value,tags.get(273).value+4)),
    [255,0,255,0],
  );
});

test('64-bit DNG links aligned transparency mask through IFD8 SubIFDs', () => {
  const base = encodeBigLinearDngReference({width:2,height:2,pixels});
  const file = appendBigTransparencyMask(base,{width:2,height:2,mask});
  const ifd0=Number(file.readBigUInt64LE(8));
  const count0=Number(file.readBigUInt64LE(ifd0));
  let subIfd;
  for(let i=0;i<count0;i++){
    const off=ifd0+8+i*20;
    if(file.readUInt16LE(off)===330){
      assert.equal(file.readUInt16LE(off+2),18); // TIFF_IFD8
      assert.equal(Number(file.readBigUInt64LE(off+4)),1);
      subIfd=Number(file.readBigUInt64LE(off+12));
    }
  }
  assert.ok(subIfd > 0);
  assert.equal(subIfd % 8,0);
  assert.equal(file.readBigUInt64LE(ifd0 + 8 + count0*20),0n);
  assert.equal(Number(file.readBigUInt64LE(subIfd)),10);

  const tags=new Map();
  for(let i=0;i<10;i++){
    const off=subIfd+8+i*20;
    tags.set(file.readUInt16LE(off),{
      type:file.readUInt16LE(off+2),
      count:Number(file.readBigUInt64LE(off+4)),
      value:Number(file.readBigUInt64LE(off+12)),
    });
  }
  assert.equal(tags.get(254).value,4);
  assert.equal(tags.get(262).value,4);
  assert.deepEqual(
    Array.from(file.subarray(tags.get(273).value,tags.get(273).value+4)),
    [255,0,255,0],
  );
});
