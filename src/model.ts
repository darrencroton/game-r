import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import type { Config } from './config.ts';
import type { Content, ToolResult } from './tools.ts';

export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface TokenUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface Reply {
  text: string;
  calls: ToolCall[];
  usage: TokenUsage;
  stop: string;
}

/** A conversation kept in the provider's own message format. Append-only: earlier turns are never edited. */
export interface Conversation {
  user(content: Content[]): void;
  results(results: { call: ToolCall; result: ToolResult }[], note?: string): void;
  next(): Promise<Reply>;
  /** Input tokens of the latest request, i.e. the current size of the context. */
  readonly contextTokens: number;
}

export type RetryListener = (message: string, delayMs: number) => void;

export interface Provider {
  start(system: string, tools: ToolSpec[], onRetry: RetryListener): Conversation;
}

/** An error that retrying will not fix (bad request, authentication, configuration). */
export class FatalModelError extends Error {}

export async function createProvider(model: Config['model']): Promise<Provider> {
  if (model.provider === 'openai-compatible') {
    const { OpenAICompatible } = await import('./openai.ts');
    return new OpenAICompatible(model);
  }
  throw new FatalModelError('The anthropic provider is not built yet (it needs @anthropic-ai/sdk; see HANDOFF.md). Use provider: openai-compatible meanwhile.');
}

/** Reads one NAME=value entry from a secrets file; a missing file reads as empty. */
function readSecret(file: string, name: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new FatalModelError(`Cannot read ${file} (model.secrets_file): ${(err as Error).message}`);
  }
  // parseEnv reads "A= " followed by "B=x" as A="B=x", so trailing blanks are trimmed first.
  return parseEnv(text.replace(/[ \t]+$/gm, ''))[name];
}

/** The API key: the environment variable named by api_key_env, else that name in the secrets file. */
export function apiKey(model: Config['model']): string | null {
  const name = model.api_key_env;
  if (!name) return null;
  const key = process.env[name] || (model.secrets_file ? readSecret(model.secrets_file, name) : undefined);
  if (!key) {
    const where = model.secrets_file ? `Add ${name}=… to ${model.secrets_file} (model.secrets_file) or set the ${name} environment variable` : `Set the ${name} environment variable`;
    throw new FatalModelError(`${where}, or set api_key_env: null for a server that needs no key.`);
  }
  return key;
}

export function cost(usage: TokenUsage, price: Config['model']['price_per_mtok']): number {
  if (!price) return 0;
  const read = price.cache_read ?? price.input * 0.1;
  const write = price.cache_write ?? price.input * 1.25;
  return (usage.input * price.input + usage.cache_read * read + usage.cache_write * write + usage.output * price.output) / 1_000_000;
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 10;
const MAX_DELAY_MS = 300_000;

export class HttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, message: string, retryAfterMs: number | null) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** POSTs JSON and returns the parsed response; HTTP failures become HttpError. */
export async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs = 600_000): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    const after = Number(res.headers.get('retry-after'));
    throw new HttpError(res.status, `HTTP ${res.status}: ${text.slice(0, 500)}`, Number.isFinite(after) && after > 0 ? after * 1000 : null);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(res.status, `Response was not JSON: ${text.slice(0, 200)}`, null);
  }
}

/** Retries rate limits, overloads, server errors and network failures with backoff; anything else is fatal. */
export async function withRetries<T>(fn: () => Promise<T>, onRetry: RetryListener, baseDelayMs = 2000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err instanceof HttpError ? err.status : null;
      const retryable = status === null ? !(err instanceof FatalModelError) : RETRYABLE.has(status);
      if (!retryable) throw new FatalModelError((err as Error).message);
      if (attempt >= MAX_ATTEMPTS) throw err;
      const backoff = Math.min(MAX_DELAY_MS, baseDelayMs * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
      const delay = Math.min(MAX_DELAY_MS, Math.max(backoff, (err as HttpError).retryAfterMs ?? 0));
      onRetry((err as Error).message, delay);
      await sleep(delay);
    }
  }
}

export function textOfResult(result: ToolResult): string {
  const text = result.content
    .filter((c): c is Extract<Content, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  return result.isError ? `Error: ${text}` : text || '(no text)';
}
