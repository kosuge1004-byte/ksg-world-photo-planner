import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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

import {
  createManifestDraft,
  ManifestDraftValidationError,
} from '../create_manifest_draft.mjs';
import {inventoryDngDirectory} from '../inventory_dng_corpus.mjs';

async function prepareInventory(directory) {
  const inventoryPath = path.join(directory, 'inventory.json');
  await writeFile(path.join(directory, 'sample.dng'), 'candidate-dng');
  await inventoryDngDirectory({
    directoryPath: directory,
    outputPath: inventoryPath,
    now: () => new Date('2026-07-30T01:00:00Z'),
    log: () => {},
  });
  return inventoryPath;
}

test('creates an explicitly incomplete draft from a valid inventory',
    async () => {
      const directory = await mkdtemp(
          path.join(tmpdir(), 'mobile-stack-manifest-draft-'));
      const outputPath = path.join(directory, 'manifest-draft.json');
      const fixedDate = new Date('2026-07-30T02:00:00Z');
      try {
        const inventoryPath = await prepareInventory(directory);
        const inventoryBytes = await readFile(inventoryPath);
        const inventorySha256 = createHash('sha256')
            .update(inventoryBytes)
            .digest('hex');
        const messages = [];
        const result = await createManifestDraft({
          inventoryPath,
          outputPath,
          corpusId: 'mobile-stack-private-dng',
          now: () => fixedDate,
          log: (message) => messages.push(message),
        });
        const draft = JSON.parse(await readFile(outputPath, 'utf8'));

        assert.deepEqual(result, {
          samples: 1,
          inventorySha256,
          outputPath,
        });
        assert.equal(draft.status, 'incomplete');
        assert.equal(draft.corpusId, 'mobile-stack-private-dng');
        assert.equal(draft.inventorySha256, inventorySha256);
        assert.equal(draft.generatedAt, fixedDate.toISOString());
        assert.equal(draft.samples[0].provenance, null);
        assert.equal(draft.samples[0].reference, null);
        assert.equal(draft.samples[0].expected, null);
        assert.equal(draft.samples[0].floatTolerance, 0.0001);
        assert.deepEqual(messages, [
          'Created an incomplete manifest draft for 1 samples.',
          `Draft ${outputPath}`,
        ]);
      } finally {
        await rm(directory, {recursive: true, force: true});
      }
    });

test('rejects a tampered inventory before creating a draft', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-manifest-tampered-'));
  const outputPath = path.join(directory, 'manifest-draft.json');
  try {
    const inventoryPath = await prepareInventory(directory);
    const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
    inventory.samples[0].sha256 = '0'.repeat(64);
    const tamperedPath = path.join(directory, 'tampered.json');
    await writeFile(tamperedPath, JSON.stringify(inventory));

    await assert.rejects(
        createManifestDraft({
          inventoryPath: tamperedPath,
          outputPath,
          corpusId: 'mobile-stack-private-dng',
          log: () => {},
        }),
        ManifestDraftValidationError);
    await assert.rejects(
        readFile(outputPath),
        (error) => error?.code === 'ENOENT');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('refuses to replace a draft and removes its temporary file', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-manifest-existing-'));
  const outputPath = path.join(directory, 'manifest-draft.json');
  try {
    const inventoryPath = await prepareInventory(directory);
    const options = {
      inventoryPath,
      outputPath,
      corpusId: 'mobile-stack-private-dng',
      log: () => {},
    };
    await createManifestDraft(options);
    const original = await readFile(outputPath, 'utf8');
    await assert.rejects(
        createManifestDraft(options),
        (error) => error?.code === 'EEXIST');
    assert.equal(await readFile(outputPath, 'utf8'), original);
    assert.deepEqual(
        (await readdir(directory))
            .filter((name) => name.startsWith('.manifest-draft.json.')),
        []);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('honors caller cancellation without creating a draft', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-manifest-abort-'));
  const outputPath = path.join(directory, 'manifest-draft.json');
  const abortController = new AbortController();
  try {
    const inventoryPath = await prepareInventory(directory);
    abortController.abort(new Error('user cancelled draft'));
    await assert.rejects(
        createManifestDraft({
          inventoryPath,
          outputPath,
          corpusId: 'mobile-stack-private-dng',
          signal: abortController.signal,
          log: () => {},
        }),
        /user cancelled draft/);
    await assert.rejects(
        readFile(outputPath),
        (error) => error?.code === 'ENOENT');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
