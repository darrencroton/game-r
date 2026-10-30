import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CampaignSchema, deepMerge, type Config } from '../src/config.ts';
import type { ToolResult } from '../src/tools.ts';

export const FIXTURE_URL = pathToFileURL(path.join(import.meta.dirname, 'fixtures', 'game.html')).href;

export async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'game-r-test-'));
}

export async function makeConfig(over: Record<string, unknown> = {}): Promise<Config> {
  // Points agent CLIs at a command that cannot exist, and never reads the user's secrets file.
  const base = { name: 'test', url: FIXTURE_URL, instructions: 'Play the game.', output: await tempDir(), model: { command: '/nonexistent/agent-cli', secrets_file: null } };
  return CampaignSchema.parse(deepMerge(base, over));
}

export function textOf(result: ToolResult): string {
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');
}
