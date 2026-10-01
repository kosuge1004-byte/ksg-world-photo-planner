import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {createManifestDraft} from '../create_manifest_draft.mjs';
import {
  finalizeManifest,
  ManifestFinalizationError,
} from '../finalize_manifest.mjs';
import {inventoryDngDirectory} from '../inventory_dng_corpus.mjs';
import {validateManifest} from '../verify_dng_corpus.mjs';

const originalDngBytes = Buffer.from('12345678');

function reviewedMetadata() {
  return {
    width: 4,
    height: 2,
    cfa: 'RGGB',
    activeArea: {
      left: 0,
      top: 0,
      width: 4,
      height: 2,
    },
    orientation: 1,
    blackLevels: [64, 64, 64, 64],
    whiteLevel: 1023,
    cameraWhiteBalance: null,
  };
}

async function prepareAuthoringFiles(directory, {complete = true} = {}) {
  const inventoryPath = path.join(directory, 'inventory.json');
  const draftPath = path.join(directory, 'manifest-draft.json');
  await writeFile(path.join(directory, 'sample.dng'), originalDngBytes);
  await inventoryDngDirectory({
    directoryPath: directory,
    outputPath: inventoryPath,
    now: () => new Date('2026-07-30T01:00:00Z'),
    log: () => {},
  });
  await createManifestDraft({
    inventoryPath,
    outputPath: draftPath,
    corpusId: 'mobile-stack-private-dng',
    now: () => new Date('2026-07-30T02:00:00Z'),
    log: () => {},
  });
  if (complete) {
    const draft = JSON.parse(await readFile(draftPath, 'utf8'));
    draft.samples[0].provenance = {
      source: 'user-captured',
      license: 'private verification only',
      redistributable: false,
    };
    draft.samples[0].reference = {
      tool: 'reference-tool',
      version: '1.0',
      command: 'reference-tool sample.dng',
      recordedAt: '2026-07-30T03:00:00Z',
    };
    draft.samples[0].expected = reviewedMetadata();
    await writeFile(draftPath, `${JSON.stringify(draft, null, 2)}\n`);
  }
  return {draftPath, inventoryPath};
}

test('finalizes a reviewed draft after rehashing its DNG file', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-finalize-'));
  const outputPath = path.join(directory, 'manifest.json');
  try {
    const {draftPath, inventoryPath} =
        await prepareAuthoringFiles(directory);
    const messages = [];
    const result = await finalizeManifest({
      draftPath,
      inventoryPath,
      directoryPath: directory,
      outputPath,
      log: (message) => messages.push(message),
    });
    const manifest = JSON.parse(await readFile(outputPath, 'utf8'));

    assert.deepEqual(result, {samples: 1, outputPath});
    assert.equal(validateManifest(manifest), manifest);
    assert.deepEqual(Object.keys(manifest), [
      'schemaVersion',
      'corpusId',
      'samples',
    ]);
    assert.equal(manifest.samples[0].provenance.source, 'user-captured');
    assert.deepEqual(messages, [
      'Finalized a verification manifest for 1 samples.',
      `Manifest ${outputPath}`,
    ]);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('rejects a draft with an incomplete review block', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-finalize-incomplete-'));
  const outputPath = path.join(directory, 'manifest.json');
  try {
    const {draftPath, inventoryPath} =
        await prepareAuthoringFiles(directory, {complete: false});
    await assert.rejects(
        finalizeManifest({
          draftPath,
          inventoryPath,
          directoryPath: directory,
          outputPath,
          log: () => {},
        }),
        ManifestFinalizationError);
    await assert.rejects(
        readFile(outputPath),
        (error) => error?.code === 'ENOENT');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('rejects inventory bytes changed after draft creation', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-finalize-inventory-'));
  const outputPath = path.join(directory, 'manifest.json');
  try {
    const {draftPath, inventoryPath} =
        await prepareAuthoringFiles(directory);
    const inventory = await readFile(inventoryPath, 'utf8');
    await writeFile(inventoryPath, `${inventory}\n`);
    await assert.rejects(
        finalizeManifest({
          draftPath,
          inventoryPath,
          directoryPath: directory,
          outputPath,
          log: () => {},
        }),
        /exact inventory bytes/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('rejects a DNG changed after inventory creation', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-finalize-dng-'));
  const outputPath = path.join(directory, 'manifest.json');
  try {
    const {draftPath, inventoryPath} =
        await prepareAuthoringFiles(directory);
    await writeFile(
        path.join(directory, 'sample.dng'),
        Buffer.from('87654321'));
    await assert.rejects(
        finalizeManifest({
          draftPath,
          inventoryPath,
          directoryPath: directory,
          outputPath,
          log: () => {},
        }),
        /SHA-256 differs/);
    await assert.rejects(
        readFile(outputPath),
        (error) => error?.code === 'ENOENT');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('refuses to replace a finalized manifest', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-finalize-existing-'));
  const outputPath = path.join(directory, 'manifest.json');
  try {
    const {draftPath, inventoryPath} =
        await prepareAuthoringFiles(directory);
    const options = {
      draftPath,
      inventoryPath,
      directoryPath: directory,
      outputPath,
      log: () => {},
    };
    await finalizeManifest(options);
    const original = await readFile(outputPath, 'utf8');
    await assert.rejects(
        finalizeManifest(options),
        (error) => error?.code === 'EEXIST');
    assert.equal(await readFile(outputPath, 'utf8'), original);
    assert.deepEqual(
        (await readdir(directory))
            .filter((name) => name.startsWith('.manifest.json.')),
        []);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('honors caller cancellation without finalizing a manifest', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-finalize-abort-'));
  const outputPath = path.join(directory, 'manifest.json');
  const abortController = new AbortController();
  try {
    const {draftPath, inventoryPath} =
        await prepareAuthoringFiles(directory);
    abortController.abort(new Error('user cancelled finalization'));
    await assert.rejects(
        finalizeManifest({
          draftPath,
          inventoryPath,
          directoryPath: directory,
          outputPath,
          signal: abortController.signal,
          log: () => {},
        }),
        /user cancelled finalization/);
    await assert.rejects(
        readFile(outputPath),
        (error) => error?.code === 'ENOENT');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
