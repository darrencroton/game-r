import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { deviceNames, isProblem, type Point } from './browser.ts';
import type { Session } from './session.ts';

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/jpeg'; file: string };

export interface ToolResult {
  content: Content[];
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  input: z.ZodObject;
  run(args: any): Promise<Content[]>;
}

const MAX_TEXT = 30_000;

function text(value: string): Content {
  return { type: 'text', text: value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + '\n… truncated' : value };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function duration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

type ImageContent = Extract<Content, { type: 'image' }>;

async function image(session: Session, buf: Buffer): Promise<ImageContent> {
  const file = await session.saveShot(buf);
  return { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg', file };
}

async function pageLine(session: Session): Promise<string> {
  const { browser } = session;
  const page = browser.page;
  const vp = page.viewportSize();
  const clock = session.config.clock === 'allowed' ? ` · clock ${browser.paused ? 'paused' : 'running'} at ${seconds(await browser.gameTime())}` : '';
  return `${page.url()} · "${await page.title()}" · viewport ${vp?.width}×${vp?.height} css px · ${browser.device}${browser.orientation === 'landscape' ? ' landscape' : ''}${browser.hasTouch ? ' (touch)' : ''}${clock}`;
}

// ---------- act ----------

const ACTIONS = ['click', 'tap', 'hover', 'long_press', 'drag', 'swipe', 'pinch', 'key', 'keys', 'type', 'scroll', 'wait', 'goto', 'reload', 'back'] as const;

const ActionSchema = z.object({
  do: z.enum(ACTIONS),
  at: z.string().optional().describe('Target: a ref from read_page ("e12"), a grid cell from look ("F7", upper case), or CSS pixels "x,y".'),
  to: z.string().optional().describe('drag: destination target, same forms as at.'),
  key: z.string().optional().describe('key: a key name such as "ArrowUp", "Enter", "a", "Shift+Tab".'),
  keys: z.array(z.string()).optional().describe('keys: pressed together as a chord, e.g. ["Control", "s"].'),
  text: z.string().optional().describe('type: text to type.'),
  url: z.string().optional().describe('goto: URL.'),
  ms: z.number().int().min(0).max(120_000).optional().describe('wait: duration. key/keys/long_press: hold time. drag/swipe/pinch: gesture duration. Game time when the clock is paused.'),
  button: z.enum(['left', 'right', 'middle']).optional(),
  count: z.number().int().min(1).max(3).optional().describe('click: 2 for double-click.'),
  dir: z.enum(['up', 'down', 'left', 'right']).optional().describe('swipe: direction.'),
  distance: z.number().positive().optional().describe('swipe: length in CSS px (default 200).'),
  scale: z.number().positive().optional().describe('pinch: >1 zooms in, <1 zooms out.'),
  dx: z.number().optional(),
  dy: z.number().optional().describe('scroll: wheel deltas in px (positive dy scrolls down).'),
});

type Action = z.infer<typeof ActionSchema>;

const REF = /^(?:f\d+)?e\d+$/;
const CELL = /^[A-Z]+\d+$/;
const XY = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`needs "${what}"`);
  return value;
}

async function resolvePoint(session: Session, target: string): Promise<Point> {
  const xy = XY.exec(target);
  if (xy) return { x: Number(xy[1]), y: Number(xy[2]) };
  if (CELL.test(target)) return session.browser.cellCentre(target);
  if (REF.test(target)) {
    const loc = session.browser.page.locator(`aria-ref=${target}`);
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 });
    const box = await loc.boundingBox({ timeout: 5000 });
    if (!box) throw new Error(`${target} is not visible`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  throw new Error(`target "${target}" must be a ref like e12, a grid cell like F7, or x,y`);
}

async function gesture(session: Session, from: Point, to: Point, ms: number, fingers: (p: Point, t: number) => Point[]): Promise<void> {
  const { browser } = session;
  const steps = Math.max(4, Math.min(60, Math.round(ms / 16)));
  const at = (t: number): Point => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  const touch = browser.hasTouch && session.config.browser.engine === 'chromium';
  if (touch) {
    await browser.touch('touchStart', fingers(from, 0));
    for (let i = 1; i <= steps; i++) {
      await browser.wait(ms / steps);
      await browser.touch('touchMove', fingers(at(i / steps), i / steps));
    }
    await browser.touch('touchEnd', []);
    return;
  }
  if (fingers(from, 0).length > 1) throw new Error('pinch needs a touch device on the chromium engine');
  const mouse = browser.page.mouse;
  await mouse.move(from.x, from.y);
  await mouse.down();
  for (let i = 1; i <= steps; i++) {
    await browser.wait(ms / steps);
    const p = at(i / steps);
    await mouse.move(p.x, p.y);
  }
  await mouse.up();
}

async function runAction(session: Session, a: Action): Promise<string | void> {
  const { browser } = session;
  const page = browser.page;
  switch (a.do) {
    case 'click': {
      const at = need(a.at, 'at');
      const opts = { button: a.button ?? 'left', clickCount: a.count ?? 1 } as const;
      if (REF.test(at)) await page.locator(`aria-ref=${at}`).click({ ...opts, timeout: 5000 });
      else {
        const p = await resolvePoint(session, at);
        await page.mouse.click(p.x, p.y, opts);
      }
      return;
    }
    case 'tap': {
      const at = need(a.at, 'at');
      if (!browser.hasTouch) {
        await runAction(session, { do: 'click', at });
        return 'clicked: this device has no touch';
      }
      if (REF.test(at)) await page.locator(`aria-ref=${at}`).tap({ timeout: 5000 });
      else {
        const p = await resolvePoint(session, at);
        await page.touchscreen.tap(p.x, p.y);
      }
      return;
    }
    case 'hover': {
      const p = await resolvePoint(session, need(a.at, 'at'));
      await page.mouse.move(p.x, p.y);
      return;
    }
    case 'long_press': {
      const p = await resolvePoint(session, need(a.at, 'at'));
      await gesture(session, p, p, a.ms ?? 800, (q) => [q]);
      return;
    }
    case 'drag': {
      const from = await resolvePoint(session, need(a.at, 'at'));
      const to = await resolvePoint(session, need(a.to, 'to'));
      await gesture(session, from, to, a.ms ?? 300, (q) => [q]);
      return;
    }
    case 'swipe': {
      const from = await resolvePoint(session, need(a.at, 'at'));
      const d = a.distance ?? 200;
      const v = { up: [0, -d], down: [0, d], left: [-d, 0], right: [d, 0] }[need(a.dir, 'dir')]!;
      await gesture(session, from, { x: from.x + v[0]!, y: from.y + v[1]! }, a.ms ?? 250, (q) => [q]);
      return;
    }
    case 'pinch': {
      const c = await resolvePoint(session, need(a.at, 'at'));
      const scale = need(a.scale, 'scale');
      const start = 60;
      await gesture(session, c, c, a.ms ?? 300, (q, t) => {
        const half = (start * (1 + (scale - 1) * t)) / 2;
        return [{ x: q.x - half, y: q.y }, { x: q.x + half, y: q.y }];
      });
      return;
    }
    case 'key': {
      const key = need(a.key, 'key');
      if (a.ms) {
        await page.keyboard.down(key);
        await browser.wait(a.ms);
        await page.keyboard.up(key);
      } else await page.keyboard.press(key);
      return;
    }
    case 'keys': {
      const keys = need(a.keys, 'keys');
      for (const k of keys) await page.keyboard.down(k);
      await browser.wait(a.ms ?? 0);
      for (const k of [...keys].reverse()) await page.keyboard.up(k);
      return;
    }
    case 'type':
      await page.keyboard.type(need(a.text, 'text'));
      return;
    case 'scroll': {
      if (a.dx === undefined && a.dy === undefined) throw new Error('needs "dy" or "dx"');
      if (a.at) {
        const p = await resolvePoint(session, a.at);
        await page.mouse.move(p.x, p.y);
      }
      await page.mouse.wheel(a.dx ?? 0, a.dy ?? 0);
      return;
    }
    case 'wait':
      await browser.wait(need(a.ms, 'ms'));
      return;
    case 'goto':
      await page.goto(need(a.url, 'url'), { waitUntil: 'load', timeout: 60_000 });
      return;
    case 'reload':
      await page.reload({ waitUntil: 'load', timeout: 60_000 });
      return;
    case 'back':
      await page.goBack({ waitUntil: 'load', timeout: 60_000 });
      return;
  }
}

function describeAction(a: Action): string {
  const parts: string[] = [a.do];
  if (a.at) parts.push(a.at);
  if (a.to) parts.push(`→ ${a.to}`);
  if (a.key) parts.push(a.key);
  if (a.keys) parts.push(a.keys.join('+'));
  if (a.dir) parts.push(a.dir);
  if (a.text !== undefined) parts.push(JSON.stringify(a.text.length > 40 ? a.text.slice(0, 40) + '…' : a.text));
  if (a.url) parts.push(a.url);
  if (a.ms !== undefined) parts.push(`${a.ms}ms`);
  return parts.join(' ');
}

function firstLine(err: unknown): string {
  return String((err as Error)?.message ?? err).split('\n')[0]!.replace(/^(locator|page|mouse|keyboard|touchscreen)\.\w+: /, '');
}

function consoleSummary(session: Session, since: number): string {
  const entries = session.browser.entriesSince(since).filter((e) => isProblem(e.level));
  if (!entries.length) return '';
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.level, (counts.get(e.level) ?? 0) + 1);
  const latest = entries.at(-1)!;
  return `\nconsole: ${[...counts].map(([k, n]) => `${n} ${k}`).join(', ')} since this act — latest: ${latest.text.split('\n')[0]!.slice(0, 160)}`;
}

// ---------- tools ----------

export function createTools(session: Session): Tool[] {
  const { config, browser, files } = session;
  const tools: Tool[] = [];

  tools.push({
    name: 'look',
    description:
      'Screenshot of the game. Image pixels are CSS pixels, so a point in the image is the "x,y" you can target. ' +
      'grid overlays labelled cells (true = 64 px cells, or a number for the cell size) for aiming at canvas content by cell name. ' +
      'region [x,y,w,h] zooms in at device resolution. save_as copies the image to /run or /memory (e.g. "/run/findings/menu-overlap.jpg"). ' +
      'Every screenshot is also kept under /run/shots.',
    input: z.object({
      grid: z.union([z.boolean(), z.number().int().min(16).max(400)]).optional(),
      region: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]).optional(),
      save_as: z.string().optional(),
    }),
    async run({ grid, region, save_as }) {
      const size = grid === true ? 64 : grid || undefined;
      const shot = await image(session, await browser.screenshot({ grid: size, region }));
      let line = `${await pageLine(session)}${size ? ` · grid ${size}px` : ''}${region ? ` · region ${region.join(',')}` : ''} · ${shot.file}`;
      if (save_as) {
        const dest = files.resolve(save_as, true).abs;
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(files.resolve(shot.file, false).abs, dest);
        line += ` · saved as ${save_as}`;
      }
      return [shot, text(line)];
    },
  });

  tools.push({
    name: 'read_page',
    description:
      'Accessibility snapshot of the page: roles, names, text and refs like [ref=e12] to target with act. ' +
      'Best for menus, dialogs, HUD text and forms; canvas content is not described (use look). ' +
      'boxes adds [box=x,y,w,h] in CSS px. find keeps only lines containing that text (case-insensitive).',
    input: z.object({
      boxes: z.boolean().optional(),
      find: z.string().optional(),
      depth: z.number().int().positive().optional(),
    }),
    async run({ boxes, find, depth }) {
      let snap = await browser.page.ariaSnapshot({ mode: 'ai', boxes: boxes ?? false, depth, timeout: 20_000 });
      if (find) {
        const needle = find.toLowerCase();
        const hits = snap.split('\n').filter((l) => l.toLowerCase().includes(needle));
        snap = hits.length ? hits.join('\n') : `No lines contain "${find}".`;
      }
      return [text(`${await pageLine(session)}\n${snap}`)];
    },
  });

  tools.push({
    name: 'act',
    description:
      'Send a batch of inputs, in order. Stops at the first failure and reports why. ' +
      'Each action is {do, ...}: click {at, button?, count?} · tap {at} · hover {at} · long_press {at, ms?} · drag {at, to, ms?} · ' +
      'swipe {at, dir, distance?, ms?} · pinch {at, scale, ms?} · key {key, ms? (hold)} · keys {keys (chord), ms?} · type {text} · ' +
      'scroll {at?, dy, dx?} · wait {ms} · goto {url} · reload · back. ' +
      'Targets: a ref from read_page ("e12"), a grid cell from look ("F7"), or "x,y" in CSS px. ' +
      'While the clock is paused, waits, holds and gestures advance game time by their ms and nothing else moves time. ' +
      'look_after returns a screenshot once the batch is done.',
    input: z.object({
      actions: z.array(ActionSchema).min(1).max(50),
      look_after: z.boolean().optional(),
    }),
    async run({ actions, look_after }) {
      const since = browser.logSeq;
      const lines: string[] = [];
      for (const [i, a] of (actions as Action[]).entries()) {
        try {
          const note = await runAction(session, a);
          lines.push(`${i + 1}. ${describeAction(a)}: ok${note ? ` (${note})` : ''}`);
        } catch (err) {
          lines.push(`${i + 1}. ${describeAction(a)}: FAILED — ${firstLine(err)}`);
          if (i < actions.length - 1) lines.push(`(${actions.length - i - 1} remaining action(s) not run)`);
          break;
        }
      }
      const out: Content[] = [text(lines.join('\n') + consoleSummary(session, since))];
      if (look_after) out.push(await image(session, await browser.screenshot({})), text(await pageLine(session)));
      return out;
    },
  });

  tools.push({
    name: 'console',
    description:
      'Browser console messages, uncaught page errors, failed or 4xx/5xx network requests and auto-accepted dialogs. ' +
      'By default returns what is new since the last call; all returns everything kept for this run. problems_only drops logs and info.',
    input: z.object({
      all: z.boolean().optional(),
      problems_only: z.boolean().optional(),
      limit: z.number().int().positive().max(500).optional(),
    }),
    async run({ all, problems_only, limit }) {
      let entries = browser.readLog(all ?? false);
      if (problems_only) entries = entries.filter((e) => isProblem(e.level));
      const shown = entries.slice(-(limit ?? 100));
      if (!shown.length) return [text('Nothing new in the console.')];
      const skipped = entries.length - shown.length;
      return [text((skipped ? `(${skipped} earlier entries not shown)\n` : '') + shown.map((e) => `+${seconds(e.at)} ${e.level.padEnd(9)} ${e.text}`).join('\n'))];
    },
  });

  if (config.clock === 'allowed') {
    tools.push({
      name: 'clock',
      description:
        "Control the page's game time: requestAnimationFrame, setTimeout/setInterval, Date and performance.now. " +
        'pause freezes the game while you think; advance {ms} runs it forward by that much game time; resume returns to real time. ' +
        'Not covered: Web Audio, CSS animations and timers inside Web Workers. Inputs still reach the page while paused, ' +
        'but the game only reacts as time advances. Use it if pausing suits the game and your instructions.',
      input: z.object({
        action: z.enum(['pause', 'resume', 'advance', 'status']),
        ms: z.number().int().positive().max(3_600_000).optional(),
      }),
      async run({ action, ms }) {
        if (action === 'pause') await browser.pause();
        if (action === 'resume') await browser.resume();
        if (action === 'advance') {
          if (!browser.paused) throw new Error('advance needs the clock paused first.');
          await browser.advance(need(ms, 'ms'));
        }
        return [text(`clock ${browser.paused ? 'paused' : 'running'} · game time ${seconds(await browser.gameTime())}`)];
      },
    });
  }

  tools.push({
    name: 'browser',
    description:
      'Change the emulated device or screen. orientation and viewport resize the page in place (like rotating a phone). ' +
      'device changes the device profile (touch, user agent, pixel ratio) and restart reopens the browser: both reload the page at its current URL, ' +
      'so in-memory game state is lost while saved data (localStorage, IndexedDB, cookies) is kept. Call with no arguments to see the current setup.',
    input: z.object({
      device: z.string().optional().describe('"desktop" or a Playwright device name, e.g. "Pixel 7", "iPhone 15", "iPad Pro 11".'),
      orientation: z.enum(['portrait', 'landscape']).optional(),
      viewport: z.tuple([z.number().int().positive(), z.number().int().positive()]).nullable().optional().describe('[width, height] in CSS px; null returns to the device default.'),
      restart: z.boolean().optional(),
    }),
    async run({ device, orientation, viewport, restart }) {
      const notes: string[] = [];
      if (device !== undefined) {
        const match = deviceNames().find((d) => d.toLowerCase() === device.toLowerCase());
        if (!match) {
          const near = deviceNames().filter((d) => d.toLowerCase().includes(device.toLowerCase().split(' ')[0]!)).slice(0, 12);
          throw new Error(`Unknown device "${device}".${near.length ? ` Similar: ${near.join(', ')}` : ''}`);
        }
        browser.device = match.replace(/ landscape$/i, '');
        if (/ landscape$/i.test(match)) browser.orientation = 'landscape';
        restart = true;
      }
      if (orientation !== undefined) browser.orientation = orientation;
      if (viewport !== undefined) browser.viewport = viewport;
      if (restart) {
        const url = await browser.relaunch();
        notes.push(`reopened ${url}`);
      } else if (orientation !== undefined || viewport !== undefined) {
        const vp = browser.contextOptions().viewport!;
        await browser.page.setViewportSize(vp);
        notes.push('resized in place');
      }
      return [text(`${await pageLine(session)}${notes.length ? `\n${notes.join('; ')}` : ''}`)];
    },
  });

  if (config.access === 'developer') {
    tools.push({
      name: 'evaluate',
      description: 'Developer access: evaluate a JavaScript expression in the page and return its JSON value. Promises are awaited.',
      input: z.object({ expression: z.string().min(1) }),
      async run({ expression }) {
        const value = await browser.page.evaluate(expression);
        return [text(value === undefined ? 'undefined' : JSON.stringify(value, null, 2) ?? String(value))];
      },
    });
  }

  tools.push({
    name: 'files',
    description:
      'Your workspace. /memory is yours and persists across runs and context refreshes: keep it organised and current. ' +
      '/run is this run (write logs, reports, findings there). /runs holds every run of this campaign, read-only. ' +
      'Commands: view {path, view_range?} (directories list their contents) · create {path, file_text} · ' +
      'str_replace {path, old_str, new_str} (old_str must be unique) · insert {path, insert_line, insert_text} · delete {path} · rename {old_path, new_path}.',
    input: z.object({
      command: z.enum(['view', 'create', 'str_replace', 'insert', 'delete', 'rename']),
      path: z.string().optional(),
      view_range: z.tuple([z.number().int(), z.number().int()]).optional(),
      file_text: z.string().optional(),
      old_str: z.string().optional(),
      new_str: z.string().optional(),
      insert_line: z.number().int().optional(),
      insert_text: z.string().optional(),
      old_path: z.string().optional(),
      new_path: z.string().optional(),
    }),
    async run(a) {
      switch (a.command) {
        case 'view':
          return [text(await files.view(need(a.path, 'path'), a.view_range))];
        case 'create':
          return [text(await files.create(need(a.path, 'path'), need(a.file_text, 'file_text')))];
        case 'str_replace':
          return [text(await files.strReplace(need(a.path, 'path'), need(a.old_str, 'old_str'), a.new_str ?? ''))];
        case 'insert':
          return [text(await files.insert(need(a.path, 'path'), need(a.insert_line, 'insert_line'), need(a.insert_text, 'insert_text')))];
        case 'delete':
          return [text(await files.delete(need(a.path, 'path')))];
        default:
          return [text(await files.rename(need(a.old_path, 'old_path'), need(a.new_path, 'new_path')))];
      }
    },
  });

  tools.push({
    name: 'status',
    description: 'Elapsed wall time, run number, turns, tokens, cost and the hard limits with what remains.',
    input: z.object({}),
    async run() {
      const { limits } = config;
      const left = (used: number, limit: number | null, fmt: (n: number) => string) => (limit === null ? 'no limit' : `limit ${fmt(limit)}, ${fmt(Math.max(0, limit - used))} left`);
      const u = session.usage;
      const lines = [
        `Campaign ${config.name} · ${session.state}${session.doneReason ? ` (${session.doneReason})` : ''} · now ${new Date().toISOString()}`,
        `Run ${session.run} (${left(session.run, limits.runs, String)})`,
        `Wall time: campaign ${duration(session.elapsedMs)} (${left(session.elapsedMs, limits.hours === null ? null : limits.hours * 3_600_000, duration)}) · this run ${duration(session.runElapsedMs)}`,
      ];
      if (session.mode === 'engine') {
        lines.push(
          `Turns: ${session.turnsThisRun} this run (${left(session.turnsThisRun, limits.turns_per_run, String)}) · ${u.turns} in total`,
          `Tokens: ${u.input_tokens.toLocaleString()} in, ${u.output_tokens.toLocaleString()} out · cost $${u.cost_usd.toFixed(2)} (${left(u.cost_usd, limits.cost_usd, (n) => `$${n.toFixed(2)}`)})`,
        );
      } else lines.push('Turns, tokens and cost are not tracked when playing through MCP.');
      if (config.clock === 'allowed' && session.state === 'running') lines.push(`Clock: ${browser.paused ? 'paused' : 'running'} · game time ${seconds(await browser.gameTime())}`);
      return [text(lines.join('\n'))];
    },
  });

  tools.push({
    name: 'notify',
    description: 'Send the user a notification now. Use it for what they would want to know straight away: a serious finding, a milestone, a problem you cannot get past.',
    input: z.object({
      title: z.string().min(1).max(120),
      message: z.string().min(1).max(1000),
      level: z.enum(['info', 'finding', 'milestone', 'problem']).optional(),
    }),
    async run({ title, message, level }) {
      return [text(await session.notify('agent', title, message, level ?? 'info'))];
    },
  });

  tools.push({
    name: 'end_run',
    description:
      'End this run. Before calling, record in /memory what you learned and what to try next. ' +
      'next "new_run" starts a fresh run (the page reopens at the game URL; /memory carries over); "done" ends the campaign.',
    input: z.object({
      summary: z.string().min(1).max(4000),
      next: z.enum(['new_run', 'done']),
    }),
    async run({ summary, next }) {
      const ended = await session.endRun(summary, next);
      if (ended) return [text(`Run ended. The campaign is over: ${ended}.`)];
      return [text(`Run ended. Run ${session.run} has started at ${config.url}.`), await image(session, await browser.screenshot({}))];
    },
  });

  return tools;
}

const ALWAYS_AVAILABLE = new Set(['status', 'files']);

export class Toolbox {
  readonly tools: Tool[];
  private readonly byName: Map<string, Tool>;
  private readonly session: Session;

  constructor(session: Session) {
    this.session = session;
    this.tools = createTools(session);
    this.byName = new Map(this.tools.map((t) => [t.name, t]));
  }

  async call(name: string, args: unknown): Promise<ToolResult> {
    const { session } = this;
    const tool = this.byName.get(name);
    let result: ToolResult;
    if (!tool) result = fail(`Unknown tool "${name}".`);
    else if (session.state === 'done' && !ALWAYS_AVAILABLE.has(name)) result = fail(`The campaign has ended: ${session.doneReason}.`);
    else {
      const limit = session.state === 'running' ? session.limitReached() : null;
      if (limit) {
        await session.finish(limit);
        result = fail(`The campaign has ended: ${limit}.`);
      } else {
        const parsed = tool.input.safeParse(args ?? {});
        if (!parsed.success) result = fail(`Invalid arguments for ${name}:\n${parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}`);
        else {
          try {
            result = { content: await tool.run(parsed.data) };
          } catch (err) {
            result = fail(firstLine(err));
          }
        }
      }
    }
    if (result.isError) session.lastError = (result.content[0] as { text: string }).text;
    const logged = result.content.map((c) => (c.type === 'image' ? { image: c.file } : { text: c.text }));
    await session.workspace.log({ type: 'tool', name, args, result: logged, error: result.isError ?? false });
    await session.saveStatus({ last_tool: name });
    return result;
  }
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
