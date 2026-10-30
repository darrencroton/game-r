import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { clockTime, Session } from '../src/session.ts';
import { Toolbox } from '../src/tools.ts';
import { FIXTURE_URL, makeConfig, textOf } from './helpers.ts';

describe('tools against the fixture game', () => {
  let session: Session;
  let box: Toolbox;
  let startRef = '';
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
    assert.match(textOf(result), /"Dodge" · viewport 1280×800 css px · desktop · grid/);
    const line = result.content.at(-1);
    assert.ok(line?.type === 'text' && /^⏱ \d\d:\d\d:\d\d .* · run 1 of 2 · \dm\d\ds in run · 1 calls · campaign \dm\d\ds of 48h00m · game \d+\.\ds$/.test(line.text), JSON.stringify(line));
    assert.match(textOf(result), /grid 64px · \/run\/shots\/0001\.jpg · saved as \/run\/findings\/menu\.jpg/);
    await stat(path.join(session.workspace.runDir, 'findings', 'menu.jpg'));
    await stat(path.join(session.workspace.runDir, 'live.jpg'));
  });

  test('read_page gives refs that act can click', async () => {
    startRef = await refOf('Start');
    const result = await call('act', { actions: [{ do: 'click', at: startRef }] });
    assert.match(textOf(result), /1\. click e\d+: ok/);
    assert.equal((await game()).state, 'playing');
  });

  test('canvas-only screens, stale refs and unknown arguments are explained', async () => {
    assert.match(textOf(await call('read_page')), /accessibility tree is empty/);
    assert.match(textOf(await call('read_page', { find: 'Start' })), /accessibility tree is empty/);
    await call('clock', { action: 'pause' });
    const stale = await call('act', { actions: [{ do: 'click', at: startRef }] });
    assert.match(textOf(stale), new RegExp(`FAILED — .*${startRef} may be hidden, covered or gone`));
    const look = await call('look', { zoom: 2 });
    assert.ok(look.isError);
    assert.match(textOf(look), /Unrecognized key.*zoom/);
    assert.match(textOf(await call('act', { actions: [{ do: 'key', key: 'ArrowLeft', hold_ms: 100 }] })), /actions\.0: Unrecognized key.*hold_ms/);
    await call('clock', { action: 'resume' });
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

  test('status reports the campaign, and ends with the status line like every result', async () => {
    const result = await call('status');
    assert.match(textOf(result), /^test · running · 0 tokens in, 0 out/);
    assert.match((result.content.at(-1) as { text: string }).text, /^⏱ .* · run 1 of 2 · /);
  });

  test('templates, log and report start each run; log.md is the framework\'s', async () => {
    const memory = textOf(await call('files', { command: 'view', path: '/memory' }));
    for (const name of ['README.md', 'guide.md', 'lessons.md']) assert.match(memory, new RegExp(`${name} \\(\\d+ B, changed `));
    assert.match(textOf(await call('files', { command: 'view', path: '/run/report.md' })), /# Run 1[\s\S]*## Objective/);
    await call('log', { text: 'Chose hard mode: the guide says it scores double.' });
    const log = textOf(await call('files', { command: 'view', path: '/run/log.md' }));
    assert.match(log, /- \d\d:\d\d:\d\d .* \(\+\dm\d\ds\) Run 1 started/);
    assert.match(log, /\(\+\dm\d\ds\) Chose hard mode: the guide says it scores double\./);
    assert.match(textOf(await call('files', { command: 'create', path: '/run/log.md', file_text: 'x' })), /written by the engine/);
  });

  test('end_run seals the run; the next starts only when the driver begins it; the run limit ends the campaign', async () => {
    await call('files', { command: 'create', path: '/memory/notes.md', file_text: 'Rocks fall every 500 ms.' });
    let result = await call('end_run', { summary: 'Learned the controls.', next: 'new_run' });
    assert.match(textOf(result), /Run 1 ended\. End your turn: run 2 starts in a fresh session/);
    assert.match(textOf(await call('look')), /Run 1 has ended\. End your turn/);
    const facts = JSON.parse(await readFile(path.join(session.workspace.dir, 'run-001', 'run.json'), 'utf8'));
    assert.equal(facts.summary, 'Learned the controls.');
    assert.equal(facts.ended_by, 'end_run');
    assert.equal(facts.memory_updated, true);
    assert.equal(await readFile(path.join(session.workspace.dir, 'run-001', 'memory', 'notes.md'), 'utf8'), 'Rocks fall every 500 ms.');
    assert.match(await readFile(path.join(session.workspace.dir, 'ledger.md'), 'utf8'), /\| 1 \| .* \| end_run \| new_run \| Learned the controls\. \|/);
    await session.nextRun();
    assert.equal(session.run, 2);
    assert.match(textOf(await call('files', { command: 'view', path: '/memory/notes.md' })), /500 ms/);
    assert.match(textOf(await call('files', { command: 'view', path: '/runs' })), /run-001\/[\s\S]*run\.json[\s\S]*run-002\//);
    const transcript = (await readFile(path.join(session.workspace.dir, 'run-001', 'transcript.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(transcript.some((e) => e.type === 'tool' && e.name === 'look' && e.result.some((r: { image?: string }) => r.image === '/run/shots/0001.jpg')));

    await call('files', { command: 'create', path: '/memory/run2.md', file_text: 'Run 2 notes.' });
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
      assert.deepEqual(names, ['look', 'read_page', 'act', 'console', 'browser', 'files', 'status', 'log', 'notify', 'end_run']);
    } finally {
      await session.close();
    }
  });

  test('end_run holds once while /memory is unchanged; reopening at the limit leaves the run\'s facts alone', async () => {
    const config = await makeConfig({ limits: { runs: 1 } });
    const first = await Session.open(config, 'mcp');
    await first.begin();
    const box = new Toolbox(first);
    assert.match(textOf(await box.call('end_run', { summary: 'The only run.', next: 'new_run' })), /Run 1 has not ended: \/memory has not changed during this run\. Do the End step/);
    assert.equal(first.sealed, false);
    assert.match(textOf(await box.call('end_run', { summary: 'The only run.', next: 'new_run' })), /Run 1 ended\. The campaign is over: limit reached: 1 runs\.$/);
    await first.close();
    const facts = path.join(first.workspace.dir, 'run-001', 'run.json');
    const before = await readFile(facts, 'utf8');
    assert.equal(JSON.parse(before).memory_updated, false);
    const second = await Session.open(config, 'mcp');
    await second.begin();
    await second.close();
    assert.equal(second.doneReason, 'limit reached: 1 runs');
    assert.equal(await readFile(facts, 'utf8'), before);
  });

  test('no new run starts inside the wrap-up window', async () => {
    const session = await Session.open(await makeConfig({ limits: { runs: null, hours: 1, wrap_up_minutes: 61 } }), 'mcp');
    try {
      const box = new Toolbox(session);
      await session.begin();
      assert.equal(session.run, 1);
      await box.call('files', { command: 'create', path: '/memory/notes.md', file_text: 'Noted.' });
      const ended = await box.call('end_run', { summary: 'Out of time.', next: 'new_run' });
      assert.match(textOf(ended), /campaign is over: limit nearly reached \(\S+ left\): no new run in the wrap-up window/);
    } finally {
      await session.close();
    }
  });

  test('end_run keeps only the screenshots a file names, unless keep_shots is all; a stop keeps them all', async () => {
    for (const keep of ['referenced', 'all', 'stop'] as const) {
      const session = await Session.open(await makeConfig({ browser: { keep_shots: keep === 'all' ? 'all' : 'referenced' } }), 'mcp');
      try {
        const box = new Toolbox(session);
        await session.begin();
        for (let i = 0; i < 3; i += 1) await box.call('look', {});
        await box.call('files', { command: 'create', path: '/run/findings.md', file_text: 'Overlap: /run/shots/0002.jpg' });
        await box.call('files', { command: 'create', path: '/memory/notes.md', file_text: 'Goal ticked (/runs/run-001/shots/0003.jpg).' });
        if (keep === 'stop') await session.close('stopped');
        else await box.call('end_run', { summary: 'Looked.', next: 'new_run' });
        const shots = (await readdir(path.join(session.workspace.dir, 'run-001', 'shots'))).sort();
        assert.deepEqual(shots, keep === 'referenced' ? ['0002.jpg', '0003.jpg'] : ['0001.jpg', '0002.jpg', '0003.jpg']);
        await stat(path.join(session.workspace.dir, 'run-001', 'live.jpg'));
      } finally {
        await session.close();
      }
    }
  });

  test('clock times have two-digit hours', () => {
    assert.match(clockTime(new Date(2026, 9, 31, 0, 5, 7)), /^00:05:07 /);
  });

  test('look lists what can scroll: the page and areas on screen', async () => {
    const url = FIXTURE_URL.replace('game.html', 'scroll.html');
    const session = await Session.open(await makeConfig({ url }), 'mcp');
    try {
      await session.begin();
      const line = textOf(await new Toolbox(session).call('look', {}));
      assert.match(line, /scrollable: page ↓ \d+ px · area 20,20 \d+×\d+ ↓ \d+ px/);
    } finally {
      await session.close();
    }
  });

  test('usage is pending while an agent CLI session runs, so a crash leaves it unknown', async () => {
    const session = await Session.open(await makeConfig(), 'engine');
    try {
      await session.begin();
      const facts = async () => JSON.parse(await readFile(path.join(session.workspace.runDir, 'run.json'), 'utf8'));
      await session.awaitUsage();
      assert.equal((await facts()).usage_known, false);
      await session.addUsage({ input: 10, output: 5, cache_read: 0, cache_write: 0 }, 0.01, 3, true);
      assert.equal((await facts()).usage_known, true);
    } finally {
      await session.close();
    }
  });

  test('pace.seconds_per_call spaces out game tools only', async () => {
    const session = await Session.open(await makeConfig({ pace: { seconds_per_call: 0.4 } }), 'mcp');
    try {
      const box = new Toolbox(session);
      await session.begin();
      await box.call('console', {});
      let t = Date.now();
      await box.call('console', {});
      assert.ok(Date.now() - t >= 350, `game tool waited ${Date.now() - t} ms`);
      t = Date.now();
      await box.call('files', { command: 'view', path: '/memory' });
      assert.ok(Date.now() - t < 200, `workspace tool waited ${Date.now() - t} ms`);
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
      await session.workspace.startRun(new Date(), 'now');
      session.config.notify.command = 'exit 3';
      assert.match(textOf(await new Toolbox(session).call('notify', { title: 'Hi', message: 'x' })), /exited with code 3/);
      await session.notify('run_end', 'Run 1 ended', 'x');
      const failed = (await readFile(path.join(session.workspace.runDir, 'transcript.jsonl'), 'utf8')).split('\n').filter((l) => l.includes('"notify_failed"'));
      assert.equal(failed.length, 2);
      assert.match(failed[1]!, /"event":"run_end"/);
    } finally {
      await session.close();
    }
  });
});
