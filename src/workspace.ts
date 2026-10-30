import { appendFile, copyFile, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import type { Config } from './config.ts';

export const ENGINE_FILES = new Set(['transcript.jsonl', 'shots', 'live.jpg', 'run.json', 'log.md', 'video', 'trace.zip']);

const TEMPLATES = new URL('../templates/', import.meta.url).pathname;

/** The facts of one run, written only by the framework. */
export interface RunFacts {
  run: number;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  calls?: number;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  usage_known?: boolean;
  ended_by?: string;
  next?: string;
  summary?: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class Workspace {
  readonly dir: string;
  readonly memoryDir: string;
  readonly profileDir: string;
  private readonly lockFile: string;
  private locked = false;
  readonly config: Config;
  run = 0;

  constructor(config: Config) {
    this.config = config;
    this.dir = path.join(config.output, config.name);
    this.memoryDir = path.join(this.dir, 'memory');
    this.profileDir = path.join(this.dir, 'profile');
    this.lockFile = path.join(this.dir, 'campaign.lock');
  }

  get runDir(): string {
    return path.join(this.dir, runName(this.run));
  }

  async open(): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true });
    await this.lock();
    await writeFile(path.join(this.dir, 'config.yaml'), stringify(this.config));
    this.run = (await this.runNumbers()).at(-1) ?? 0;
  }

  private async lock(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(this.lockFile, 'wx');
        await handle.writeFile(String(process.pid));
        await handle.close();
        this.locked = true;
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const pid = Number((await readFile(this.lockFile, 'utf8').catch(() => '')).trim());
        if (pid && pidAlive(pid)) throw new Error(`Campaign "${this.config.name}" is already running (pid ${pid}).`);
        await rm(this.lockFile, { force: true });
      }
    }
    throw new Error(`Could not lock ${this.lockFile}`);
  }

  async runNumbers(): Promise<number[]> {
    const entries = await readdir(this.dir, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((e) => e.isDirectory() && /^run-\d+$/.test(e.name))
      .map((e) => Number(e.name.slice(4)))
      .sort((a, b) => a - b);
  }

  /** Creates the next run's folder, its report from the template, and the memory templates if /memory is empty. */
  async startRun(startedAt: Date, started: string): Promise<number> {
    this.run += 1;
    await mkdir(path.join(this.runDir, 'shots'), { recursive: true });
    if (this.config.browser.profile === 'run') await rm(this.profileDir, { recursive: true, force: true });
    if (!(await readdir(this.memoryDir)).some((name) => !name.startsWith('.'))) {
      for (const name of await readdir(path.join(TEMPLATES, 'memory'))) await copyFile(path.join(TEMPLATES, 'memory', name), path.join(this.memoryDir, name));
    }
    const report = await readFile(path.join(TEMPLATES, 'run', 'report.md'), 'utf8');
    await writeFile(path.join(this.runDir, 'report.md'), report.replace('{{run}}', String(this.run)).replace('{{started}}', started));
    await this.saveRun({ run: this.run, started_at: startedAt.toISOString() });
    return this.run;
  }

  /** True while /memory/README.md is still the template. */
  async memoryIsTemplate(): Promise<boolean> {
    const [mine, template] = await Promise.all([
      readFile(path.join(this.memoryDir, 'README.md'), 'utf8').catch(() => null),
      readFile(path.join(TEMPLATES, 'memory', 'README.md'), 'utf8'),
    ]);
    return mine === null || mine === template;
  }

  /** Writes run.json (atomically) and, unless told not to, regenerates ledger.md. */
  async saveRun(facts: RunFacts, ledger = true): Promise<void> {
    const file = path.join(this.dir, runName(facts.run), 'run.json');
    await writeFile(`${file}.tmp`, JSON.stringify(facts, null, 2));
    await rename(`${file}.tmp`, file);
    if (ledger) await writeFile(path.join(this.dir, 'ledger.md'), await this.ledger());
  }

  /** A table of every run, built from their run.json files. */
  async ledger(): Promise<string> {
    const rows: string[] = [];
    for (const n of await this.runNumbers()) {
      let f: RunFacts | null;
      try {
        f = JSON.parse(await readFile(path.join(this.dir, runName(n), 'run.json'), 'utf8').catch(() => 'null'));
      } catch {
        rows.push(`| ${n} | | | | | run.json unreadable | | |`);
        continue;
      }
      if (!f) continue;
      const minutes = f.duration_ms === undefined ? '' : `${Math.round(f.duration_ms / 60_000)} min`;
      const cost = f.usage_known === false ? 'unknown' : f.cost_usd === undefined ? '' : `$${f.cost_usd.toFixed(2)}`;
      const ended = f.ended_at ? (f.ended_by ?? '') : n === this.run && this.locked ? 'running' : 'interrupted';
      const summary = (f.summary ?? '').split('\n')[0]!.slice(0, 200).replace(/\|/g, '/');
      const started = new Date(f.started_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short', hour12: false });
      rows.push(`| ${n} | ${started} | ${minutes} | ${f.calls ?? ''} | ${cost} | ${ended} | ${f.next ?? ''} | ${summary} |`);
    }
    return `# Runs of ${this.config.name}\n\n| Run | Started | Time | Calls | Cost | Ended by | Next | Summary |\n|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`;
  }

  async timeline(line: string): Promise<void> {
    if (!this.run) return;
    await appendFile(path.join(this.runDir, 'log.md'), line + '\n');
  }

  async log(event: Record<string, unknown>): Promise<void> {
    if (!this.run) return;
    await appendFile(path.join(this.runDir, 'transcript.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n');
  }

  async writeStatus(status: Record<string, unknown>): Promise<void> {
    await writeFile(path.join(this.dir, 'status.json'), JSON.stringify({ ...status, updated_at: new Date().toISOString() }, null, 2));
  }

  async close(): Promise<void> {
    if (this.locked) await rm(this.lockFile, { force: true });
    this.locked = false;
  }
}

export function runName(n: number): string {
  return `run-${String(n).padStart(3, '0')}`;
}
