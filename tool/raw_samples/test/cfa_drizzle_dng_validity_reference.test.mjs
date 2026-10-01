import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRgbTransparencyMask,
  buildDemosaicTransparencyMaskRggb,
} from '../cfa_drizzle_dng_validity_reference.mjs';

test('direct RGB mask requires source coverage in all three planes', () => {
  const mask = buildRgbTransparencyMask({
    minimumCoverage: 1,
    interleavedCoverage: Float32Array.from([
      1,1,1,
      2,0.99,2,
      0,0,0,
      5,3,2,
    ]),
  });
  assert.deepEqual(Array.from(mask), [255,0,0,255]);
});

test('direct RGB mask rejects majority-saturated channel even when unsaturated survivors remain', () => {
  const mask = buildRgbTransparencyMask({
    minimumCoverage: 1e-6,
    minimumSaturationFraction: 0.5,
    interleavedCoverage: Float32Array.from([
      1, 1, 1,
      1, 1, 1,
      1, 1, 1,
    ]),
    interleavedSaturationCoverage: Float32Array.from([
      0, 0, 0,
      3, 0, 0,
      1, 0, 0,
    ]),
    interleavedSaturationDecisionCoverage: Float32Array.from([
      4, 4, 4,
      1, 4, 4,
      3, 4, 4,
    ]),
  });
  assert.deepEqual(Array.from(mask), [255, 0, 255]);
});

test('direct RGB saturation decision uses pre-rejection non-saturated coverage', () => {
  const mask = buildRgbTransparencyMask({
    minimumCoverage: 1e-6,
    minimumSaturationFraction: 0.5,
    interleavedCoverage: Float32Array.from([1, 1, 1]),
    interleavedSaturationCoverage: Float32Array.from([1, 0, 0]),
    interleavedSaturationDecisionCoverage: Float32Array.from([3, 1, 1]),
  });
  // 1 saturated / (3 pre-rejection non-saturated + 1 saturated) = 25%.
  // Survivor-only coverage would incorrectly call this 50% saturated.
  assert.deepEqual(Array.from(mask), [255]);
});

test('native-CFA mask checks only the physically sampled CFA plane', () => {
  // RGGB 2x2. Give only each native CFA plane coverage; unrelated planes are 0.
  const coverage = Float32Array.from([
    1,0,0,  0,1,0,
    0,1,0,  0,0,1,
  ]);
  const mask = buildDemosaicTransparencyMaskRggb({
    width:2,
    height:2,
    interleavedCoverage:coverage,
    minimumCoverage:1,
    radius:0,
  });
  assert.deepEqual(Array.from(mask), [255,255,255,255]);
});

test('demosaic mask expands one undefined CFA site by exact radius 5', () => {
  const width=13, height=13;
  const coverage = new Float32Array(width*height*3);
  for (let y=0;y<height;y++) {
    for (let x=0;x<width;x++) {
      const p=y*width+x;
      const c=((x&1)===0 && (y&1)===0) ? 0 :
        ((x&1)===1 && (y&1)===1) ? 2 : 1;
      coverage[p*3+c]=1;
    }
  }
  // center native site loses coverage.
  const x=6,y=6,p=y*width+x;
  coverage[p*3+0]=0; // (6,6) is R in RGGB
  const mask=buildDemosaicTransparencyMaskRggb({
    width,height,interleavedCoverage:coverage,minimumCoverage:1,radius:5,
  });
  let invalid=0;
  for (const v of mask) if (v===0) invalid++;
  assert.equal(invalid,121);
});

test('existing reconstructed saturation/invalid state joins coverage invalidity', () => {
  const width=13,height=13;
  const coverage = new Float32Array(width*height*3);
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const p=y*width+x;
    const c=((x&1)===0 && (y&1)===0) ? 0 :
      ((x&1)===1 && (y&1)===1) ? 2 : 1;
    coverage[p*3+c]=1;
  }
  const invalid=new Uint8Array(width*height);
  invalid[6*width+6]=1;
  const mask=buildDemosaicTransparencyMaskRggb({
    width,height,interleavedCoverage:coverage,minimumCoverage:1,
    reconstructedInvalid:invalid,radius:5,
  });
  assert.equal(mask[6*width+6],0);
  assert.equal(mask[0],255);
});


test('minimumCoverage must be strictly positive so zero coverage cannot become valid', () => {
  assert.throws(() => buildRgbTransparencyMask({
    minimumCoverage: 0,
    interleavedCoverage: Float32Array.from([0,0,0]),
  }), /finite and positive/);
  assert.throws(() => buildDemosaicTransparencyMaskRggb({
    width:1,height:1,minimumCoverage:0,radius:0,
    interleavedCoverage: Float32Array.from([0,0,0]),
  }), /finite and positive/);
});

test('native-CFA mask rejects non-finite or negative native coverage instead of treating it as valid', () => {
  for (const bad of [NaN, Infinity, -1]) {
    const coverage = Float32Array.from([bad,0,0]);
    assert.throws(() => buildDemosaicTransparencyMaskRggb({
      width:1,height:1,interleavedCoverage:coverage,minimumCoverage:1e-6,radius:0,
    }), /finite and non-negative/);
  }
});
