import 'dart:async';

import 'package:flutter/material.dart';

import 'design/mobile_stack_theme.dart';
import 'core/background/foreground_timeout_recovery.dart';
import 'features/home/home_screen.dart';
import 'features/focus_stack/focus_stack_screen.dart';
import 'features/meteor/meteor_screen.dart';
import 'features/milkyway/cfa_drizzle_milky_way_screen.dart';
import 'features/milkyway/milkyway_screen.dart';
import 'features/settings/settings_screen.dart';
import 'features/startrail/startrail_screen.dart';

class MobileStackApp extends StatefulWidget {
  const MobileStackApp({super.key});

  @override
  State<MobileStackApp> createState() => _MobileStackAppState();
}

class _MobileStackAppState extends State<MobileStackApp>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Covers a cold UI-process start where no resumed callback is guaranteed
    // after the widget tree is installed. The Activity is visible by the time
    // the post-frame callback runs, so Android may legally restart the FGS.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(_resumeRecoverableJob());
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_resumeRecoverableJob());
    }
  }

  Future<void> _resumeRecoverableJob() async {
    try {
      await ForegroundTimeoutRecovery.resumeIfNeeded();
    } on Object {
      // A durable recoverable status and manual retry remain available. A
      // transient Android launch denial must not become an unhandled Future.
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Mobile Stack',
      debugShowCheckedModeBanner: false,
      themeMode: ThemeMode.dark,
      darkTheme: buildMobileStackTheme(),
      routes: <String, WidgetBuilder>{
        '/': (_) => const HomeScreen(),
        MilkyWayScreen.routeName: (_) => const MilkyWayScreen(),
        CfaDrizzleMilkyWayScreen.routeName: (_) =>
            const CfaDrizzleMilkyWayScreen(),
        StarTrailScreen.routeName: (_) => const StarTrailScreen(),
        MeteorScreen.routeName: (_) => const MeteorScreen(),
        FocusStackScreen.routeName: (_) => const FocusStackScreen(),
        SettingsScreen.routeName: (_) => const SettingsScreen(),
      },
    );
  }
}
