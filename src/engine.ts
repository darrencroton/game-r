import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { agentLoop, checkAgentCli } from './agent.ts';
import { AGENT_CLIS, type Config } from './config.ts';
import { cost, createProvider, type Conversation, type Provider, type ToolCall, type ToolSpec } from './model.ts';
import { systemPrompt } from './prompt.ts';
import { Session } from './session.ts';
import { statusLine, Toolbox, type ToolResult } from './tools.ts';

const REFRESH_NOTE = "Context refresh: after this turn your context will be cleared to keep it small. Bring README.md's Now up to date this turn. The game is not affected.";
const NUDGE = 'Carry on with your instructions: act through the tools. Call end_run when this run is over.';
const CUT_OFF = 'Your reply was cut off at the output limit. Keep replies shorter and act through the tools.';
const MAX_IDLE_REPLIES = 3;

/** What a driver needs to play one campaign. */
export interface Drive {
  config: Config;
  session: Session;
  toolbox: Toolbox;
  system: string;
  log: (line: string) => void;
  /** Why the campaign should stop now (signal or `game-r stop`), if it should. */
  stopReason(): Promise<string | null>;
  opening(kind: 'run' | 'refresh'): Promise<string>;
  /** Waits up to `ms`, returning early if a stop is requested. */
  pause(ms: number): Promise<void>;
  /** First wait after a failed agent CLI session; doubles on each further failure. */
  retryBaseMs: number;
}

export function toolSpecs(toolbox: Toolbox): ToolSpec[] {
  return toolbox.tools.map((tool) => {
    const { $schema: _, ...schema } = z.toJSONSchema(tool.input) as Record<string, unknown>;
    return { name: tool.name, description: tool.description, schema };
  });
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

export function kTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

async function opening(session: Session, kind: 'run' | 'refresh'): Promise<string> {
  const status = await statusLine(session);
  if (kind === 'refresh') {
    return `Your context was refreshed to keep it small. This is still run ${session.run} and the game is exactly as you left it.\n\n${status}\n\nDo the Start step's reading (README.md, lessons.md, the parts of guide.md you need; your Objective is in /run/report.md), then carry on.`;
  }
  const earlier = session.run > 1 ? `Earlier runs:\n\n${(await session.workspace.ledger()).split('\n').slice(2).join('\n')}` : 'This is the first run of the campaign.';
  const start = (await session.workspace.memoryIsTemplate())
    ? '/memory still holds the templates: Orient first, then do the Start step.'
    : 'Begin with the Start step.';
  return `Run ${session.run} has started: the browser is open at ${session.config.url}.\n\n${status}\n\n${earlier}\n\n${start}`;
}

export interface RunOptions {
  log?: (line: string) => void;
  retryBaseMs?: number;
}

/** Runs a campaign until it is done, a limit is reached, or a stop is requested. Returns why it ended. */
export async function runCampaign(config: Config, options: RunOptions = {}): Promise<string> {
  const log = options.log ?? ((line: string) => console.error(line));
  const agentCli = (AGENT_CLIS as readonly string[]).includes(config.model.provider);
  const provider = agentCli ? null : await createProvider(config.model);
  if (agentCli) await checkAgentCli(config.model);
  const session = await Session.open(config, 'engine');
  const stopFile = path.join(session.workspace.dir, 'stop.request');
  await rm(stopFile, { force: true });
  let stopping: string | null = null;
  const onSignal = (): void => {
    if (stopping) process.exit(130);
    stopping = 'stopped by signal';
    log('Stopping after this turn (Ctrl-C again to quit now).');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let failure: string | undefined;
  try {
    const toolbox = new Toolbox(session);
    const stopReason = async (): Promise<string | null> => {
      if (!stopping && (await exists(stopFile))) stopping = 'stop requested';
      return stopping;
    };
    const drive: Drive = {
      config,
      session,
      toolbox,
      system: await systemPrompt(config),
      log,
      stopReason,
      opening: (kind) => opening(session, kind),
      retryBaseMs: options.retryBaseMs ?? 60_000,
      pause: async (ms) => {
        for (const end = Date.now() + ms; Date.now() < end && !(await stopReason()); ) await sleep(Math.min(5000, end - Date.now()));
      },
    };
    await session.begin();
    log(`game-r: campaign "${config.name}" · ${config.model.provider} ${config.model.name ?? '(default model)'} · output ${session.workspace.dir}`);
    if (provider) await modelLoop(drive, provider);
    else await agentLoop(drive);

    if (session.state === 'done') return session.doneReason;
    await session.workspace.log({ type: 'stopped', reason: stopping });
    return stopping ?? 'stopped';
  } catch (err) {
    const message = (err as Error).message;
    failure = `error: ${message.slice(0, 200)}`;
    session.lastError = message;
    await session.workspace.log({ type: 'error', message });
    await session.notify('error', `Campaign ${config.name} stopped with an error`, message, 'problem');
    throw err;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await session.close(failure ?? stopping ?? 'stopped');
  }
}

/** The engine's own loop over a model API: one append-only conversation per context. */
async function modelLoop(drive: Drive, provider: Provider): Promise<void> {
  const { config, session, toolbox, log } = drive;
  const specs = toolSpecs(toolbox);
  let convo: Conversation | null = null;
  let next: 'run' | 'refresh' = 'run';
  let refreshAfterTurn = false;
  let idle = 0;

  while (session.state === 'running' && !(await drive.stopReason())) {
    if (!convo) {
      convo = provider.start(drive.system, specs, (message, delay) => log(`  retrying in ${Math.round(delay / 1000)}s: ${message.slice(0, 160)}`));
      convo.user([{ type: 'text', text: await drive.opening(next) }]);
      await session.workspace.log({ type: 'context', reason: next });
    }

    const reply = await convo.next();
    const spent = cost(reply.usage, config.model.price_per_mtok);
    await session.addUsage(reply.usage, spent);
    await session.workspace.log({
      type: 'model',
      text: reply.text,
      calls: reply.calls.map((c) => ({ name: c.name, args: c.args })),
      stop: reply.stop,
      usage: reply.usage,
      cost_usd: spent,
      context_tokens: convo.contextTokens,
    });
    log(`run ${session.run} call ${session.callsThisRun}: ${reply.calls.map((c) => c.name).join(', ') || '(no tool call)'} · context ${kTokens(convo.contextTokens)} · $${session.usage.cost_usd.toFixed(2)}`);

    if (!reply.calls.length) {
      idle += 1;
      if (idle >= MAX_IDLE_REPLIES) {
        await session.finish(`the agent stopped acting (${MAX_IDLE_REPLIES} replies in a row without a tool call)`);
        return;
      }
      convo.user([{ type: 'text', text: reply.stop === 'length' || reply.stop === 'max_tokens' ? CUT_OFF : NUDGE }]);
      continue;
    }
    idle = 0;

    const results: { call: ToolCall; result: ToolResult }[] = [];
    for (const call of reply.calls) {
      if (session.sealed || session.state !== 'running') break;
      results.push({ call, result: await toolbox.call(call.name, call.args) });
    }
    if (session.state !== 'running') return;
    if (session.sealed) {
      await session.nextRun();
      convo = null;
      next = 'run';
      refreshAfterTurn = false;
      continue;
    }
    if (refreshAfterTurn) {
      convo = null;
      next = 'refresh';
      refreshAfterTurn = false;
      continue;
    }
    let note: string | undefined;
    if (convo.contextTokens >= config.context.refresh_tokens) {
      note = REFRESH_NOTE;
      refreshAfterTurn = true;
    }
    convo.results(results, note);
  }
}
