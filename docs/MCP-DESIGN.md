# game-r — design (draft 0.5)

An engine where an LLM plays and tests HTML web-app games from a URL, under the
user's instructions, for hours to days, and learns from run to run.

> Status: steps 1–2b built (tools, MCP server, engine, agent CLI players, OpenAI-compatible provider). Next: hand-played tests and first runs on the example games. See §10 and `HANDOFF.md`.

---

## 1. Principles

- **The agent does the job.** We provide a browser, a workspace and a few
  tools. Planning, note-keeping, time-keeping, reporting and bug hunting are the
  agent's, guided by the user's instructions. No supervisor models, scripted
  stall detectors or goal checkers: they are brittle layers that second-guess
  the model.
- **KISS and DRY.** One config file. One tool set, used both by the engine's own
  loop and by any MCP client. Few dependencies.
- **Game-agnostic.** Nothing in the engine knows about a particular game.
  Anything game-specific goes in the instructions.
- **Self-contained runs.** Everything a campaign produces lives in its own
  directory. Campaigns run side by side without sharing state.
- **The framework only enforces what the agent can't:** the user's hard limits
  (cost, time, runs), browser lifecycle, context size, logging.

This follows Anthropic's own guidance for harnesses ("strip the harness down;
ask what can I stop doing?") and the later Claude Plays Pokémon setup, where
newer models kept their own organised notes in a memory folder instead of
relying on scaffolding.

---

## 2. Prior art — what we keep

| Source | Kept |
|---|---|
| Claude Plays Pokémon | Instructions always present; a memory the model curates itself; periodic context refresh |
| Anthropic harness guidance | Stable prompt first (cache-friendly); a memory folder; prune scaffolding |
| Battle Drones `AGENT-BATTLES.md` | Fresh context with the agent's own notes (flat cost instead of quadratic); a few batched-action tools; budgets enforced by the runner |
| Playwright MCP | Accessibility snapshot with element refs; coordinate input for canvas |
| Gemini Plays Pokémon / Continual Harness | The agent writes its own notes, routines and strategies rather than us hand-building them |
| Reflexion / Voyager | Learning across runs = the agent reading its past reports and memory before the next run |

**Considered, not adopted.** Mounting Playwright MCP as-is: it is built for web
forms (~25 tools, high token cost) and lacks what games need (held keys, touch
gestures, a game clock, grid screenshots). We build a small game-oriented tool
set directly on the Playwright library instead.

---

## 3. Shape

```
game-r.yaml ──► game-r run <campaign>
                    │
                    ▼
        ┌────────────── engine ───────────────┐
        │ campaign: runs · limits · logs       │
        │ tools (one registry) ────────────────┼──► game-r mcp (stdio, for any MCP client)
        │   browser · workspace · run          │
        │ player, one of:                      │
        │  ├ agent CLI: claude -p / codex exec ◄┼── tools over loopback HTTP MCP (bearer token)
        │  └ own loop over a model API ────────┼──► OpenAI-compatible (OpenCode Go, OpenAI, …)
        └───────┬──────────────────┬───────────┘
                ▼                  ▼
          Playwright         runs/<campaign>/
          browser            memory/ · run-001/ · run-002/ …
```

- **`game-r run <campaign>`** runs a campaign unattended. The player is either
  an **agent CLI** on the user's subscription (`claude-code`: Claude Code's
  `claude -p`; `codex`: `codex exec`), or game-r's **own loop** over a model
  API (`openai-compatible`; `anthropic` later). Either way game-r owns the
  campaign: the browser, the tools, runs, limits, memory and logs.
- **Agent CLIs** get only game-r's tools, over a loopback Streamable HTTP MCP
  server guarded by a random bearer token: Claude Code with `--tools ""` and
  `--strict-mcp-config`, Codex with its shell tool switched off. The prompt
  goes in as the system prompt (Claude Code) or developer instructions
  (Codex). When the CLI ends its turn, game-r resumes the same session with a
  nudge; each new run starts a fresh session from /memory; the CLI compacts its
  own context. Failures (such as a subscription's usage limit) back off from a
  minute up to an hour and retry, up to 8 times; three sessions in a row with
  no tool call end the campaign.
- **`game-r mcp <campaign>`** serves the same tools over stdio, same campaign
  directory and config, so Claude Code or another client can play or poke at a
  game interactively. No separate code path.

---

## 4. Configuration — one file

All user options and directions live in **`game-r.yaml`**. `defaults` apply to
every campaign; each campaign overrides only what differs. API keys stay in
environment variables, named in the config, never written into it.

The commented file in the repository, [`game-r.yaml`](../game-r.yaml), is the
reference: every option with its default, and three example campaigns (ToME
UI testing, Battle Drones speed-runs, and a tiny local test game). A campaign
needs only a `url` (http(s), or a local path relative to the config) and
`instructions`; everything else is inherited.

```yaml
campaigns:
  tome-ui:
    url: https://darrencroton.github.io/tales-of-middle-earth/
    browser: { device: "Pixel 7" }
    instructions: |
      Test ToME as a phone player. Play normally and look for UI bugs and quirks …
```

Example `notify.command` for macOS:

```zsh
osascript -e 'display notification (system attribute "GAMER_MESSAGE") with title (system attribute "GAMER_TITLE")'
```

Message text reaches the command only through environment variables, never by
string interpolation, so game or model text can't inject shell commands.

**Access levels.**
- `player` — the agent sees and does what a player can: the rendered page, its
  accessibility tree, the browser console, and anything the game itself offers
  (settings, modes, debug/wizard options the game exposes to its users). This
  is the default.
- `developer` — adds `evaluate` (run JS in the page) for QA work that needs
  internal state.

---

## 5. Tools

Eleven tools (nine always, plus `clock` and `evaluate` when the config allows them), one registry. Results are compact text; screenshots are images.
Every input-tool result ends with a one-line summary of new console errors, if
there are any, so the agent notices them without polling.

### Browser

| Tool | Arguments | Does |
|---|---|---|
| `look` | `grid?` (overlay labelled cells for canvas aiming), `region?` (zoom), `save_as?` | Screenshot plus URL, title and viewport. `save_as` writes it into the run directory for reports. |
| `read_page` | `filter?` (`interactive` / `all`), `query?` | Accessibility/DOM text snapshot with element refs (`[e12] button "Explore"`). |
| `act` | `actions: Action[]`, `look_after?` | Runs a batch of inputs in order; stops at the first failure; returns `ok`/reason per action. |
| `console` | `since?` (`last` / `start`), `level?` | Console messages, page errors and failed network requests. |
| `clock` | `pause` / `resume` / `advance {ms}` / `status` | Controls the page's game time (`requestAnimationFrame`, timers, `performance.now()`). Present only if `clock: allowed`. |
| `browser` | `device?`, `viewport?`, `orientation?`, `restart?` | Change device or orientation mid-run; restart the browser (profile kept). |
| `evaluate` | `expression` | Run JS in the page. Present only if `access: developer`. |

Each action is one flat object, `{do, ...}`, which every provider's tool calling handles well:

```jsonc
{ "do": "click", "at": "e12" }                    // ref from read_page (after a reload refs may look like f1e6)
{ "do": "tap", "at": "F7" }                       // grid cell from look (upper case)
{ "do": "click", "at": "320,180", "button": "right", "count": 2 }   // CSS px
{ "do": "hover" | "long_press", "at": "…", "ms": 800 }
{ "do": "drag", "at": "…", "to": "…", "ms": 300 }
{ "do": "swipe", "at": "…", "dir": "up", "distance": 200, "ms": 250 }
{ "do": "pinch", "at": "…", "scale": 2 }          // two-finger touch, chromium
{ "do": "key", "key": "ArrowRight", "ms": 500 }   // ms = hold time
{ "do": "keys", "keys": ["Control", "s"] }        // chord
{ "do": "type", "text": "Frodo" }
{ "do": "scroll", "at": "…", "dy": 300 }
{ "do": "wait", "ms": 250 }                       // game time when the clock is paused
{ "do": "goto", "url": "…" } · { "do": "reload" } · { "do": "back" }
```

On a touch device, drags, swipes and long presses are real touch events
(Chromium DevTools protocol); elsewhere they fall back to the mouse. A `tap`
on a device without touch is a click. Dialogs (`alert`, `confirm`, `prompt`)
are accepted automatically and logged to the console so the agent sees them.

The clock was verified in this environment with Playwright 1.63: paused for
1.5 s of wall time → 0 frames; `advance 1000` → 63 frames and 10 `setInterval`
ticks. A held key with the clock paused moves the game exactly that much game
time (tested). It does not cover Web Audio, CSS animations or Web Worker timers; the
framework prompt tells the agent so, and the agent decides whether pausing
suits the game and its instructions.

### Workspace

| Tool | Arguments | Does |
|---|---|---|
| `files` | `view` / `create` / `str_replace` / `insert` / `delete` / `rename` | File access with the same commands as Anthropic's memory tool, confined to three roots: `/memory` (read-write, kept across runs), `/run` (read-write, this run), `/runs` (read-only, earlier runs of this campaign). |

### Run

| Tool | Arguments | Does |
|---|---|---|
| `status` | — | Wall time elapsed, run number, turns, tokens, cost, and each limit with what remains. |
| `notify` | `title`, `message`, `level` (`info`/`finding`/`milestone`/`problem`) | Sends a notification through `notify.command`. |
| `end_run` | `summary`, `next` (`new_run` / `done`) | Ends this run. `new_run` starts the next one (within limits); `done` ends the campaign. |

---

## 6. The loop (API providers)

`src/engine.ts`; agent CLIs are driven by `src/agent.ts` instead (§3). One conversation per context; each conversation is
**append-only** in the provider's own message format.

```
create the provider (fails fast on a bad model config)
open the campaign; start the next run (browser opens at the URL)
loop until the campaign is done, a limit is hit, or a stop is requested:
  if no conversation: start one = system prompt + an opening message (run start or refresh)
  reply = model(conversation)                       # retries 408/409/429/5xx/529 with backoff
  count tokens and cost; log the reply
  no tool calls → nudge ("carry on, act through the tools"); 3 in a row ends the campaign
  run the tool calls in order (the browser is stateful); log each one
  end_run started a new run → new conversation (run opening)
  turns_per_run reached → end the run (warned one turn earlier)
  refresh was announced last turn → new conversation (refresh opening)
  context ≥ refresh_tokens → append the results plus "context refreshes after this turn; save to /memory"
  otherwise → append the results
```

- **System prompt** (`src/prompt.ts`) = a short framework prompt (tools,
  workspace layout, clock caveats, how runs and refreshes work) followed by the
  user's `instructions`, verbatim. Sent with every request and never edited, so
  the instructions can't scroll out or be summarised away; it is also the
  cacheable prefix.
- **Openings**: a run opening (run number, the `status` text, earlier runs,
  "start by reading /memory") or a refresh opening ("still run N, the game is
  as you left it, read /memory").
- **Context size** is bounded by `context.refresh_tokens` (default 200k input
  tokens per request). A refresh is "simple compaction" with the agent as the
  summariser: it saves to /memory, then the next request starts clean. Nothing
  earlier is ever edited or deleted client-side, which current Claude models
  require: editing earlier turns invalidates their thinking blocks (preserved
  thinking) and restarts the prompt cache. Old screenshots therefore stay until
  the refresh; on Anthropic the API's server-side tool-result clearing is the
  allowed way to drop them sooner.
- **Images in tool results**: Anthropic takes them inside `tool_result`;
  Chat Completions does not, so the OpenAI-compatible adapter sends them in a
  user message straight after the tool messages.
- **Errors**: retryable API errors back off (honouring `retry-after`, up to 10
  attempts, ≤ 5 min apart); anything else is fatal, notified and recorded in
  `status.json`. Browser problems come back to the agent as tool errors; it can
  `browser {restart: true}`.

---

## 7. On disk

```
runs/<campaign>/
  config.yaml          # resolved config snapshot, written at each start
  campaign.lock        # pid; stops two processes running one campaign
  status.json          # state (running/done/stopped), run, turns, tokens, cost, elapsed, last error
  stop.request         # written by `game-r stop`; the engine stops after the current turn
  profile/             # browser profile (in-game saves, localStorage, IndexedDB)
  memory/              # agent-owned, kept across runs
  run-001/
    transcript.jsonl   # every model reply and tool call/result (images by file reference)
    shots/             # every screenshot, numbered
    live.jpg           # latest screenshot
    end.json           # the agent's end_run summary
    video/ trace.zip   # if enabled
    …                  # whatever the agent writes: report.md, findings.md, log.md
  run-002/
```

Separate campaigns run in parallel, each with its own browser, directory and
lock. A run is portable: zip the campaign directory and it is all there.
Elapsed time and usage are cumulative across processes (read back from
`status.json`), so limits hold across restarts.

---

## 8. CLI

| Command | Does |
|---|---|
| `game-r run <campaign> [--config game-r.yaml]` | Run with the configured model. Running it again continues the campaign with a new run (memory, browser profile and limits carry over). |
| `game-r stop <campaign>` | Stop cleanly at the end of the current turn (Ctrl-C does the same; twice quits at once). |
| `game-r status [campaign]` | Read `status.json` for one or all campaigns. |
| `game-r mcp <campaign>` | Serve the tools over MCP (stdio) for an interactive client. |
| `game-r config <campaign>` · `game-r list` | Show a resolved campaign; list campaigns. |

---

## 9. Tech

| Concern | Choice |
|---|---|
| Language | TypeScript on Node ≥ 22.18, run directly (type stripping; no build step) |
| Browser | `playwright` 1.63.0 (pinned to the browsers installed in the cloud environment) |
| MCP | `@modelcontextprotocol/sdk` (+ `zod` 4, which also gives the tools' JSON Schemas) |
| Config | `yaml` |
| Players | Agent CLIs on subscriptions: Claude Code (`claude -p`) and Codex (`codex exec`), spawned headless. Model APIs: OpenAI-compatible Chat Completions over `fetch` (OpenCode Go, OpenAI, OpenRouter, Ollama, LM Studio, vLLM). An Anthropic API provider would use `@anthropic-ai/sdk` (deferred) |
| Logs | JSONL + files (no database) |

---

## 10. Build order

| Step | Delivers | Check | Status |
|---|---|---|---|
| 1 | Config loader, browser tools, `files`, `status`, `notify`, `end_run`, workspace, `game-r mcp` | Tests against a fixture game; an agent plays through the tools | **Built.** Played the fixture turn by turn on paused time |
| 2 | Engine loop (`game-r run`, `stop`), context refresh, usage and cost, limits, OpenAI-compatible provider | Loop tests against a mock model server | **Built** |
| 2b | Agent CLI players (Claude Code, Codex) over HTTP MCP; OpenCode Go support (headers, `vision`) | Fake-CLI tests; a real Claude Code smoke run | **Built** (34 tests). Claude Code verified for real; Codex and OpenCode Go await access |
| 3 | Both example games, live | Hand-played tool checks, then short campaigns per provider | Next (see `HANDOFF.md`) |
| 4 | Multi-run campaigns in practice; tune the framework prompt | Run 5 plays measurably better than run 1, from its own memory | |
| — | Anthropic API provider | — | Deferred: subscriptions cover Claude |

## 11. Future work

Not in v1, kept for later iterations once real campaigns show where the agent
needs help. Each should earn its place by measured improvement.

**Steering and visibility**
- Steering a running campaign (e.g. an `inbox.md` the engine passes to the agent when it changes).
- A small live dashboard (status, latest screenshot, findings, run timeline).

**Supporting roles (from draft 0.1)**
- *Auditor*: a cheaper model that periodically checks progress against the instructions and can ask for a replan.
- *Archivist*: curates /memory (prunes, merges, checks entries against recent evidence).
- *Reflector*: a dedicated post-mortem at run end that proposes lessons and the next run's focus.
- *Verifier*: re-runs a reported bug to confirm it before it is reported.

**Measurement and guards**
- Stall detection (state fingerprints, unchanged frames, repeated action patterns) surfaced to the agent as alerts.
- Goal tracking tied to the instructions (goals that cite an objective).
- Lesson utility scoring: lessons carry evidence and a score updated from run outcomes.
- Coverage tracking: a map of screens and states reached, to steer exploration.

**Testing pipeline**
- Deterministic oracles (layout overflow, tap-target size, heap growth, frame timing, accessibility via axe-core).
- Findings pipeline: de-duplicate, verify by replay, classify.
- Deterministic replay of a run from its transcript (seeded `Math.random` + clock + logged inputs).
- Automatic shortening of reproduction steps (delta debugging).

**Games and scale**
- Optional game adapters (structured state, score, legal actions), e.g. wrapping ToME's `window.__tome` or Battle Drones' arena seat API, when a game benefits and the user wants it; and adapter bootstrapping by the agent.
- Reflex controllers: agent-written in-page scripts for twitch mechanics.
- Parallel runs within one campaign sharing memory.
- Model-vs-model comparison reports.

---

## Sources

- Battle Drones, [`AGENT-BATTLES.md`](https://github.com/simonw/battledrones/blob/main/AGENT-BATTLES.md)
- Anthropic, [Harnessing Claude's intelligence](https://claude.com/blog/harnessing-claudes-intelligence)
- [Claude Plays Pokémon (Latent Space)](https://latent.space/reading/claude-plays-pokemon/); [ZenML summary](https://www.zenml.io/llmops-database/building-and-deploying-a-pokemon-playing-llm-agent-at-anthropic)
- [Continual Harness (arXiv 2605.09998)](https://arxiv.org/html/2605.09998v1)
- [Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [lmgame-Bench](https://arxiv.org/html/2505.15146v2)
- Voyager (Wang et al., 2023); Reflexion (Shinn et al., 2023)
