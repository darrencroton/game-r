import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from './config.ts';
import { cost, createProvider, type Conversation, type ToolCall, type ToolSpec } from './model.ts';
import { systemPrompt } from './prompt.ts';
import { Session } from './session.ts';
import { Toolbox, type ToolResult } from './tools.ts';

const REFRESH_NOTE =
  'Context refresh: after this turn your context will be cleared to keep it small. ' +
  'Save what you need to /memory now: where you are, what you are doing and what comes next. The game is not affected.';
const LAST_TURN_NOTE = 'This is the last turn of this run (limits.turns_per_run). Save what you learned to /memory now.';
const NUDGE = 'Carry on with your instructions: act through the tools. Call end_run when this run is over.';
const CUT_OFF = 'Your reply was cut off at the output limit. Keep replies shorter and act through the tools.';
const MAX_IDLE_REPLIES = 3;

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

function kTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

async function opening(session: Session, toolbox: Toolbox, kind: 'run' | 'refresh'): Promise<string> {
  const status = (await toolbox.tools.find((t) => t.name === 'status')!.run({}))[0];
  const statusText = status?.type === 'text' ? status.text : '';
  const earlier = (await session.workspace.runNumbers()).filter((n) => n < session.run);
  if (kind === 'refresh') {
    return `Your context was refreshed to keep it small. This is still run ${session.run} and the game is exactly as you left it.\n\n${statusText}\n\nRead /memory to pick up where you were, then carry on.`;
  }
  const runs = earlier.length ? `Earlier runs (${earlier.length}) are under /runs with their transcripts and whatever you wrote there.` : 'This is the first run of the campaign.';
  return `Run ${session.run} has started: the browser is open at ${session.config.url}.\n\n${statusText}\n\n${runs} Start by reading /memory, then carry on with your instructions.`;
}

export interface RunOptions {
  log?: (line: string) => void;
}

/** Runs a campaign until it is done, a limit is reached, or a stop is requested. Returns why it ended. */
export async function runCampaign(config: Config, options: RunOptions = {}): Promise<string> {
  const log = options.log ?? ((line: string) => console.error(line));
  const provider = await createProvider(config.model);
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
  try {
    const toolbox = new Toolbox(session);
    const specs = toolSpecs(toolbox);
    const system = await systemPrompt(config);
    await session.begin();
    log(`game-r: campaign "${config.name}" · ${config.model.provider} ${config.model.name} · output ${session.workspace.dir}`);

    let convo: Conversation | null = null;
    let next: 'run' | 'refresh' = 'run';
    let refreshAfterTurn = false;
    let idle = 0;

    while (session.state === 'running') {
      if (!stopping && (await exists(stopFile))) stopping = 'stop requested';
      if (stopping) break;
      if (!convo) {
        convo = provider.start(system, specs, (message, delay) => log(`  retrying in ${Math.round(delay / 1000)}s: ${message.slice(0, 160)}`));
        convo.user([{ type: 'text', text: await opening(session, toolbox, next) }]);
        await session.workspace.log({ type: 'context', reason: next });
      }

      const reply = await convo.next();
      const spent = cost(reply.usage, config.model.price_per_mtok);
      session.addUsage(reply.usage, spent);
      await session.workspace.log({
        type: 'model',
        text: reply.text,
        calls: reply.calls.map((c) => ({ name: c.name, args: c.args })),
        stop: reply.stop,
        usage: reply.usage,
        cost_usd: spent,
        context_tokens: convo.contextTokens,
      });
      log(`run ${session.run} turn ${session.turnsThisRun}: ${reply.calls.map((c) => c.name).join(', ') || '(no tool call)'} · context ${kTokens(convo.contextTokens)} · $${session.usage.cost_usd.toFixed(2)}`);

      if (!reply.calls.length) {
        idle += 1;
        if (idle >= MAX_IDLE_REPLIES) {
          await session.finish(`the agent stopped acting (${MAX_IDLE_REPLIES} replies in a row without a tool call)`);
          break;
        }
        convo.user([{ type: 'text', text: reply.stop === 'length' || reply.stop === 'max_tokens' ? CUT_OFF : NUDGE }]);
        continue;
      }
      idle = 0;

      const run = session.run;
      const results: { call: ToolCall; result: ToolResult }[] = [];
      for (const call of reply.calls) {
        if (session.run !== run || session.state !== 'running') break;
        results.push({ call, result: await toolbox.call(call.name, call.args) });
      }
      if (session.state !== 'running') break;
      if (session.run !== run) {
        convo = null;
        next = 'run';
        refreshAfterTurn = false;
        continue;
      }
      const turnLimit = config.limits.turns_per_run;
      if (turnLimit !== null && session.turnsThisRun >= turnLimit) {
        const ended = await session.endRun(`Stopped at the limit of ${turnLimit} turns per run.`, 'new_run');
        if (ended) break;
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
      if (turnLimit !== null && session.turnsThisRun === turnLimit - 1) note = LAST_TURN_NOTE;
      else if (convo.contextTokens >= config.context.refresh_tokens) {
        note = REFRESH_NOTE;
        refreshAfterTurn = true;
      }
      convo.results(results, note);
    }

    if (session.state === 'done') return session.doneReason;
    await session.workspace.log({ type: 'stopped', reason: stopping });
    return stopping ?? 'stopped';
  } catch (err) {
    const message = (err as Error).message;
    session.lastError = message;
    await session.workspace.log({ type: 'error', message });
    await session.notify('error', `Campaign ${config.name} stopped with an error`, message, 'problem');
    throw err;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await session.close();
  }
}
