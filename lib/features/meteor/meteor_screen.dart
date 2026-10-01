import 'package:flutter/material.dart';

import '../../core/models/processing_mode.dart';
import '../common/calibration_frame_options_screen.dart';

class MeteorScreen extends StatelessWidget {
  const MeteorScreen({super.key});

  static const String routeName = '/meteor';

  @override
  Widget build(BuildContext context) {
    return const CalibrationFrameOptionsScreen(
      mode: ProcessingMode.meteor,
      appBarTitle: '流星群',
      lightFrameDescription: '候補検出と前後フレーム解析に使用するRAWを撮影順に選択します。',
    );
  }
}
