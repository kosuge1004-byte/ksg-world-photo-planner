import 'package:flutter/material.dart';

import '../../core/models/processing_mode.dart';
import '../common/calibration_frame_options_screen.dart';

class StarTrailScreen extends StatelessWidget {
  const StarTrailScreen({super.key});

  static const String routeName = '/star-trail';

  @override
  Widget build(BuildContext context) {
    return const CalibrationFrameOptionsScreen(
      mode: ProcessingMode.starTrail,
      appBarTitle: '星の軌跡',
      lightFrameDescription: '比較明合成するRAWを撮影順に選択します。星の位置合わせは行いません。',
    );
  }
}
