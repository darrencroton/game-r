import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { deepMerge } from '../src/config.ts';
import { runCampaign } from '../src/engine.ts';
import { makeConfig, tempDir } from './helpers.ts';

const FAKE = path.join(import.meta.dirname, 'fixtures', 'fake-agent.mjs');

type Step = { calls?: [string, unknown][]; error?: string };

/** Runs a campaign with the fake agent CLI and returns the reason it ended plus each invocation's argv and env. */
async function play(provider: 'claude-code' | 'codex', steps: Step[], over: Record<string, unknown> = {}) {
  const dir = await tempDir();
  const script = path.join(dir, 'script.json');
  await writeFile(script, JSON.stringify(steps.map((s) => ({ calls: s.calls ?? [], error: s.error }))));
  process.env.FAKE_AGENT_SCRIPT = script;
  process.env.CLAUDE_CODE_SESSION_ID = 'outer-session';
  const config = await makeConfig(deepMerge({ model: { provider, name: 'test-model', command: FAKE, reasoning: 'high' } }, over));
  const lines: string[] = [];
  const reason = await runCampaign(config, { log: (l) => lines.push(l), retryBaseMs: 10 });
  const calls = (await readFile(script + '.log', 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { argv: string[]; sessionEnv: string | null });
  const status = JSON.parse(await readFile(path.join(config.output, config.name, 'status.json'), 'utf8'));
  return { reason, calls, status, config, lines };
}

const after = (argv: string[], flag: string): string => argv[argv.indexOf(flag) + 1] ?? '';

describe('agent CLI drivers', () => {
  test('claude-code: tools only, the system prompt, resume with a nudge, cumulative cost', async () => {
    const { reason, calls, status, config } = await play('claude-code', [
      { calls: [['look', {}], ['files', { command: 'create', path: '/memory/notes.md', file_text: 'Start is top left.' }]] },
      { calls: [['end_run', { summary: 'Learned the menu.', next: 'goal_met' }]] },
    ]);
    assert.equal(reason, 'the agent reported the goal met');
    assert.equal(calls.length, 2);
    const [first, second] = calls.map((c) => c.argv);
    assert.equal(after(first!, '-p').startsWith('Run 1 has started'), true);
    assert.match(after(first!, '--system-prompt'), /You are playing and testing a web game[\s\S]*Play the game\./);
    assert.equal(after(first!, '--tools'), '');
    assert.equal(after(first!, '--allowedTools'), 'mcp__gamer');
    assert.ok(first!.includes('--strict-mcp-config'));
    assert.equal(after(first!, '--model'), 'test-model');
    assert.equal(after(first!, '--effort'), 'high');
    assert.ok(!first!.includes('--resume'));
    assert.equal(after(second!, '--resume'), 'session-1');
    assert.match(after(second!, '-p'), /^Carry on with your instructions/);
    assert.ok(calls.every((c) => c.sessionEnv === null), 'the outer Claude Code session id leaked into the agent CLI');
    assert.equal(status.usage.turns, 3);
    assert.ok(Math.abs(status.usage.cost_usd - 0.02) < 1e-9, `cost ${status.usage.cost_usd}`);
    assert.equal(await readFile(path.join(config.output, config.name, 'memory', 'notes.md'), 'utf8'), 'Start is top left.');
  });

  test('codex: exec with JSON events, MCP over HTTP, no shell tool, resume by thread id', async () => {
    const { reason, calls, status } = await play('codex', [{ calls: [['files', { command: 'create', path: '/memory/notes.md', file_text: 'Noted.' }]] }, { calls: [['end_run', { summary: 'Done.', next: 'goal_met' }]] }]);
    assert.equal(reason, 'the agent reported the goal met');
    const [first, second] = calls.map((c) => c.argv);
    assert.deepEqual(first!.slice(0, 2), ['exec', '--json']);
    for (const setting of ['features.shell_tool=false', 'mcp_servers.gamer.default_tools_approval_mode="approve"', 'mcp_servers.gamer.bearer_token_env_var="GAMER_MCP_TOKEN"', 'model_reasoning_effort="high"']) {
      assert.ok(first!.includes(setting), `missing -c ${setting}`);
    }
    assert.ok(first!.some((a) => a.startsWith('developer_instructions="You are playing')));
    assert.equal(after(first!, '-m'), 'test-model');
    assert.equal(after(first!, '-s'), 'read-only');
    assert.deepEqual(second!.slice(-3, -1), ['resume', 'session-1']);
    assert.match(second!.at(-1)!, /^Carry on/);
    assert.equal(status.usage.input_tokens, 2000);
    assert.equal(status.usage.cost_usd, 0);
  });

  test('a new run starts a fresh agent session with the run opening', async () => {
    const { reason, calls } = await play('claude-code', [{ calls: [['files', { command: 'create', path: '/memory/notes.md', file_text: 'Noted.' }], ['end_run', { summary: 'One.', next: 'new_run' }]] }, { calls: [['files', { command: 'create', path: '/memory/more.md', file_text: 'More.' }], ['end_run', { summary: 'Two.', next: 'new_run' }]] }], {
      limits: { runs: 2 },
    });
    assert.equal(reason, 'limit reached: 2 runs');
    assert.ok(!calls[1]!.argv.includes('--resume'));
    assert.match(after(calls[1]!.argv, '-p'), /^Run 2 has started[\s\S]*⏱ [\s\S]*Earlier runs:[\s\S]*\| 1 \|[\s\S]*\| One\. \|/);
  });

  test('failures back off and retry; idle sessions end the campaign', async () => {
    const { reason, calls, lines } = await play('codex', [{ error: 'You have hit your usage limit' }, {}, {}, {}]);
    assert.match(reason, /stopped acting \(3 sessions in a row without a tool call\)/);
    assert.equal(calls.length, 4);
    assert.ok(lines.some((l) => /error: You have hit your usage limit/.test(l)));
    assert.ok(lines.some((l) => /retrying in/.test(l)));
  });

  test('a missing CLI fails before the campaign opens', async () => {
    const config = await makeConfig({ model: { provider: 'claude-code', command: '/nonexistent/claude' } });
    await assert.rejects(runCampaign(config, { log: () => {} }), /Cannot run "\/nonexistent\/claude --version"/);
  });
});
