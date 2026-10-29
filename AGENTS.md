# AGENTS.md — working on game-r

game-r is an engine where an LLM plays and tests HTML web games from a URL,
under the user's instructions, for hours to days, learning from run to run.
Read these first:

| File | What it holds |
|---|---|
| `HANDOFF.md` | Current state, what is verified, the next steps in order, open decisions |
| `docs/MCP-DESIGN.md` | The design: principles, tools, loop, on-disk layout, build order, future work |
| `game-r.yaml` | Every user option, commented, with example campaigns |

## The user's direction (most important)

- **KISS and DRY.** A thin framework: a browser, a workspace and a few tools.
  One config file. One tool registry shared by MCP and the engine loop.
- **The agent does the job.** Planning, notes, time-keeping, reporting and bug
  hunting belong to the agent, guided by the user's instructions. Do not add
  supervisor models, scripted stall detectors, goal checkers or other layers
  that second-guess it: the user called these brittle. Build a tool only where
  the agent needs one. Ideas of that kind live in the design doc's *Future
  work* list and must earn their place by measured improvement first.
- **Game-agnostic.** Nothing in `src/` knows about a particular game. Game
  knowledge goes in a campaign's `instructions`.
- **All user options in `game-r.yaml`**, with comments and defaults. API keys
  only through environment variables named in the config.
- **Self-contained runs on disk** (`runs/<campaign>/`), so campaigns run side by
  side. Local only.
- **Autonomous with notifications** (`notify.command`). Live steering is future
  work.
- **Never install packages without asking.** Approved so far: `playwright`
  (pinned 1.63.0), `@modelcontextprotocol/sdk`, `zod`, `yaml`. Pending:
  `@anthropic-ai/sdk` (see `HANDOFF.md`).
- Writing: UK English; concise; headings and tables. Code comments say what
  the code does, not why, and stay sparse. The user is on macOS (zsh), in
  Melbourne.

## Layout

```
src/cli.ts        commands: run, stop, mcp, status, config, list
src/config.ts     zod schema for game-r.yaml; defaults → campaign merge; path resolution
src/workspace.ts  campaign directory, lock, run folders, transcript, status.json
src/session.ts    one campaign in one process: workspace + browser + files, limits, notify, usage
src/browser.ts    Playwright: persistent context, devices, console capture, clock, touch, screenshots + grid
src/files.ts      the files tool's backend: /memory (rw), /run (rw), /runs (ro)
src/tools.ts      the tool registry (zod inputs) and Toolbox.call (validate, run, log, never throw)
src/prompt.ts     the framework system prompt + the campaign's instructions
src/mcp.ts        `game-r mcp`: the tools over MCP stdio, with the prompt as server instructions
src/engine.ts     `game-r run`: the model loop, openings, refresh, nudges, limits, stop
src/model.ts      provider interface, retries, cost, createProvider
src/openai.ts     OpenAI-compatible Chat Completions provider (fetch)
test/             node:test; fixtures/game.html is a small canvas game used by the tests
```

## Commands

```zsh
npm test                                   # 28 tests, ~25 s, real headless Chromium
npx tsc --noEmit                           # needs typescript (not a dependency; see below)
node src/cli.ts list | config <c> | status [c] | run <c> | stop <c> | mcp <c>
```

In the Claude cloud environment TypeScript is installed globally but
`@types/node` lives elsewhere, so typecheck with:

```zsh
tsc --noEmit -p . --typeRoots /opt/node-tools/node_modules/@types
```

## Code conventions

- **Node runs the `.ts` sources directly** (type stripping, Node ≥ 22.18). So:
  no parameter properties, enums or namespaces (`erasableSyntaxOnly` in
  `tsconfig.json` catches them); imports use `.ts` extensions; no build step.
- **zod schemas are the single source** for tool inputs: MCP takes them
  directly and the engine converts them with `z.toJSONSchema`. Avoid tuples
  (they become `prefixItems`, which some providers reject); use
  `z.array(...).length(n)`.
- **Actions are flat objects** `{do, at, ...}`, which every provider's tool
  calling handles; targets are a ref (`e12`, `f1e6`), a grid cell (`F7`,
  upper case) or `"x,y"` in CSS px.
- **Tools return errors, they don't throw.** `Toolbox.call` validates, runs,
  converts exceptions to `isError` results, logs every call to the transcript
  and writes `status.json`.
- **Model conversations are append-only** (see *Lessons*). Each provider keeps
  its history in its own native format inside its `Conversation`.
- Text from games or models reaches the notify command only through
  environment variables (`GAMER_*`), never interpolated into the shell command.
- Verify with the real browser, not only unit tests. Probe any uncertain
  Playwright or API behaviour with a short script in the scratchpad before
  building on it (the clock, aria refs and the grid overlay were all probed
  first, and each probe changed the design).
- Run the suite two or three times after browser-touching changes to catch
  timing flakiness.

## Lessons learned (don't rediscover these)

**Playwright and the browser**
- `context.clock.install()` must run when the context is created, before page
  scripts: timers a page registered natively before install keep running.
  Install leaves the clock running at real speed until paused.
- Pausing races the running clock: `pauseAt(Date.now())` can fail with
  "Cannot fast-forward to the past" and leave the clock half-paused. Pause
  slightly ahead and retry (`GameBrowser.pause`).
- The clock covers `requestAnimationFrame`, timers, `Date` and
  `performance.now`; not Web Audio, CSS animations or Web Worker timers.
  Playwright actions (click actionability checks) still work while paused.
- `page.ariaSnapshot({ mode: 'ai', boxes: true })` gives `[ref=e12]` and
  `[box=x,y,w,h]` (CSS px); `locator('aria-ref=e12')` resolves a ref. After a
  reload refs gain a frame prefix (`f1e6`).
- `screenshot({ scale: 'css' })` makes image pixels equal CSS pixels, so the
  agent can target what it sees. The grid overlay is an SVG background on
  `html::after` passed through the screenshot's `style` option: it never
  touches the page's DOM.
- Phone landscape is its own Playwright device (`Pixel 7 landscape` is
  863×360), not a swapped portrait viewport.
- Multi-touch (pinch) needs Chromium's DevTools protocol
  (`Input.dispatchTouchEvent`); Chromium fires one `touchstart` per finger.
  Both example games mostly use pointer events.
- `alert`/`confirm`/`prompt` block the page; they are accepted automatically
  and logged to the console so the agent sees them.

**Models**
- Current Claude models (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1) bind
  thinking blocks to the conversation: editing or deleting earlier turns
  invalidates them (a 400 on newer accounts) and restarts the prompt cache.
  Never prune history client-side. game-r's context refresh starts a *new*
  conversation instead (the agent saves to /memory first); Anthropic's
  server-side tool-result clearing is the allowed way to drop old screenshots
  sooner.
- Opus 5.5: thinking cannot be disabled (effort is the control, default
  `medium`, set it explicitly); forced `tool_choice` (`any`/`tool`) returns a
  400; 1M context; $4/$20 per million tokens (cache reads $0.20). Sonnet 5.5
  $2/$10; Haiku 5.5 $0.10/$0.50. Load the `claude-api` skill before writing
  Anthropic code: it says to use `@anthropic-ai/sdk`, not raw HTTP, in
  TypeScript.
- Chat Completions doesn't allow images in `tool` messages: the
  OpenAI-compatible provider sends them in a user message right after.
  `api.openai.com` wants `max_completion_tokens`; other servers `max_tokens`.
  `reasoning_effort` is only sent when `reasoning` is not `off`.

**The cloud environment (Claude Code on the web)**
- Playwright's browsers are preinstalled at `/opt/pw-browsers`
  (`PLAYWRIGHT_BROWSERS_PATH`). Never run `playwright install`; keep
  `playwright` pinned to 1.63.0 so it finds them.
- An MCP stdio client passes the server only a minimal environment, which
  drops `PLAYWRIGHT_BROWSERS_PATH`; `test/mcp.test.ts` passes `process.env`
  through. On a normal Mac install browsers are in the default cache.
- Network: github.com (clone) and the npm registry work; `arxiv.org`,
  `dev.to`, `latent.space` and `*.github.io` were blocked in the first
  session (the user is adding `*.github.io`).
- Running `npm ci` in a cloned third-party game repo was refused by the
  sandbox's safety check (it runs third-party install scripts). Don't retry
  or work around it; use the live github.io builds. ToME's build also needs
  the Emscripten SDK.
- No `ANTHROPIC_API_KEY` was set in the first session.
- A stop hook asks for everything to be committed and pushed before a turn
  ends. Work on a branch (`claude/...`), never `main`.
- Don't `pkill -f <pattern>` from Bash: the pattern also matches the shell
  running the command and kills it (exit 144). Find PIDs with
  `ps -eo pid,args | grep "[n]ode driver"` and `kill` them. Background
  servers outlive the command that started them; stop them when done.

## Playing hands-on from a session

`game-r mcp` serves the tools to an MCP client, but a cloud session can't add
an MCP server to itself. To play through the exact same tools from Bash, run a
throwaway driver from the scratchpad that keeps one `Session` open and serves
`Toolbox.call` over local HTTP, saving images to files you can view:

```ts
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { Session } from '/home/user/game-r/src/session.ts';
import { Toolbox } from '/home/user/game-r/src/tools.ts';
import { loadConfig } from '/home/user/game-r/src/config.ts';
const s = await Session.open(await loadConfig('/home/user/game-r/game-r.yaml', process.argv[2]!), 'mcp');
const box = new Toolbox(s);
await s.begin();
let n = 0;
http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const { tool, args } = JSON.parse(body);
  const r = await box.call(tool, args);
  res.end(r.content.map((c) => {
    if (c.type === 'text') return c.text;
    const f = `${import.meta.dirname}/view-${++n}.jpg`;
    writeFileSync(f, Buffer.from(c.data, 'base64'));
    return `[image ${f}]`;
  }).join('\n'));
}).listen(8799, '127.0.0.1');
```

```zsh
node driver.ts tome-ui &   # then:
curl -s localhost:8799 -d '{"tool":"look","args":{"grid":true}}'
```

## The example games

- **ToME — Tales of Middle-earth** (`darrencroton/tales-of-middle-earth`, the
  user's): ToME 2 compiled to WebAssembly, a phone-first PWA. Turn-based.
  Pointer events plus some touch. `window.__tome` is a debug hook
  (`screenText`, `sendText`, `mode`, `actions`, `tapCell`, `exploreStop`…) and
  `?wizard` enables wizard mode; both are developer-level access, not player
  access. Its own e2e tests use Pixel 7 portrait and landscape and a Galaxy Tab.
- **Battle Drones** (`simonw/battledrones`): a real-time RTS on canvas; pointer
  events and wheel. Its `AGENT-BATTLES.md` (fresh context per round with the
  agent's own notes, compact text observations, rounds of game time) shaped
  this design. Replays open with `?replay=<record>`.
