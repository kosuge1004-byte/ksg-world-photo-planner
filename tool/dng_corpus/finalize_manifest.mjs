import {createHash} from 'node:crypto';
import {
  lstat,
  readFile,
  realpath,
} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {TextDecoder} from 'node:util';
import path from 'node:path';

import {
  InventoryValidationError,
  validateInventory,
} from './inventory_dng_corpus.mjs';
import {
  CorpusValidationError,
  sha256File,
  validateManifest,
  writeJsonAtomic,
} from './verify_dng_corpus.mjs';

const maximumAuthoringFileBytes = 10 * 1024 * 1024;
const identifierPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const isoTimestampPattern =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const strictUtf8Decoder = new TextDecoder('utf-8', {fatal: true});

export class ManifestFinalizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestFinalizationError';
  }
}

function abortReason(signal, fallback = 'Manifest finalization cancelled') {
  if (signal?.reason instanceof Error) return signal.reason;
  if (signal?.reason !== undefined) {
    return new Error(String(signal.reason));
  }
  return new Error(fallback);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function requireObject(value, location) {
  if (value === null ||
      typeof value !== 'object' ||
      Array.isArray(value)) {
    throw new ManifestFinalizationError(
        `${location}: must be an object`);
  }
  return value;
}

function requireKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ManifestFinalizationError(
          `${location}: unknown field "${key}"`);
    }
  }
}

function sameFileState(before, after) {
  return before.isFile() &&
      after.isFile() &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs &&
      before.dev === after.dev &&
      before.ino === after.ino;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative);
}

async function readStableAuthoringFile(
    filePath,
    location,
    signal) {
  throwIfAborted(signal);
  const absolutePath = path.resolve(filePath);
  const before = await lstat(absolutePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new ManifestFinalizationError(
        `${location}: must be a regular file, not a symbolic link`);
  }
  if (!Number.isSafeInteger(before.size) ||
      before.size > maximumAuthoringFileBytes) {
    throw new ManifestFinalizationError(
        `${location}: must not exceed ` +
        `${maximumAuthoringFileBytes} bytes`);
  }
  let bytes;
  try {
    bytes = await readFile(absolutePath, {signal});
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw error;
  }
  const after = await lstat(absolutePath);
  if (!sameFileState(before, after)) {
    throw new ManifestFinalizationError(
        `${location}: changed while it was being read`);
  }
  return bytes;
}

function parseJson(bytes, location) {
  let text;
  try {
    text = strictUtf8Decoder.decode(bytes);
  } catch {
    throw new ManifestFinalizationError(
        `${location}: must contain valid UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ManifestFinalizationError(
        `${location}: must contain valid JSON`);
  }
}

function validateDraft(draftValue) {
  const draft = requireObject(draftValue, 'draft');
  requireKeys(
      draft,
      new Set([
        'schemaVersion',
        'draftType',
        'draftVersion',
        'status',
        'corpusId',
        'inventorySha256',
        'generatedAt',
        'samples',
      ]),
      'draft');
  if (draft.schemaVersion !== 1 ||
      draft.draftType !==
        'mobile-stack-dng-corpus-manifest-draft' ||
      draft.draftVersion !== 1 ||
      draft.status !== 'incomplete') {
    throw new ManifestFinalizationError(
        'draft: unsupported draft contract');
  }
  if (typeof draft.corpusId !== 'string' ||
      !identifierPattern.test(draft.corpusId)) {
    throw new ManifestFinalizationError(
        'draft.corpusId: invalid identifier');
  }
  if (typeof draft.inventorySha256 !== 'string' ||
      !sha256Pattern.test(draft.inventorySha256)) {
    throw new ManifestFinalizationError(
        'draft.inventorySha256: invalid SHA-256');
  }
  if (typeof draft.generatedAt !== 'string' ||
      !isoTimestampPattern.test(draft.generatedAt) ||
      Number.isNaN(Date.parse(draft.generatedAt))) {
    throw new ManifestFinalizationError(
        'draft.generatedAt: invalid ISO-8601 timestamp');
  }
  if (!Array.isArray(draft.samples) ||
      draft.samples.length === 0 ||
      draft.samples.length > 10000) {
    throw new ManifestFinalizationError(
        'draft.samples: must contain 1 through 10000 samples');
  }

  const manifest = {
    schemaVersion: 1,
    corpusId: draft.corpusId,
    samples: draft.samples,
  };
  try {
    validateManifest(manifest);
  } catch (error) {
    if (error instanceof CorpusValidationError) {
      throw new ManifestFinalizationError(
          `draft is incomplete or invalid: ${error.message}`);
    }
    throw error;
  }
  return {draft, manifest};
}

function validateInventoryLink(draft, inventory, inventoryBytes) {
  const inventorySha256 = createHash('sha256')
      .update(inventoryBytes)
      .digest('hex');
  if (draft.inventorySha256 !== inventorySha256) {
    throw new ManifestFinalizationError(
        'draft.inventorySha256 does not match the exact inventory bytes');
  }
  if (draft.samples.length !== inventory.samples.length) {
    throw new ManifestFinalizationError(
        'draft samples do not match the inventory length');
  }
  draft.samples.forEach((sample, index) => {
    const inventorySample = inventory.samples[index];
    const location = `draft.samples[${index}]`;
    if (sample.id !== inventorySample.idSuggestion ||
        sample.file !== inventorySample.file ||
        sample.sha256 !== inventorySample.sha256 ||
        sample.byteLength !== inventorySample.byteLength) {
      throw new ManifestFinalizationError(
          `${location}: mechanical fields differ from the inventory`);
    }
  });
}

async function resolveRegularSample(root, sample, signal) {
  throwIfAborted(signal);
  const segments = sample.file.split('/');
  let candidate = root;
  let details = null;
  for (let index = 0; index < segments.length; index += 1) {
    candidate = path.join(candidate, segments[index]);
    details = await lstat(candidate);
    if (details.isSymbolicLink()) {
      throw new ManifestFinalizationError(
          `${sample.id}: symbolic links are not allowed in the DNG path`);
    }
    if (index < segments.length - 1 && !details.isDirectory()) {
      throw new ManifestFinalizationError(
          `${sample.id}: a parent DNG path component is not a directory`);
    }
  }
  if (details === null || !details.isFile()) {
    throw new ManifestFinalizationError(
        `${sample.id}: DNG path must resolve to a regular file`);
  }
  const resolvedPath = await realpath(candidate);
  if (!isInside(root, resolvedPath)) {
    throw new ManifestFinalizationError(
        `${sample.id}: DNG path resolves outside the corpus directory`);
  }
  return {candidate, details, resolvedPath};
}

async function verifyDngFiles(directoryPath, samples, signal) {
  throwIfAborted(signal);
  const lexicalRoot = path.resolve(directoryPath);
  const lexicalRootDetails = await lstat(lexicalRoot);
  if (!lexicalRootDetails.isDirectory() ||
      lexicalRootDetails.isSymbolicLink()) {
    throw new ManifestFinalizationError(
        'directoryPath must be a regular directory, not a symbolic link');
  }
  const root = await realpath(lexicalRoot);
  for (const sample of samples) {
    const {
      candidate,
      details: before,
      resolvedPath,
    } = await resolveRegularSample(root, sample, signal);
    if (before.size !== sample.byteLength) {
      throw new ManifestFinalizationError(
          `${sample.id}: expected ${sample.byteLength} bytes, ` +
          `received ${before.size}`);
    }
    const digest = await sha256File(resolvedPath, {signal});
    const after = await lstat(candidate);
    const resolvedAfter = await realpath(candidate);
    if (!sameFileState(before, after) ||
        resolvedAfter !== resolvedPath) {
      throw new ManifestFinalizationError(
          `${sample.id}: DNG file changed while it was being hashed`);
    }
    if (digest !== sample.sha256) {
      throw new ManifestFinalizationError(
          `${sample.id}: SHA-256 differs from the reviewed inventory`);
    }
  }
}

export async function finalizeManifest({
  draftPath,
  inventoryPath,
  directoryPath,
  outputPath,
  signal,
  log = console.log,
}) {
  throwIfAborted(signal);
  const [draftBytes, inventoryBytes] = await Promise.all([
    readStableAuthoringFile(draftPath, 'draftPath', signal),
    readStableAuthoringFile(inventoryPath, 'inventoryPath', signal),
  ]);
  throwIfAborted(signal);
  const {draft, manifest} = validateDraft(
      parseJson(draftBytes, 'draftPath'));
  let inventory;
  try {
    inventory = validateInventory(
        parseJson(inventoryBytes, 'inventoryPath'));
  } catch (error) {
    if (error instanceof InventoryValidationError) {
      throw new ManifestFinalizationError(error.message);
    }
    throw error;
  }
  validateInventoryLink(draft, inventory, inventoryBytes);
  await verifyDngFiles(
      directoryPath,
      manifest.samples,
      signal);
  throwIfAborted(signal);
  const absoluteOutputPath = await writeJsonAtomic(
      outputPath,
      manifest,
      {signal});
  log(`Finalized a verification manifest for ${manifest.samples.length} samples.`);
  log(`Manifest ${absoluteOutputPath}`);
  return {
    samples: manifest.samples.length,
    outputPath: absoluteOutputPath,
  };
}

function parseArguments(argumentsList) {
  const options = {};
  const allowed = new Set([
    '--draft',
    '--inventory',
    '--directory',
    '--output',
  ]);
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--help') return {help: true};
    if (!allowed.has(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argumentsList[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${argument}`);
    }
    const key = argument.slice(2);
    if (Object.hasOwn(options, key)) {
      throw new Error(`Duplicate argument: ${argument}`);
    }
    options[key] = value;
    index += 1;
  }
  if (!options.draft ||
      !options.inventory ||
      !options.directory ||
      !options.output) {
    throw new Error(
        '--draft, --inventory, --directory, and --output are required');
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(
        'usage: node finalize_manifest.mjs ' +
        '--draft <draft.json> --inventory <inventory.json> ' +
        '--directory <dng-directory> --output <manifest.json>');
    return;
  }
  const abortController = new AbortController();
  let interruptionExitCode = null;
  const interrupt = (name, exitCode) => {
    interruptionExitCode ??= exitCode;
    abortController.abort(
        new Error(`Manifest finalization interrupted by ${name}`));
  };
  const interruptWithSigint = () => interrupt('SIGINT', 130);
  const interruptWithSigterm = () => interrupt('SIGTERM', 143);
  process.once('SIGINT', interruptWithSigint);
  process.once('SIGTERM', interruptWithSigterm);
  try {
    await finalizeManifest({
      draftPath: options.draft,
      inventoryPath: options.inventory,
      directoryPath: options.directory,
      outputPath: options.output,
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
