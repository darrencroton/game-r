# AGENTS.md — working on game-r

game-r is an engine where an LLM plays and tests HTML web games from a URL,
under the user's instructions, for hours to days, learning from run to run.
Read these first:

| File | What it holds |
|---|---|
| `docs/MCP-DESIGN.md` | The design: principles, tools, loop, on-disk layout, build order, future work |
| `game-r.yaml` | Every user option, commented, with example campaigns; personal settings and campaigns go in the gitignored `game-r.local.yaml`, merged over it |
| `local/` (if present) | Gitignored, the maintainer's own: `local/AGENTS.md` (their machine and working rules: **read it too**), `local/HANDOFF.md` (current state, next steps, open decisions), run reports |

## The maintainer's direction (most important)

- **KISS and DRY.** A thin framework: a browser, a workspace and a few tools.
  One config file. One tool registry shared by MCP and the engine loop.
- **The agent does the job.** Planning, notes, time-keeping, reporting and bug
  hunting belong to the agent, guided by the user's instructions. Do not add
  supervisor models, scripted stall detectors, goal checkers or other layers
  that second-guess it: the maintainer called these brittle. Build a tool only where
  the agent needs one. Ideas of that kind live in the design doc's *Future
  work* list and must earn their place by measured improvement first.
- **Game-agnostic.** Nothing in `src/` knows about a particular game. Game
  knowledge goes in a campaign's `instructions`.
- **All user options in `game-r.yaml`**, with comments and defaults. API keys
  never in it: named in the config, read from the environment or `.env`.
  Ship only generic examples there; personal campaigns, hosts and notify
  commands belong in `game-r.local.yaml`, run results and notes in `local/`.
- **Self-contained runs on disk** (`runs/<campaign>/`), so campaigns run side by
  side. Local only.
- **Autonomous with notifications** (`notify.command`). Live steering is future
  work.
- **Runs use subscriptions first**: Claude (through Claude Code) and
  ChatGPT (through Codex). API-key providers (OpenCode Go, local servers)
  come second.
- **Never install packages without asking.** Approved so far: `playwright`
  (pinned 1.63.0), `@modelcontextprotocol/sdk`, `zod`, `yaml`; dev:
  `typescript` (7.0.2), `@types/node` (22.x, matching the oldest supported Node).
  `@anthropic-ai/sdk` was asked about and deferred (only needed for the
  Anthropic API provider).
- **Secrets in `.env`** (gitignored), read by `apiKey()` for `model.api_key_env`
  without touching `process.env`; an environment variable wins. Never print it.
- **New users run `./setup.sh`.** Keep it working when setup needs change.
- Writing: UK English; concise; headings and tables. Code comments say what
  the code does, not why, and stay sparse.

## Layout

```
src/cli.ts        commands: run, stop, mcp, status, config, list
src/config.ts     zod schema for game-r.yaml; the game-r.local.yaml overlay; defaults → campaign merge; path resolution
src/workspace.ts  campaign directory, lock, run folders (run.json, report from template, log.md), ledger, memory templates, status.json
src/session.ts    one campaign in one process: run lifecycle (seal, next run), limits and warnings, pacing, timeline, notify, usage
src/browser.ts    Playwright: persistent context, devices, console capture, clock, touch, screenshots + grid
src/files.ts      the files tool's backend: /memory (rw), /run (rw), /runs (ro)
src/tools.ts      the tool registry (zod inputs), the status line, and Toolbox.call (count, validate, pace, run, log, never throw)
src/prompt.ts     the framework system prompt (tools, memory layout, run protocol) + the campaign's instructions
src/mcp.ts        the tools as an MCP server: stdio (`game-r mcp`) or loopback HTTP with a bearer token (for agent CLIs)
src/engine.ts     `game-r run`: shared set-up, stop and errors; the model loop (openings, refresh, nudges, limits)
src/agent.ts      `game-r run` with an agent CLI: claude-code (`claude -p`) or codex (`codex exec`) playing over HTTP MCP
src/model.ts      provider interface, retries, cost, createProvider
src/openai.ts     OpenAI-compatible Chat Completions provider (fetch); headers, vision switch
templates/        memory (README.md, guide.md, lessons.md) and run (report.md) templates: headings only; the rules live in prompt.ts
scripts/drive.ts  hand-play driver: one Session's tools over loopback HTTP (see *Playing hands-on*)
setup.sh          one-step, re-runnable setup for new users (deps, Chromium, .env, players, config, checks)
.env.example      secrets template; setup.sh copies it to .env (gitignored)
docs/             MCP-DESIGN.md, the design
test/             node:test; fixtures: game.html (a small canvas game), scroll.html (scroll areas), fake-agent.mjs (fakes both CLIs)
```

## Commands

```zsh
./setup.sh [--skip-tests]                  # setup / health check, safe to re-run
npm test                                   # ~15-30 s, real headless Chromium
npm run typecheck                          # tsc --noEmit over src, test, scripts
node src/cli.ts list | config <c> | status [c] | run <c> | stop <c> | mcp <c>   [-c game-r.yaml]
node scripts/drive.ts <c> [--headed]       # hand-play driver
```

## Code conventions

- **Node runs the `.ts` sources directly** (type stripping: Node 22.18+ or 23.6+). So:
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

**Memory, reporting and the protocol (design §7)**
- The first real ToME run (Opus) skipped the game's help, invented clock times, thought 15 minutes had passed after 3.4, and ended the campaign with its goal unmet. Structure fixed it, not supervision: templated memory, a run protocol in the prompt, a status line on every result, and framework-written facts.
- The second run (after the fix) kept good memory and lessons, and it learned across runs, but it never read the game's help under a 30-minute limit. Step 1 now applies whatever the time limit and follows the instructions' Getting started first. The user may give the agent a head start: instructions take Goal / Getting started / Deliverables, and files put in a campaign's `memory/` before its first run are kept.
- An end point in the game (death, win, game over) ends the run unless the instructions say otherwise, so in roguelikes `runs` counts deaths. If /memory hasn't changed during a run, its first `end_run` is held back with the reason (a file-activity check, not a content judgement); this works for every player, because the API loop discards results after a seal.
- Sonnet on high effort is the default and the benchmark player.
- Long campaigns keep memory useful through its layout: `guide.md` is the big picture and `lessons.md` the keyed detail, with a Review every fifth run and a snapshot per run. The layout is defined in `src/prompt.ts` and design §7; don't restate it elsewhere.
- `look` adds a `scrollable:` line because phone screenshots show no scrollbars. Agents had scrolled 13 times in about 1,300 calls, while ToME's race list hides 7 of its 22 races below the fold.
- Rules live once, in `src/prompt.ts`. Templates hold headings and one descriptive line; notes and openings name protocol steps instead of restating them.
- `end_run` seals the run; the driver starts the next (a fresh CLI session or conversation), so a late call can't play the next run. Under `game-r mcp` the next run starts at the next call.
- Every result ends with the status line; tests' `textOf` drops it. Calls are counted before a tool runs, so every line agrees.
- `read_page {url}` uses a separate headless browser: the game's clock is installed on its whole context and every tab is watched. Plain text beats an accessibility snapshot for docs pages. Only http(s): `file:` would let an injected agent read local files.

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
- Tool inputs are `z.strictObject`s, so unknown arguments are reported. Over
  MCP the SDK validates before `Toolbox.call`, so invalid calls there are not
  in the transcript or the call count.
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

**Agent CLIs (subscriptions)**
- Claude Code: `claude -p` with `--output-format json`, `--system-prompt`,
  `--mcp-config '{"mcpServers":{"gamer":{"type":"http","url":…,"headers":…}}}'`,
  `--strict-mcp-config`, `--tools ""` (no built-in tools), `--allowedTools
  mcp__gamer`, `--permission-prompts none`, `--model`, `--effort`,
  `--resume <session_id>`. Never `--bare`: bare mode ignores subscription
  logins and `CLAUDE_CODE_OAUTH_TOKEN`. With `--resume`, `total_cost_usd` is
  the session's running total, so game-r records the difference.
- Inside a Claude Code cloud session a nested `claude -p` runs on the user's
  subscription, but it inherits `CLAUDE_CODE_SESSION_ID` and would reuse the
  outer session's id; `src/agent.ts` removes it (and two related variables).
- Codex: `codex exec --json` (JSONL events `thread.started` → `thread_id`,
  `turn.completed` → `usage`, `turn.failed`, `item.completed`), `resume <id>
  <prompt>` after the options, `-c` TOML overrides for the MCP server (`url`,
  `bearer_token_env_var`, `default_tools_approval_mode="approve"`,
  `required`), `features.shell_tool=false`, `developer_instructions`,
  `model_reasoning_effort`, `--ignore-user-config` (auth still from
  `~/.codex`), `-s read-only`. Headless sign-in: `codex login --device-auth`.
  The docs site is `developers.openai.com`; when it is blocked, read the
  source on github.com (`openai/codex`, `codex-rs/exec/src/cli.rs`,
  `codex-rs/config/src/mcp_types.rs`).
- **Codex (verified 2026-10-30, codex-cli 0.163.0):**
  - It plays through these flags, and it sees MCP images.
  - Find model names and abilities in `~/.codex/models_cache.json` (`slug`, `supported_reasoning_levels`, `input_modalities`). "terra" is `gpt-6.1-terra`.
  - Always set `model.name`: `--ignore-user-config` drops the user's default model.
  - Codex reports tokens but no cost, so set `price_per_mtok` from LiteLLM's list. Cross-check with `npx ccusage@20.0.45 codex session --since YYYYMMDD --json`, matching sessions by thread id.
- OpenCode Go: Chat Completions at `https://opencode.ai/inference/go/openai/v1`
  (Bearer `OPENCODE_API_KEY`, plus an `x-opencode-session` affinity header).
  Some models use other APIs (Responses, Messages, Gemini). Reasoning values
  differ by model. `sst/models.dev` → `providers/opencode-go` gives each
  model's API type, but its prices didn't match the live API's (below).
- **OpenCode Go (verified 2026-10-30):**
  - The key is in `.env`.
  - The model list is at `https://opencode.ai/inference/go/v1/models` (`/openai/v1/models` returns 404). It gives each model's modalities, efforts and prices.
  - Trust `usage.opencode.list_cost` for prices: `deepseek-v4.1-flash` is $0.30 / $1.20 per million tokens, not models.dev's $0.15 / $0.60. `cost` is 0 because usage is billed to the Go allowance.
  - DeepSeek returns `reasoning_content`; `src/openai.ts` sends it back.
- **ChatGPT subscription limit (seen 2026-10-31):** Codex fails a turn with "You've hit your usage limit. … try again at 2:53 PM". game-r's log line cuts the message off before the time, but the run's transcript has it in full. Terra on high effort used up the allowance in about 1.2 h of play, and Luna on max effort ran 3 h in the next window. game-r still retries it like any other error while the clock runs.
- **The clock tool traps turn-based play:** Luna paused it, never resumed it, and advanced it by hand 91 times to make moves happen, although every status line said "paused". Use `clock: off` for turn-based games.
- **Downloads:** Playwright deletes downloads when the context closes, so `GameBrowser.watch` saves each one to `run-NNN/downloads/` (read-only to the agent) and logs it to `console`. ToME's title screen *Backup → Export game data* is one.
- Node's `fetch` has a hidden 300 s headers timeout (undici) that `AbortSignal` cannot extend, so a slow non-streamed reply failed after 5 minutes. `postJson` uses `node:http(s)`; `model.request_timeout_seconds` is the only bound.
- **Config:** YAML merge keys (`<<: *anchor`) are enabled. Before, they were ignored without a warning, and a campaign that reused a model block fell back to the default player, which would have started the real `claude`. Check a new campaign with `node src/cli.ts config <c>` before running it.
- **ccusage** (`npx ccusage@20.0.45`, not a dependency) prices Claude Code, Codex and OpenCode logs from LiteLLM. Use it to cross-check the ledger's costs.
- **Tests must never start a real agent CLI**: it spends the user's
  subscription. `test/helpers.ts` points `model.command` at a non-existent
  path, and tests merge overrides with `deepMerge` (a shallow spread once
  replaced the whole model block, fell back to the default provider and ran
  the real `claude`). Real checks: tiny, deliberate, announced (Haiku, low
  effort, `hours: 0.03`).
- **A crash of game-r itself (checked 2026-10-30 with `kill -9` mid-run):**
  - Chromium dies with it, because it runs over a pipe.
  - The orphaned `claude -p` exits within about 30 s, once its MCP server is gone.
  - Running the campaign again clears the stale lock and marks the run interrupted (calls kept, usage unknown). Elapsed time carries over, and play continues with memory intact.
  - `game-r status` reports a dead pid as interrupted.
- **Context and instruction files in agent CLIs (probed 2026-10-31):**
  - Neither CLI compacted in a long run: Sonnet 5.5's window is 1M (Claude Code compacts at about 967k) and Codex's default is about 90% of its window. game-r now passes `context.refresh_tokens` as Claude Code's `--autocompact` (it fires about 30k below) and Codex's `model_auto_compact_token_limit`. Both compact inside a headless session.
  - Both CLIs search upwards from the run folder (inside this repo) for instruction files, so game sessions loaded `~/.claude/CLAUDE.md` and this file. game-r sets `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` (undocumented; check a session log for "Contents of" after a Claude Code upgrade) and Codex's `project_doc_max_bytes=0`. `--safe-mode` also removes the MCP tools; `CLAUDE_CONFIG_DIR` needs a second login.
- `events.once(child, 'close')` rejects when the child emits `error` (for
  example ENOENT); `src/agent.ts` uses its own `finished()` helper.
- Don't `pkill -f <pattern>` from Bash: the pattern also matches the shell
  running the command and kills it (exit 144). Find PIDs with
  `ps -eo pid,args | grep "[n]ode driver"` and `kill` them. Background
  servers outlive the command that started them; stop them when done.

## Playing hands-on from a session

`game-r mcp` serves the tools to an MCP client, but a session can't add an MCP server to itself. To play through exactly the same tools from Bash, run `scripts/drive.ts`: it keeps one `Session` open, serves `Toolbox.call` over loopback HTTP, and saves result images to files you can view. It writes to `runs/<campaign>-hand/` with no limits, so the campaign's own memory and limits are untouched.

```zsh
node scripts/drive.ts tome-ui --headed --out <scratchpad>/tome &   # then:
curl -s localhost:8799 -d '{"tool":"look","args":{"grid":true}}'
curl -s localhost:8799 -d '{"tool":"act","args":{"actions":[{"do":"click","at":"F7"}]}}'
```

Add `--notify` to let `notify` and `end_run` send real notifications (off by default). Requests carrying an `Origin` header (from web pages) are refused. Stop it with `kill <pid>` (find it with `ps -eo pid,args | grep "[d]rive.ts"`); it closes the session cleanly on SIGTERM.

## The example games

- **ToME — Tales of Middle-earth** (`darrencroton/tales-of-middle-earth`, the
  maintainer's): ToME 2 compiled to WebAssembly, a phone-first PWA. Turn-based.
  Pointer events plus some touch. `window.__tome` is a debug hook
  (`screenText`, `sendText`, `mode`, `actions`, `tapCell`, `exploreStop`…) and
  `?wizard` enables wizard mode; both are developer-level access, not player
  access. Its own e2e tests use Pixel 7 portrait and landscape and a Galaxy Tab.
- **Battle Drones** (`simonw/battledrones`): a real-time RTS on canvas; pointer
  events and wheel. Its `AGENT-BATTLES.md` (fresh context per round with the
  agent's own notes, compact text observations, rounds of game time) shaped
  this design. Replays open with `?replay=<record>`.
