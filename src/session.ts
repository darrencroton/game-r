import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config, NotifyEventName } from './config.ts';
import type { TokenUsage } from './model.ts';
import { GameBrowser } from './browser.ts';
import { Files } from './files.ts';
import { Workspace, type RunFacts } from './workspace.ts';

export interface Usage {
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export type Mode = 'engine' | 'mcp';

const NO_USAGE: Usage = { turns: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };

/** Local wall-clock time with its zone, e.g. "14:02:07 GMT+11". */
export function clockTime(date = new Date()): string {
  return date.toLocaleTimeString(undefined, { hour12: false, timeZoneName: 'short' });
}

/** A short duration, e.g. "3m24s" or "1h05m". */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

export class Session {
  readonly workspace: Workspace;
  readonly browser: GameBrowser;
  readonly files: Files;
  state: 'running' | 'done' | 'stopped' = 'running';
  doneReason = '';
  usage: Usage = { ...NO_USAGE };
  /** No run of this session is open: before the first run, and after a run has ended until the next starts. */
  sealed = true;
  callsThisRun = 0;
  lastError: string | null = null;
  private shotCount = 0;
  private elapsedBase = 0;
  private readonly openedAt = Date.now();
  private runStartedAt = Date.now();
  private runUsage: Usage = { ...NO_USAGE };
  private runUsageKnown = true;
  private runEnd: Pick<RunFacts, 'ended_at' | 'duration_ms' | 'ended_by' | 'next' | 'summary' | 'memory_updated'> = {};
  private memoryAtStart = '';
  private endRunHeld = false;
  private warned = false;
  private nextPaceAt = 0;

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

  /** Adds a model turn's or an agent CLI session's usage to the campaign and the current (possibly sealed) run. */
  async addUsage(tokens: TokenUsage, costUsd: number, turns = 1, known = true): Promise<void> {
    if (!this.run) return;
    const input = tokens.input + tokens.cache_read + tokens.cache_write;
    for (const u of [this.usage, this.runUsage]) {
      u.turns += turns;
      u.input_tokens += input;
      u.output_tokens += tokens.output;
      u.cost_usd += costUsd;
    }
    if (!known) this.runUsageKnown = false;
    await this.saveRun();
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
    const now = new Date();
    this.runStartedAt = now.getTime();
    this.sealed = false;
    this.callsThisRun = 0;
    this.runUsage = { ...NO_USAGE };
    this.runUsageKnown = true;
    this.runEnd = {};
    this.warned = false;
    this.endRunHeld = false;
    this.shotCount = 0;
    const run = await this.workspace.startRun(now, `${now.toISOString().slice(0, 10)} ${clockTime(now)}`);
    this.memoryAtStart = await this.workspace.memoryStamp();
    this.browser.resetLogOrigin();
    await this.browser.launch(this.config.url);
    await this.workspace.log({ type: 'run_start', run, url: this.config.url });
    await this.timeline(`Run ${run} started at ${this.config.url}`);
    await this.saveStatus();
    return run;
  }

  /** Starts the next run if the current one is sealed and the campaign goes on (limits permitting). */
  async nextRun(): Promise<void> {
    if (this.sealed && this.state === 'running') await this.begin();
  }

  /** Writes the open run's facts so far, without rebuilding the ledger. */
  async checkpoint(): Promise<void> {
    if (!this.sealed) await this.saveRun(false);
  }

  /** True the first time end_run is called in a run that hasn't changed /memory: that call doesn't end the run. */
  async holdEndRun(): Promise<boolean> {
    if (this.endRunHeld || (await this.workspace.memoryStamp()) !== this.memoryAtStart) return false;
    this.endRunHeld = true;
    return true;
  }

  private async saveRun(ledger = true): Promise<void> {
    if (this.runEnd.ended_at) this.runEnd.memory_updated = (await this.workspace.memoryStamp()) !== this.memoryAtStart;
    await this.workspace.saveRun({
      run: this.run,
      started_at: new Date(this.runStartedAt).toISOString(),
      calls: this.callsThisRun,
      input_tokens: this.runUsage.input_tokens,
      output_tokens: this.runUsage.output_tokens,
      cost_usd: this.runUsage.cost_usd,
      usage_known: this.runUsageKnown,
      ...this.runEnd,
    }, ledger);
  }

  private async seal(endedBy: string, next?: string, summary?: string): Promise<void> {
    this.sealed = true;
    this.runEnd = { ended_at: new Date().toISOString(), duration_ms: this.runElapsedMs, ended_by: endedBy, next, summary };
    await this.workspace.log({ type: 'run_end', ended_by: endedBy, next, summary });
    await this.timeline(`Run ${this.run} ended (${endedBy}${next ? `, next: ${next}` : ''})${summary ? `: ${summary}` : ''}`);
    await this.saveRun();
  }

  /** Seals this run. The next one starts when the driver begins it. Returns why the campaign ended, if it did. */
  async endRun(summary: string, next: 'new_run' | 'goal_met' | 'goal_impossible', endedBy = 'end_run'): Promise<string | null> {
    if (this.sealed) return null;
    await this.seal(endedBy, next, summary);
    await this.notify('run_end', `Run ${this.run} ended`, summary);
    if (next === 'goal_met') return this.finish('the agent reported the goal met');
    if (next === 'goal_impossible') return this.finish('the agent reported the goal impossible');
    const limit = this.limitReached(true);
    if (limit) return this.finish(limit);
    await this.saveStatus();
    return null;
  }

  /** The first hard limit reached, if any. `atRunEnd` also counts the run limit, and the wrap-up window once a run has been played. */
  limitReached(atRunEnd = false): string | null {
    const { limits } = this.config;
    if (limits.hours !== null && this.elapsedMs >= limits.hours * 3_600_000) return `limit reached: ${limits.hours} hours`;
    if (limits.cost_usd !== null && this.usage.cost_usd >= limits.cost_usd) return `limit reached: $${limits.cost_usd}`;
    if (atRunEnd && limits.runs !== null && this.run >= limits.runs) return `limit reached: ${limits.runs} runs`;
    const near = this.campaignNearLimit();
    if (atRunEnd && this.run > 0 && near.length) return `limit nearly reached (${near.join(', ')}): no new run in the wrap-up window`;
    return null;
  }

  /** What makes the campaign as a whole due to wrap up: little time left, or most of the budget spent. */
  private campaignNearLimit(): string[] {
    const { limits } = this.config;
    const near: string[] = [];
    if (limits.hours !== null) {
      const left = limits.hours * 3_600_000 - this.elapsedMs;
      if (left <= limits.wrap_up_minutes * 60_000) near.push(`${span(left)} left`);
    }
    if (limits.cost_usd !== null && this.usage.cost_usd >= limits.cost_usd * 0.9) near.push(`$${this.usage.cost_usd.toFixed(2)} of $${limits.cost_usd} spent`);
    return near;
  }

  /** The wrap-up warning while a limit is near; written to log.md the first time in each run. */
  async warning(): Promise<string | null> {
    if (this.sealed || this.state !== 'running') return null;
    const { limits } = this.config;
    const near = this.campaignNearLimit();
    if (limits.calls_per_run !== null && limits.calls_per_run - this.callsThisRun <= 10) near.push(`${Math.max(0, limits.calls_per_run - this.callsThisRun)} calls left in this run`);
    if (!near.length) return null;
    const warning = `⚠ wrap up: ${near.join(', ')}. Do the End step now.`;
    if (!this.warned) {
      this.warned = true;
      await this.timeline(warning);
    }
    return warning;
  }

  /** Waits until pace.seconds_per_call has passed since the previous paced call; calls take turns. */
  async pace(): Promise<void> {
    const gap = this.config.pace.seconds_per_call * 1000;
    if (!gap) return;
    const at = Math.max(Date.now(), this.nextPaceAt);
    this.nextPaceAt = at + gap;
    if (at > Date.now()) await sleep(at - Date.now());
  }

  /** Appends a stamped line to this run's log.md. */
  async timeline(text: string): Promise<void> {
    await this.workspace.timeline(`- ${clockTime()} (+${span(this.runElapsedMs)}) ${text.replace(/\s*\n\s*/g, ' ')}`);
  }

  async finish(reason: string): Promise<string> {
    if (this.state === 'done') return this.doneReason;
    this.state = 'done';
    this.doneReason = reason;
    if (!this.sealed) await this.seal(reason);
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
    if (event === 'agent') await this.timeline(`notify (${level}): ${title}: ${message}`);
    if (!command || !on.includes(event)) return command ? `Not sent: "${event}" notifications are off.` : 'Logged. No notify.command is configured.';
    const result = await new Promise<string>((resolve) => {
      const child = spawn(command, {
        shell: process.env.SHELL || true,
        stdio: 'ignore',
        timeout: 15_000,
        env: { ...process.env, GAMER_TITLE: title, GAMER_MESSAGE: message, GAMER_LEVEL: level, GAMER_CAMPAIGN: this.config.name, GAMER_EVENT: event },
      });
      child.on('error', (err) => resolve(`Notification failed: ${err.message}`));
      child.on('exit', (code, signal) => resolve(code === 0 ? 'Sent.' : code === null ? `Notification command was stopped (${signal}; 15 s limit).` : `Notification command exited with code ${code}.`));
    });
    if (result !== 'Sent.') await this.workspace.log({ type: 'notify_failed', event, result });
    return result;
  }

  async saveStatus(extra: Record<string, unknown> = {}): Promise<void> {
    await this.workspace.writeStatus({
      campaign: this.config.name,
      mode: this.mode,
      pid: process.pid,
      state: this.state,
      done_reason: this.doneReason || null,
      run: this.run,
      calls_this_run: this.callsThisRun,
      sealed: this.sealed,
      elapsed_ms: this.elapsedMs,
      run_elapsed_ms: this.runElapsedMs,
      usage: this.usage,
      limits: this.config.limits,
      last_error: this.lastError,
      ...extra,
    });
  }

  async close(reason = 'stopped'): Promise<void> {
    if (this.state === 'running') this.state = 'stopped';
    if (!this.sealed) await this.seal(reason).catch(() => {});
    await this.saveStatus().catch(() => {});
    await this.browser.close();
    await this.workspace.close();
  }
}
