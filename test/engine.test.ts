import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, test } from 'node:test';
import { runCampaign } from '../src/engine.ts';
import { deepMerge } from '../src/config.ts';
import { cost, FatalModelError, HttpError, withRetries } from '../src/model.ts';
import { makeConfig } from './helpers.ts';

type Reply = { text?: string; calls?: [string, unknown][]; prompt?: number; status?: number };

/** A Chat Completions server that answers with scripted replies and records every request. */
async function mockModel(script: Reply[]) {
  const requests: any[] = [];
  const headers: http.IncomingHttpHeaders[] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    headers.push(req.headers);
    const step = script[requests.length - 1] ?? { text: 'out of script' };
    if (step.status) {
      res.writeHead(step.status, { 'content-type': 'application/json' }).end('{"error":"scripted"}');
      return;
    }
    const tool_calls = (step.calls ?? []).map(([name, args], i) => ({ id: `call_${requests.length}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: step.text ?? null, ...(tool_calls.length ? { tool_calls } : {}) }, finish_reason: tool_calls.length ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: step.prompt ?? 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 400 } },
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { url, requests, headers, close: () => server.close() };
}

async function campaign(url: string, over: Record<string, unknown> = {}) {
  return makeConfig(deepMerge({ model: { provider: 'openai-compatible', name: 'mock', base_url: url, api_key_env: null, price_per_mtok: { input: 2, output: 10 } } }, over));
}

const lines: string[] = [];
const log = (line: string) => lines.push(line);
const lastUserText = (req: any) =>
  JSON.stringify(
    req.messages
      .filter((m: any) => m.role === 'user')
      .at(-1)
      .content,
  );

describe('engine loop', () => {
  test('plays turns, feeds screenshots back, tracks cost and ends when the agent says done', async () => {
    const mock = await mockModel([
      { calls: [['look', { grid: true }], ['files', { command: 'create', path: '/memory/notes.md', file_text: 'Tap Start.' }]] },
      { calls: [['end_run', { summary: 'Looked around.', next: 'goal_met' }]] },
    ]);
    try {
      const config = await campaign(mock.url);
      const reason = await runCampaign(config, { log });
      assert.equal(reason, 'the agent reported the goal met');

      const [first, second] = mock.requests;
      assert.equal(first.model, 'mock');
      assert.equal(first.max_tokens, 16000);
      assert.equal(first.reasoning_effort, 'medium');
      assert.match(first.messages[0].content, /You are playing and testing a web game[\s\S]*Play the game\./);
      assert.match(lastUserText(first), /Run 1 has started[\s\S]*⏱ [\s\S]*first run of the campaign[\s\S]*Orient first/);
      assert.deepEqual(first.tools.map((t: any) => t.function.name), ['look', 'read_page', 'act', 'console', 'clock', 'browser', 'files', 'status', 'log', 'notify', 'end_run']);
      assert.equal(first.tools[0].function.parameters.properties.region.maxItems, 4);

      const tools = second.messages.filter((m: any) => m.role === 'tool');
      assert.equal(tools.length, 2);
      assert.match(tools[0].content, /"Dodge"/);
      assert.match(tools[1].content, /Wrote \/memory\/notes\.md/);
      const images = second.messages.at(-1).content.filter((p: any) => p.type === 'image_url');
      assert.equal(images.length, 1);
      assert.match(images[0].image_url.url, /^data:image\/jpeg;base64,/);

      const dir = path.join(config.output, config.name);
      assert.equal(await readFile(path.join(dir, 'memory', 'notes.md'), 'utf8'), 'Tap Start.');
      const status = JSON.parse(await readFile(path.join(dir, 'status.json'), 'utf8'));
      assert.equal(status.state, 'done');
      assert.equal(status.usage.turns, 2);
      assert.equal(status.usage.input_tokens, 2000);
      // per turn: 600 uncached × $2 + 400 cached × $0.2 + 100 out × $10, per million
      assert.ok(Math.abs(status.usage.cost_usd - 2 * cost({ input: 600, cache_read: 400, cache_write: 0, output: 100 }, { input: 2, output: 10 })) < 1e-12);
      const transcript = (await readFile(path.join(dir, 'run-001', 'transcript.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      assert.deepEqual(
        transcript.map((e) => e.type),
        ['run_start', 'context', 'model', 'tool', 'tool', 'model', 'run_end', 'notify', 'campaign_end', 'notify', 'tool'],
      );
    } finally {
      mock.close();
    }
  });

  test('warns before a context refresh, then starts a fresh conversation in the same run', async () => {
    const mock = await mockModel([
      { calls: [['status', {}]], prompt: 5000 },
      { calls: [['files', { command: 'create', path: '/memory/where.md', file_text: 'On the menu.' }]], prompt: 6000 },
      { calls: [['end_run', { summary: 'Done.', next: 'goal_met' }]] },
    ]);
    try {
      await runCampaign(await campaign(mock.url, { context: { refresh_tokens: 4000 } }), { log });
      assert.match(lastUserText(mock.requests[1]), /Context refresh: after this turn/);
      const third = mock.requests[2];
      assert.equal(third.messages.length, 2);
      assert.match(lastUserText(third), /context was refreshed[\s\S]*still run 1/);
    } finally {
      mock.close();
    }
  });

  test('OpenCode Go style: per-conversation headers, raw reasoning values, no images for a text-only model', async () => {
    const mock = await mockModel([{ calls: [['look', {}]] }, { calls: [['end_run', { summary: 'Done.', next: 'goal_met' }]] }]);
    try {
      process.env.TEST_GO_KEY = 'go-key';
      const config = await campaign(mock.url, {
        model: { api_key_env: 'TEST_GO_KEY', headers: { 'x-opencode-session': '{conversation}' }, reasoning: 'max', vision: false },
      });
      await runCampaign(config, { log });
      const [first, second] = mock.requests;
      assert.equal(mock.headers[0]!.authorization, 'Bearer go-key');
      assert.match(String(mock.headers[0]!['x-opencode-session']), /^[0-9a-f-]{36}$/);
      assert.equal(mock.headers[1]!['x-opencode-session'], mock.headers[0]!['x-opencode-session']);
      assert.equal(first.reasoning_effort, 'max');
      assert.match(first.messages[0].content, /You cannot see images/);
      assert.doesNotMatch(JSON.stringify(second.messages), /image_url/);
    } finally {
      mock.close();
    }
  });

  test('nudges an agent that stops using tools, and ends after three idle replies', async () => {
    const mock = await mockModel([{ text: 'Thinking aloud.' }, { text: 'Still thinking.' }, { text: 'Hmm.' }]);
    try {
      const reason = await runCampaign(await campaign(mock.url), { log });
      assert.match(reason, /stopped acting \(3 replies in a row/);
      assert.match(lastUserText(mock.requests[1]), /Carry on with your instructions/);
      assert.equal(mock.requests[1].messages.at(-2).content, 'Thinking aloud.');
    } finally {
      mock.close();
    }
  });

  test('calls_per_run warns ahead, then seals the run; the run limit ends the campaign', async () => {
    const mock = await mockModel([{ calls: [['status', {}]] }, { calls: [['status', {}]] }]);
    try {
      const reason = await runCampaign(await campaign(mock.url, { limits: { runs: 1, calls_per_run: 2 } }), { log });
      assert.equal(reason, 'limit reached: 1 runs');
      assert.match(JSON.stringify(mock.requests[1].messages), /wrap up: 1 calls left in this run\. Do the End step now/);
    } finally {
      mock.close();
    }
  });

  test('a fatal API error stops the campaign with the reason', async () => {
    const mock = await mockModel([{ status: 401 }]);
    try {
      await assert.rejects(runCampaign(await campaign(mock.url), { log }), (err: Error) => err instanceof FatalModelError && /HTTP 401/.test(err.message));
    } finally {
      mock.close();
    }
  });

  test('the anthropic provider explains what it still needs', async () => {
    await assert.rejects(runCampaign(await makeConfig({ model: { provider: 'anthropic', name: 'claude-opus-5-5' } }), { log }), /needs @anthropic-ai\/sdk/);
  });
});

describe('withRetries', () => {
  test('retries overloads and rate limits, then succeeds', async () => {
    let calls = 0;
    const retries: string[] = [];
    const value = await withRetries(
      async () => {
        calls += 1;
        if (calls < 3) throw new HttpError(calls === 1 ? 529 : 429, `HTTP ${calls === 1 ? 529 : 429}`, null);
        return 'ok';
      },
      (message) => retries.push(message),
      1,
    );
    assert.equal(value, 'ok');
    assert.deepEqual(retries, ['HTTP 529', 'HTTP 429']);
  });

  test('does not retry a bad request', async () => {
    let calls = 0;
    await assert.rejects(
      withRetries(
        async () => {
          calls += 1;
          throw new HttpError(400, 'HTTP 400: bad', null);
        },
        () => {},
        1,
      ),
      FatalModelError,
    );
    assert.equal(calls, 1);
  });
});
