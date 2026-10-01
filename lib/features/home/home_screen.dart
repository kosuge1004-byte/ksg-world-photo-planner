import 'package:flutter/material.dart';

import '../../core/background/foreground_timeout_recovery.dart';
import '../../core/background/background_stack_controller.dart';
import '../../core/background/stack_job_registry.dart';
import '../../core/background/stack_job_status.dart';
import '../../core/models/processing_mode.dart';
import '../../design/mobile_stack_theme.dart';
import '../meteor/meteor_screen.dart';
import '../focus_stack/focus_stack_screen.dart';
import '../milkyway/cfa_drizzle_milky_way_progress_screen.dart';
import '../milkyway/cfa_drizzle_milky_way_screen.dart';
import '../milkyway/milkyway_screen.dart';
import '../common/standard_background_progress_screen.dart';
import '../settings/settings_screen.dart';
import '../startrail/startrail_screen.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      extendBodyBehindAppBar: true,
      appBar: AppBar(
        title: const Text('Mobile Stack'),
        actions: <Widget>[
          IconButton(
            tooltip: '設定',
            onPressed: () =>
                Navigator.pushNamed(context, SettingsScreen.routeName),
            icon: const Icon(Icons.tune_rounded),
          ),
        ],
      ),
      body: StarfieldBackground(
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(14, 14, 14, 32),
            children: const <Widget>[
              _BrandHero(),
              SizedBox(height: 14),
              _RecoverableStackCard(),
              SizedBox(height: 24),
              Text(
                '何を処理しますか？',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 25, fontWeight: FontWeight.w800),
              ),
              SizedBox(height: 6),
              Text(
                '用途を選ぶと、専用のワークフローを開始します',
                textAlign: TextAlign.center,
                style: TextStyle(color: MobileStackColors.muted, fontSize: 13),
              ),
              SizedBox(height: 18),
              _ModeCard(
                mode: ProcessingMode.milkyWay,
                subtitle: '星を位置合わせしてノイズを低減し、地上との境界を自然に仕上げます。',
                icon: Icons.auto_awesome_rounded,
                routeName: MilkyWayScreen.routeName,
                accent: Color(0xFF8151FF),
                glow: Color(0xFF4D267E),
                chips: <String>['位置合わせ', '地上固定', '移動体除去'],
              ),
              SizedBox(height: 12),
              _ModeCard(
                mode: ProcessingMode.starTrail,
                subtitle: '比較明合成と始端・終端フェードで滑らかな星の軌跡を作ります。',
                icon: Icons.motion_photos_on_rounded,
                routeName: StarTrailScreen.routeName,
                accent: Color(0xFF2C79FF),
                glow: Color(0xFF123F88),
                chips: <String>['比較明', 'フェード', '隙間補完'],
              ),
              SizedBox(height: 12),
              _ModeCard(
                mode: ProcessingMode.meteor,
                subtitle: '流星候補を抽出し、確認したフレームだけを背景へ合成します。',
                icon: Icons.bolt_rounded,
                routeName: MeteorScreen.routeName,
                accent: Color(0xFF28AE6F),
                glow: Color(0xFF145A3D),
                chips: <String>['流星抽出', '候補確認', '人工物除外'],
              ),
              SizedBox(height: 12),
              _ModeCard(
                mode: ProcessingMode.focusStack,
                subtitle: 'ピント位置の異なる複数枚を高精度に位置合わせし、全体にピントの合った1枚へ合成します。',
                icon: Icons.filter_center_focus_rounded,
                routeName: FocusStackScreen.routeName,
                accent: Color(0xFFF08A5D),
                glow: Color(0xFF7A3F2B),
                chips: <String>['フォーカス合成', '位置合わせ', '境界ブレンド'],
              ),
              SizedBox(height: 16),
              _RecentProjectCard(),
              SizedBox(height: 10),
              _ExperimentalModeLink(),
            ],
          ),
        ),
      ),
    );
  }
}

class _BrandHero extends StatelessWidget {
  const _BrandHero();

  @override
  Widget build(BuildContext context) {
    return AspectRatio(
      aspectRatio: 16 / 9,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(18),
        child: Stack(
          fit: StackFit.expand,
          children: <Widget>[
            Image.asset(
              'assets/images/mobile_stack_brand.png',
              fit: BoxFit.cover,
              filterQuality: FilterQuality.high,
            ),
            const DecoratedBox(
              decoration: BoxDecoration(
                border: Border.fromBorderSide(
                  BorderSide(color: Color(0x335FA8FF)),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ModeCard extends StatelessWidget {
  const _ModeCard({
    required this.mode,
    required this.subtitle,
    required this.icon,
    required this.routeName,
    required this.accent,
    required this.glow,
    required this.chips,
  });

  final ProcessingMode mode;
  final String subtitle;
  final IconData icon;
  final String routeName;
  final Color accent;
  final Color glow;
  final List<String> chips;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(18),
      clipBehavior: Clip.antiAlias,
      child: Ink(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: accent.withValues(alpha: 0.8)),
          gradient: LinearGradient(
            colors: <Color>[
              MobileStackColors.surface,
              glow.withValues(alpha: 0.78),
            ],
            begin: Alignment.centerLeft,
            end: Alignment.centerRight,
          ),
          boxShadow: <BoxShadow>[
            BoxShadow(
              color: accent.withValues(alpha: 0.12),
              blurRadius: 24,
              offset: const Offset(0, 10),
            ),
          ],
        ),
        child: InkWell(
          onTap: () => Navigator.pushNamed(context, routeName),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 17, 14, 16),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Container(
                  width: 46,
                  height: 46,
                  decoration: BoxDecoration(
                    color: accent.withValues(alpha: 0.16),
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: accent.withValues(alpha: 0.5)),
                  ),
                  child: Icon(icon, color: Colors.white, size: 27),
                ),
                const SizedBox(width: 13),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        mode.label,
                        style: const TextStyle(
                          fontSize: 19,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        subtitle,
                        style: const TextStyle(
                          color: Color(0xFFD9E0EC),
                          fontSize: 12,
                          height: 1.5,
                        ),
                      ),
                      const SizedBox(height: 10),
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: <Widget>[
                          for (final String chip in chips)
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                                vertical: 4,
                              ),
                              decoration: BoxDecoration(
                                color: Colors.white.withValues(alpha: 0.06),
                                borderRadius: BorderRadius.circular(999),
                                border: Border.all(
                                  color: Colors.white.withValues(alpha: 0.1),
                                ),
                              ),
                              child: Text(
                                chip,
                                style: const TextStyle(fontSize: 10),
                              ),
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
                const Padding(
                  padding: EdgeInsets.only(top: 10),
                  child: Icon(Icons.chevron_right_rounded, size: 30),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _RecentProjectCard extends StatelessWidget {
  const _RecentProjectCard();

  @override
  Widget build(BuildContext context) {
    return Card(
      child: ListTile(
        enabled: false,
        leading: const Icon(Icons.history_rounded),
        title: const Text('最近使ったプロジェクト'),
        subtitle: const Text('プロジェクト保存は今後の実装で有効になります'),
        trailing: const Icon(Icons.chevron_right_rounded),
      ),
    );
  }
}

/// 天の川/星景モードのCFA drizzleベース実験的パイプライン
/// (Work84-93)への、控えめな入口。既存の`_ModeCard`3枚とは意図的に
/// 見た目を変え(小さく、目立たない色)、通常モードと同格の選択肢では
/// なく「試してみたい人向けの追加の選択肢」であることを一目で伝える。
class _ExperimentalModeLink extends StatelessWidget {
  const _ExperimentalModeLink();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: TextButton.icon(
        onPressed: () => Navigator.pushNamed(
          context,
          CfaDrizzleMilkyWayScreen.routeName,
        ),
        icon: const Icon(Icons.science_outlined, size: 16),
        label: const Text(
          '天の川モード・高画質（実験的）を試す',
          style: TextStyle(fontSize: 12),
        ),
        style: TextButton.styleFrom(
          foregroundColor: MobileStackColors.muted,
        ),
      ),
    );
  }
}

class _RecoverableStackCard extends StatefulWidget {
  const _RecoverableStackCard();

  @override
  State<_RecoverableStackCard> createState() => _RecoverableStackCardState();
}

class _RecoverableStackSnapshot {
  const _RecoverableStackSnapshot({required this.record, required this.status});

  final StackJobRecord record;
  final StackJobStatus status;
}

class _RecoverableStackCardState extends State<_RecoverableStackCard>
    with WidgetsBindingObserver {
  Future<_RecoverableStackSnapshot?>? _snapshot;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _snapshot = _load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refresh();
  }

  void _refresh() {
    setState(() => _snapshot = _load());
  }

  Future<_RecoverableStackSnapshot?> _load() async {
    // Reconcile a persisted queued/running snapshot with Android WorkManager
    // before presenting it after process death or app relaunch.
    await StackJobRegistry.activeJob();
    final StackJobRecord? record = await StackJobRegistry.recoverableJob();
    if (record == null) return null;
    StackJobStatus? status = await StackJobStatus.readFile(record.statusPath);
    if (status == null) return null;

    // App-level lifecycle recovery is authoritative. Calling it here as well
    // makes an already-mounted home card refresh immediately; concurrent calls
    // are coalesced by ForegroundTimeoutRecovery.
    if (status.state == StackJobState.interruptedRecoverable &&
        ForegroundTimeoutRecovery.recoverableCauses
            .contains(status.recoveryCause)) {
      try {
        final bool resumed = await ForegroundTimeoutRecovery.resumeIfNeeded();
        if (resumed) {
          status = status.copyWith(
            state: StackJobState.queued,
            stage: 'Android制限解除後・保存済み地点から自動再開中…',
            clearError: true,
            clearRecoveryCause: true,
          );
        }
      } on Object {
        // Keep the durable interrupted state visible. The explicit resume
        // control remains available if Android rejects this foreground start.
      }
    }
    return _RecoverableStackSnapshot(record: record, status: status!);
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<_RecoverableStackSnapshot?>(
      future: _snapshot,
      builder: (BuildContext context,
          AsyncSnapshot<_RecoverableStackSnapshot?> snapshot) {
        final _RecoverableStackSnapshot? value = snapshot.data;
        if (value == null) return const SizedBox.shrink();
        final StackJobStatus status = value.status;
        final int percent = (status.progress.clamp(0.0, 1.0) * 100).round();
        final String state = switch (status.state) {
          StackJobState.queued => '待機中',
          StackJobState.running => '処理中',
          StackJobState.completed => '完了',
          StackJobState.failed => 'エラー',
          StackJobState.interruptedRecoverable => '中断・再開可能',
          StackJobState.cancelled => 'キャンセル',
        };
        final BackgroundStackLaunch launch = BackgroundStackLaunch(
          uniqueName: value.record.uniqueName,
          statusPath: value.record.statusPath,
          outputPath: value.record.outputPath,
          frameCount: value.record.frameCount,
          recovered: true,
          jobKind: value.record.jobKind,
          modeName: value.record.modeName,
          jobLabel: value.record.jobLabel,
          sourcePaths: value.record.sourcePaths,
          outputFormatName: value.record.outputFormatName,
          storagePresetName: value.record.storagePresetName,
        );
        return Card(
          child: ListTile(
            leading: const Icon(Icons.sync_rounded),
            title: Text('${value.record.jobLabel}：$state $percent%'),
            subtitle: Text(
                '${status.stage} ・ ${status.currentItem}/${status.totalItems}枚'),
            trailing: const Icon(Icons.chevron_right_rounded),
            onTap: () async {
              await Navigator.of(context).push<void>(
                MaterialPageRoute<void>(
                  builder: (_) => value.record.jobKind == 'cfaDrizzle'
                      ? CfaDrizzleMilkyWayProgressScreen.resume(launch: launch)
                      : StandardBackgroundProgressScreen.resume(launch: launch),
                ),
              );
              if (mounted) _refresh();
            },
          ),
        );
      },
    );
  }
}
