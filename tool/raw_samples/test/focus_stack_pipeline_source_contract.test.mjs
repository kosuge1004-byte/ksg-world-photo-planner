import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pipeline=readFileSync(
  new URL('../../../lib/core/focus_stack/focus_stack_pipeline.dart',import.meta.url),
  'utf8',
);

test('focus-stack pipeline connects RAW decode through production demosaic',()=>{
  assert.match(pipeline,/rawDecoderRegistry\.requireDecoder/);
  assert.match(pipeline,/decoder\.decode/);
  assert.match(pipeline,/demosaicReconstructedMosaic/);
  assert.match(pipeline,/demosaicRegistry:/);
});

test('reference frame is preserved and other frames are aligned into its coordinates',()=>{
  assert.match(pipeline,/referenceStore = decodedStores\[referenceIndex\]/);
  assert.match(pipeline,/estimateFocusAlignmentFromLuminance/);
  assert.match(pipeline,/resampleFocusLuminanceForMarking/);
  assert.match(pipeline,/reference:\s*referenceLuminance/);
  assert.match(pipeline,/alignment\.toSamplingTransform\(\)/);
});

test('final full-resolution measures use file-backed integral storage',()=>{
  assert.match(pipeline,/writeModifiedLaplacianFocusMeasureFile/);
  assert.match(pipeline,/selectAndRefineFocusWinnersToFiles/);
  assert.doesNotMatch(pipeline,/List<FocusMeasurePlane> measures/);
  assert.doesNotMatch(pipeline,/modifiedLaplacianFocusMeasure\(/);
});

test('final reference RGB and green reads avoid redundant full planes',()=>{
  assert.doesNotMatch(pipeline,/_materializeReferenceFrame/);
  assert.doesNotMatch(pipeline,/Float32List\.fromList\(tile\.interleavedRgb\)/);
  assert.doesNotMatch(pipeline,/List<int>\.filled\(store\.width \* store\.height, 1\)/);
  assert.match(pipeline,/const int rowsPerRead = 64/);
});

test('final aligned RGB is resampled and written to a file-backed result in bounded tiles',()=>{
  assert.match(pipeline,/blendRegisteredFocusStoresFromFileBackedWinnersAndCoverageToStore/);
  assert.match(pipeline,/finalRgbStore/);
  assert.doesNotMatch(pipeline,/blendRegisteredFocusStoresMemoryBounded\(/);
  assert.doesNotMatch(pipeline,/List<FocusAlignedFrame> alignedFrames/);
});

test('focus stack reaches winner regularization and halo-aware blending',()=>{
  assert.match(pipeline,/selectAndRefineFocusWinnersToFiles/);
  assert.match(pipeline,/regularizeFileBackedFocusWinnerMapTwoPass/);
  assert.match(pipeline,/blendRegisteredFocusStoresFromFileBackedWinnersAndCoverageToStore/);
  assert.doesNotMatch(pipeline,/final FocusBlendWeights weights/);
});

test('final result remains linear camera RGB in file-backed storage before output color/DNG packaging',()=>{
  assert.match(pipeline,/final LinearRgbTileStore cameraRgbStore/);
  assert.match(pipeline,/cameraRgbStore: blend\.rgbStore/);
  assert.doesNotMatch(pipeline,/final Float32List interleavedCameraRgb/);
  assert.doesNotMatch(pipeline,/final FocusWinnerMap winnerMap/);
  assert.match(pipeline,/referenceMetadata/);
  assert.doesNotMatch(pipeline,/encodeLinearDng|writeLinearDng|ColorMatrix1/);
});

test('temporary demosaic stores are always disposed',()=>{
  assert.match(pipeline,/finally \{/);
  assert.match(pipeline,/scores\.delete\(recursive: true\)/);
  assert.match(pipeline,/decodedStores\.reversed/);
  assert.match(pipeline,/await store\.dispose\(\)/);
});
