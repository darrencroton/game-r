import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config, NotifyEventName } from './config.ts';
import type { TokenUsage } from './model.ts';
import { GameBrowser } from './browser.ts';
import { Files } from './files.ts';
import { Workspace } from './workspace.ts';

export interface Usage {
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export type Mode = 'engine' | 'mcp';

export class Session {
  readonly workspace: Workspace;
  readonly browser: GameBrowser;
  readonly files: Files;
  state: 'running' | 'done' | 'stopped' = 'running';
  doneReason = '';
  usage: Usage = { turns: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  turnsThisRun = 0;
  lastError: string | null = null;
  private shotCount = 0;
  private elapsedBase = 0;
  private readonly openedAt = Date.now();
  private runStartedAt = Date.now();

  readonly config: Config;
  readonly mode: Mode;

  private constructor(config: Config, mode: Mode) {
    this.config = config;
    this.mode = mode;
    this.workspace = new Workspace(config);
    this.browser = new GameBrowser(config.browser, config.clock === 'allowed', () => ({
      profile: this.workspace.profileDir,
      run: this.workspace.runDir,
    }));
    this.files = new Files(() => ({ memory: this.workspace.memoryDir, run: this.workspace.runDir, runs: this.workspace.dir }));
  }

  static async open(config: Config, mode: Mode): Promise<Session> {
    const session = new Session(config, mode);
    await session.workspace.open();
    await session.restoreTotals();
    return session;
  }

  private async restoreTotals(): Promise<void> {
    try {
      const prev = JSON.parse(await readFile(path.join(this.workspace.dir, 'status.json'), 'utf8'));
      this.elapsedBase = Number(prev.elapsed_ms) || 0;
      if (prev.usage) this.usage = { ...this.usage, ...prev.usage };
    } catch {
      /* first start */
    }
  }

  /** Starts the next run, or ends the campaign at once if a limit is already reached. */
  async begin(): Promise<void> {
    const limit = this.limitReached(true);
    if (limit) await this.finish(limit);
    else await this.startRun();
  }

  addUsage(tokens: TokenUsage, costUsd: number): void {
    this.usage.turns += 1;
    this.turnsThisRun += 1;
    this.usage.input_tokens += tokens.input + tokens.cache_read + tokens.cache_write;
    this.usage.output_tokens += tokens.output;
    this.usage.cost_usd += costUsd;
  }

  get elapsedMs(): number {
    return this.elapsedBase + (Date.now() - this.openedAt);
  }

  get runElapsedMs(): number {
    return Date.now() - this.runStartedAt;
  }

  get run(): number {
    return this.workspace.run;
  }

  async startRun(): Promise<number> {
    await this.browser.close();
    const run = await this.workspace.startRun();
    this.runStartedAt = Date.now();
    this.turnsThisRun = 0;
    this.shotCount = 0;
    this.browser.resetLogOrigin();
    await this.browser.launch(this.config.url);
    await this.workspace.log({ type: 'run_start', run, url: this.config.url });
    await this.saveStatus();
    return run;
  }

  /** Ends the current run; starts the next one unless the campaign is over. Returns the reason it ended, if it did. */
  async endRun(summary: string, next: 'new_run' | 'done'): Promise<string | null> {
    await this.workspace.endRun(summary, next);
    await this.workspace.log({ type: 'run_end', summary, next });
    await this.notify('run_end', `Run ${this.run} ended`, summary);
    if (next === 'done') return this.finish('the agent reported the campaign done');
    const limit = this.limitReached(true);
    if (limit) return this.finish(limit);
    await this.startRun();
    return null;
  }

  /** The first hard limit reached, if any. `atRunEnd` also counts the run limit. */
  limitReached(atRunEnd = false): string | null {
    const { limits } = this.config;
    if (limits.hours !== null && this.elapsedMs >= limits.hours * 3_600_000) return `limit reached: ${limits.hours} hours`;
    if (limits.cost_usd !== null && this.usage.cost_usd >= limits.cost_usd) return `limit reached: $${limits.cost_usd}`;
    if (atRunEnd && limits.runs !== null && this.run >= limits.runs) return `limit reached: ${limits.runs} runs`;
    return null;
  }

  async finish(reason: string): Promise<string> {
    if (this.state === 'done') return this.doneReason;
    this.state = 'done';
    this.doneReason = reason;
    await this.workspace.log({ type: 'campaign_end', reason });
    await this.notify(reason.startsWith('limit') ? 'limit' : 'campaign_end', `Campaign ${this.config.name} ended`, reason);
    await this.saveStatus();
    await this.browser.close();
    return reason;
  }

  async saveShot(image: Buffer): Promise<string> {
    this.shotCount += 1;
    const name = `${String(this.shotCount).padStart(4, '0')}.jpg`;
    await writeFile(path.join(this.workspace.runDir, 'shots', name), image);
    await writeFile(path.join(this.workspace.runDir, 'live.jpg'), image);
    return `/run/shots/${name}`;
  }

  async notify(event: NotifyEventName, title: string, message: string, level = 'info'): Promise<string> {
    const { command, on } = this.config.notify;
    await this.workspace.log({ type: 'notify', event, title, message, level });
    if (!command || !on.includes(event)) return command ? `Not sent: "${event}" notifications are off.` : 'Logged. No notify.command is configured.';
    return new Promise((resolve) => {
      const child = spawn(command, {
        shell: process.env.SHELL || true,
        stdio: 'ignore',
        timeout: 15_000,
        env: { ...process.env, GAMER_TITLE: title, GAMER_MESSAGE: message, GAMER_LEVEL: level, GAMER_CAMPAIGN: this.config.name, GAMER_EVENT: event },
      });
      child.on('error', (err) => resolve(`Notification failed: ${err.message}`));
      child.on('exit', (code) => resolve(code === 0 ? 'Sent.' : `Notification command exited with code ${code}.`));
    });
  }

  async saveStatus(extra: Record<string, unknown> = {}): Promise<void> {
    await this.workspace.writeStatus({
      campaign: this.config.name,
      mode: this.mode,
      pid: process.pid,
      state: this.state,
      done_reason: this.doneReason || null,
      run: this.run,
      turns_this_run: this.turnsThisRun,
      elapsed_ms: this.elapsedMs,
      run_elapsed_ms: this.runElapsedMs,
      usage: this.usage,
      limits: this.config.limits,
      last_error: this.lastError,
      ...extra,
    });
  }

  async close(): Promise<void> {
    if (this.state === 'running') this.state = 'stopped';
    await this.saveStatus().catch(() => {});
    await this.browser.close();
    await this.workspace.close();
  }
}
