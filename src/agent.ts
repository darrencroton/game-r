import { spawn, type ChildProcess } from 'node:child_process';
import type { Config } from './config.ts';
import type { Drive } from './engine.ts';
import { MCP_SERVER_NAME, startHttpMcp, type HttpMcp } from './mcp.ts';
import { FatalModelError, type TokenUsage } from './model.ts';

const NUDGE = `Carry on with your instructions: act through the ${MCP_SERVER_NAME} tools. Call end_run when this run is over.`;
const MAX_IDLE = 3;
const MAX_FAILURES = 8;
const TOOL_TIMEOUT_S = 900;
const FINISH_GRACE_MS = 60_000;
/** Variables a cloud Claude Code session sets that would make a nested `claude` reuse its session. */
const CLEARED_ENV = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION'];

interface Invocation {
  sessionId: string | null;
  usage: TokenUsage;
  /** Claude Code reports the session's cumulative cost; Codex reports none. */
  costUsd: number | null;
  error: string | null;
  text: string;
  /** The CLI reported its usage (Claude Code's final JSON, or a Codex turn.completed). */
  receipt?: boolean;
}

interface AgentCli {
  command: string;
  args(prompt: string, resume: string | null): string[];
  env: Record<string, string>;
  parse(stdout: string): Invocation;
}

const NO_USAGE: TokenUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

function claudeCode(drive: Drive, mcp: HttpMcp): AgentCli {
  const model = drive.config.model;
  const mcpConfig = JSON.stringify({
    mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } },
  });
  return {
    command: model.command ?? 'claude',
    args: (prompt, resume) => [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--system-prompt',
      drive.system,
      '--mcp-config',
      mcpConfig,
      '--strict-mcp-config',
      '--tools',
      '',
      '--allowedTools',
      `mcp__${MCP_SERVER_NAME}`,
      '--permission-prompts',
      'none',
      ...(model.name ? ['--model', model.name] : []),
      ...(model.reasoning !== 'off' ? ['--effort', model.reasoning] : []),
      ...(resume ? ['--resume', resume] : []),
    ],
    env: { MCP_TOOL_TIMEOUT: String(TOOL_TIMEOUT_S * 1000) },
    parse(stdout) {
      let r: any;
      try {
        r = JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
      } catch {
        return { sessionId: null, usage: NO_USAGE, costUsd: null, error: `unreadable output: ${stdout.slice(-300) || '(none)'}`, text: '' };
      }
      const u = r.usage ?? {};
      return {
        sessionId: r.session_id ?? null,
        usage: { input: u.input_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 },
        costUsd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : null,
        error: r.is_error ? String(r.result || r.subtype || 'error') : null,
        text: typeof r.result === 'string' ? r.result : '',
        receipt: r.usage !== undefined,
      };
    },
  };
}

function codex(drive: Drive, mcp: HttpMcp): AgentCli {
  const model = drive.config.model;
  const toml = (value: string): string => JSON.stringify(value);
  const server = `mcp_servers.${MCP_SERVER_NAME}`;
  const options = (): string[] => [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '-s',
    'read-only',
    '-C',
    drive.session.workspace.runDir,
    '-c',
    `${server}.url=${toml(mcp.url)}`,
    '-c',
    `${server}.bearer_token_env_var="GAMER_MCP_TOKEN"`,
    '-c',
    `${server}.default_tools_approval_mode="approve"`,
    '-c',
    `${server}.required=true`,
    '-c',
    `${server}.tool_timeout_sec=${TOOL_TIMEOUT_S}`,
    '-c',
    'features.shell_tool=false',
    '-c',
    `developer_instructions=${toml(drive.system)}`,
    ...(model.name ? ['-m', model.name] : []),
    ...(model.reasoning !== 'off' ? ['-c', `model_reasoning_effort=${toml(model.reasoning)}`] : []),
  ];
  return {
    command: model.command ?? 'codex',
    args: (prompt, resume) => (resume ? [...options(), 'resume', resume, prompt] : [...options(), prompt]),
    env: {},
    parse(stdout) {
      const out: Invocation = { sessionId: null, usage: { ...NO_USAGE }, costUsd: null, error: null, text: '' };
      for (const line of stdout.split('\n')) {
        let e: any;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.type === 'thread.started') out.sessionId = e.thread_id ?? null;
        if (e.type === 'turn.completed' && e.usage) {
          out.receipt = true;
          const cached = e.usage.cached_input_tokens ?? 0;
          out.usage.input += (e.usage.input_tokens ?? 0) - cached;
          out.usage.cache_read += cached;
          out.usage.output += e.usage.output_tokens ?? 0;
        }
        if (e.type === 'turn.failed') out.error = e.error?.message ?? 'turn failed';
        if (e.type === 'error') out.error = e.message ?? 'error';
        if (e.type === 'item.completed' && e.item?.type === 'agent_message') out.text = e.item.text ?? '';
      }
      if (!out.sessionId && !out.error) out.error = `no session started: ${stdout.slice(-300) || '(no output)'}`;
      return out;
    },
  };
}

/** Resolves with the exit code, or with the error if the process could not start. */
function finished(child: ChildProcess): Promise<number | Error> {
  return new Promise((resolve) => {
    child.once('error', resolve);
    child.once('close', (code) => resolve(code ?? -1));
  });
}

/** Fails fast, before the campaign opens, if the configured CLI cannot be run. */
export async function checkAgentCli(model: Config['model']): Promise<void> {
  const command = model.command ?? (model.provider === 'codex' ? 'codex' : 'claude');
  const child = spawn(command, ['--version'], { stdio: 'ignore' });
  const code = await finished(child);
  if (code !== 0) {
    const how = model.provider === 'codex' ? 'npm install -g @openai/codex, then codex login' : 'see https://code.claude.com/docs, then claude auth login';
    throw new FatalModelError(`Cannot run "${command} --version" (${code instanceof Error ? code.message : `exit ${code}`}). Install it (${how}) or set model.command.`);
  }
}

async function invoke(drive: Drive, cli: AgentCli, mcp: HttpMcp, prompt: string, resume: string | null): Promise<Invocation> {
  const { session } = drive;
  const env: NodeJS.ProcessEnv = { ...process.env, ...cli.env, GAMER_MCP_TOKEN: mcp.token };
  for (const key of CLEARED_ENV) delete env[key];
  const run = session.run;
  const child = spawn(cli.command, cli.args(prompt, resume), { cwd: session.workspace.runDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  let interrupted = false;
  let endedAt: number | null = null;
  const watch = setInterval(async () => {
    if (interrupted) return;
    const stop = await drive.stopReason();
    const limit = session.state === 'running' ? session.limitReached() : null;
    if (limit) await session.finish(limit).catch((err: Error) => drive.log(`could not finish the campaign: ${err.message}`));
    if (session.state !== 'running' || session.sealed || session.run !== run) endedAt ??= Date.now();
    if (!stop && (endedAt === null || Date.now() - endedAt < FINISH_GRACE_MS)) return;
    interrupted = true;
    child.kill('SIGINT');
    setTimeout(() => child.kill('SIGTERM'), 15_000).unref();
  }, 2000);
  try {
    const code = await finished(child);
    if (code instanceof Error) throw new FatalModelError(`Cannot run ${cli.command}: ${code.message}`);
    const result = cli.parse(stdout);
    if (!result.error && code !== 0 && !interrupted) result.error = `${cli.command} exited with code ${code}: ${stderr.trim().slice(-300)}`;
    if (interrupted) result.error = null;
    return result;
  } finally {
    clearInterval(watch);
  }
}

/** Lets an agent CLI (Claude Code, Codex) play: it calls the tools over MCP, game-r keeps the campaign, limits and runs. */
export async function agentLoop(drive: Drive): Promise<void> {
  const { config, session, toolbox, log } = drive;
  const mcp = await startHttpMcp(toolbox, drive.system, '0.1.0');
  const cli = config.model.provider === 'codex' ? codex(drive, mcp) : claudeCode(drive, mcp);
  const costSeen = new Map<string, number>();
  let resume: string | null = null;
  let runCallsAt = toolbox.calls;
  let run = session.run;
  let idle = 0;
  let failures = 0;
  try {
    while (session.state === 'running' && !(await drive.stopReason())) {
      const limit = session.limitReached();
      if (limit) {
        await session.finish(limit);
        return;
      }
      await session.nextRun();
      if (session.state !== 'running') return;
      if (session.run !== run) {
        run = session.run;
        runCallsAt = toolbox.calls;
        resume = null;
        idle = 0;
      }
      const before = toolbox.calls;
      const prompt = resume ? NUDGE : await drive.opening(toolbox.calls > runCallsAt ? 'refresh' : 'run');
      const r = await invoke(drive, cli, mcp, prompt, resume);
      const calls = toolbox.calls - before;
      let spent = 0;
      if (r.costUsd !== null && r.sessionId) {
        spent = Math.max(0, r.costUsd - (costSeen.get(r.sessionId) ?? 0));
        costSeen.set(r.sessionId, r.costUsd);
      }
      await session.addUsage(r.usage, spent, calls, r.receipt === true);
      await session.workspace.log({ type: 'agent', provider: config.model.provider, session_id: r.sessionId, text: r.text, tool_calls: calls, usage: r.usage, cost_usd: spent, error: r.error });
      log(`run ${run}: ${config.model.provider} ${r.sessionId?.slice(0, 8) ?? '-'} · ${calls} tool calls${r.error ? ` · error: ${r.error.slice(0, 160)}` : ''}${r.costUsd !== null ? ` · $${session.usage.cost_usd.toFixed(2)}` : ''}`);

      if (session.state !== 'running' || session.sealed || session.run !== run) continue;
      if (r.error) {
        failures += 1;
        if (failures === 1) await session.notify('error', `${config.model.provider} failed in ${config.name}`, `${r.error.slice(0, 500)} (retrying)`, 'problem');
        if (failures >= MAX_FAILURES) {
          await session.finish(`the agent CLI failed ${MAX_FAILURES} times in a row: ${r.error.slice(0, 300)}`);
          return;
        }
        const wait = Math.min(3_600_000, drive.retryBaseMs * 2 ** (failures - 1));
        log(`  retrying in ${Math.round(wait / 1000)} s`);
        await drive.pause(wait);
        resume = r.sessionId ?? resume;
        continue;
      }
      failures = 0;
      resume = r.sessionId;
      idle = calls === 0 ? idle + 1 : 0;
      if (idle >= MAX_IDLE) {
        await session.finish(`the agent stopped acting (${MAX_IDLE} sessions in a row without a tool call)`);
        return;
      }
    }
  } finally {
    await mcp.close();
  }
}
