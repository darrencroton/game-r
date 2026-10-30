// Hand-play driver: keeps one Session open and serves Toolbox.call over loopback HTTP,
// so a person or a coding agent can play through exactly the agent's tools from a shell.
//
//   node scripts/drive.ts <campaign> [--headed] [--notify] [--port 8799] [--out <dir>] [--config game-r.yaml]
//   curl -s localhost:8799 -d '{"tool":"look","args":{"grid":true}}'
//
// Writes to runs/<campaign>-hand/ (the campaign's own memory is untouched) with no limits.
// Notifications are only logged unless --notify. Requests from web pages (with an Origin header) are refused.
// Images in a result are saved to --out and replaced by "[image <path>]".
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { Session } from '../src/session.ts';
import { Toolbox } from '../src/tools.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string', default: 'game-r.yaml' },
    port: { type: 'string', default: '8799' },
    out: { type: 'string', default: path.join(tmpdir(), 'game-r-drive') },
    headed: { type: 'boolean', default: false },
    notify: { type: 'boolean', default: false },
  },
});
const [campaign] = positionals;
if (!campaign) {
  console.error('Usage: node scripts/drive.ts <campaign> [--headed] [--notify] [--port 8799] [--out <dir>] [--config game-r.yaml]');
  process.exit(1);
}

const config = await loadConfig(values.config!, campaign);
config.name = `${config.name}-hand`;
config.limits = { runs: null, hours: null, cost_usd: null, turns_per_run: null };
if (values.headed) config.browser.headless = false;
if (!values.notify) config.notify.command = null;
const out = path.resolve(values.out!);
mkdirSync(out, { recursive: true });

let box: Toolbox | undefined;
let images = 0;

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.headers.origin !== undefined || !box) {
    res.statusCode = 403;
    res.end(box ? 'POST from a shell only.\n' : 'Starting.\n');
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  let text: string;
  try {
    const { tool, args } = JSON.parse(body);
    const result = await box.call(tool, args ?? {});
    text = result.content
      .map((c) => {
        if (c.type === 'text') return c.text;
        const file = path.join(out, `view-${String(++images).padStart(4, '0')}.jpg`);
        writeFileSync(file, Buffer.from(c.data, 'base64'));
        return `[image ${file}]`;
      })
      .join('\n');
    if (result.isError) text = `ERROR: ${text}`;
  } catch (err) {
    text = `ERROR: ${(err as Error).message}`;
  }
  res.end(`${text}\n`);
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(Number(values.port), '127.0.0.1', resolve);
}).catch((err: Error) => {
  console.error(`drive: cannot listen on port ${values.port}: ${err.message}`);
  process.exit(1);
});
const session = await Session.open(config, 'mcp');
const toolbox = new Toolbox(session);
await session.begin();
box = toolbox;
console.error(`drive: ${config.name} on http://127.0.0.1:${values.port}, images in ${out}, run folder ${session.workspace.runDir}`);

const shutdown = async (): Promise<void> => {
  server.close();
  await session.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
