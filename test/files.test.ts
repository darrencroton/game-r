import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { Files } from '../src/files.ts';
import { tempDir } from './helpers.ts';

async function setup() {
  const dir = await tempDir();
  const roots = { memory: path.join(dir, 'memory'), run: path.join(dir, 'run-002'), runs: dir };
  await mkdir(roots.memory, { recursive: true });
  await mkdir(path.join(dir, 'run-001'), { recursive: true });
  await mkdir(roots.run, { recursive: true });
  await writeFile(path.join(dir, 'run-001', 'report.md'), 'old report\n');
  await writeFile(path.join(dir, 'campaign.lock'), '1');
  return new Files(() => roots);
}

test('create, view, str_replace, insert, rename and delete', async () => {
  const files = await setup();
  await files.create('/memory/notes/plan.md', 'line one\nline two\n');
  assert.match(await files.view('/memory/notes/plan.md'), /1\tline one\n\s+2\tline two/);
  await files.strReplace('/memory/notes/plan.md', 'line two', 'line 2');
  await files.insert('/memory/notes/plan.md', 1, 'inserted');
  assert.match(await files.view('/memory/notes/plan.md', [2, 3]), /2\tinserted\n\s+3\tline 2/);
  await files.rename('/memory/notes/plan.md', '/memory/plan.md');
  assert.match(await files.view('/memory'), /plan\.md/);
  await files.delete('/memory/plan.md');
  await assert.rejects(files.view('/memory/plan.md'), /does not exist/);
});

test('str_replace insists on a unique match', async () => {
  const files = await setup();
  await files.create('/run/log.md', 'a\na\n');
  await assert.rejects(files.strReplace('/run/log.md', 'a', 'b'), /occurs 2 times/);
  await assert.rejects(files.strReplace('/run/log.md', 'zzz', 'b'), /not found/);
});

test('roots are enforced', async () => {
  const files = await setup();
  await assert.rejects(files.create('/etc/passwd', 'x'), /must start with/);
  await assert.rejects(files.create('/memory/../../escape.txt', 'x'), /must start with/);
  await assert.rejects(files.create('/runs/run-001/report.md', 'x'), /read-only/);
  await assert.rejects(files.create('/run/transcript.jsonl', 'x'), /written by the engine/);
  await assert.rejects(files.create('/run/shots/1.jpg', 'x'), /written by the engine/);
  await assert.rejects(files.view('/runs/campaign.lock'), /only run-NNN/);
  assert.match(await files.view('/runs/run-001/report.md'), /old report/);
  const listing = await files.view('/runs');
  assert.match(listing, /run-001/);
  assert.doesNotMatch(listing, /campaign\.lock|memory/);
});
