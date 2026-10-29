import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Session } from '../src/session.ts';
import { Toolbox } from '../src/tools.ts';
import { makeConfig, textOf } from './helpers.ts';

describe('tools against the fixture game', () => {
  let session: Session;
  let box: Toolbox;
  const call = (name: string, args: unknown = {}) => box.call(name, args);
  const game = async () => JSON.parse(textOf(await call('evaluate', { expression: 'window.game' })));
  const refOf = async (label: string) => {
    const snap = textOf(await call('read_page', { find: label }));
    const m = new RegExp(`"${label}" \\[ref=((?:f\\d+)?e\\d+)\\]`).exec(snap);
    assert.ok(m, `no ref for ${label} in:\n${snap}`);
    return m[1]!;
  };

  before(async () => {
    session = await Session.open(await makeConfig({ access: 'developer', limits: { runs: 2 } }), 'engine');
    box = new Toolbox(session);
    await session.begin();
  });
  after(async () => session.close());

  test('look returns a CSS-pixel screenshot, keeps it on disk and can save a copy', async () => {
    const result = await call('look', { grid: true, save_as: '/run/findings/menu.jpg' });
    assert.ok(!result.isError, textOf(result));
    const img = result.content.find((c) => c.type === 'image');
    assert.ok(img && img.type === 'image' && img.data.length > 1000);
    assert.match(textOf(result), /"Dodge" · viewport 1280×800 css px · desktop · clock running/);
    assert.match(textOf(result), /grid 64px · \/run\/shots\/0001\.jpg · saved as \/run\/findings\/menu\.jpg/);
    await stat(path.join(session.workspace.runDir, 'findings', 'menu.jpg'));
    await stat(path.join(session.workspace.runDir, 'live.jpg'));
  });

  test('read_page gives refs that act can click', async () => {
    const start = await refOf('Start');
    const result = await call('act', { actions: [{ do: 'click', at: start }] });
    assert.match(textOf(result), /1\. click e\d+: ok/);
    assert.equal((await game()).state, 'playing');
  });

  test('a paused clock freezes the game; holds and waits advance it', async () => {
    await call('clock', { action: 'pause' });
    const a = await game();
    await sleep(500);
    const b = await game();
    assert.equal(b.frames, a.frames, 'frames advanced while paused');
    const result = await call('act', { actions: [{ do: 'key', key: 'ArrowRight', ms: 500 }, { do: 'wait', ms: 100 }] });
    assert.ok(!result.isError, textOf(result));
    const c = await game();
    assert.ok(c.frames - b.frames >= 30 && c.frames - b.frames <= 45, `frames advanced ${c.frames - b.frames}`);
    assert.ok(c.x > b.x + 80, `x moved ${c.x - b.x}`);
    assert.match(textOf(await call('clock', { action: 'advance', ms: 1000 })), /clock paused · game time/);
    assert.ok((await game()).frames - c.frames >= 55);
    await call('clock', { action: 'resume' });
    await sleep(300);
    assert.ok((await game()).frames > c.frames + 60);
  });

  test('grid cells and x,y target the canvas', async () => {
    await call('clock', { action: 'pause' });
    const before = (await game()).taps;
    await call('act', { actions: [{ do: 'click', at: 'B2' }, { do: 'click', at: '300,100' }] });
    const g = await game();
    assert.equal(g.taps, before + 2);
    assert.ok(Math.abs(g.x - 300) < 2, `x is ${g.x}`);
    await call('clock', { action: 'resume' });
  });

  test('page errors are flagged in act results and listed by console', async () => {
    await call('act', { actions: [{ do: 'reload' }] });
    await call('console', {});
    const breakRef = await refOf('Break');
    const result = await call('act', { actions: [{ do: 'click', at: breakRef }] });
    assert.match(textOf(result), /console: 1 pageerror since this act — latest: TypeError/);
    assert.match(textOf(await call('console', {})), /pageerror\s+TypeError: Cannot read properties of null/);
    assert.equal(textOf(await call('console', {})), 'Nothing new in the console.');
  });

  test('failures stop the batch with a reason', async () => {
    const result = await call('act', { actions: [{ do: 'click', at: 'e9999' }, { do: 'wait', ms: 10 }] });
    assert.match(textOf(result), /1\. click e9999: FAILED — .*\n\(1 remaining action\(s\) not run\)/);
    assert.match(textOf(await call('act', { actions: [{ do: 'click', at: 'somewhere' }] })), /must be a ref like e12/);
    assert.match(textOf(await call('act', { actions: [{ do: 'key' }] })), /needs "key"/);
  });

  test('invalid arguments and unknown tools are reported, not thrown', async () => {
    const bad = await call('act', { actions: [{ do: 'fly' }] });
    assert.ok(bad.isError);
    assert.match(textOf(bad), /Invalid arguments for act/);
    assert.ok((await call('nope')).isError);
  });

  test('devices: touch gestures on a phone, rotation in place', async () => {
    let result = await call('browser', { device: 'pixel 7' });
    assert.match(textOf(result), /viewport 412×839 css px · Pixel 7 \(touch\)/);
    result = await call('browser', { orientation: 'landscape' });
    assert.match(textOf(result), /viewport 863×360 css px · Pixel 7 landscape \(touch\)[\s\S]*resized in place/);
    await call('act', { actions: [{ do: 'tap', at: await refOf('Start') }] });
    assert.equal((await game()).state, 'playing');
    result = await call('act', {
      actions: [
        { do: 'swipe', at: '200,150', dir: 'left', distance: 100 },
        { do: 'pinch', at: '200,150', scale: 2 },
      ],
    });
    assert.ok(!result.isError, textOf(result));
    assert.deepEqual((await game()).gestures, ['1-finger', '2-finger']);
    assert.match(textOf(await call('browser', { device: 'Galaxy Z' })), /Unknown device/);
    await call('browser', { device: 'desktop', orientation: 'portrait' });
  });

  test('status reports the run and limits', async () => {
    const text = textOf(await call('status'));
    assert.match(text, /Run 1 \(limit 2, 1 left\)/);
    assert.match(text, /Wall time: campaign 0h 00m \(limit 48h 00m/);
    assert.match(text, /Tokens: 0 in, 0 out/);
  });

  test('end_run starts a new run, then the run limit ends the campaign', async () => {
    await call('files', { command: 'create', path: '/memory/notes.md', file_text: 'Rocks fall every 500 ms.' });
    let result = await call('end_run', { summary: 'Learned the controls.', next: 'new_run' });
    assert.match(textOf(result), /Run 2 has started/);
    assert.equal(session.run, 2);
    const end = JSON.parse(await readFile(path.join(session.workspace.dir, 'run-001', 'end.json'), 'utf8'));
    assert.equal(end.summary, 'Learned the controls.');
    assert.match(textOf(await call('files', { command: 'view', path: '/memory/notes.md' })), /500 ms/);
    assert.match(textOf(await call('files', { command: 'view', path: '/runs' })), /run-001\/[\s\S]*end\.json[\s\S]*run-002\//);
    const transcript = (await readFile(path.join(session.workspace.dir, 'run-001', 'transcript.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(transcript.some((e) => e.type === 'tool' && e.name === 'look' && e.result.some((r: { image?: string }) => r.image === '/run/shots/0001.jpg')));

    result = await call('end_run', { summary: 'Second run.', next: 'new_run' });
    assert.match(textOf(result), /campaign is over: limit reached: 2 runs/);
    assert.equal(session.state, 'done');
    assert.match(textOf(await call('look')), /The campaign has ended/);
    assert.match(textOf(await call('status')), /done \(limit reached: 2 runs\)/);
    const status = JSON.parse(await readFile(path.join(session.workspace.dir, 'status.json'), 'utf8'));
    assert.equal(status.state, 'done');
  });
});

describe('access and clock settings', () => {
  test('player access has no evaluate; clock off has no clock tool', async () => {
    const session = await Session.open(await makeConfig({ clock: 'off' }), 'mcp');
    try {
      const names = new Toolbox(session).tools.map((t) => t.name);
      assert.deepEqual(names, ['look', 'read_page', 'act', 'console', 'browser', 'files', 'status', 'notify', 'end_run']);
    } finally {
      await session.close();
    }
  });

  test('a second process cannot open a running campaign', async () => {
    const config = await makeConfig();
    const first = await Session.open(config, 'mcp');
    try {
      await assert.rejects(Session.open(config, 'mcp'), /already running/);
    } finally {
      await first.close();
    }
    const again = await Session.open(config, 'mcp');
    await again.close();
  });

  test('notify runs the configured command with the message in the environment', async () => {
    const config = await makeConfig();
    const out = path.join(config.output, 'note.txt');
    config.notify.command = `printf '%s|%s|%s' "$GAMER_TITLE" "$GAMER_MESSAGE" "$GAMER_LEVEL" > '${out}'`;
    const session = await Session.open(config, 'mcp');
    try {
      const result = await new Toolbox(session).call('notify', { title: 'Hi; rm -rf /', message: '$(whoami)', level: 'finding' });
      assert.equal(textOf(result), 'Sent.');
      assert.equal(await readFile(out, 'utf8'), 'Hi; rm -rf /|$(whoami)|finding');
    } finally {
      await session.close();
    }
  });
});
