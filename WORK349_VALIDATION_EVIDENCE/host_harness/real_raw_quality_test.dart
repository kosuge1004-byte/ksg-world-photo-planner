import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/demosaic/demosaic_registry.dart';
import 'package:mobile_stack/core/demosaic/native_mobile_stack_demosaic_engine.dart';
import 'package:mobile_stack/core/engine/phase2_validated_job_executor.dart';
import 'package:mobile_stack/core/engine/processing_job.dart';
import 'package:mobile_stack/core/export/dng_final_render_profile.dart';
import 'package:mobile_stack/core/export/export_result.dart';
import 'package:mobile_stack/core/export/output_image_format.dart';
import 'package:mobile_stack/core/image/file_backed_linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/image/raw_saturation_mask.dart';
import 'package:mobile_stack/core/models/processing_mode.dart';
import 'package:mobile_stack/core/raw/native_raw_decoder_factory.dart';
import 'package:mobile_stack/core/raw/raw_native_contract.dart';
import 'package:mobile_stack/core/session/milky_way_pipeline.dart';
import 'package:mobile_stack/core/registration/star_psf_quality.dart';
import 'package:mobile_stack/core/registration/flat_sky_noise_quality.dart';
import 'ffi_bridge.dart';
final class HostBackend implements RawNativeDecodeBackend,
    RawNativeFileDecodeBackend, RawNativeMetadataProbeBackend {
  HostBackend(this.libraryPath);
  final String libraryPath;
  FfiRawNativeBridge open() => FfiRawNativeBridge.openForCurrentPlatform(
      androidLibraryName: libraryPath);
  @override
  Future<RawNativeDecodedFrame> decode(RawNativeDecodeCommand command) async {
    final bridge = open();
    try { return bridge.decode(command, takeSampleOwnership: true); }
    finally { bridge.close(); }
  }
  @override
  Future<RawNativeFileDecodedFrame> decodeToFile({required RawNativeDecodeCommand command,
      required String outputPath}) async {
    final bridge = open();
    try { return bridge.decodeToFile(command, outputPath: outputPath); }
    finally { bridge.close(); }
  }
  @override
  Future<RawNativeMetadataFrame> probeMetadata(RawNativeMetadataProbeCommand command) async {
    final bridge = open();
    try { return bridge.probeMetadata(command); }
    finally { bridge.close(); }
  }
}


void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('3 real Sony RAW full-resolution Milky Way quality and DNG export', () async {
    final env = Platform.environment;
    final rawDir = Directory(env['MOBILE_STACK_REAL_RAW_DIR']!);
    final destination = Directory(env['MOBILE_STACK_REAL_OUTPUT_DIR']!);
    await destination.create(recursive: true);
    final backend = HostBackend(env['MOBILE_STACK_HOST_DLL']!);
    final engine = NativeMobileStackDemosaicEngine(library: DynamicLibrary.open(backend.libraryPath));
    final allSources = (await rawDir.list().where((f) => f.path.toLowerCase().endsWith('.arw')).toList())..sort((a,b) => a.path.compareTo(b.path));
    final sources = allSources.take(3).toList();
    expect(sources, hasLength(3));
    final stores = <LinearRgbTileStore?>[];
    final masks = <RawSaturationMask?>[];
    DngFinalRenderProfile? referenceProfile;
    final decodeReports = <Object>[];
    MilkyWayPipelineResult? result;
    try {
      for (int i = 0; i < sources.length; i++) {
        final timer = Stopwatch()..start();
        LinearRgbTileStore? decoded;
        RawSaturationMask? mask;
        final path = '${destination.path}/frame_$i.f32';
        await runPhase2ValidatedJob(ProcessingJob(id:'host349-$i', mode:ProcessingMode.milkyWay,sourcePath:sources[i].path)..state=ProcessingJobState.running, (_) {},
          decoderRegistry:createProductionNativeRawDecoderRegistry(backend:backend),
          metadataProbe:createProductionNativeRawMetadataProbe(backend:backend),
          demosaicRegistry:DemosaicRegistry([engine]),
          fileBackRawBeforeDemosaic:true, preferStreamedRawCalibration:true,
          rgbTileStoreFactory:({required width,required height,required plan}) => FileBackedLinearRgbTileStore.create(path:path,width:width,height:height,plan:plan),
          onRenderMetadataReady:(m,c) { if (i==0) { referenceProfile=DngFinalRenderProfile.fromMetadata(sourceId:sources[i].path,metadata:m,cfaPattern:c); } },
          onSaturationMaskReady:(m) => mask=m,
          onTileStoreReady:(s) => decoded=s);
        expect(decoded!.width,4000); expect(decoded!.height,6000);
        stores.add(decoded); masks.add(mask);
        decodeReports.add({'source':sources[i].path,'ms':timer.elapsedMilliseconds,'width':decoded!.width,'height':decoded!.height});
        print('HOST349_RAW_DECODE_PASS ${sources[i].path} ${timer.elapsedMilliseconds}ms');
      }
      result = await registerAndCombineDecodedFrames(sourcePaths:[for(final s in sources) s.path],frameStores:stores,
        saturationInfluenceMasks:masks,decodeFailures:{},referenceIndex:0,
        outputTileStoreFactory:FileBackedLinearRgbTileStore.createTemporary,
        enableMovingObjectRemoval:true,preserveStaticForeground:true,tileSize:512);
      expect(result.frameDiagnostics.where((d)=>d.included).length, greaterThanOrEqualTo(2));
      final referenceStars = await detectMilkyWayRegistrationStars(stores[0]!);
      final finalStars = await detectMilkyWayRegistrationStars(result.tileStore);
      final psf=compareRegisteredStarPsf(referenceStars:referenceStars,finalStars:finalStars);
      final noise=await compareFlatSkyNoise(referenceStore:stores[0]!,finalStore:result.tileStore,referenceStars:referenceStars);
      expect(evaluateStarPsfQualityGate(comparison:psf).passed,isTrue);
      expect(evaluateFlatSkyNoiseQualityGate(comparison:noise).passed,isTrue);
      for(int y=0;y<6000;y+=128) {
        final h = y+128<=6000 ? 128 : 6000-y;
        final t=await result.tileStore.readRegion(x:0,y:y,width:4000,height:h);
        expect(t.interleavedRgb.every((v)=>v.isFinite),isTrue,reason:'Non-finite output at row $y');
      }
      final output = '${destination.path}/milky_way_host349.dng';
      await exportTileStoreToImage(tileStore:result.tileStore,outputPath:output,format:OutputImageFormat.linearDng,renderProfile:referenceProfile);
      expect(await File(output).length(),greaterThan(60*1024*1024));
      final report={
        'result':'PASS','platform':'Windows host-only bridge; not Android E2E',
        'decoded':decodeReports,'output':output,'bytes':await File(output).length(),
        'included':result.frameDiagnostics.where((d)=>d.included).length,
        'psf':{'referenceMeasured':psf.referenceMeasuredStarCount,'pairs':psf.measuredPairCount,'medianFwhmRatio':psf.medianFwhmRatio,'p90FwhmRatio':psf.p90FwhmRatio,'roundnessDelta':psf.medianRoundnessDelta},
        'noise':{'selectedTiles':noise.selectedTileCount,'coefficients':noise.sampledCoefficientCount,'referenceSigma':noise.referenceSigma,'finalSigma':noise.finalSigma,'ratio':noise.noiseRatio},
        'allOutputSamplesFinite':true,
        'frames':[for(final d in result.frameDiagnostics) {'source':d.sourcePath,'included':d.included,'reason':d.excludedReason,'rms':d.rmsResidual,'rmsLimit':d.registrationRmsLimit,'p95':d.residualP95,'max':d.residualMax,'spanX':d.matchSpanXFraction,'spanY':d.matchSpanYFraction,'quadrants':d.matchOccupiedQuadrants,'localCorrection':d.localCorrectionApplied,'weight':d.registrationWeight}]
      };
      await File('${destination.path}/results.json').writeAsString(jsonEncode(report),flush:true);
      print('HOST349_RAW_STACK_PASS ${jsonEncode(report)}');
    } on Object catch (error) {
      await File('${destination.path}/failure.json').writeAsString(jsonEncode({'error':'$error','decoded':decodeReports}),flush:true);
      rethrow;
    } finally {
      await result?.tileStore.dispose(); await result?.contributionStore?.dispose();
      for(final s in stores) { await (s as FileBackedLinearRgbTileStore).closeRetainingFile(); }
    }
  }, timeout: const Timeout(Duration(minutes:30)));
}
