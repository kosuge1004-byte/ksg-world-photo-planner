import {
  lstat,
  readdir,
  realpath,
} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

import {
  sha256File,
  writeJsonAtomic,
} from './verify_dng_corpus.mjs';

const defaultMaximumFiles = 1000;
const maximumAllowedFiles = 10000;
const dngExtensionPattern = /\.dng$/i;
const identifierPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const isoTimestampPattern =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export class InventoryValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InventoryValidationError';
  }
}

function abortReason(signal, fallback = 'Inventory cancelled') {
  if (signal?.reason instanceof Error) return signal.reason;
  if (signal?.reason !== undefined) {
    return new Error(String(signal.reason));
  }
  return new Error(fallback);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function compareCodePoints(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative);
}

function validateMaximumFiles(value, location) {
  if (!Number.isSafeInteger(value) ||
      value < 1 ||
      value > maximumAllowedFiles) {
    throw new InventoryValidationError(
        `${location}: must be an integer from 1 through ` +
        `${maximumAllowedFiles}`);
  }
}

function requireObject(value, location) {
  if (value === null ||
      typeof value !== 'object' ||
      Array.isArray(value)) {
    throw new InventoryValidationError(
        `${location}: must be an object`);
  }
  return value;
}

function requireKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new InventoryValidationError(
          `${location}: unknown field "${key}"`);
    }
  }
}

export function validateInventory(inventoryValue) {
  const inventory = requireObject(inventoryValue, 'inventory');
  requireKeys(
      inventory,
      new Set([
        'schemaVersion',
        'inventoryType',
        'inventoryVersion',
        'status',
        'generatedAt',
        'options',
        'samples',
      ]),
      'inventory');
  if (inventory.schemaVersion !== 1) {
    throw new InventoryValidationError(
        'inventory.schemaVersion: must equal 1');
  }
  if (inventory.inventoryType !==
      'mobile-stack-dng-corpus-inventory') {
    throw new InventoryValidationError(
        'inventory.inventoryType: unsupported inventory type');
  }
  if (inventory.inventoryVersion !== 1) {
    throw new InventoryValidationError(
        'inventory.inventoryVersion: must equal 1');
  }
  if (inventory.status !== 'draft') {
    throw new InventoryValidationError(
        'inventory.status: must equal "draft"');
  }
  if (typeof inventory.generatedAt !== 'string' ||
      !isoTimestampPattern.test(inventory.generatedAt) ||
      Number.isNaN(Date.parse(inventory.generatedAt))) {
    throw new InventoryValidationError(
        'inventory.generatedAt: must be an ISO-8601 timestamp');
  }
  const options = requireObject(
      inventory.options,
      'inventory.options');
  requireKeys(
      options,
      new Set(['maximumFiles']),
      'inventory.options');
  validateMaximumFiles(
      options.maximumFiles,
      'inventory.options.maximumFiles');
  if (!Array.isArray(inventory.samples) ||
      inventory.samples.length === 0 ||
      inventory.samples.length > options.maximumFiles) {
    throw new InventoryValidationError(
        'inventory.samples: must contain 1 through maximumFiles samples');
  }

  const identifiers = new Set();
  const files = new Set();
  inventory.samples.forEach((sampleValue, index) => {
    const location = `inventory.samples[${index}]`;
    const sample = requireObject(sampleValue, location);
    requireKeys(
        sample,
        new Set([
          'idSuggestion',
          'file',
          'byteLength',
          'sha256',
        ]),
        location);
    if (typeof sample.idSuggestion !== 'string' ||
        !identifierPattern.test(sample.idSuggestion)) {
      throw new InventoryValidationError(
          `${location}.idSuggestion: invalid identifier`);
    }
    if (identifiers.has(sample.idSuggestion)) {
      throw new InventoryValidationError(
          `${location}.idSuggestion: must be unique`);
    }
    identifiers.add(sample.idSuggestion);
    if (typeof sample.file !== 'string' ||
        sample.file.length === 0 ||
        path.posix.isAbsolute(sample.file) ||
        /^[a-zA-Z]:/.test(sample.file) ||
        sample.file.includes('\\') ||
        sample.file.includes('\0') ||
        sample.file.split('/').some(
            (segment) => segment === '' ||
              segment === '.' ||
              segment === '..') ||
        !dngExtensionPattern.test(sample.file)) {
      throw new InventoryValidationError(
          `${location}.file: invalid relative DNG path`);
    }
    if (files.has(sample.file)) {
      throw new InventoryValidationError(
          `${location}.file: must be unique`);
    }
    files.add(sample.file);
    if (!Number.isSafeInteger(sample.byteLength) ||
        sample.byteLength < 0) {
      throw new InventoryValidationError(
          `${location}.byteLength: invalid file length`);
    }
    if (typeof sample.sha256 !== 'string' ||
        !sha256Pattern.test(sample.sha256)) {
      throw new InventoryValidationError(
          `${location}.sha256: invalid SHA-256`);
    }
    if (!sample.idSuggestion.endsWith(
        `-${sample.sha256.slice(0, 8)}`)) {
      throw new InventoryValidationError(
          `${location}.idSuggestion: digest suffix does not match SHA-256`);
    }
  });
  return inventory;
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

function normalizedRelativePath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function idSuggestion(relativePath, sha256) {
  const withoutExtension = normalizedRelativePath(relativePath)
      .replace(/\.dng$/i, '');
  let slug = withoutExtension
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  if (slug.length === 0) slug = 'dng';
  const suffix = sha256.slice(0, 8);
  const maximumSlugLength = 64 - suffix.length - 1;
  slug = slug
      .slice(0, maximumSlugLength)
      .replace(/-+$/g, '');
  if (slug.length === 0) slug = 'dng';
  return `${slug}-${suffix}`;
}

async function discoverCandidates(root, maximumFiles, signal) {
  const directories = [''];
  const candidates = [];
  for (let index = 0; index < directories.length; index += 1) {
    throwIfAborted(signal);
    const relativeDirectory = directories[index];
    const directoryPath = path.join(root, relativeDirectory);
    const entries = await readdir(directoryPath, {withFileTypes: true});
    entries.sort((left, right) => compareCodePoints(left.name, right.name));
    for (const entry of entries) {
      throwIfAborted(signal);
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        if (dngExtensionPattern.test(entry.name)) {
          throw new InventoryValidationError(
              `${normalizedRelativePath(relativePath)}: ` +
              'symbolic-link DNG candidates are not allowed');
        }
        continue;
      }
      if (entry.isDirectory()) {
        directories.push(relativePath);
        continue;
      }
      if (!dngExtensionPattern.test(entry.name)) continue;
      if (!entry.isFile()) {
        throw new InventoryValidationError(
            `${normalizedRelativePath(relativePath)}: ` +
            'DNG candidate must be a regular file');
      }
      candidates.push(relativePath);
      if (candidates.length > maximumFiles) {
        throw new InventoryValidationError(
            `directory contains more than ${maximumFiles} DNG candidates`);
      }
    }
  }
  candidates.sort(compareCodePoints);
  if (candidates.length === 0) {
    throw new InventoryValidationError(
        'directory contains no .dng files');
  }
  return candidates;
}

export async function inventoryDngDirectory({
  directoryPath,
  outputPath,
  maximumFiles = defaultMaximumFiles,
  signal,
  now = () => new Date(),
  log = console.log,
}) {
  validateMaximumFiles(maximumFiles, 'maximumFiles');
  throwIfAborted(signal);
  const root = await realpath(path.resolve(directoryPath));
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory()) {
    throw new InventoryValidationError(
        'directoryPath must resolve to a directory');
  }
  const candidates = await discoverCandidates(
      root,
      maximumFiles,
      signal);
  const samples = [];

  for (const relativePath of candidates) {
    throwIfAborted(signal);
    const lexicalPath = path.join(root, relativePath);
    const before = await lstat(lexicalPath);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new InventoryValidationError(
          `${normalizedRelativePath(relativePath)}: ` +
          'DNG candidate changed before hashing');
    }
    if (!Number.isSafeInteger(before.size) || before.size < 0) {
      throw new InventoryValidationError(
          `${normalizedRelativePath(relativePath)}: ` +
          'file size exceeds the safe integer range');
    }
    const resolvedPath = await realpath(lexicalPath);
    if (!isInside(root, resolvedPath)) {
      throw new InventoryValidationError(
          `${normalizedRelativePath(relativePath)}: ` +
          'DNG candidate resolves outside the inventory directory');
    }
    const sha256 = await sha256File(resolvedPath, {signal});
    const after = await lstat(lexicalPath);
    const resolvedAfter = await realpath(lexicalPath);
    if (!sameFileState(before, after) || resolvedAfter !== resolvedPath) {
      throw new InventoryValidationError(
          `${normalizedRelativePath(relativePath)}: ` +
          'DNG candidate changed while it was being hashed');
    }
    const file = normalizedRelativePath(relativePath);
    samples.push({
      idSuggestion: idSuggestion(relativePath, sha256),
      file,
      byteLength: before.size,
      sha256,
    });
  }

  throwIfAborted(signal);
  const generatedAt = now();
  if (!(generatedAt instanceof Date) ||
      Number.isNaN(generatedAt.valueOf())) {
    throw new InventoryValidationError(
        'now must return a valid Date');
  }
  const inventory = {
    schemaVersion: 1,
    inventoryType: 'mobile-stack-dng-corpus-inventory',
    inventoryVersion: 1,
    status: 'draft',
    generatedAt: generatedAt.toISOString(),
    options: {maximumFiles},
    samples,
  };
  validateInventory(inventory);
  const absoluteOutputPath = await writeJsonAtomic(
      outputPath,
      inventory,
      {signal});
  log(`Inventoried ${samples.length} candidate DNG files.`);
  log(`Inventory ${absoluteOutputPath}`);
  return {
    files: samples.length,
    outputPath: absoluteOutputPath,
  };
}

function parseArguments(argumentsList) {
  const options = {};
  const allowed = new Set([
    '--directory',
    '--output',
    '--max-files',
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
    const key = argument === '--max-files' ?
      'maximumFiles' :
      argument.slice(2);
    if (Object.hasOwn(options, key)) {
      throw new Error(`Duplicate argument: ${argument}`);
    }
    options[key] = value;
    index += 1;
  }
  if (!options.directory || !options.output) {
    throw new Error('--directory and --output are required');
  }
  options.maximumFiles = options.maximumFiles === undefined ?
    defaultMaximumFiles :
    Number(options.maximumFiles);
  validateMaximumFiles(options.maximumFiles, '--max-files');
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(
        'usage: node inventory_dng_corpus.mjs ' +
        '--directory <dng-directory> --output <inventory.json> ' +
        '[--max-files 1-10000]');
    return;
  }
  const abortController = new AbortController();
  let interruptionExitCode = null;
  const interrupt = (name, exitCode) => {
    interruptionExitCode ??= exitCode;
    abortController.abort(
        new Error(`Inventory interrupted by ${name}`));
  };
  const interruptWithSigint = () => interrupt('SIGINT', 130);
  const interruptWithSigterm = () => interrupt('SIGTERM', 143);
  process.once('SIGINT', interruptWithSigint);
  process.once('SIGTERM', interruptWithSigterm);
  try {
    await inventoryDngDirectory({
      directoryPath: options.directory,
      outputPath: options.output,
      maximumFiles: options.maximumFiles,
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
