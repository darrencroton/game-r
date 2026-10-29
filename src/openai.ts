import type { Config } from './config.ts';
import { apiKey, FatalModelError, postJson, textOfResult, withRetries, type Conversation, type Provider, type Reply, type RetryListener, type ToolCall, type ToolSpec } from './model.ts';
import type { Content, ToolResult } from './tools.ts';

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type Message =
  | { role: 'system' | 'user'; content: string | Part[] }
  | { role: 'assistant'; content: string | null; tool_calls?: unknown[] }
  | { role: 'tool'; tool_call_id: string; content: string };

const EFFORT: Record<string, string | null> = { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };

function parts(content: Content[]): Part[] {
  return content.map((c) => (c.type === 'text' ? { type: 'text', text: c.text } : { type: 'image_url', image_url: { url: `data:${c.mimeType};base64,${c.data}` } }));
}

/** Chat Completions API: OpenAI, Gemini's compatible endpoint, OpenRouter, Ollama, LM Studio, vLLM. */
export class OpenAICompatible implements Provider {
  private readonly model: Config['model'];
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(model: Config['model']) {
    if (!model.base_url) throw new FatalModelError('provider openai-compatible needs model.base_url, e.g. https://api.openai.com/v1');
    this.model = model;
    this.url = model.base_url.replace(/\/+$/, '') + '/chat/completions';
    const key = apiKey(model);
    this.headers = key ? { authorization: `Bearer ${key}` } : {};
  }

  start(system: string, tools: ToolSpec[], onRetry: RetryListener): Conversation {
    return new OpenAIConversation(this.model, this.url, this.headers, system, tools, onRetry);
  }
}

class OpenAIConversation implements Conversation {
  private readonly messages: Message[];
  private readonly body: Record<string, unknown>;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly onRetry: RetryListener;
  contextTokens = 0;

  constructor(model: Config['model'], url: string, headers: Record<string, string>, system: string, tools: ToolSpec[], onRetry: RetryListener) {
    this.url = url;
    this.headers = headers;
    this.onRetry = onRetry;
    this.messages = [{ role: 'system', content: system }];
    const effort = EFFORT[model.reasoning];
    const officialOpenAI = new URL(url).hostname === 'api.openai.com';
    this.body = {
      model: model.name,
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })),
      [officialOpenAI ? 'max_completion_tokens' : 'max_tokens']: model.max_output_tokens,
      ...(effort ? { reasoning_effort: effort } : {}),
    };
  }

  user(content: Content[]): void {
    this.messages.push({ role: 'user', content: parts(content) });
  }

  results(results: { call: ToolCall; result: ToolResult }[], note?: string): void {
    const images: Part[] = [];
    for (const { call, result } of results) {
      this.messages.push({ role: 'tool', tool_call_id: call.id, content: textOfResult(result) });
      images.push(...parts(result.content.filter((c) => c.type === 'image')));
    }
    const extra: Part[] = [];
    if (images.length) extra.push({ type: 'text', text: 'Screenshots returned by the tool calls above, in order:' }, ...images);
    if (note) extra.push({ type: 'text', text: note });
    if (extra.length) this.messages.push({ role: 'user', content: extra });
  }

  async next(): Promise<Reply> {
    const res = await withRetries(() => postJson(this.url, { ...this.body, messages: this.messages }, this.headers), this.onRetry);
    const message = res.choices?.[0]?.message;
    if (!message) throw new FatalModelError(`Unexpected response: ${JSON.stringify(res).slice(0, 300)}`);
    const toolCalls: any[] = message.tool_calls ?? [];
    this.messages.push({ role: 'assistant', content: message.content ?? null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    const calls = toolCalls.map((tc) => {
      let args: unknown = tc.function?.arguments ?? '{}';
      try {
        args = JSON.parse(args as string);
      } catch {
        /* left as the raw string: the tool reports invalid arguments */
      }
      return { id: tc.id, name: tc.function?.name ?? '', args };
    });
    const prompt = res.usage?.prompt_tokens ?? 0;
    const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    this.contextTokens = prompt;
    return {
      text: typeof message.content === 'string' ? message.content : '',
      calls,
      usage: { input: prompt - cached, cache_read: cached, cache_write: 0, output: res.usage?.completion_tokens ?? 0 },
      stop: res.choices[0].finish_reason ?? 'unknown',
    };
  }
}
