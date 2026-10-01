import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const registryPath = new URL(
  '../../../lib/core/background/stack_job_registry.dart',
  import.meta.url,
);
const statusPath = new URL(
  '../../../lib/core/background/stack_job_status.dart',
  import.meta.url,
);

test('Android active-job authority is persisted ProcessorService status, not WorkManager', async () => {
  const source = await readFile(registryPath, 'utf8');
  assert.match(source, /Android heavy work is hosted by ProcessorService/);
  assert.match(source, /persisted status file is/);
  assert.match(source, /cross-process authority/);
  assert.doesNotMatch(source, /WorkInfo/);
  assert.doesNotMatch(source, /対応するAndroid WorkManager処理が見つかりません/);
  assert.match(source, /return record;/);
});

test('registry replacement does not delete authoritative file before rename', async () => {
  const source = await readFile(registryPath, 'utf8');
  assert.doesNotMatch(
    source,
    /if \(await file\.exists\(\)\) await file\.delete\(\);\s*await temporary\.rename\(path\);/,
  );
  assert.match(
    source,
    /\.tmp\.\$(?:pid|\{pid\})\.\$\{DateTime\.now\(\)\.microsecondsSinceEpoch\}/,
  );
  assert.match(source, /await temporary\.rename\(path\);/);
});

test('status replacement uses per-write temp file and rename replacement', async () => {
  const source = await readFile(statusPath, 'utf8');
  assert.doesNotMatch(
    source,
    /if \(await file\.exists\(\)\) await file\.delete\(\);\s*await temporary\.rename\(path\);/,
  );
  assert.match(
    source,
    /\.tmp\.\$(?:pid|\{pid\})\.\$\{DateTime\.now\(\)\.microsecondsSinceEpoch\}/,
  );
  assert.match(source, /await temporary\.rename\(path\);/);
});
