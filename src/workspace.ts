import { constants } from 'node:fs';
import { appendFile, chmod, copyFile, cp, lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import type { Config } from './config.ts';

export const ENGINE_FILES = new Set(['transcript.jsonl', 'shots', 'live.jpg', 'run.json', 'log.md', 'memory', 'video', 'trace.zip', 'downloads']);

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
  memory_updated?: boolean;
  ended_by?: string;
  next?: string;
  summary?: string;
}

export function pidAlive(pid: number): boolean {
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
  private writes = 0;
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

  /**
   * Creates the next run's folder and its report; on the first run, copies in the memory templates the user hasn't provided.
   * A fresh profile is empty, or a copy of browser.profile_from: for every run with profile: run; with profile_from, also
   * for the first run and for a run after one the agent ended (end_run).
   */
  async startRun(startedAt: Date, started: string): Promise<number> {
    const from = this.config.browser.profile_from;
    const fresh = this.config.browser.profile === 'run' || (from !== null && (this.run === 0 || (await this.endedBy(this.run)) === 'end_run'));
    this.run += 1;
    await mkdir(path.join(this.runDir, 'shots'), { recursive: true });
    if (fresh) {
      await rm(this.profileDir, { recursive: true, force: true });
      if (from) await copyWritable(from, this.profileDir);
    }
    if (this.run === 1) {
      for (const name of await readdir(path.join(TEMPLATES, 'memory'))) {
        await copyFile(path.join(TEMPLATES, 'memory', name), path.join(this.memoryDir, name), constants.COPYFILE_EXCL).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'EEXIST') throw err;
        });
      }
    }
    const report = await readFile(path.join(TEMPLATES, 'run', 'report.md'), 'utf8');
    await writeFile(path.join(this.runDir, 'report.md'), report.replace('{{run}}', String(this.run)).replace('{{started}}', started));
    await this.saveRun({ run: this.run, started_at: startedAt.toISOString() });
    return this.run;
  }

  private async endedBy(run: number): Promise<string | undefined> {
    const text = await readFile(path.join(this.dir, runName(run), 'run.json'), 'utf8').catch(() => 'null');
    try {
      return (JSON.parse(text) as RunFacts | null)?.ended_by;
    } catch {
      return undefined;
    }
  }

  /** True while /memory/README.md is still the template. */
  async memoryIsTemplate(): Promise<boolean> {
    const [mine, template] = await Promise.all([
      readFile(path.join(this.memoryDir, 'README.md'), 'utf8').catch(() => null),
      readFile(path.join(TEMPLATES, 'memory', 'README.md'), 'utf8'),
    ]);
    return mine === template;
  }

  /** A fingerprint of /memory (every name and its last change), to tell whether a run changed it. */
  async memoryStamp(): Promise<string> {
    const names = (await readdir(this.memoryDir, { recursive: true })).sort();
    const parts: string[] = [];
    for (const name of names) parts.push(`${name}@${(await stat(path.join(this.memoryDir, name))).mtimeMs}`);
    return parts.join('|');
  }

  /** Copies /memory into run-NNN/memory as it is now, replacing any earlier copy for that run. */
  async snapshotMemory(run: number): Promise<void> {
    const dest = path.join(this.dir, runName(run), 'memory');
    await rm(dest, { recursive: true, force: true });
    await cp(this.memoryDir, dest, { recursive: true });
  }

  /** Deletes the run's screenshots that no file in the run folder (bar the transcript and media) or in /memory names. */
  async pruneShots(): Promise<void> {
    const shots = path.join(this.runDir, 'shots');
    const named = new Set<string>();
    for (const dir of [this.runDir, this.memoryDir]) {
      for (const name of await readdir(dir, { recursive: true })) {
        if (name === 'transcript.jsonl' || name.split(path.sep)[0] === 'downloads' || /\.(jpe?g|png|gif|webp|webm|mp4|zip)$/i.test(name)) continue;
        const text = await readFile(path.join(dir, name), 'utf8').catch(() => '');
        for (const m of text.matchAll(/shots\/(\d+\.jpg)/g)) named.add(m[1]!);
      }
    }
    for (const name of await readdir(shots).catch(() => [])) {
      if (!named.has(name)) await rm(path.join(shots, name), { force: true });
    }
  }

  /** "README.md 24 lines · guide.md 140 lines · map.jpg 41 KB" for the top-level files in /memory. */
  async memorySizes(): Promise<string> {
    const parts: string[] = [];
    for (const name of (await readdir(this.memoryDir)).filter((n) => !n.startsWith('.')).sort()) {
      const file = path.join(this.memoryDir, name);
      const info = await stat(file);
      if (!info.isFile()) continue;
      const text = /\.(md|txt)$/i.test(name) && info.size < 1_000_000;
      parts.push(text ? `${name} ${(await readFile(file, 'utf8')).split('\n').length} lines` : `${name} ${Math.ceil(info.size / 1024)} KB`);
    }
    return parts.join(' · ') || 'empty';
  }

  /** Writes run.json (atomically) and, unless told not to, regenerates ledger.md. */
  async saveRun(facts: RunFacts, ledger = true): Promise<void> {
    await this.writeAtomic(path.join(this.dir, runName(facts.run), 'run.json'), JSON.stringify(facts, null, 2));
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
        rows.push(`| ${n} | | | | | | run.json unreadable | | |`);
        continue;
      }
      if (!f) continue;
      const minutes = f.duration_ms === undefined ? '' : `${Math.round(f.duration_ms / 60_000)} min`;
      const cost = f.usage_known === false ? 'unknown' : f.cost_usd === undefined ? '' : `$${f.cost_usd.toFixed(2)}`;
      const memory = f.memory_updated === undefined ? '' : f.memory_updated ? 'updated' : 'unchanged';
      const ended = f.ended_at ? (f.ended_by ?? '') : n === this.run && this.locked ? 'running' : 'interrupted';
      const summary = (f.summary ?? '').split('\n')[0]!.slice(0, 200).replace(/\|/g, '/');
      const started = new Date(f.started_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short', hour12: false });
      rows.push(`| ${n} | ${started} | ${minutes} | ${f.calls ?? ''} | ${cost} | ${memory} | ${ended} | ${f.next ?? ''} | ${summary} |`);
    }
    return `# Runs of ${this.config.name}\n\n| Run | Started | Time | Calls | Cost | Memory | Ended by | Next | Summary |\n|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`;
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
    await this.writeAtomic(path.join(this.dir, 'status.json'), JSON.stringify({ ...status, updated_at: new Date().toISOString() }, null, 2));
  }

  /** Writes a unique temp file, then renames it into place, so readers never see a partial file. */
  private async writeAtomic(file: string, text: string): Promise<void> {
    const tmp = `${file}.${process.pid}.${++this.writes}.tmp`;
    try {
      await writeFile(tmp, text);
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.locked) await rm(this.lockFile, { force: true });
    this.locked = false;
  }
}

/** Copies a folder and makes the copy writable, so a read-only save point can seed a browser profile. */
async function copyWritable(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true });
  for (const name of ['', ...(await readdir(to, { recursive: true }))]) {
    const file = path.join(to, name);
    const info = await lstat(file);
    if (!info.isSymbolicLink()) await chmod(file, info.mode | 0o200);
  }
}

export function runName(n: number): string {
  return `run-${String(n).padStart(3, '0')}`;
}
