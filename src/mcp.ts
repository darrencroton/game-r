import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.ts';
import { systemPrompt } from './prompt.ts';
import { Session } from './session.ts';
import { Toolbox } from './tools.ts';

export const MCP_SERVER_NAME = 'gamer';

function buildServer(toolbox: Toolbox, instructions: string, version: string, ready: Promise<unknown> = Promise.resolve()): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version }, { instructions });
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
  return server;
}

/** `game-r mcp`: the campaign's tools over stdio for an interactive MCP client. */
export async function serveMcp(config: Config, version: string): Promise<void> {
  const session = await Session.open(config, 'mcp');
  const toolbox = new Toolbox(session);
  const ready = session.begin();
  ready.catch((err) => console.error(`game-r: could not start the run: ${(err as Error).message}`));
  const server = buildServer(toolbox, await systemPrompt(config), version, ready);

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

export interface HttpMcp {
  url: string;
  token: string;
  close(): Promise<void>;
}

/** The tools over stateless Streamable HTTP on loopback, guarded by a bearer token; used to hand them to an agent CLI. */
export async function startHttpMcp(toolbox: Toolbox, instructions: string, version: string): Promise<HttpMcp> {
  const token = randomBytes(24).toString('hex');
  const httpServer = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const server = buildServer(toolbox, instructions, version);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, JSON.parse(body));
    } catch (err) {
      if (!res.headersSent) res.writeHead(400).end(String((err as Error).message));
    }
  });
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const { port } = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () =>
      new Promise((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}
