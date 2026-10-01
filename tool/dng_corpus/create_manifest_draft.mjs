import {createHash} from 'node:crypto';
import {
  lstat,
  readFile,
} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {TextDecoder} from 'node:util';
import path from 'node:path';

import {
  InventoryValidationError,
  validateInventory,
} from './inventory_dng_corpus.mjs';
import {writeJsonAtomic} from './verify_dng_corpus.mjs';

const maximumInventoryBytes = 10 * 1024 * 1024;
const identifierPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const strictUtf8Decoder = new TextDecoder('utf-8', {fatal: true});

export class ManifestDraftValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestDraftValidationError';
  }
}

function abortReason(signal, fallback = 'Manifest draft cancelled') {
  if (signal?.reason instanceof Error) return signal.reason;
  if (signal?.reason !== undefined) {
    return new Error(String(signal.reason));
  }
  return new Error(fallback);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
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

function validateCorpusId(corpusId) {
  if (typeof corpusId !== 'string' ||
      !identifierPattern.test(corpusId)) {
    throw new ManifestDraftValidationError(
        'corpusId: must use 1 through 64 lowercase identifier characters');
  }
}

async function readInventoryBytes(inventoryPath, signal) {
  throwIfAborted(signal);
  const absoluteInventoryPath = path.resolve(inventoryPath);
  const before = await lstat(absoluteInventoryPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new ManifestDraftValidationError(
        'inventoryPath must be a regular file, not a symbolic link');
  }
  if (!Number.isSafeInteger(before.size) ||
      before.size > maximumInventoryBytes) {
    throw new ManifestDraftValidationError(
        `inventoryPath must not exceed ${maximumInventoryBytes} bytes`);
  }
  let bytes;
  try {
    bytes = await readFile(absoluteInventoryPath, {signal});
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw error;
  }
  const after = await lstat(absoluteInventoryPath);
  if (!sameFileState(before, after)) {
    throw new ManifestDraftValidationError(
        'inventoryPath changed while it was being read');
  }
  return bytes;
}

function parseInventory(bytes) {
  let text;
  try {
    text = strictUtf8Decoder.decode(bytes);
  } catch {
    throw new ManifestDraftValidationError(
        'inventoryPath must contain valid UTF-8');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ManifestDraftValidationError(
        'inventoryPath must contain valid JSON');
  }
  try {
    return validateInventory(value);
  } catch (error) {
    if (error instanceof InventoryValidationError) {
      throw new ManifestDraftValidationError(error.message);
    }
    throw error;
  }
}

export async function createManifestDraft({
  inventoryPath,
  outputPath,
  corpusId,
  signal,
  now = () => new Date(),
  log = console.log,
}) {
  validateCorpusId(corpusId);
  throwIfAborted(signal);
  const inventoryBytes = await readInventoryBytes(
      inventoryPath,
      signal);
  throwIfAborted(signal);
  const inventory = parseInventory(inventoryBytes);
  const generatedAt = now();
  if (!(generatedAt instanceof Date) ||
      Number.isNaN(generatedAt.valueOf())) {
    throw new ManifestDraftValidationError(
        'now must return a valid Date');
  }
  const inventorySha256 = createHash('sha256')
      .update(inventoryBytes)
      .digest('hex');
  const draft = {
    schemaVersion: 1,
    draftType: 'mobile-stack-dng-corpus-manifest-draft',
    draftVersion: 1,
    status: 'incomplete',
    corpusId,
    inventorySha256,
    generatedAt: generatedAt.toISOString(),
    samples: inventory.samples.map((sample) => ({
      id: sample.idSuggestion,
      file: sample.file,
      sha256: sample.sha256,
      byteLength: sample.byteLength,
      floatTolerance: 0.0001,
      provenance: null,
      reference: null,
      expected: null,
    })),
  };
  const absoluteOutputPath = await writeJsonAtomic(
      outputPath,
      draft,
      {signal});
  log(`Created an incomplete manifest draft for ${draft.samples.length} samples.`);
  log(`Draft ${absoluteOutputPath}`);
  return {
    samples: draft.samples.length,
    inventorySha256,
    outputPath: absoluteOutputPath,
  };
}

function parseArguments(argumentsList) {
  const options = {};
  const allowed = new Set([
    '--inventory',
    '--output',
    '--corpus-id',
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
    const key = argument === '--corpus-id' ?
      'corpusId' :
      argument.slice(2);
    if (Object.hasOwn(options, key)) {
      throw new Error(`Duplicate argument: ${argument}`);
    }
    options[key] = value;
    index += 1;
  }
  if (!options.inventory || !options.output || !options.corpusId) {
    throw new Error(
        '--inventory, --output, and --corpus-id are required');
  }
  validateCorpusId(options.corpusId);
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(
        'usage: node create_manifest_draft.mjs ' +
        '--inventory <inventory.json> --output <draft.json> ' +
        '--corpus-id <identifier>');
    return;
  }
  const abortController = new AbortController();
  let interruptionExitCode = null;
  const interrupt = (name, exitCode) => {
    interruptionExitCode ??= exitCode;
    abortController.abort(
        new Error(`Manifest draft interrupted by ${name}`));
  };
  const interruptWithSigint = () => interrupt('SIGINT', 130);
  const interruptWithSigterm = () => interrupt('SIGTERM', 143);
  process.once('SIGINT', interruptWithSigint);
  process.once('SIGTERM', interruptWithSigterm);
  try {
    await createManifestDraft({
      inventoryPath: options.inventory,
      outputPath: options.output,
      corpusId: options.corpusId,
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
