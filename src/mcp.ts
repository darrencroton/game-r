import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Config } from './config.ts';
import { systemPrompt } from './prompt.ts';
import { Session } from './session.ts';
import { Toolbox } from './tools.ts';

export async function serveMcp(config: Config, version: string): Promise<void> {
  const session = await Session.open(config, 'mcp');
  const toolbox = new Toolbox(session);
  const ready = session.begin();
  ready.catch((err) => console.error(`game-r: could not start the run: ${(err as Error).message}`));

  const server = new McpServer({ name: 'game-r', version }, { instructions: await systemPrompt(config) });
  for (const tool of toolbox.tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args: unknown) => {
      try {
        await ready;
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `The run could not start: ${(err as Error).message}` }], isError: true };
      }
      const result = await toolbox.call(tool.name, args);
      return {
        content: result.content.map((c) => (c.type === 'image' ? { type: 'image' as const, data: c.data, mimeType: c.mimeType } : c)),
        isError: result.isError,
      };
    });
  }

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await ready.catch(() => {});
    await session.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);

  const transport = new StdioServerTransport();
  transport.onclose = () => void shutdown();
  await server.connect(transport);
  console.error(`game-r: serving campaign "${config.name}" over MCP (stdio); output in ${session.workspace.dir}`);
}
