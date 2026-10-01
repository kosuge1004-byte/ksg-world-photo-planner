import 'package:flutter/material.dart';

abstract final class MobileStackColors {
  static const Color background = Color(0xFF070A12);
  static const Color surface = Color(0xFF121722);
  static const Color surfaceHigh = Color(0xFF191F2B);
  static const Color outline = Color(0xFF2A3140);
  static const Color muted = Color(0xFF9BA5B7);
  static const Color accent = Color(0xFF6677FF);
  static const Color accentSecondary = Color(0xFF8A66FF);
  static const Color success = Color(0xFF43C982);
  static const Color warning = Color(0xFFFFBE55);
}

ThemeData buildMobileStackTheme() {
  const ColorScheme colors = ColorScheme.dark(
    primary: MobileStackColors.accent,
    secondary: MobileStackColors.accentSecondary,
    surface: MobileStackColors.surface,
    error: Color(0xFFFF6B7A),
    onPrimary: Colors.white,
    onSecondary: Colors.white,
    onSurface: Color(0xFFF5F7FB),
  );

  return ThemeData(
    brightness: Brightness.dark,
    colorScheme: colors,
    useMaterial3: true,
    scaffoldBackgroundColor: MobileStackColors.background,
    fontFamilyFallback: const <String>[
      'Noto Sans JP',
      'Yu Gothic UI',
      'Meiryo',
    ],
    appBarTheme: const AppBarTheme(
      elevation: 0,
      centerTitle: true,
      backgroundColor: Color(0xE6070A12),
      surfaceTintColor: Colors.transparent,
      titleTextStyle: TextStyle(
        color: Colors.white,
        fontSize: 17,
        fontWeight: FontWeight.w700,
      ),
    ),
    cardTheme: const CardThemeData(
      margin: EdgeInsets.zero,
      elevation: 0,
      color: MobileStackColors.surface,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(16)),
        side: BorderSide(color: MobileStackColors.outline),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size(0, 52),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size(0, 52),
        side: const BorderSide(color: MobileStackColors.outline),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
      ),
    ),
    dividerTheme: const DividerThemeData(
      color: MobileStackColors.outline,
      thickness: 1,
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(
      color: MobileStackColors.accent,
      linearTrackColor: MobileStackColors.surfaceHigh,
    ),
  );
}

class StarfieldBackground extends StatelessWidget {
  const StarfieldBackground({required this.child, super.key});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: RadialGradient(
          center: Alignment(0, -1.15),
          radius: 1.45,
          colors: <Color>[
            Color(0xFF13203A),
            MobileStackColors.background,
            Color(0xFF04060B),
          ],
          stops: <double>[0, 0.48, 1],
        ),
      ),
      child: child,
    );
  }
}
