import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CorpusValidationError,
  compareProbeResult,
  resolveSamplePath,
  runNativeProbe,
  sha256File,
  validateManifest,
  verifyCorpus,
} from '../verify_dng_corpus.mjs';

function expectedMetadata() {
  return {
    width: 6000,
    height: 4000,
    cfa: 'RGGB',
    activeArea: {
      left: 8,
      top: 8,
      width: 5984,
      height: 3984,
    },
    orientation: 1,
    blackLevels: [64, 64, 64, 64],
    whiteLevel: 16383,
    cameraWhiteBalance: [2, 1, 1, 1.5],
  };
}

function sample({
  id = 'camera-model-001',
  file = 'files/sample.dng',
  sha256 = 'a'.repeat(64),
  byteLength = 8,
} = {}) {
  return {
    id,
    file,
    sha256,
    byteLength,
    floatTolerance: 0.0001,
    provenance: {
      source: 'user-captured',
      license: 'private verification only',
      redistributable: false,
    },
    reference: {
      tool: 'reference-tool',
      version: '1.0',
      command: 'reference-tool sample.dng',
      recordedAt: '2026-07-29T00:00:00Z',
    },
    expected: expectedMetadata(),
  };
}

function manifest(sampleValue = sample()) {
  return {
    schemaVersion: 1,
    corpusId: 'mobile-stack-private-dng',
    samples: Array.isArray(sampleValue) ? sampleValue : [sampleValue],
  };
}

function probeResult() {
  return {
    schemaVersion: 1,
    status: 'ok',
    byteLength: 8,
    ...expectedMetadata(),
  };
}

test('accepts a complete provenance and reference contract', () => {
  assert.equal(validateManifest(manifest()).samples.length, 1);
});

test('rejects duplicate sample identifiers', () => {
  const duplicate = manifest();
  duplicate.samples.push(sample({file: 'files/second.dng'}));
  assert.throws(
      () => validateManifest(duplicate),
      CorpusValidationError);
});

test('rejects lexical path traversal', () => {
  assert.throws(
      () => resolveSamplePath('/corpus/manifest.json', '../sample.dng'),
      CorpusValidationError);
});

test('compares floats with the declared tolerance', () => {
  const actual = probeResult();
  actual.cameraWhiteBalance[3] += 0.00005;
  assert.deepEqual(compareProbeResult(sample(), actual), []);
  actual.width = 5999;
  assert.match(compareProbeResult(sample(), actual)[0], /width/);
});

test('hashes a file as a stream', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mobile-stack-hash-'));
  const file = path.join(directory, 'sample.dng');
  try {
    await writeFile(file, Buffer.from('12345678'));
    const expected = createHash('sha256')
        .update(Buffer.from('12345678'))
        .digest('hex');
    assert.equal(await sha256File(file), expected);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('terminates a native probe after its configured timeout', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-timeout-'));
  const scriptPath = path.join(directory, 'hang.mjs');
  try {
    await writeFile(scriptPath, 'setInterval(() => {}, 1000);\n');
    const startedAt = Date.now();
    await assert.rejects(
        runNativeProbe(
            process.execPath,
            scriptPath,
            {timeoutMilliseconds: 500}),
        /timed out after 500 ms/);
    assert.ok(Date.now() - startedAt < 5000);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('terminates a native probe when the caller aborts', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-abort-probe-'));
  const scriptPath = path.join(directory, 'hang.mjs');
  const abortController = new AbortController();
  try {
    await writeFile(scriptPath, 'setInterval(() => {}, 1000);\n');
    const startedAt = Date.now();
    const probePromise = runNativeProbe(
        process.execPath,
        scriptPath,
        {
          timeoutMilliseconds: 5000,
          signal: abortController.signal,
        });
    setTimeout(
        () => abortController.abort(
            new Error('test requested cancellation')),
        100);
    await assert.rejects(
        probePromise,
        /test requested cancellation/);
    assert.ok(Date.now() - startedAt < 5000);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('verifies size, hash, and probe metadata end to end', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-corpus-'));
  const filesDirectory = path.join(directory, 'files');
  const file = path.join(filesDirectory, 'sample.dng');
  const manifestPath = path.join(directory, 'manifest.json');
  const bytes = Buffer.from('12345678');
  const digest = createHash('sha256').update(bytes).digest('hex');
  try {
    await mkdir(filesDirectory);
    await writeFile(file, bytes);
    await writeFile(
        manifestPath,
        JSON.stringify(manifest(sample({sha256: digest}))));

    const messages = [];
    const result = await verifyCorpus({
      manifestPath,
      probePath: '/unused/mock-probe',
      probeRunner: async (_probePath, samplePath) => {
        assert.equal(samplePath, file);
        return probeResult();
      },
      log: (message) => messages.push(message),
    });

    assert.deepEqual(result, {
      passed: 1,
      total: 1,
      probeRuns: 1,
      reportPath: null,
    });
    assert.deepEqual(messages, [
      'PASS camera-model-001 run 1/1',
      'Verified 1 DNG samples across 1 probe runs.',
    ]);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('bounds parallel probes and reports completion in stable order', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-parallel-'));
  const filesDirectory = path.join(directory, 'files');
  const manifestPath = path.join(directory, 'manifest.json');
  const bytes = Buffer.from('12345678');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const samples = [
    sample({
      id: 'camera-a',
      file: 'files/a.dng',
      sha256: digest,
    }),
    sample({
      id: 'camera-b',
      file: 'files/b.dng',
      sha256: digest,
    }),
  ];
  try {
    await mkdir(filesDirectory);
    await Promise.all([
      writeFile(path.join(filesDirectory, 'a.dng'), bytes),
      writeFile(path.join(filesDirectory, 'b.dng'), bytes),
    ]);
    await writeFile(manifestPath, JSON.stringify(manifest(samples)));

    let active = 0;
    let maximumActive = 0;
    const messages = [];
    const result = await verifyCorpus({
      manifestPath,
      probePath: '/unused/mock-probe',
      jobs: 2,
      repeat: 2,
      probeRunner: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return probeResult();
      },
      log: (message) => messages.push(message),
    });

    assert.equal(maximumActive, 2);
    assert.equal(result.probeRuns, 4);
    assert.deepEqual(messages, [
      'PASS camera-a run 1/2',
      'PASS camera-a run 2/2',
      'PASS camera-b run 1/2',
      'PASS camera-b run 2/2',
      'Verified 2 DNG samples across 4 probe runs.',
    ]);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('writes a complete report once and refuses replacement', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-report-'));
  const filesDirectory = path.join(directory, 'files');
  const file = path.join(filesDirectory, 'sample.dng');
  const manifestPath = path.join(directory, 'manifest.json');
  const reportPath = path.join(directory, 'report.json');
  const bytes = Buffer.from('12345678');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const fixedDate = new Date('2026-07-29T12:34:56Z');
  try {
    await mkdir(filesDirectory);
    await writeFile(file, bytes);
    await writeFile(
        manifestPath,
        JSON.stringify(manifest(sample({sha256: digest}))));

    const options = {
      manifestPath,
      probePath: '/unused/mock-probe',
      repeat: 2,
      timeoutMilliseconds: 1234,
      reportPath,
      now: () => fixedDate,
      probeRunner: async () => probeResult(),
      log: () => {},
    };
    const result = await verifyCorpus(options);
    const reportText = await readFile(reportPath, 'utf8');
    const report = JSON.parse(reportText);

    assert.equal(result.reportPath, reportPath);
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.verifierVersion, 2);
    assert.equal(report.status, 'passed');
    assert.equal(report.completedAt, fixedDate.toISOString());
    assert.deepEqual(report.options, {
      jobs: 1,
      repeat: 2,
      timeoutMilliseconds: 1234,
    });
    assert.equal(report.samples[0].runs.length, 2);
    await assert.rejects(
        verifyCorpus(options),
        (error) => error?.code === 'EEXIST');
    assert.equal(await readFile(reportPath, 'utf8'), reportText);
    assert.deepEqual(
        (await readdir(directory))
            .filter((name) => name.startsWith('.report.json.')),
        []);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('cancels active probes after the first mismatch', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-cancel-'));
  const filesDirectory = path.join(directory, 'files');
  const manifestPath = path.join(directory, 'manifest.json');
  const reportPath = path.join(directory, 'report.json');
  const bytes = Buffer.from('12345678');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const samples = [
    sample({
      id: 'camera-a',
      file: 'files/a.dng',
      sha256: digest,
    }),
    sample({
      id: 'camera-b',
      file: 'files/b.dng',
      sha256: digest,
    }),
  ];
  let cancelled = false;
  try {
    await mkdir(filesDirectory);
    await Promise.all([
      writeFile(path.join(filesDirectory, 'a.dng'), bytes),
      writeFile(path.join(filesDirectory, 'b.dng'), bytes),
    ]);
    await writeFile(manifestPath, JSON.stringify(manifest(samples)));

    await assert.rejects(
        verifyCorpus({
          manifestPath,
          probePath: '/unused/mock-probe',
          jobs: 2,
          reportPath,
          probeRunner: async (_probePath, samplePath, {signal}) => {
            if (path.basename(samplePath) === 'a.dng') {
              await new Promise((resolve) => setTimeout(resolve, 10));
              return {...probeResult(), width: 1};
            }
            return new Promise((_resolve, reject) => {
              signal.addEventListener(
                  'abort',
                  () => {
                    cancelled = true;
                    reject(new Error('cancelled'));
                  },
                  {once: true});
            });
          },
          log: () => {},
        }),
        (error) => error instanceof CorpusValidationError &&
          /camera-a run 1/.test(error.message));
    assert.equal(cancelled, true);
    await assert.rejects(
        readFile(reportPath),
        (error) => error?.code === 'ENOENT');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('caller cancellation stops verification without a report', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-abort-corpus-'));
  const filesDirectory = path.join(directory, 'files');
  const file = path.join(filesDirectory, 'sample.dng');
  const manifestPath = path.join(directory, 'manifest.json');
  const reportPath = path.join(directory, 'report.json');
  const bytes = Buffer.from('12345678');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const abortController = new AbortController();
  let probeStarted;
  const started = new Promise((resolve) => {
    probeStarted = resolve;
  });
  try {
    await mkdir(filesDirectory);
    await writeFile(file, bytes);
    await writeFile(
        manifestPath,
        JSON.stringify(manifest(sample({sha256: digest}))));

    const verification = verifyCorpus({
      manifestPath,
      probePath: '/unused/mock-probe',
      reportPath,
      signal: abortController.signal,
      probeRunner: async (_probePath, _samplePath, {signal}) => {
        probeStarted();
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
              'abort',
              () => reject(signal.reason),
              {once: true});
        });
      },
      log: () => {},
    });
    await started;
    abortController.abort(new Error('user requested cancellation'));
    await assert.rejects(
        verification,
        /user requested cancellation/);
    await assert.rejects(
        readFile(reportPath),
        (error) => error?.code === 'ENOENT');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('does not create a report when any probe mismatches', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-no-report-'));
  const filesDirectory = path.join(directory, 'files');
  const file = path.join(filesDirectory, 'sample.dng');
  const manifestPath = path.join(directory, 'manifest.json');
  const reportPath = path.join(directory, 'report.json');
  const bytes = Buffer.from('12345678');
  const digest = createHash('sha256').update(bytes).digest('hex');
  try {
    await mkdir(filesDirectory);
    await writeFile(file, bytes);
    await writeFile(
        manifestPath,
        JSON.stringify(manifest(sample({sha256: digest}))));

    await assert.rejects(
        verifyCorpus({
          manifestPath,
          probePath: '/unused/mock-probe',
          reportPath,
          probeRunner: async () => ({
            ...probeResult(),
            width: 1,
          }),
          log: () => {},
        }),
        CorpusValidationError);
    await assert.rejects(
        readFile(reportPath),
        (error) => error?.code === 'ENOENT');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
