import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { Workspace } from '../src/workspace.ts';
import { makeConfig, tempDir } from './helpers.ts';

describe('browser.profile_from', () => {
  test('a read-only save point seeds the first run and each run after an end_run, not a run after a stop', async () => {
    const seed = path.join(await tempDir(), 'profile');
    await mkdir(path.join(seed, 'Default'), { recursive: true });
    await writeFile(path.join(seed, 'Default', 'save'), 'hero at the save point');
    await chmod(path.join(seed, 'Default', 'save'), 0o444);
    await chmod(path.join(seed, 'Default'), 0o555);
    await chmod(seed, 0o555);
    const ws = new Workspace(await makeConfig({ browser: { profile_from: seed } }));
    await ws.open();
    const save = path.join(ws.profileDir, 'Default', 'save');
    try {
      await ws.startRun(new Date(), 'now');
      assert.equal(await readFile(save, 'utf8'), 'hero at the save point');
      await writeFile(save, 'hero further on');

      await ws.saveRun({ run: 1, started_at: new Date().toISOString(), ended_at: new Date().toISOString(), ended_by: 'stop requested' });
      await ws.startRun(new Date(), 'now');
      assert.equal(await readFile(save, 'utf8'), 'hero further on', 'a run after a stop carries on');

      await ws.saveRun({ run: 2, started_at: new Date().toISOString(), ended_at: new Date().toISOString(), ended_by: 'end_run', next: 'new_run' });
      await ws.startRun(new Date(), 'now');
      assert.equal(await readFile(save, 'utf8'), 'hero at the save point', 'a run after end_run starts from the save point');
      assert.equal((await stat(save)).mode & 0o200, 0o200, 'the copy is writable');
      assert.equal((await stat(path.join(seed, 'Default', 'save'))).mode & 0o222, 0, 'the save point is untouched');
    } finally {
      await ws.close();
      await chmod(seed, 0o755);
      await chmod(path.join(seed, 'Default'), 0o755);
    }
  });
});
