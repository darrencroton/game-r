import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FIXTURE_URL, tempDir } from './helpers.ts';

test('game-r mcp serves the tools and the instructions over stdio', async () => {
  const dir = await tempDir();
  const configFile = path.join(dir, 'game-r.yaml');
  await writeFile(
    configFile,
    `defaults:\n  output: ./out\ncampaigns:\n  fixture:\n    url: ${FIXTURE_URL}\n    instructions: Survive as long as you can.\n`,
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(import.meta.dirname, '..', 'src', 'cli.ts'), 'mcp', 'fixture', '--config', configFile],
    env: process.env as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  try {
    assert.match(client.getInstructions() ?? '', /You are playing and testing a web game[\s\S]*Your instructions\nSurvive as long as you can\./);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ['look', 'read_page', 'act', 'console', 'clock', 'browser', 'files', 'status', 'log', 'notify', 'end_run'],
    );
    const act = tools.find((t) => t.name === 'act')!;
    assert.equal((act.inputSchema.properties as Record<string, unknown>).actions !== undefined, true);

    const look = await client.callTool({ name: 'look', arguments: { grid: 80 } });
    const content = look.content as Array<{ type: string; data?: string; text?: string }>;
    assert.equal(content[0]!.type, 'image', JSON.stringify(content));
    assert.ok(content[0]!.data!.length > 1000);
    assert.match(content[1]!.text!, /"Dodge"/);

    const bad = await client.callTool({ name: 'files', arguments: { command: 'view', path: '/etc' } });
    assert.equal(bad.isError, true);

    const status = JSON.parse(await readFile(path.join(dir, 'out', 'fixture', 'status.json'), 'utf8'));
    assert.equal(status.mode, 'mcp');
    assert.equal(status.run, 1);
  } finally {
    await client.close();
  }
});
