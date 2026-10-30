import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, devices, firefox, webkit, type BrowserContext, type BrowserContextOptions, type CDPSession, type Page } from 'playwright';
import type { Config } from './config.ts';

export interface Point {
  x: number;
  y: number;
}

export interface LogEntry {
  seq: number;
  at: number;
  level: string;
  text: string;
}

const MAX_LOG = 2000;
const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
const GRID_DEFAULT = 64;

export function deviceNames(): string[] {
  return ['desktop', ...Object.keys(devices)];
}

function findDevice(name: string): BrowserContextOptions | null {
  if (name.toLowerCase() === 'desktop') return { ...DESKTOP };
  const key = Object.keys(devices).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? { ...devices[key] } : null;
}

export class GameBrowser {
  context: BrowserContext | null = null;
  private pageRef: Page | null = null;
  private cdp: CDPSession | null = null;
  private log: LogEntry[] = [];
  private seq = 0;
  private readSeq = 0;
  private origin = Date.now();
  device: string;
  viewport: [number, number] | null;
  orientation: 'portrait' | 'landscape' = 'portrait';
  paused = false;
  gridSize = GRID_DEFAULT;

  private readonly cfg: Config['browser'];
  private readonly clockAllowed: boolean;
  private readonly dirs: () => { profile: string; run: string };

  constructor(cfg: Config['browser'], clockAllowed: boolean, dirs: () => { profile: string; run: string }) {
    this.cfg = cfg;
    this.clockAllowed = clockAllowed;
    this.dirs = dirs;
    this.device = cfg.device;
    this.viewport = cfg.viewport;
    if (!findDevice(this.device)) throw new Error(`Unknown device "${this.device}". Try "desktop" or a Playwright device name such as "Pixel 7".`);
  }

  get page(): Page {
    if (!this.pageRef || this.pageRef.isClosed()) throw new Error('The browser is not open. Use the browser tool with restart: true.');
    return this.pageRef;
  }

  get hasTouch(): boolean {
    return Boolean(this.contextOptions().hasTouch);
  }

  contextOptions(): BrowserContextOptions {
    const base = findDevice(this.device) ?? { ...DESKTOP };
    let opts: BrowserContextOptions = { ...base };
    if (this.orientation === 'landscape') {
      const land = findDevice(`${this.device} landscape`);
      if (land) opts = land;
      else if (opts.viewport) {
        opts.viewport = { width: opts.viewport.height, height: opts.viewport.width };
        if (opts.screen) opts.screen = { width: opts.screen.height, height: opts.screen.width };
      }
    }
    if (this.viewport) {
      opts.viewport = { width: this.viewport[0], height: this.viewport[1] };
      opts.screen = { ...opts.viewport };
    }
    if (this.cfg.engine === 'firefox') delete opts.isMobile;
    return opts;
  }

  async launch(url: string): Promise<void> {
    await this.close();
    const { profile, run } = this.dirs();
    const engine = { chromium, firefox, webkit }[this.cfg.engine];
    const context = await engine.launchPersistentContext(profile, {
      ...this.contextOptions(),
      headless: this.cfg.headless,
      recordVideo: this.cfg.record_video ? { dir: path.join(run, 'video') } : undefined,
    });
    this.context = context;
    if (this.cfg.trace) await context.tracing.start({ screenshots: true, snapshots: true });
    if (this.clockAllowed) await context.clock.install();
    this.paused = false;
    context.on('page', (page) => this.watch(page));
    for (const page of context.pages()) this.watch(page);
    const page = context.pages()[0] ?? (await context.newPage());
    this.pageRef = page;
    this.cdp = this.cfg.engine === 'chromium' ? await context.newCDPSession(page) : null;
    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  }

  async relaunch(): Promise<string> {
    const url = this.pageRef && !this.pageRef.isClosed() ? this.pageRef.url() : null;
    if (!url || url === 'about:blank') throw new Error('No page to reopen.');
    await this.launch(url);
    return url;
  }

  private watch(page: Page): void {
    page.on('console', (msg) => this.push(msg.type(), msg.text() + location(msg.location())));
    page.on('pageerror', (err) => this.push('pageerror', err.stack ?? err.message));
    page.on('requestfailed', (req) => this.push('network', `${req.method()} ${req.url()} failed: ${req.failure()?.errorText ?? 'unknown'}`));
    page.on('response', (res) => {
      if (res.status() >= 400) this.push('network', `${res.request().method()} ${res.url()} → ${res.status()}`);
    });
    page.on('dialog', async (dialog) => {
      this.push('dialog', `${dialog.type()} "${dialog.message()}" (accepted automatically)`);
      await dialog.accept(dialog.defaultValue()).catch(() => {});
    });
    page.on('popup', (popup) => this.push('info', `The page opened a new tab: ${popup.url()}`));
  }

  private push(level: string, text: string): void {
    this.log.push({ seq: this.seq++, at: Date.now() - this.origin, level, text });
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
  }

  resetLogOrigin(): void {
    this.origin = Date.now();
    this.log = [];
    this.readSeq = this.seq;
  }

  /** Entries not yet read (or all kept entries), marking everything as read. */
  readLog(all: boolean): LogEntry[] {
    const entries = all ? this.log.slice() : this.entriesSince(this.readSeq);
    this.readSeq = this.seq;
    return entries;
  }

  entriesSince(seq: number): LogEntry[] {
    return this.log.filter((e) => e.seq >= seq);
  }

  get logSeq(): number {
    return this.seq;
  }

  async gameTime(): Promise<number> {
    return this.page.evaluate(() => performance.now());
  }

  async pause(): Promise<void> {
    if (!this.context || !this.clockAllowed) throw new Error('The clock is not available.');
    for (let attempt = 1; attempt <= 3; attempt++) {
      const now = await this.page.evaluate(() => Date.now());
      try {
        await this.context.clock.pauseAt(now + 25 * attempt);
        this.paused = true;
        return;
      } catch (err) {
        if (!/past/.test(String(err))) throw err;
      }
    }
    await this.context.clock.resume().catch(() => {});
    throw new Error('Could not pause the clock; it is still running.');
  }

  async resume(): Promise<void> {
    if (!this.context || !this.clockAllowed) throw new Error('The clock is not available.');
    await this.context.clock.resume();
    this.paused = false;
  }

  async advance(ms: number): Promise<void> {
    if (!this.context || !this.clockAllowed) throw new Error('The clock is not available.');
    await this.context.clock.runFor(ms);
  }

  async wait(ms: number): Promise<void> {
    if (ms <= 0) return;
    if (this.paused) await this.advance(ms);
    else await sleep(ms);
  }

  async screenshot(opts: { grid?: number; region?: [number, number, number, number] }): Promise<Buffer> {
    const page = this.page;
    const vp = page.viewportSize() ?? { width: 1280, height: 800 };
    if (opts.grid) this.gridSize = opts.grid;
    return page.screenshot({
      type: 'jpeg',
      quality: 80,
      scale: opts.region ? 'device' : 'css',
      animations: 'allow',
      caret: 'initial',
      timeout: 20_000,
      style: opts.grid ? gridStyle(vp.width, vp.height, opts.grid) : undefined,
      clip: opts.region ? { x: opts.region[0], y: opts.region[1], width: opts.region[2], height: opts.region[3] } : undefined,
    });
  }

  cellCentre(cell: string): Point {
    const m = /^([A-Z]+)(\d+)$/.exec(cell);
    if (!m) throw new Error(`Bad cell "${cell}".`);
    let col = 0;
    for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
    const s = this.gridSize;
    return { x: (col - 1) * s + s / 2, y: (Number(m[2]) - 1) * s + s / 2 };
  }

  async touch(type: 'touchStart' | 'touchMove' | 'touchEnd', points: Point[]): Promise<void> {
    if (!this.cdp) throw new Error('Multi-touch needs the chromium engine.');
    await this.cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : points.map((p, id) => ({ x: p.x, y: p.y, id })),
    });
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.pageRef = null;
    this.cdp = null;
    if (!context) return;
    if (this.cfg.trace) await context.tracing.stop({ path: path.join(this.dirs().run, 'trace.zip') }).catch(() => {});
    await context.close().catch(() => {});
  }
}

export function isProblem(level: string): boolean {
  return level === 'error' || level === 'pageerror' || level === 'network' || level === 'dialog';
}

function location(loc: { url: string; lineNumber: number }): string {
  if (!loc.url) return '';
  const file = loc.url.split('/').pop()?.split('?')[0] ?? loc.url;
  return ` (${file}:${loc.lineNumber + 1})`;
}

export function columnLabel(index: number): string {
  let label = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
  return label;
}

/** Reads a documentation page's visible text in a throwaway headless browser, apart from the game's context. */
export async function readDocument(engine: 'chromium' | 'firefox' | 'webkit', url: string): Promise<string> {
  const protocol = new URL(url).protocol;
  if (protocol !== 'http:' && protocol !== 'https:') throw new Error(`Only http(s) URLs can be read, not ${protocol}`);
  const browser = await { chromium, firefox, webkit }[engine].launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    const text = await page.locator('body').innerText();
    return text.replace(/\n{3,}/g, '\n\n').trim();
  } finally {
    await browser.close();
  }
}

function gridStyle(width: number, height: number, size: number): string {
  let lines = '';
  for (let x = size; x < width; x += size) lines += `M${x},0V${height}`;
  for (let y = size; y < height; y += size) lines += `M0,${y}H${width}`;
  let labels = '';
  for (let c = 0; c * size < width; c++) {
    for (let r = 0; r * size < height; r++) labels += `<text x='${c * size + 2}' y='${r * size + 10}'>${columnLabel(c)}${r + 1}</text>`;
  }
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'>` +
    `<path d='${lines}' stroke='rgba(255,0,255,0.55)' stroke-width='1' fill='none'/>` +
    `<g style='font:bold 9px monospace;fill:#fff;stroke:#000;stroke-width:2px;paint-order:stroke'>${labels}</g></svg>`;
  return `html::after{content:'';position:fixed;inset:0;z-index:2147483647;pointer-events:none;background:url("data:image/svg+xml,${encodeURIComponent(svg)}") 0 0/100% 100% no-repeat}`;
}
