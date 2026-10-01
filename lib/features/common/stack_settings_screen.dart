import 'foreground_region_screen.dart';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../../core/export/lightroom_storage_preset.dart';
import '../../core/export/output_image_format.dart';
import '../../core/models/processing_mode.dart';
import '../../core/quality/processing_quality_level.dart';
import '../../core/session/processing_session.dart';
import '../../core/settings/app_settings.dart';
import '../../core/stacking/star_trail_edge_fade.dart';
import '../../core/stacking/star_trail_gap_fill.dart';
import '../../design/mobile_stack_theme.dart';
import 'star_trail_fade_preview_card.dart';

/// Final user-facing settings step shown after reference-frame selection.
class StackSettingsScreen extends StatelessWidget {
  const StackSettingsScreen({
    required this.session,
    this.showMovingObjectRemoval = true,
    super.key,
  });

  final ProcessingSession session;
  final bool showMovingObjectRemoval;

  @override
  Widget build(BuildContext context) {
    final Color accent = _accentForMode(session.mode);
    return Scaffold(
      appBar: AppBar(title: const Text('各種設定')),
      body: StarfieldBackground(
        child: SafeArea(
          child: AnimatedBuilder(
            animation: session,
            builder: (BuildContext context, Widget? child) {
              return ListView(
                padding: const EdgeInsets.fromLTRB(16, 18, 16, 24),
                children: <Widget>[
                  if (session.mode == ProcessingMode.meteor)
                    const _SettingCard(
                      icon: Icons.tune_rounded,
                      title: '画質',
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(
                            '最高画質（固定）',
                            style: TextStyle(fontWeight: FontWeight.w800),
                          ),
                          SizedBox(height: 4),
                          Text(
                            '流星候補の検出精度を優先し、解析は原寸RAWで行います。',
                            style: TextStyle(
                              color: MobileStackColors.muted,
                              height: 1.4,
                            ),
                          ),
                        ],
                      ),
                    )
                  else
                    _SettingCard(
                      icon: Icons.tune_rounded,
                      title: '画質',
                      child: DropdownButton<ProcessingQualityLevel>(
                        value: session.qualityLevel,
                        isExpanded: true,
                        underline: const SizedBox.shrink(),
                        onChanged: (ProcessingQualityLevel? value) {
                          if (value == null) return;
                          session.setQualityLevel(value);
                          AppSettings.saveQualityLevel(value);
                        },
                        items: <DropdownMenuItem<ProcessingQualityLevel>>[
                          for (final value
                              in ProcessingQualityLevel.values.reversed)
                            DropdownMenuItem<ProcessingQualityLevel>(
                              value: value,
                              child: Text(
                                '${value.label} — ${value.detail}',
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                        ],
                      ),
                    ),
                  const SizedBox(height: 12),
                  _SettingCard(
                    icon: Icons.high_quality_outlined,
                    title: '出力方式',
                    child: DropdownButton<OutputImageFormat>(
                      value: session.outputFormat,
                      isExpanded: true,
                      underline: const SizedBox.shrink(),
                      onChanged: (OutputImageFormat? value) {
                        if (value == null) return;
                        session.setOutputFormat(value);
                        AppSettings.saveOutputFormat(value);
                        AppSettings.saveStoragePreset(session.storagePreset);
                      },
                      items: <DropdownMenuItem<OutputImageFormat>>[
                        for (final value in selectableOutputFormats)
                          DropdownMenuItem<OutputImageFormat>(
                            value: value,
                            child: Text(
                              value.label,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  _SettingCard(
                    icon: Icons.photo_size_select_large_rounded,
                    title: 'ファイル容量',
                    child: DropdownButton<LightroomStoragePreset>(
                      value: session.storagePreset,
                      isExpanded: true,
                      underline: const SizedBox.shrink(),
                      onChanged: (LightroomStoragePreset? value) {
                        if (value == null) return;
                        session.setStoragePreset(value);
                        AppSettings.saveStoragePreset(value);
                      },
                      items: <DropdownMenuItem<LightroomStoragePreset>>[
                        for (final value in LightroomStoragePreset.values)
                          DropdownMenuItem<LightroomStoragePreset>(
                            value: value,
                            child: Text(
                              '${value.label} — ${value.detail}',
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                      ],
                    ),
                  ),
                  if (session.mode == ProcessingMode.starTrail) ...<Widget>[
                    const SizedBox(height: 12),
                    const _SettingCard(
                      icon: Icons.auto_awesome_rounded,
                      title: '合成方式',
                      child: Text(
                        '比較明合成（固定）。各画素で最も明るい値を採用し、星の軌跡を連続して残します。',
                        style: TextStyle(
                          color: MobileStackColors.muted,
                          height: 1.4,
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                    Card(
                      child: SwitchListTile.adaptive(
                        contentPadding: const EdgeInsets.fromLTRB(16, 8, 12, 8),
                        secondary:
                            const Icon(Icons.airplanemode_active_rounded),
                        title: const Text(
                          '飛行機・人工衛星自動除去',
                          style: TextStyle(fontWeight: FontWeight.w800),
                        ),
                        subtitle: Text(
                          session.automaticStarTrailAircraftRemoval
                              ? 'ON：天球運動と一致しない光跡や、航空機の点滅パターンを保守的に除外します。星の動きと一致する軌跡は残します。'
                              : 'OFF：光跡判定による除外を行わず、すべてのフレームを比較明合成します。',
                          style: const TextStyle(
                            color: MobileStackColors.muted,
                            height: 1.45,
                          ),
                        ),
                        value: session.automaticStarTrailAircraftRemoval,
                        activeThumbColor: accent,
                        onChanged: (bool value) {
                          session.setAutomaticStarTrailAircraftRemoval(value);
                          AppSettings.saveAutomaticStarTrailAircraftRemoval(
                            value,
                          );
                        },
                      ),
                    ),
                    const SizedBox(height: 12),
                    Card(
                      child: SwitchListTile.adaptive(
                        contentPadding: const EdgeInsets.fromLTRB(16, 8, 12, 8),
                        secondary: const Icon(Icons.blur_off_rounded),
                        title: const Text(
                          'ホットピクセル自動除去',
                          style: TextStyle(fontWeight: FontWeight.w800),
                        ),
                        subtitle: Text(
                          session.starTrailHotPixelRemoval
                              ? 'ON：ほぼ全フレームで同じ位置に光る点（ホットピクセル）を検出し、合成前に周囲の値で置き換えます。動く星の軌跡は対象外です（20枚以上で有効）。'
                              : 'OFF：ホットピクセルを補正せずに比較明合成します。',
                          style: const TextStyle(
                            color: MobileStackColors.muted,
                            height: 1.45,
                          ),
                        ),
                        value: session.starTrailHotPixelRemoval,
                        activeThumbColor: accent,
                        onChanged: (bool value) {
                          session.setStarTrailHotPixelRemoval(value);
                          AppSettings.saveStarTrailHotPixelRemoval(value);
                        },
                      ),
                    ),
                    const SizedBox(height: 12),
                    Card(
                      child: SwitchListTile.adaptive(
                        contentPadding: const EdgeInsets.fromLTRB(16, 8, 12, 8),
                        secondary: const Icon(Icons.auto_awesome_rounded),
                        title: const Text(
                          '流れ星を残す（飛行機除去の判定を慎重に）',
                          style: TextStyle(fontWeight: FontWeight.w800),
                        ),
                        subtitle: Text(
                          session.starTrailMeteorProtection
                              ? 'ON：1枚にだけ写った光跡は、点滅が4回以上はっきり分かれている場合だけ飛行機として除去します。明滅や分裂のある流れ星を残しやすくします。'
                              : 'OFF：従来どおりの判定で除去します。',
                          style: const TextStyle(
                            color: MobileStackColors.muted,
                            height: 1.45,
                          ),
                        ),
                        value: session.starTrailMeteorProtection,
                        activeThumbColor: accent,
                        onChanged: (bool value) {
                          session.setStarTrailMeteorProtection(value);
                          AppSettings.saveStarTrailMeteorProtection(value);
                        },
                      ),
                    ),
                    const SizedBox(height: 12),
                    Card(
                      child: SwitchListTile.adaptive(
                        contentPadding: const EdgeInsets.fromLTRB(16, 8, 12, 8),
                        secondary: const Icon(Icons.grain_rounded),
                        title: const Text(
                          '空の背景をなめらかにする',
                          style: TextStyle(fontWeight: FontWeight.w800),
                        ),
                        subtitle: Text(
                          session.starTrailMeanBackground
                              ? 'ON：空の背景は全フレームの平均、星の軌跡は最大値で合成します。比較明特有の背景のざらつきと明るい浮きを抑えます。軌跡の明るさは変わりません。'
                              : 'OFF：全画面を比較明（最大値）で合成します。',
                          style: const TextStyle(
                            color: MobileStackColors.muted,
                            height: 1.45,
                          ),
                        ),
                        value: session.starTrailMeanBackground,
                        activeThumbColor: accent,
                        onChanged: (bool value) {
                          session.setStarTrailMeanBackground(value);
                          AppSettings.saveStarTrailMeanBackground(value);
                        },
                      ),
                    ),
                    const SizedBox(height: 12),
                    Card(
                      child: SwitchListTile.adaptive(
                        contentPadding: const EdgeInsets.fromLTRB(16, 8, 12, 8),
                        secondary: const Icon(Icons.landscape_rounded),
                        title: const Text(
                          '地上の一時的な光を抑える',
                          style: TextStyle(fontWeight: FontWeight.w800),
                        ),
                        subtitle: Text(
                          session.automaticStarTrailForegroundProtection
                              ? 'ON：指定した地上領域だけで一時的な光を抑えます。空は対象外です。基準写真を変えた場合は領域を指定し直してください。'
                              : 'OFF：地上を含め、全画面を通常の比較明合成にします。',
                          style: const TextStyle(
                            color: MobileStackColors.muted,
                            height: 1.45,
                          ),
                        ),
                        value: session.automaticStarTrailForegroundProtection,
                        activeThumbColor: accent,
                        onChanged: (bool value) {
                          session.setAutomaticStarTrailForegroundProtection(
                            value,
                          );
                          AppSettings
                              .saveAutomaticStarTrailForegroundProtection(
                            value,
                          );
                        },
                      ),
                    ),
                    if (session.automaticStarTrailForegroundProtection)
                      ...<Widget>[
                      const SizedBox(height: 12),
                      Card(
                        child: SwitchListTile.adaptive(
                          contentPadding: const EdgeInsets.fromLTRB(16, 8, 12, 8),
                          secondary: const Icon(Icons.layers_rounded),
                          title: const Text(
                            '地上部を全フレームの平均にする',
                            style: TextStyle(fontWeight: FontWeight.w800),
                          ),
                          subtitle: Text(
                            session.starTrailForegroundAverage
                                ? 'ON：地上部を基準写真1枚ではなく全フレームの平均で作り、ノイズを減らします。車のライトなどの一時的な光も薄まります。'
                                : 'OFF：地上部は基準写真をそのまま使います。',
                            style: const TextStyle(
                              color: MobileStackColors.muted,
                              height: 1.45,
                            ),
                          ),
                          value: session.starTrailForegroundAverage,
                          activeThumbColor: accent,
                          onChanged: (bool value) {
                            session.setStarTrailForegroundAverage(value);
                            AppSettings.saveStarTrailForegroundAverage(value);
                          },
                        ),
                      ),
                      ],
                    const SizedBox(height: 12),
                    if (session
                        .automaticStarTrailForegroundProtection) ...<Widget>[
                      OutlinedButton.icon(
                        onPressed: session.referencePath == null
                            ? null
                            : () => Navigator.of(context).push(
                                MaterialPageRoute<void>(
                                    builder: (_) => ForegroundRegionScreen(
                                        session: session))),
                        icon: const Icon(Icons.draw_outlined),
                        label: Text(session.foregroundRegion == null
                            ? '地上領域を指定（必須）'
                            : '地上領域を変更'),
                      ),
                      const SizedBox(height: 12),
                    ],
                    _SettingCard(
                      icon: Icons.timeline_rounded,
                      title: 'シャッター間の隙間を補間',
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: <Widget>[
                          const _GapFillComparisonTable(),
                          const SizedBox(height: 12),
                          SegmentedButton<StarTrailGapFillMode>(
                            segments: const <ButtonSegment<
                                StarTrailGapFillMode>>[
                              ButtonSegment<StarTrailGapFillMode>(
                                value: StarTrailGapFillMode.off,
                                label: Text('OFF'),
                              ),
                              ButtonSegment<StarTrailGapFillMode>(
                                value: StarTrailGapFillMode.linear,
                                label: Text('直線'),
                              ),
                              ButtonSegment<StarTrailGapFillMode>(
                                value: StarTrailGapFillMode.arc,
                                label: Text('弧'),
                              ),
                            ],
                            selected: <StarTrailGapFillMode>{
                              session.starTrailGapFillMode,
                            },
                            onSelectionChanged:
                                (Set<StarTrailGapFillMode> selection) {
                              final StarTrailGapFillMode value =
                                  selection.first;
                              session.setStarTrailGapFillMode(value);
                              AppSettings.saveStarTrailGapFillMode(value);
                            },
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),
                    Card(
                      child: SwitchListTile.adaptive(
                        contentPadding: const EdgeInsets.fromLTRB(16, 8, 12, 8),
                        secondary: const Icon(Icons.gradient_rounded),
                        title: const Text(
                          '始まり・終わりを薄くする',
                          style: TextStyle(fontWeight: FontWeight.w800),
                        ),
                        subtitle: Text(
                          session.starTrailFadeMode != StarTrailFadeMode.off
                              ? 'ON：軌跡の端に向かって徐々に薄くします。解像度・画質は変わりません。'
                              : 'OFF：軌跡は端まで同じ明るさのまま合成します。',
                          style: const TextStyle(
                            color: MobileStackColors.muted,
                            height: 1.45,
                          ),
                        ),
                        value:
                            session.starTrailFadeMode != StarTrailFadeMode.off,
                        activeThumbColor: accent,
                        onChanged: (bool value) {
                          final StarTrailFadeMode newMode = value
                              ? StarTrailFadeMode.both
                              : StarTrailFadeMode.off;
                          session.setStarTrailFadeMode(newMode);
                          AppSettings.saveStarTrailFadeMode(newMode);
                        },
                      ),
                    ),
                    if (session.starTrailFadeMode !=
                        StarTrailFadeMode.off) ...<Widget>[
                      const SizedBox(height: 12),
                      StarTrailFadePreviewCard(
                        thumbnails: <Uint8List?>[
                          for (final file in session.files) file.thumbnailBytes,
                        ],
                        fadeSettings: session.starTrailFadeSettings,
                      ),
                      const SizedBox(height: 12),
                      _SettingCard(
                        icon: Icons.tune_rounded,
                        title: 'フェードの詳細設定',
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: <Widget>[
                            const Text(
                              '適用範囲',
                              style: TextStyle(fontWeight: FontWeight.w700),
                            ),
                            const SizedBox(height: 8),
                            SegmentedButton<StarTrailFadeMode>(
                              segments: const <ButtonSegment<
                                  StarTrailFadeMode>>[
                                ButtonSegment<StarTrailFadeMode>(
                                  value: StarTrailFadeMode.both,
                                  label: Text('両端'),
                                ),
                                ButtonSegment<StarTrailFadeMode>(
                                  value: StarTrailFadeMode.startOnly,
                                  label: Text('始まりのみ'),
                                ),
                                ButtonSegment<StarTrailFadeMode>(
                                  value: StarTrailFadeMode.endOnly,
                                  label: Text('終わりのみ'),
                                ),
                              ],
                              selected: <StarTrailFadeMode>{
                                session.starTrailFadeMode,
                              },
                              onSelectionChanged:
                                  (Set<StarTrailFadeMode> selection) {
                                final StarTrailFadeMode value = selection.first;
                                session.setStarTrailFadeMode(value);
                                AppSettings.saveStarTrailFadeMode(value);
                              },
                            ),
                            const SizedBox(height: 16),
                            Text(
                              'フェードの長さ：全体の'
                              '${(session.starTrailFadeLengthFraction * 100).round()}%',
                              style:
                                  const TextStyle(fontWeight: FontWeight.w700),
                            ),
                            Slider(
                              value: session.starTrailFadeLengthFraction,
                              min: 0.02,
                              max: 0.5,
                              divisions: 48,
                              activeColor: accent,
                              label:
                                  '${(session.starTrailFadeLengthFraction * 100).round()}%',
                              onChanged: (double value) {
                                session.setStarTrailFadeLengthFraction(value);
                              },
                              onChangeEnd: (double value) {
                                AppSettings.saveStarTrailFadeLengthFraction(
                                  value,
                                );
                              },
                            ),
                            const SizedBox(height: 8),
                            Text(
                              '端の最低輝度：'
                              '${(session.starTrailFadeMinWeight * 100).round()}%'
                              '${session.starTrailFadeMinWeight == 0 ? '（完全に消える）' : ''}',
                              style:
                                  const TextStyle(fontWeight: FontWeight.w700),
                            ),
                            Slider(
                              value: session.starTrailFadeMinWeight,
                              min: 0.0,
                              max: 0.8,
                              divisions: 40,
                              activeColor: accent,
                              label:
                                  '${(session.starTrailFadeMinWeight * 100).round()}%',
                              onChanged: (double value) {
                                session.setStarTrailFadeMinWeight(value);
                              },
                              onChangeEnd: (double value) {
                                AppSettings.saveStarTrailFadeMinWeight(value);
                              },
                            ),
                            const SizedBox(height: 16),
                            const Text(
                              'フェードカーブ',
                              style: TextStyle(fontWeight: FontWeight.w700),
                            ),
                            const SizedBox(height: 8),
                            SegmentedButton<StarTrailFadeCurve>(
                              segments: const <ButtonSegment<
                                  StarTrailFadeCurve>>[
                                ButtonSegment<StarTrailFadeCurve>(
                                  value: StarTrailFadeCurve.linear,
                                  label: Text('直線'),
                                ),
                                ButtonSegment<StarTrailFadeCurve>(
                                  value: StarTrailFadeCurve.ease,
                                  label: Text('滑らか'),
                                ),
                              ],
                              selected: <StarTrailFadeCurve>{
                                session.starTrailFadeCurve,
                              },
                              onSelectionChanged:
                                  (Set<StarTrailFadeCurve> selection) {
                                final StarTrailFadeCurve value =
                                    selection.first;
                                session.setStarTrailFadeCurve(value);
                                AppSettings.saveStarTrailFadeCurve(value);
                              },
                            ),
                          ],
                        ),
                      ),
                    ],
                  ],
                  if (session.mode == ProcessingMode.meteor) ...<Widget>[
                    const SizedBox(height: 12),
                    const _SettingCard(
                      icon: Icons.travel_explore_rounded,
                      title: '流星候補の選択',
                      child: Text(
                        '候補を自動検出・分類した後、実際に合成する流星はレビュー画面でユーザーが選択します。',
                        style: TextStyle(
                          color: MobileStackColors.muted,
                          height: 1.4,
                        ),
                      ),
                    ),
                  ],
                  if (showMovingObjectRemoval &&
                      session.mode == ProcessingMode.milkyWay) ...<Widget>[
                    const SizedBox(height: 12),
                    Card(
                      child: SwitchListTile.adaptive(
                        contentPadding: const EdgeInsets.fromLTRB(16, 8, 12, 8),
                        secondary:
                            const Icon(Icons.airplanemode_active_rounded),
                        title: const Text(
                          '移動体（飛行機等）自動削除',
                          style: TextStyle(fontWeight: FontWeight.w800),
                        ),
                        subtitle: Text(
                          session.automaticMovingObjectRemoval
                              ? 'ON：フレーム間の外れ値を除去します。流れ星も除去対象になる場合があります。'
                              : 'OFF：外れ値を削除せず合成します。流れ星など一時的な光跡を残したい場合はこちら。',
                          style: const TextStyle(
                            color: MobileStackColors.muted,
                            height: 1.45,
                          ),
                        ),
                        value: session.automaticMovingObjectRemoval,
                        activeThumbColor: accent,
                        onChanged: (bool value) {
                          session.setAutomaticMovingObjectRemoval(value);
                          AppSettings.saveAutomaticMovingObjectRemoval(value);
                        },
                      ),
                    ),
                  ],
                  if (session.mode == ProcessingMode.milkyWay) ...<Widget>[
                    const SizedBox(height: 12),
                    Card(
                      child: SwitchListTile.adaptive(
                        contentPadding: const EdgeInsets.fromLTRB(16, 8, 12, 8),
                        secondary: const Icon(Icons.grid_on_rounded),
                        title: const Text(
                          '全視野の高精度位置合わせ（試験機能）',
                          style: TextStyle(fontWeight: FontWeight.w800),
                        ),
                        subtitle: Text(
                          session.wholeFieldRegistration
                              ? 'ON：画面全体に分散した星で、空の回転とレンズの遠近を含めて位置合わせします。四隅の星の伸び・二重化を抑えます。'
                              : 'OFF：従来の位置合わせ（回転・平行移動）で合成します。',
                          style: const TextStyle(
                            color: MobileStackColors.muted,
                            height: 1.45,
                          ),
                        ),
                        value: session.wholeFieldRegistration,
                        activeThumbColor: accent,
                        onChanged: (bool value) {
                          session.setWholeFieldRegistration(value);
                          AppSettings.saveWholeFieldRegistration(value);
                        },
                      ),
                    ),
                  ],
                  const SizedBox(height: 22),
                  if (session.mode == ProcessingMode.starTrail) ...<Widget>[
                    SwitchListTile.adaptive(
                      title: const Text('比較明だけの参照DNGを作る'),
                      subtitle: const Text(
                          '全RAWを原寸・最高画質で現像し、除去・地上光抑制・gap補間・fadeをかけずに比較明合成します。'),
                      value: session.starTrailPureMaxReference,
                      onChanged: session.setStarTrailPureMaxReference,
                    ),
                    const SizedBox(height: 12),
                  ],
                  FilledButton.icon(
                    style: FilledButton.styleFrom(
                      backgroundColor: accent,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                    ),
                    onPressed: session.mode == ProcessingMode.starTrail &&
                            !session.starTrailPureMaxReference &&
                            session.automaticStarTrailForegroundProtection &&
                            session.foregroundRegion == null
                        ? null
                        : () => Navigator.of(context).pop(true),
                    icon: const Icon(Icons.play_arrow_rounded),
                    label: const Text('この設定で処理を開始'),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

class _GapFillComparisonTable extends StatelessWidget {
  const _GapFillComparisonTable();

  @override
  Widget build(BuildContext context) {
    const TextStyle labelStyle =
        TextStyle(fontWeight: FontWeight.w800, fontSize: 13);
    const TextStyle bodyStyle = TextStyle(
      color: MobileStackColors.muted,
      fontSize: 12.5,
      height: 1.4,
    );
    Widget row(String label, String off, String linear, String arc) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            SizedBox(width: 56, child: Text(label, style: labelStyle)),
            Expanded(child: Text(off, style: bodyStyle)),
            const SizedBox(width: 8),
            Expanded(child: Text(linear, style: bodyStyle)),
            const SizedBox(width: 8),
            Expanded(child: Text(arc, style: bodyStyle)),
          ],
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const Row(
          children: <Widget>[
            SizedBox(width: 56),
            Expanded(
              child: Text('OFF', style: TextStyle(fontWeight: FontWeight.w800)),
            ),
            SizedBox(width: 8),
            Expanded(
              child: Text('直線', style: TextStyle(fontWeight: FontWeight.w800)),
            ),
            SizedBox(width: 8),
            Expanded(
              child: Text('弧', style: TextStyle(fontWeight: FontWeight.w800)),
            ),
          ],
        ),
        const Divider(height: 12),
        row(
          '見た目',
          '撮影間隔ごとに軌跡が途切れる（従来通り）',
          '隙間を直線でつなぐ。短い間隔ならほぼ気づかない',
          '実際の天球の弧に沿ってつなぐ。最も自然',
        ),
        row(
          '精度',
          '—',
          '間隔が長い・広角/魚眼レンズだと、直線のズレがやや目立つことがある',
          '角速度・回転中心を計算するので理論上最も正確',
        ),
        row(
          '処理時間',
          '追加なし（一番速い）',
          'ほぼ変わらない（星検出のみ追加）',
          '天の川モードの位置合わせと同等の計算が全フレームに追加され、体感で数割〜数倍遅くなりうる',
        ),
        row(
          '安定性',
          '最も枯れている',
          '新機能・未検証（実機テスト前）',
          '新機能・未検証（実機テスト前）。回転推定に失敗した区間は自動的に直線へ切り替わる',
        ),
      ],
    );
  }
}

class _SettingCard extends StatelessWidget {
  const _SettingCard({
    required this.icon,
    required this.title,
    required this.child,
  });

  final IconData icon;
  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Icon(icon, size: 19, color: MobileStackColors.muted),
                const SizedBox(width: 8),
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            child,
          ],
        ),
      ),
    );
  }
}

Color _accentForMode(ProcessingMode mode) => switch (mode) {
      ProcessingMode.milkyWay => const Color(0xFF8151FF),
      ProcessingMode.starTrail => const Color(0xFF2C79FF),
      ProcessingMode.meteor => const Color(0xFF28AE6F),
      ProcessingMode.focusStack => const Color(0xFFF08A5D),
    };
