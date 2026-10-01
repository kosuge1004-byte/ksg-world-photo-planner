import {createHash, randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {
  link,
  open,
  readFile,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {spawn} from 'node:child_process';

const cfaPatterns = new Set(['RGGB', 'BGGR', 'GRBG', 'GBRG']);
const identifierPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const isoTimestampPattern =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const maximumJobs = 8;
const maximumRepeat = 100;
const maximumProbeOutputBytes = 1024 * 1024;
const defaultProbeTimeoutMilliseconds = 30 * 1000;
const minimumProbeTimeoutMilliseconds = 100;
const maximumProbeTimeoutMilliseconds = 5 * 60 * 1000;

export class CorpusValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorpusValidationError';
  }
}

function fail(location, message) {
  throw new CorpusValidationError(`${location}: ${message}`);
}

function isObject(value) {
  return value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value);
}

function requireObject(value, location) {
  if (!isObject(value)) fail(location, 'must be an object');
  return value;
}

function requireKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(location, `unknown field "${key}"`);
  }
}

function requireString(value, location) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(location, 'must be a non-empty string');
  }
}

function requireInteger(value, minimum, location) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(location, `must be an integer greater than or equal to ${minimum}`);
  }
}

function requireFiniteNumber(value, minimum, location) {
  if (!Number.isFinite(value) || value < minimum) {
    fail(location, `must be a finite number greater than or equal to ${minimum}`);
  }
}

function validateNumberArray(value, length, minimum, location) {
  if (!Array.isArray(value) || value.length !== length) {
    fail(location, `must contain exactly ${length} numbers`);
  }
  value.forEach((item, index) => {
    requireFiniteNumber(item, minimum, `${location}[${index}]`);
  });
}

function validateExpected(expectedValue, location) {
  const expected = requireObject(expectedValue, location);
  requireKeys(
      expected,
      new Set([
        'width',
        'height',
        'cfa',
        'activeArea',
        'orientation',
        'blackLevels',
        'whiteLevel',
        'cameraWhiteBalance',
      ]),
      location);
  requireInteger(expected.width, 1, `${location}.width`);
  requireInteger(expected.height, 1, `${location}.height`);
  if (!cfaPatterns.has(expected.cfa)) {
    fail(`${location}.cfa`, 'must be RGGB, BGGR, GRBG, or GBRG');
  }
  requireInteger(expected.orientation, 1, `${location}.orientation`);
  if (expected.orientation > 8) {
    fail(`${location}.orientation`, 'must not exceed 8');
  }

  const active = requireObject(
      expected.activeArea,
      `${location}.activeArea`);
  requireKeys(
      active,
      new Set(['left', 'top', 'width', 'height']),
      `${location}.activeArea`);
  requireInteger(active.left, 0, `${location}.activeArea.left`);
  requireInteger(active.top, 0, `${location}.activeArea.top`);
  requireInteger(active.width, 1, `${location}.activeArea.width`);
  requireInteger(active.height, 1, `${location}.activeArea.height`);
  if (active.left + active.width > expected.width ||
      active.top + active.height > expected.height) {
    fail(`${location}.activeArea`, 'must fit inside the full image');
  }

  validateNumberArray(
      expected.blackLevels,
      4,
      0,
      `${location}.blackLevels`);
  requireFiniteNumber(expected.whiteLevel, 0, `${location}.whiteLevel`);
  if (expected.whiteLevel <= 0 ||
      expected.blackLevels.some((value) => value >= expected.whiteLevel)) {
    fail(location, 'black levels must be below a positive white level');
  }
  if (expected.cameraWhiteBalance !== null) {
    validateNumberArray(
        expected.cameraWhiteBalance,
        4,
        Number.MIN_VALUE,
        `${location}.cameraWhiteBalance`);
  }
}

function validateSample(sampleValue, index, identifiers) {
  const location = `samples[${index}]`;
  const sample = requireObject(sampleValue, location);
  requireKeys(
      sample,
      new Set([
        'id',
        'file',
        'sha256',
        'byteLength',
        'floatTolerance',
        'provenance',
        'reference',
        'expected',
      ]),
      location);
  requireString(sample.id, `${location}.id`);
  if (!identifierPattern.test(sample.id)) {
    fail(`${location}.id`, 'contains unsupported characters');
  }
  if (identifiers.has(sample.id)) {
    fail(`${location}.id`, 'must be unique');
  }
  identifiers.add(sample.id);

  requireString(sample.file, `${location}.file`);
  if (sample.file.includes('\0')) {
    fail(`${location}.file`, 'must not contain NUL');
  }
  requireString(sample.sha256, `${location}.sha256`);
  if (!sha256Pattern.test(sample.sha256)) {
    fail(`${location}.sha256`, 'must be 64 lowercase hexadecimal characters');
  }
  requireInteger(sample.byteLength, 8, `${location}.byteLength`);
  if (sample.floatTolerance !== undefined) {
    requireFiniteNumber(
        sample.floatTolerance,
        0,
        `${location}.floatTolerance`);
    if (sample.floatTolerance > 1) {
      fail(`${location}.floatTolerance`, 'must not exceed 1');
    }
  }

  const provenance = requireObject(
      sample.provenance,
      `${location}.provenance`);
  requireKeys(
      provenance,
      new Set(['source', 'license', 'redistributable', 'notes']),
      `${location}.provenance`);
  requireString(provenance.source, `${location}.provenance.source`);
  requireString(provenance.license, `${location}.provenance.license`);
  if (typeof provenance.redistributable !== 'boolean') {
    fail(
        `${location}.provenance.redistributable`,
        'must be a boolean');
  }
  if (provenance.notes !== undefined) {
    requireString(provenance.notes, `${location}.provenance.notes`);
  }

  const reference = requireObject(
      sample.reference,
      `${location}.reference`);
  requireKeys(
      reference,
      new Set(['tool', 'version', 'command', 'recordedAt']),
      `${location}.reference`);
  requireString(reference.tool, `${location}.reference.tool`);
  requireString(reference.version, `${location}.reference.version`);
  requireString(reference.command, `${location}.reference.command`);
  requireString(reference.recordedAt, `${location}.reference.recordedAt`);
  if (!isoTimestampPattern.test(reference.recordedAt) ||
      Number.isNaN(Date.parse(reference.recordedAt))) {
    fail(`${location}.reference.recordedAt`, 'must be an ISO-8601 timestamp');
  }

  validateExpected(sample.expected, `${location}.expected`);
}

export function validateManifest(manifestValue) {
  const manifest = requireObject(manifestValue, 'manifest');
  requireKeys(
      manifest,
      new Set(['schemaVersion', 'corpusId', 'samples']),
      'manifest');
  if (manifest.schemaVersion !== 1) {
    fail('manifest.schemaVersion', 'must equal 1');
  }
  requireString(manifest.corpusId, 'manifest.corpusId');
  if (!identifierPattern.test(manifest.corpusId)) {
    fail('manifest.corpusId', 'contains unsupported characters');
  }
  if (!Array.isArray(manifest.samples) || manifest.samples.length === 0) {
    fail('manifest.samples', 'must contain at least one sample');
  }
  const identifiers = new Set();
  manifest.samples.forEach((sample, index) => {
    validateSample(sample, index, identifiers);
  });
  return manifest;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative);
}

export function resolveSamplePath(manifestPath, sampleFile) {
  if (path.isAbsolute(sampleFile)) {
    fail('sample.file', 'must be relative to the manifest');
  }
  const root = path.dirname(path.resolve(manifestPath));
  const candidate = path.resolve(root, sampleFile);
  if (!isInside(root, candidate)) {
    fail('sample.file', 'must remain inside the corpus directory');
  }
  return candidate;
}

function abortReason(signal, fallback = 'Verification cancelled') {
  if (signal?.reason instanceof Error) return signal.reason;
  if (signal?.reason !== undefined) {
    return new Error(String(signal.reason));
  }
  return new Error(fallback);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

export async function sha256File(filePath, {signal} = {}) {
  throwIfAborted(signal);
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(filePath, {signal})) {
      hash.update(chunk);
    }
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw error;
  }
  return hash.digest('hex');
}

function compareExact(mismatches, location, expected, actual) {
  if (actual !== expected) {
    mismatches.push(`${location}: expected ${expected}, received ${actual}`);
  }
}

function compareFloat(
    mismatches,
    location,
    expected,
    actual,
    tolerance) {
  if (!Number.isFinite(actual) ||
      Math.abs(actual - expected) > tolerance) {
    mismatches.push(
        `${location}: expected ${expected} ± ${tolerance}, received ${actual}`);
  }
}

function compareFloatArray(
    mismatches,
    location,
    expected,
    actual,
    tolerance) {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    mismatches.push(`${location}: expected ${expected.length} values`);
    return;
  }
  expected.forEach((value, index) => {
    compareFloat(
        mismatches,
        `${location}[${index}]`,
        value,
        actual[index],
        tolerance);
  });
}

export function compareProbeResult(sample, probe) {
  const mismatches = [];
  if (!isObject(probe)) return ['probe: expected a JSON object'];
  compareExact(mismatches, 'schemaVersion', 1, probe.schemaVersion);
  compareExact(mismatches, 'status', 'ok', probe.status);
  compareExact(mismatches, 'byteLength', sample.byteLength, probe.byteLength);

  const expected = sample.expected;
  const tolerance = sample.floatTolerance ?? 0.0001;
  compareExact(mismatches, 'width', expected.width, probe.width);
  compareExact(mismatches, 'height', expected.height, probe.height);
  compareExact(mismatches, 'cfa', expected.cfa, probe.cfa);
  compareExact(
      mismatches,
      'orientation',
      expected.orientation,
      probe.orientation);

  if (!isObject(probe.activeArea)) {
    mismatches.push('activeArea: expected an object');
  } else {
    for (const field of ['left', 'top', 'width', 'height']) {
      compareExact(
          mismatches,
          `activeArea.${field}`,
          expected.activeArea[field],
          probe.activeArea[field]);
    }
  }
  compareFloatArray(
      mismatches,
      'blackLevels',
      expected.blackLevels,
      probe.blackLevels,
      tolerance);
  compareFloat(
      mismatches,
      'whiteLevel',
      expected.whiteLevel,
      probe.whiteLevel,
      tolerance);
  if (expected.cameraWhiteBalance === null) {
    compareExact(
        mismatches,
        'cameraWhiteBalance',
        null,
        probe.cameraWhiteBalance);
  } else {
    compareFloatArray(
        mismatches,
        'cameraWhiteBalance',
        expected.cameraWhiteBalance,
        probe.cameraWhiteBalance,
        tolerance);
  }
  return mismatches;
}

function normalizedProbeResult(probe) {
  return {
    schemaVersion: probe.schemaVersion,
    status: probe.status,
    byteLength: probe.byteLength,
    width: probe.width,
    height: probe.height,
    cfa: probe.cfa,
    activeArea: {
      left: probe.activeArea.left,
      top: probe.activeArea.top,
      width: probe.activeArea.width,
      height: probe.activeArea.height,
    },
    orientation: probe.orientation,
    blackLevels: [...probe.blackLevels],
    whiteLevel: probe.whiteLevel,
    cameraWhiteBalance: probe.cameraWhiteBalance === null ?
      null :
      [...probe.cameraWhiteBalance],
  };
}

export function runNativeProbe(
    probePath,
    samplePath,
    {
      timeoutMilliseconds = defaultProbeTimeoutMilliseconds,
      signal,
    } = {}) {
  validateTimeoutMilliseconds(
      timeoutMilliseconds,
      'timeoutMilliseconds');
  if (signal?.aborted) {
    return Promise.reject(abortReason(signal, 'Native probe cancelled'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
        probePath,
        [samplePath],
        {
          shell: false,
          windowsHide: true,
        });
    const stdoutChunks = [];
    const stderrChunks = [];
    let outputBytes = 0;
    let terminalError = null;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
    };
    const terminate = (error) => {
      if (terminalError !== null || settled) return;
      terminalError = error;
      child.kill();
    };
    const cancel = () => {
      terminate(abortReason(signal, 'Native probe cancelled'));
    };
    const timeout = setTimeout(
        () => terminate(new Error(
            `Native probe timed out after ${timeoutMilliseconds} ms`)),
        timeoutMilliseconds);
    signal?.addEventListener('abort', cancel, {once: true});

    const collect = (chunks, chunk) => {
      if (terminalError !== null) return;
      outputBytes += chunk.length;
      if (outputBytes > maximumProbeOutputBytes) {
        terminate(new Error(
            `Native probe output exceeds ${maximumProbeOutputBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', (chunk) => collect(stdoutChunks, chunk));
    child.stderr.on('data', (chunk) => collect(stderrChunks, chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(terminalError ?? error);
    });
    child.on('close', (code, terminationSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminalError !== null) {
        reject(terminalError);
        return;
      }
      const output = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const errorOutput =
          Buffer.concat(stderrChunks).toString('utf8').trim();
      let probe;
      try {
        probe = JSON.parse(output);
      } catch {
        reject(new Error(
            `Native probe returned invalid JSON: ${output || '<empty>'}`));
        return;
      }
      if (code !== 0) {
        const detail = probe.message || errorOutput || 'unknown error';
        reject(new Error(
            `Native probe failed with exit ` +
            `${code ?? terminationSignal}: ${detail}`));
        return;
      }
      resolve(probe);
    });
  });
}

async function mapConcurrent(items, jobs, mapper, onFirstError = () => {}) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let firstError = null;

  async function worker() {
    while (firstError === null) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        if (firstError === null) {
          firstError = error;
          onFirstError(error);
        }
      }
    }
  }

  const workerCount = Math.min(jobs, Math.max(items.length, 1));
  await Promise.all(
      Array.from({length: workerCount}, () => worker()));
  if (firstError !== null) throw firstError;
  return results;
}

function validateExecutionCount(value, maximum, location) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(location, `must be an integer from 1 through ${maximum}`);
  }
}

function validateTimeoutMilliseconds(value, location) {
  if (!Number.isSafeInteger(value) ||
      value < minimumProbeTimeoutMilliseconds ||
      value > maximumProbeTimeoutMilliseconds) {
    fail(
        location,
        `must be an integer from ${minimumProbeTimeoutMilliseconds} ` +
        `through ${maximumProbeTimeoutMilliseconds}`);
  }
}

export async function writeJsonAtomic(
    outputPath,
    value,
    {signal} = {}) {
  throwIfAborted(signal);
  const absoluteOutputPath = path.resolve(outputPath);
  const temporaryPath = path.join(
      path.dirname(absoluteOutputPath),
      `.${path.basename(absoluteOutputPath)}.${process.pid}.` +
      `${randomBytes(8).toString('hex')}.tmp`);
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  let handle = null;
  let temporaryCreated = false;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    temporaryCreated = true;
    await handle.writeFile(contents, {encoding: 'utf8'});
    await handle.sync();
    await handle.close();
    handle = null;
    throwIfAborted(signal);
    await link(temporaryPath, absoluteOutputPath);
  } finally {
    if (handle !== null) await handle.close().catch(() => {});
    if (temporaryCreated) await unlink(temporaryPath).catch(() => {});
  }
  return absoluteOutputPath;
}

export async function writeReportAtomic(
    reportPath,
    report,
    options = {}) {
  return writeJsonAtomic(reportPath, report, options);
}

export async function verifyCorpus({
  manifestPath,
  probePath,
  probeRunner = runNativeProbe,
  jobs = 1,
  repeat = 1,
  timeoutMilliseconds = defaultProbeTimeoutMilliseconds,
  reportPath = null,
  signal,
  now = () => new Date(),
  log = console.log,
}) {
  validateExecutionCount(jobs, maximumJobs, 'jobs');
  validateExecutionCount(repeat, maximumRepeat, 'repeat');
  validateTimeoutMilliseconds(
      timeoutMilliseconds,
      'timeoutMilliseconds');
  throwIfAborted(signal);
  const absoluteManifestPath = path.resolve(manifestPath);
  const manifestBytes = await readFile(absoluteManifestPath);
  throwIfAborted(signal);
  const manifest = validateManifest(
      JSON.parse(manifestBytes.toString('utf8')));
  const manifestSha256 = createHash('sha256')
      .update(manifestBytes)
      .digest('hex');
  const corpusRoot = await realpath(path.dirname(absoluteManifestPath));
  const verifiedSamples = [];

  for (const sample of manifest.samples) {
    throwIfAborted(signal);
    const lexicalPath = resolveSamplePath(absoluteManifestPath, sample.file);
    const samplePath = await realpath(lexicalPath);
    if (!isInside(corpusRoot, samplePath)) {
      fail(`samples.${sample.id}.file`, 'symlink escapes the corpus directory');
    }
    const details = await stat(samplePath);
    if (!details.isFile()) {
      fail(`samples.${sample.id}.file`, 'must resolve to a regular file');
    }
    if (details.size !== sample.byteLength) {
      fail(
          `samples.${sample.id}.byteLength`,
          `expected ${sample.byteLength}, received ${details.size}`);
    }
    const digest = await sha256File(samplePath, {signal});
    if (digest !== sample.sha256) {
      fail(
          `samples.${sample.id}.sha256`,
          `expected ${sample.sha256}, received ${digest}`);
    }
    verifiedSamples.push({sample, samplePath});
  }

  const tasks = [];
  verifiedSamples.forEach((verified, sampleIndex) => {
    for (let repeatIndex = 0; repeatIndex < repeat; repeatIndex += 1) {
      tasks.push({...verified, sampleIndex, repeatIndex});
    }
  });
  const probeAbortController = new AbortController();
  const cancelActiveProbes = () => {
    if (!probeAbortController.signal.aborted) {
      probeAbortController.abort(abortReason(signal));
    }
  };
  signal?.addEventListener('abort', cancelActiveProbes, {once: true});
  let runResults;
  try {
    throwIfAborted(signal);
    runResults = await mapConcurrent(
        tasks,
        jobs,
        async (task) => {
          throwIfAborted(probeAbortController.signal);
          const probe = await probeRunner(
              probePath,
              task.samplePath,
              {
                timeoutMilliseconds,
                signal: probeAbortController.signal,
              });
          const mismatches = compareProbeResult(task.sample, probe);
          if (mismatches.length > 0) {
            throw new CorpusValidationError(
                `${task.sample.id} run ${task.repeatIndex + 1}:\n  ` +
                mismatches.join('\n  '));
          }
          return {
            sampleIndex: task.sampleIndex,
            repeatIndex: task.repeatIndex,
            probe: normalizedProbeResult(probe),
          };
        },
        () => probeAbortController.abort(
            new Error(
                'Native probes cancelled after another run failed')));
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancelActiveProbes);
  }

  throwIfAborted(signal);
  const completedAt = now();
  if (!(completedAt instanceof Date) ||
      Number.isNaN(completedAt.valueOf())) {
    fail('now', 'must return a valid Date');
  }
  const report = {
    schemaVersion: 2,
    reportType: 'mobile-stack-dng-corpus-verification',
    verifierVersion: 2,
    status: 'passed',
    corpusId: manifest.corpusId,
    manifestSha256,
    completedAt: completedAt.toISOString(),
    options: {jobs, repeat, timeoutMilliseconds},
    samples: manifest.samples.map((sample, sampleIndex) => ({
      id: sample.id,
      file: sample.file,
      sha256: sample.sha256,
      byteLength: sample.byteLength,
      floatTolerance: sample.floatTolerance ?? 0.0001,
      provenance: sample.provenance,
      reference: sample.reference,
      expected: sample.expected,
      runs: runResults
          .filter((run) => run.sampleIndex === sampleIndex)
          .map((run) => run.probe),
    })),
  };

  const absoluteReportPath = reportPath === null ?
    null :
    await writeReportAtomic(reportPath, report, {signal});
  tasks.forEach((task) => {
    log(
        `PASS ${task.sample.id} ` +
        `run ${task.repeatIndex + 1}/${repeat}`);
  });
  log(
      `Verified ${manifest.samples.length} DNG samples ` +
      `across ${tasks.length} probe runs.`);
  if (absoluteReportPath !== null) {
    log(`Report ${absoluteReportPath}`);
  }
  return {
    passed: manifest.samples.length,
    total: manifest.samples.length,
    probeRuns: tasks.length,
    reportPath: absoluteReportPath,
  };
}

function parseArguments(argumentsList) {
  const options = {};
  const allowed = new Set([
    '--manifest',
    '--probe',
    '--jobs',
    '--repeat',
    '--timeout-ms',
    '--report',
  ]);
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--help') return {help: true};
    if (!allowed.has(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argumentsList[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${argument}`);
    const key = argument === '--timeout-ms' ?
      'timeoutMilliseconds' :
      argument.slice(2);
    if (Object.hasOwn(options, key)) {
      throw new Error(`Duplicate argument: ${argument}`);
    }
    options[key] = value;
    index += 1;
  }
  if (!options.manifest || !options.probe) {
    throw new Error('--manifest and --probe are required');
  }
  options.jobs = options.jobs === undefined ? 1 : Number(options.jobs);
  options.repeat = options.repeat === undefined ? 1 : Number(options.repeat);
  options.timeoutMilliseconds = options.timeoutMilliseconds === undefined ?
    defaultProbeTimeoutMilliseconds :
    Number(options.timeoutMilliseconds);
  validateExecutionCount(options.jobs, maximumJobs, '--jobs');
  validateExecutionCount(options.repeat, maximumRepeat, '--repeat');
  validateTimeoutMilliseconds(
      options.timeoutMilliseconds,
      '--timeout-ms');
  options.report ??= null;
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(
        'usage: node verify_dng_corpus.mjs ' +
        '--manifest <manifest.json> --probe <mobile_stack_dng_probe_cli> ' +
        '[--jobs 1-8] [--repeat 1-100] [--timeout-ms 100-300000] ' +
        '[--report <report.json>]');
    return;
  }
  const abortController = new AbortController();
  let interruptionExitCode = null;
  const interrupt = (name, exitCode) => {
    interruptionExitCode ??= exitCode;
    abortController.abort(
        new Error(`Verification interrupted by ${name}`));
  };
  const interruptWithSigint = () => interrupt('SIGINT', 130);
  const interruptWithSigterm = () => interrupt('SIGTERM', 143);
  process.once('SIGINT', interruptWithSigint);
  process.once('SIGTERM', interruptWithSigterm);
  try {
    await verifyCorpus({
      manifestPath: options.manifest,
      probePath: options.probe,
      jobs: options.jobs,
      repeat: options.repeat,
      timeoutMilliseconds: options.timeoutMilliseconds,
      reportPath: options.report,
      signal: abortController.signal,
    });
  } catch (error) {
    if (interruptionExitCode !== null) {
      process.exitCode = interruptionExitCode;
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', interruptWithSigint);
    process.removeListener('SIGTERM', interruptWithSigterm);
  }
}

if (process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode ??= 1;
  });
}
