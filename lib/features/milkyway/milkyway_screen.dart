import 'package:flutter/material.dart';

import '../../core/models/processing_mode.dart';
import '../common/calibration_frame_options_screen.dart';

class MilkyWayScreen extends StatelessWidget {
  const MilkyWayScreen({super.key});

  static const String routeName = '/milky-way';

  @override
  Widget build(BuildContext context) {
    return const CalibrationFrameOptionsScreen(
      mode: ProcessingMode.milkyWay,
      appBarTitle: '天の川',
      lightFrameDescription: '位置合わせとスタックに使用するRAWを撮影順に選択します。',
    );
  }
}
