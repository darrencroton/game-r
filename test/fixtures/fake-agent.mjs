#!/usr/bin/env node
// Stands in for `claude -p` or `codex exec` in tests: calls scripted tools over MCP, prints the CLI's output format.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  console.log('fake-agent 1.0.0');
  process.exit(0);
}
const codex = argv[0] === 'exec';
const script = JSON.parse(readFileSync(process.env.FAKE_AGENT_SCRIPT, 'utf8'));
const stateFile = process.env.FAKE_AGENT_SCRIPT + '.state';
let n = 0;
try {
  n = Number(readFileSync(stateFile, 'utf8'));
} catch {}
writeFileSync(stateFile, String(n + 1));
appendFileSync(process.env.FAKE_AGENT_SCRIPT + '.log', JSON.stringify({ argv, sessionEnv: process.env.CLAUDE_CODE_SESSION_ID ?? null }) + '\n');
const step = script[n] ?? { calls: [] };

let url;
let token;
if (codex) {
  url = JSON.parse(argv[argv.findIndex((a) => a.startsWith('mcp_servers.gamer.url='))].split('=').slice(1).join('='));
  token = process.env.GAMER_MCP_TOKEN;
} else {
  const server = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]).mcpServers.gamer;
  url = server.url;
  token = server.headers.Authorization.replace('Bearer ', '');
}

if (!step.error) {
  const client = new Client({ name: 'fake-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  for (const [name, args] of step.calls) await client.callTool({ name, arguments: args });
  await client.close();
}

const resumeAt = argv.indexOf(codex ? 'resume' : '--resume');
const sessionId = resumeAt >= 0 ? argv[resumeAt + 1] : `session-${n + 1}`;
if (codex) {
  const lines = [{ type: 'thread.started', thread_id: sessionId }, { type: 'turn.started' }];
  if (step.error) lines.push({ type: 'turn.failed', error: { message: step.error } });
  else {
    lines.push({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'done for now' } });
    lines.push({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 } });
  }
  console.log(lines.map((l) => JSON.stringify(l)).join('\n'));
} else {
  console.log(
    JSON.stringify({
      type: 'result',
      subtype: step.error ? 'error_during_execution' : 'success',
      is_error: Boolean(step.error),
      result: step.error ?? 'done for now',
      session_id: sessionId,
      total_cost_usd: 0.01 * (n + 1),
      usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 100, output_tokens: 50 },
    }),
  );
}
