import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const AGENT_CLIS = ['claude-code', 'codex'] as const;

const ModelSchema = z.object({
  provider: z.enum([...AGENT_CLIS, 'anthropic', 'openai-compatible']).default('claude-code'),
  name: z.string().nullable().default(null),
  command: z.string().nullable().default(null),
  base_url: z.string().nullable().default(null),
  api_key_env: z.string().nullable().default(null),
  secrets_file: z.string().nullable().default('./.env'),
  headers: z.record(z.string(), z.string()).default({}),
  max_output_tokens: z.number().int().positive().default(16000),
  request_timeout_seconds: z.number().positive().default(600),
  reasoning: z.string().default('high'),
  vision: z.boolean().default(true),
  price_per_mtok: z
    .object({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cache_read: z.number().nonnegative().optional(),
      cache_write: z.number().nonnegative().optional(),
    })
    .nullable()
    .default(null),
});

const BrowserSchema = z.object({
  engine: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  headless: z.boolean().default(true),
  device: z.string().default('desktop'),
  viewport: z.tuple([z.number().int().positive(), z.number().int().positive()]).nullable().default(null),
  profile: z.enum(['campaign', 'run']).default('campaign'),
  profile_from: z.string().nullable().default(null),
  record_video: z.boolean().default(false),
  trace: z.boolean().default(false),
  keep_shots: z.enum(['referenced', 'all']).default('referenced'),
});

const ContextSchema = z.object({
  refresh_tokens: z.number().int().positive().default(200_000),
});

const LimitsSchema = z.object({
  runs: z.number().int().positive().nullable().default(10),
  hours: z.number().positive().nullable().default(48),
  cost_usd: z.number().positive().nullable().default(null),
  calls_per_run: z.number().int().positive().nullable().default(null),
  wrap_up_minutes: z.number().nonnegative().default(5),
});

const PaceSchema = z.object({
  seconds_per_call: z.number().min(0).max(600).default(0),
});

const NotifyEvent = z.enum(['agent', 'run_end', 'campaign_end', 'limit', 'error']);

const NotifySchema = z.object({
  command: z.string().nullable().default(null),
  on: z.array(NotifyEvent).default(['agent', 'run_end', 'campaign_end', 'limit', 'error']),
});

export const CampaignSchema = z.object({
  name: z.string().regex(/^[\w.-]+$/, 'campaign names may use letters, digits, _ . and -'),
  url: z.string().min(1),
  instructions: z.string().min(1),
  model: ModelSchema.default(ModelSchema.parse({})),
  browser: BrowserSchema.default(BrowserSchema.parse({})),
  access: z.enum(['player', 'developer']).default('player'),
  clock: z.enum(['allowed', 'off']).default('allowed'),
  context: ContextSchema.default(ContextSchema.parse({})),
  limits: LimitsSchema.default(LimitsSchema.parse({})),
  pace: PaceSchema.default(PaceSchema.parse({})),
  notify: NotifySchema.default(NotifySchema.parse({})),
  system_prompt_file: z.string().nullable().default(null),
  output: z.string().default('./runs'),
});

export type Config = z.infer<typeof CampaignSchema>;
export type NotifyEventName = z.infer<typeof NotifyEvent>;

const FileSchema = z.object({
  defaults: z.record(z.string(), z.unknown()).default({}),
  campaigns: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});

type ConfigFile = z.infer<typeof FileSchema>;

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepMerge(base: Plain, over: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(over)) {
    out[key] = isPlain(value) && isPlain(out[key]) ? deepMerge(out[key] as Plain, value) : value;
  }
  return out;
}

export class ConfigError extends Error {}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

export function parseConfigText(text: string, source: string): ConfigFile {
  let raw: unknown;
  try {
    raw = parse(text, { merge: true }) ?? {};
  } catch (err) {
    throw new ConfigError(`${source}: invalid YAML: ${(err as Error).message}`);
  }
  const unknown = isPlain(raw) ? Object.keys(raw).filter((k) => k !== 'defaults' && k !== 'campaigns' && !k.startsWith('x-')) : [];
  if (unknown.length) throw new ConfigError(`${source}: unknown top-level key ${unknown.join(', ')} (use defaults, campaigns, or an x- name to hold YAML anchors)`);
  const file = FileSchema.safeParse(raw);
  if (!file.success) throw new ConfigError(`${source}:\n${formatIssues(file.error)}`);
  return file.data;
}

export function resolveCampaign(file: ConfigFile, name: string, baseDir: string): Config {
  const campaign = file.campaigns[name];
  if (!campaign) {
    const known = Object.keys(file.campaigns);
    throw new ConfigError(`No campaign "${name}". Known: ${known.length ? known.join(', ') : '(none)'}`);
  }
  const merged = deepMerge(file.defaults, campaign);
  const result = CampaignSchema.safeParse({ ...merged, name });
  if (!result.success) throw new ConfigError(`Campaign "${name}":\n${formatIssues(result.error)}`);
  const config = result.data;
  config.output = path.resolve(baseDir, config.output);
  if (config.browser.profile_from) config.browser.profile_from = path.resolve(baseDir, config.browser.profile_from);
  if (config.model.secrets_file) config.model.secrets_file = path.resolve(baseDir, config.model.secrets_file);
  if (config.system_prompt_file) config.system_prompt_file = path.resolve(baseDir, config.system_prompt_file);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(config.url)) config.url = new URL(`file://${path.resolve(baseDir, config.url)}`).href;
  return config;
}

/** The personal overlay for a config file, in the same folder: game-r.yaml → game-r.local.yaml. */
export function localConfigPath(file: string): string {
  const ext = path.extname(file);
  return path.join(path.dirname(file), `${path.basename(file, ext)}.local${ext}`);
}

/** Merges an overlay over a config: defaults deep-merged, campaigns added, or deep-merged by name. */
export function mergeConfigFiles(base: ConfigFile, over: ConfigFile): ConfigFile {
  return {
    defaults: deepMerge(base.defaults, over.defaults),
    campaigns: deepMerge(base.campaigns, over.campaigns) as ConfigFile['campaigns'],
  };
}

async function readText(file: string, missingOk: boolean): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (missingOk && (err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ConfigError(`Cannot read ${file}: ${(err as Error).message}`);
  }
}

/** Reads a config file and, when it exists, its local overlay (see localConfigPath). */
export async function readConfigFile(file: string): Promise<ConfigFile> {
  const base = parseConfigText((await readText(file, false))!, file);
  const localFile = localConfigPath(file);
  const local = await readText(localFile, true);
  return local === null ? base : mergeConfigFiles(base, parseConfigText(local, localFile));
}

export async function loadConfig(file: string, name: string): Promise<Config> {
  return resolveCampaign(await readConfigFile(file), name, path.dirname(path.resolve(file)));
}

export async function listCampaigns(file: string): Promise<string[]> {
  return Object.keys((await readConfigFile(file)).campaigns);
}
