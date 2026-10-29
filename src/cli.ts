#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import { ConfigError, listCampaigns, loadConfig } from './config.ts';
import { runCampaign } from './engine.ts';
import { FatalModelError } from './model.ts';
import { serveMcp } from './mcp.ts';

const USAGE = `game-r — LLMs play and test web games

Usage: game-r <command> [campaign] [--config game-r.yaml]

Commands:
  run <campaign>      Run a campaign with its configured model until it is done or a limit is reached
                      (running it again continues the campaign with a new run)
  stop <campaign>     Ask a running campaign to stop at the end of its current turn
  mcp <campaign>      Serve the game tools over MCP (stdio) for Claude Code or another client
  status [campaign]   Show the status of one campaign, or of every campaign in the config
  config <campaign>   Print a campaign's resolved configuration
  list                List the campaigns in the config
`;

async function version(): Promise<string> {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

async function showStatus(configFile: string, name: string): Promise<void> {
  const config = await loadConfig(configFile, name);
  const file = path.join(config.output, config.name, 'status.json');
  let status: Record<string, any>;
  try {
    status = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    console.log(`${name}: not started`);
    return;
  }
  const hours = (Number(status.elapsed_ms) / 3_600_000).toFixed(2);
  const cost = status.mode === 'engine' ? ` · $${Number(status.usage?.cost_usd ?? 0).toFixed(2)}` : '';
  const reason = status.done_reason ? ` (${status.done_reason})` : '';
  console.log(`${name}: ${status.state}${reason} · run ${status.run} · ${hours} h${cost} · updated ${status.updated_at}${status.last_error ? `\n  last error: ${status.last_error}` : ''}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { config: { type: 'string', short: 'c', default: 'game-r.yaml' }, help: { type: 'boolean', short: 'h' } },
  });
  const [command, name] = positionals;
  const configFile = values.config!;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  const needName = (): string => {
    if (!name) throw new ConfigError(`"${command}" needs a campaign name. Campaigns are listed by "game-r list".`);
    return name;
  };
  switch (command) {
    case 'run': {
      const reason = await runCampaign(await loadConfig(configFile, needName()));
      console.error(`game-r: campaign ended: ${reason}`);
      return;
    }
    case 'stop': {
      const config = await loadConfig(configFile, needName());
      const dir = path.join(config.output, config.name);
      await writeFile(path.join(dir, 'stop.request'), new Date().toISOString()).catch(() => {
        throw new ConfigError(`"${config.name}" has not been started.`);
      });
      console.log(`Asked "${config.name}" to stop after its current turn.`);
      return;
    }
    case 'mcp':
      await serveMcp(await loadConfig(configFile, needName()), await version());
      return;
    case 'status':
      for (const n of name ? [name] : await listCampaigns(configFile)) await showStatus(configFile, n);
      return;
    case 'config':
      console.log(stringify(await loadConfig(configFile, needName())));
      return;
    case 'list':
      console.log((await listCampaigns(configFile)).join('\n') || '(no campaigns)');
      return;
    default:
      throw new ConfigError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main().catch((err) => {
  console.error(err instanceof ConfigError || err instanceof FatalModelError ? `game-r: ${err.message}` : ((err as Error).stack ?? String(err)));
  process.exit(1);
});
