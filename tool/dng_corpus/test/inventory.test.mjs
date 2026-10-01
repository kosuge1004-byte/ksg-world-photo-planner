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
  InventoryValidationError,
  inventoryDngDirectory,
} from '../inventory_dng_corpus.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('inventories nested DNG candidates in deterministic order', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-inventory-'));
  const nested = path.join(directory, 'nested');
  const outputPath = path.join(directory, 'inventory.json');
  const firstBytes = Buffer.from('first-dng');
  const secondBytes = Buffer.from('second-dng');
  const fixedDate = new Date('2026-07-30T01:02:03Z');
  try {
    await mkdir(nested);
    await Promise.all([
      writeFile(path.join(directory, 'z.DNG'), secondBytes),
      writeFile(path.join(nested, 'a.dng'), firstBytes),
      writeFile(path.join(directory, 'ignored.txt'), 'not a DNG'),
    ]);
    const messages = [];
    const result = await inventoryDngDirectory({
      directoryPath: directory,
      outputPath,
      now: () => fixedDate,
      log: (message) => messages.push(message),
    });
    const inventory = JSON.parse(await readFile(outputPath, 'utf8'));

    assert.deepEqual(result, {
      files: 2,
      outputPath,
    });
    assert.equal(inventory.status, 'draft');
    assert.equal(inventory.generatedAt, fixedDate.toISOString());
    assert.deepEqual(
        inventory.samples.map((sample) => sample.file),
        ['nested/a.dng', 'z.DNG']);
    assert.equal(inventory.samples[0].byteLength, firstBytes.length);
    assert.equal(inventory.samples[0].sha256, sha256(firstBytes));
    assert.match(
        inventory.samples[0].idSuggestion,
        /^nested-a-[0-9a-f]{8}$/);
    assert.equal(inventory.samples[1].byteLength, secondBytes.length);
    assert.equal(inventory.samples[1].sha256, sha256(secondBytes));
    assert.deepEqual(messages, [
      'Inventoried 2 candidate DNG files.',
      `Inventory ${outputPath}`,
    ]);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('refuses to replace an existing inventory and removes its temporary file',
    async () => {
      const directory = await mkdtemp(
          path.join(tmpdir(), 'mobile-stack-inventory-existing-'));
      const outputPath = path.join(directory, 'inventory.json');
      try {
        await writeFile(path.join(directory, 'sample.dng'), 'candidate');
        await inventoryDngDirectory({
          directoryPath: directory,
          outputPath,
          log: () => {},
        });
        const original = await readFile(outputPath, 'utf8');
        await assert.rejects(
            inventoryDngDirectory({
              directoryPath: directory,
              outputPath,
              log: () => {},
            }),
            (error) => error?.code === 'EEXIST');
        assert.equal(await readFile(outputPath, 'utf8'), original);
        assert.deepEqual(
            (await readdir(directory))
                .filter((name) => name.startsWith('.inventory.json.')),
            []);
      } finally {
        await rm(directory, {recursive: true, force: true});
      }
    });

test('enforces the configured candidate limit before writing output',
    async () => {
      const directory = await mkdtemp(
          path.join(tmpdir(), 'mobile-stack-inventory-limit-'));
      const outputPath = path.join(directory, 'inventory.json');
      try {
        await Promise.all([
          writeFile(path.join(directory, 'a.dng'), 'first'),
          writeFile(path.join(directory, 'b.dng'), 'second'),
        ]);
        await assert.rejects(
            inventoryDngDirectory({
              directoryPath: directory,
              outputPath,
              maximumFiles: 1,
              log: () => {},
            }),
            InventoryValidationError);
        await assert.rejects(
            readFile(outputPath),
            (error) => error?.code === 'ENOENT');
      } finally {
        await rm(directory, {recursive: true, force: true});
      }
    });

test('honors caller cancellation without writing output', async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), 'mobile-stack-inventory-abort-'));
  const outputPath = path.join(directory, 'inventory.json');
  const abortController = new AbortController();
  try {
    await writeFile(path.join(directory, 'sample.dng'), 'candidate');
    abortController.abort(new Error('user cancelled inventory'));
    await assert.rejects(
        inventoryDngDirectory({
          directoryPath: directory,
          outputPath,
          signal: abortController.signal,
          log: () => {},
        }),
        /user cancelled inventory/);
    await assert.rejects(
        readFile(outputPath),
        (error) => error?.code === 'ENOENT');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
