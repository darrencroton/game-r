import { appendFile, mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import type { Config } from './config.ts';

export const ENGINE_FILES = new Set(['transcript.jsonl', 'shots', 'live.jpg', 'end.json', 'video', 'trace.zip']);

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

  async startRun(): Promise<number> {
    this.run += 1;
    await mkdir(path.join(this.runDir, 'shots'), { recursive: true });
    if (this.config.browser.profile === 'run') await rm(this.profileDir, { recursive: true, force: true });
    return this.run;
  }

  async endRun(summary: string, next: string): Promise<void> {
    await writeFile(path.join(this.runDir, 'end.json'), JSON.stringify({ summary, next, ended_at: new Date().toISOString() }, null, 2));
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
