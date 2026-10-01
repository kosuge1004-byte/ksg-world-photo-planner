import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/engine/concurrency_policy.dart';
import 'package:mobile_stack/core/engine/job_scheduler.dart';
import 'package:mobile_stack/core/engine/processing_job.dart';
import 'package:mobile_stack/core/engine/resource_snapshot.dart';
import 'package:mobile_stack/core/models/processing_mode.dart';

void main() {
  const ResourceSnapshot snapshot = ResourceSnapshot(
    logicalProcessors: 12,
    availableMemoryBytes: 8 * 1024 * 1024 * 1024,
    thermalPressure: 0,
    batteryLevel: 1,
  );

  test('全ジョブを完了し全体進捗が1になる', () async {
    final JobScheduler scheduler = JobScheduler(
      resourceReader: () async => snapshot,
      executor: (ProcessingJob job, void Function(double) report) async {
        report(0.5);
        await Future<void>.delayed(Duration.zero);
        report(1);
      },
    );

    scheduler.enqueueAll(<ProcessingJob>[
      ProcessingJob(
          id: '1', mode: ProcessingMode.milkyWay, sourcePath: '/1.arw'),
      ProcessingJob(
          id: '2', mode: ProcessingMode.milkyWay, sourcePath: '/2.arw'),
    ]);
    await scheduler.waitUntilIdle();

    expect(
        scheduler.jobs.every(
            (ProcessingJob job) => job.state == ProcessingJobState.completed),
        isTrue);
    expect(
        scheduler.jobs.every((ProcessingJob job) => job.progress == 1), isTrue);
    await scheduler.dispose();
  });

  test('待機中と実行中のジョブをキャンセルできる', () async {
    final Completer<void> blocker = Completer<void>();
    final JobScheduler scheduler = JobScheduler(
      resourceReader: () async => const ResourceSnapshot(
        logicalProcessors: 1,
        availableMemoryBytes: 8 * 1024 * 1024 * 1024,
        thermalPressure: 0,
        batteryLevel: 1,
      ),
      executor: (ProcessingJob job, void Function(double) report) async {
        while (!job.cancellationRequested && !blocker.isCompleted) {
          await Future<void>.delayed(const Duration(milliseconds: 1));
        }
      },
    );

    scheduler.enqueueAll(<ProcessingJob>[
      ProcessingJob(
          id: '1', mode: ProcessingMode.starTrail, sourcePath: '/1.nef'),
      ProcessingJob(
          id: '2', mode: ProcessingMode.starTrail, sourcePath: '/2.nef'),
    ]);
    await Future<void>.delayed(const Duration(milliseconds: 5));
    scheduler.cancelAll();
    blocker.complete();
    await scheduler.waitUntilIdle();

    expect(
        scheduler.jobs.every(
            (ProcessingJob job) => job.state == ProcessingJobState.cancelled),
        isTrue);
    await scheduler.dispose();
  });

  test('Executor例外を失敗状態として保持する', () async {
    final JobScheduler scheduler = JobScheduler(
      resourceReader: () async => snapshot,
      executor: (ProcessingJob job, void Function(double) report) async {
        throw StateError('decode failed');
      },
    );
    scheduler.enqueue(
      ProcessingJob(
          id: '1', mode: ProcessingMode.meteor, sourcePath: '/bad.cr3'),
    );
    await scheduler.waitUntilIdle();

    expect(scheduler.jobs.single.state, ProcessingJobState.failed);
    expect(scheduler.jobs.single.error, isA<StateError>());
    await scheduler.dispose();
  });

  test('full-frame RAW policy never overlaps retained job buffers', () async {
    int active = 0;
    int maximumActive = 0;
    final JobScheduler scheduler = JobScheduler(
      resourceReader: () async => snapshot,
      policy: fullFrameRawConcurrencyPolicy,
      executor: (ProcessingJob job, void Function(double) report) async {
        active += 1;
        maximumActive = active > maximumActive ? active : maximumActive;
        await Future<void>.delayed(Duration.zero);
        active -= 1;
      },
    );
    scheduler.enqueueAll(<ProcessingJob>[
      ProcessingJob(
        id: 'raw-1',
        mode: ProcessingMode.meteor,
        sourcePath: '/1.arw',
      ),
      ProcessingJob(
        id: 'raw-2',
        mode: ProcessingMode.meteor,
        sourcePath: '/2.arw',
      ),
      ProcessingJob(
        id: 'raw-3',
        mode: ProcessingMode.meteor,
        sourcePath: '/3.arw',
      ),
    ]);
    await scheduler.waitUntilIdle();

    expect(maximumActive, 1);
    expect(
      scheduler.jobs.every(
        (ProcessingJob job) => job.state == ProcessingJobState.completed,
      ),
      isTrue,
    );
    await scheduler.dispose();
  });
  test('最終ジョブ開始時に完了snapshotを先行通知しない', () async {
    int executorActive = 0;
    final List<JobSchedulerSnapshot> seen = <JobSchedulerSnapshot>[];
    final JobScheduler scheduler = JobScheduler(
      resourceReader: () async => const ResourceSnapshot(
        logicalProcessors: 1,
        availableMemoryBytes: 8 * 1024 * 1024 * 1024,
        thermalPressure: 0,
        batteryLevel: 1,
      ),
      policy: fullFrameRawConcurrencyPolicy,
      executor: (ProcessingJob job, void Function(double) report) async {
        executorActive += 1;
        // Reproduce production executors that synchronously emit progress
        // before their first asynchronous boundary.
        report(0.1);
        await Future<void>.delayed(Duration.zero);
        report(1);
        executorActive -= 1;
      },
    );

    final StreamSubscription<JobSchedulerSnapshot> subscription =
        scheduler.snapshots.listen((JobSchedulerSnapshot value) {
      seen.add(value);
      expect(
        value.isFinished && executorActive > 0,
        isFalse,
        reason: 'A running RAW job must never be reported as scheduler idle.',
      );
    });

    scheduler.enqueueAll(<ProcessingJob>[
      ProcessingJob(
        id: 'raw-1',
        mode: ProcessingMode.milkyWay,
        sourcePath: '/1.arw',
      ),
      ProcessingJob(
        id: 'raw-2',
        mode: ProcessingMode.milkyWay,
        sourcePath: '/2.arw',
      ),
      ProcessingJob(
        id: 'raw-3',
        mode: ProcessingMode.milkyWay,
        sourcePath: '/3.arw',
      ),
    ]);

    await scheduler.waitUntilIdle();
    expect(seen.where((JobSchedulerSnapshot value) => value.isFinished),
        isNotEmpty);
    expect(scheduler.jobs.last.state, ProcessingJobState.completed);

    await subscription.cancel();
    await scheduler.dispose();
  });

  test('jobTimeoutが未設定なら長時間実行のジョブを待ち続ける（挙動不変）', () async {
    final Completer<void> release = Completer<void>();
    final JobScheduler scheduler = JobScheduler(
      resourceReader: () async => snapshot,
      executor: (ProcessingJob job, void Function(double) report) async {
        await release.future;
      },
    );
    scheduler.enqueue(
      ProcessingJob(
          id: '1', mode: ProcessingMode.milkyWay, sourcePath: '/1.arw'),
    );
    await Future<void>.delayed(const Duration(milliseconds: 5));
    expect(scheduler.jobs.single.state, ProcessingJobState.running);
    release.complete();
    await scheduler.waitUntilIdle();
    expect(scheduler.jobs.single.state, ProcessingJobState.completed);
    await scheduler.dispose();
  });

  test('jobTimeoutを超えたジョブは失敗としてisFinishedへ抜ける', () async {
    final JobScheduler scheduler = JobScheduler(
      resourceReader: () async => snapshot,
      jobTimeout: const Duration(milliseconds: 20),
      executor: (ProcessingJob job, void Function(double) report) async {
        report(0.99);
        // Simulate a stalled native call that never returns on its own.
        await Completer<void>().future;
      },
    );
    scheduler.enqueue(
      ProcessingJob(
          id: 'stuck', mode: ProcessingMode.milkyWay, sourcePath: '/1.arw'),
    );
    await scheduler.waitUntilIdle();

    final ProcessingJob job = scheduler.jobs.single;
    expect(job.state, ProcessingJobState.failed);
    expect(job.error, isA<TimeoutException>());
    // A timeout must not be reported as a user cancellation: the failure
    // screen keys off `error`, not `cancellationRequested`, to show the
    // real reason instead of a silent "キャンセルしました".
    await scheduler.dispose();
  });

  test('タイムアウト後に停止未確認のexecutorと後続ジョブを並行実行しない', () async {
    final List<String> started = <String>[];
    final JobScheduler scheduler = JobScheduler(
      resourceReader: () async => snapshot,
      policy: const ConcurrencyPolicy(maximumWorkers: 1),
      jobTimeout: const Duration(milliseconds: 20),
      executor: (ProcessingJob job, void Function(double) report) async {
        started.add(job.id);
        if (job.id == 'stuck') await Completer<void>().future;
      },
    );
    scheduler.enqueueAll(<ProcessingJob>[
      ProcessingJob(
        id: 'stuck',
        mode: ProcessingMode.milkyWay,
        sourcePath: '/stuck.arw',
      ),
      ProcessingJob(
        id: 'next',
        mode: ProcessingMode.milkyWay,
        sourcePath: '/next.arw',
      ),
    ]);

    await scheduler.waitUntilIdle();

    expect(started, <String>['stuck']);
    expect(scheduler.jobs.first.state, ProcessingJobState.failed);
    expect(scheduler.jobs.last.state, ProcessingJobState.failed);
    expect(scheduler.jobs.last.error, isA<StateError>());
    await scheduler.dispose();
  });

  test('資源情報の取得失敗はキューを永久停止させない', () async {
    int reads = 0;
    final JobScheduler scheduler = JobScheduler(
      resourceReader: () async {
        reads++;
        throw StateError('resource channel unavailable');
      },
      executor: (ProcessingJob job, void Function(double) report) async {},
    );
    scheduler.enqueue(
      ProcessingJob(
        id: 'resource-failure',
        mode: ProcessingMode.milkyWay,
        sourcePath: '/1.arw',
      ),
    );
    await scheduler.waitUntilIdle();
    expect(reads, 1);
    expect(scheduler.jobs.single.state, ProcessingJobState.failed);
    expect(scheduler.jobs.single.error, isA<StateError>());
    await scheduler.dispose();
  });

  test('総時間がtimeoutを超えても進捗が続けば完了する', () async {
    final JobScheduler scheduler = JobScheduler(
      resourceReader: () async => snapshot,
      jobTimeout: const Duration(milliseconds: 25),
      executor: (ProcessingJob job, void Function(double) report) async {
        for (int step = 1; step <= 5; step++) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
          report(step / 5);
        }
      },
    );
    scheduler.enqueue(
      ProcessingJob(
          id: 'slow-progress',
          mode: ProcessingMode.milkyWay,
          sourcePath: '/slow.arw'),
    );
    await scheduler.waitUntilIdle();
    expect(scheduler.jobs.single.state, ProcessingJobState.completed);
    await scheduler.dispose();
  });
}
