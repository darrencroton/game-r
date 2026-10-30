# game-r — design (draft 0.6)

An engine where an LLM plays and tests HTML web-app games from a URL, under the
user's instructions, for hours to days, and learns from run to run.

> Status: steps 1–2b built and run for real on the test game and ToME. Draft 0.6 adds §7, memory, reporting and the run protocol, from what the first ToME run taught (step 3b in §10). See `HANDOFF.md`.

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
every campaign; each campaign overrides only what differs. API keys are never written into it: the config names a key (`model.api_key_env`), and game-r reads it from the environment or the gitignored `.env` file (`model.secrets_file`).

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

New in draft 0.6 (§7): `pace.seconds_per_call` (0 = off) and `limits.wrap_up_minutes` (default 5). `limits.turns_per_run` becomes `limits.calls_per_run`, counted in tool calls for every player.

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

Twelve tools (ten always, plus `clock` and `evaluate` when the config allows them), one registry. Results are compact text; screenshots are images. Inputs are strict: an unknown argument is an error, not silently dropped.
Every input-tool result ends with a one-line summary of new console errors, if
there are any, so the agent notices them without polling.

**Every result ends with a status line**, added in one place (`Toolbox.call`), so the agent never has to estimate time:

```
⏱ 14:02:07 AEDT · run 2 · 3m24s in run · campaign 12m of 15m · game 182.3s paused
```

It shows local time with its zone, the run, wall time and tool calls used against each limit that is set (`hours`, `cost_usd`, `calls_per_run`), and the game clock when the clock tool is on. The clock lives here only, not in the page line. Browser telemetry is optional: if the browser is closed or the page has crashed, the line still carries the time and limits. The `status` tool returns the same line plus token and cost detail; one function formats both. Warnings are in §7, under *Limits*.

### Browser

| Tool | Arguments | Does |
|---|---|---|
| `look` | `grid?` (overlay labelled cells for canvas aiming), `region?` (zoom), `save_as?` | Screenshot plus URL, title and viewport, and a `scrollable:` line when the page or an area on screen has more content beyond its edges (phones show no scrollbars, so a screenshot alone can't tell; scrolling drawn inside a canvas can't be detected). `save_as` writes it into the run directory for reports. |
| `read_page` | `boxes?`, `find?`, `depth?`, `url?` | Accessibility snapshot with element refs (`button "Explore" [ref=e12]`). With `url`, reads a documentation page in a short-lived headless browser of its own (about 2 s), so it doesn't share the game's clock, storage or console. It returns the page's plain text (capped; `find` filters it), then closes. A probe found plain text more faithful than a snapshot here: GitHub's file view hides the file's lines from the accessibility tree. |
| `act` | `actions: Action[]`, `look_after?` | Runs a batch of inputs in order; stops at the first failure; returns `ok`/reason per action. |
| `console` | `all?`, `problems_only?` | Console messages, page errors and failed network requests. |
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
| `files` | `view` / `create` / `str_replace` / `insert` / `delete` / `rename` | File access with the same commands as Anthropic's memory tool, confined to three roots: `/memory` (read-write, kept across runs), `/run` (read-write, this run), `/runs` (read-only, earlier runs of this campaign). Listings show each file's last change; `view` with `find` returns only matching lines, for key lookups in long files. |
| `log` | `text` | Appends `- 14:02:07 (+3m24s) <text>` to `/run/log.md`. That file is the run's one timeline: the framework adds run start, warnings, notifications and run end to it, and the agent can't edit it directly. |

### Run

| Tool | Arguments | Does |
|---|---|---|
| `status` | — | The status line, plus tokens and cost. |
| `notify` | `title`, `message`, `level` (`info`/`finding`/`milestone`/`problem`) | Sends a notification through `notify.command`. |
| `end_run` | `summary` (one or two sentences), `next` (`new_run` / `goal_met` / `goal_impossible`) | Seals this run (§7). `new_run` asks for another run within the limits; the other two end the campaign and say why. There is no bare "done": the first ToME run ended its campaign with the goal unmet. An agent CLI is told to end its turn; the next run starts in a fresh session. |

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
  calls_per_run reached → seal the run; next run as above (the status line warned 10 calls ahead)
  end_run sealed the run → the next run starts with a new conversation (run opening)
  refresh was announced last turn → new conversation (refresh opening)
  context ≥ refresh_tokens → append the results plus "context refreshes after this turn: bring README.md's Now up to date"
  otherwise → append the results
```

- **System prompt** (`src/prompt.ts`) = a short framework prompt (tools,
  workspace layout, clock caveats, how runs and refreshes work) followed by the
  user's `instructions`, verbatim. Sent with every request and never edited, so
  the instructions can't scroll out or be summarised away; it is also the
  cacheable prefix.
- **Openings**: a run opening (run number, the status line, the ledger of earlier runs, whether /memory is still the template, and the protocol step to start with) or a refresh opening ("still run N, the game is as you left it; do the Start step's reading").
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

## 7. Memory, reporting and the run protocol

The first ToME run (`HANDOFF.md`) showed what an unstructured /memory costs. The agent never read the game's help and went down without armour. It invented clock times, believed 15 minutes had passed after 3.4, and ended the campaign with its goal unmet. Its notes were one file of screen coordinates written two minutes in. The fix is structure, not supervision: **the agent's memory and its reporting are the same few files.** Templates lay them out, a short protocol in the framework prompt keeps them current, and facts that only the framework writes anchor them.

### What lives where

```text
runs/<campaign>/
  ledger.md            framework: one row per run, regenerated from every run.json
  memory/              agent: kept across runs; also the user's view of the campaign
    README.md          start here, one page: Goal (checklist), Now (state + next action), Plan, Files
    guide.md           the big picture, kept manageable: purpose, rules, controls, best strategy, open questions, sources;
                       distils lessons.md and points to its keys
    lessons.md         the detail, cumulative: keyed entries "- [key] situation → what to do (run, evidence)" by topic
  run-NNN/
    run.json           framework: times, calls, tokens, cost, how it ended, next, summary (replaces end.json)
    report.md          agent: Objective (at the start), Outcome (at the end)
    log.md             the run's timeline: `log` entries plus framework events, all stamped
    memory/            framework: a copy of /memory as the run ended
    transcript.jsonl · shots/ · live.jpg · video/ · trace.zip
  config.yaml · campaign.lock · status.json · stop.request · profile/
```

- **Rules live once, in the framework prompt.** The templates (`templates/memory/*.md`, `templates/run/report.md`) hold only headings and one line saying what each section holds. The framework copies the memory templates only on the first run, and only those whose files are missing, so it never overwrites the user's seed files or fights an agent that has reorganised its files later. It creates each run's `report.md` at run start with the run number and start time.
- **The instructions are the brief and stay fixed** (they are the system prompt). README.md's Goal turns them into a checklist of verifiable criteria. An item is ticked only with evidence: a `/runs/run-NNN/…` path to a screenshot or a log line.
- **The agent need not start from nothing.** Instructions work best in three parts: Goal; Getting started, a known plan or direction from the user for the opening (what to read first, what usually works), which the agent follows before anything else; and Deliverables. A campaign can also start with knowledge: files put in `runs/<campaign>/memory/` before its first run are kept, because on the first run the framework copies only the templates whose files are missing. No new mechanism is needed for either.
- **README.md's Now is the only handoff:** the current state and one concrete next action.
- **The guide is the big picture; lessons are the detail.** For runs of hours or days, memory must stay useful rather than grow into a log. lessons.md is cumulative: every lesson is a keyed entry, grouped by topic, cleaned only at Reviews (duplicates merged, wrong or contradicted entries fixed or deleted, hunches settled). guide.md is the distilled picture, kept to a manageable size and rewritten in place; it points to lesson keys for detail. Each run start reads README.md and guide.md and looks lessons up by key (`files view` with `find`), so the reading cost stays flat as lessons grow. History never goes in either: it lives in run reports, logs and the ledger.
- **Every fifth run is a Review run** (runs 5, 10, …; the opening also says so): before playing, the agent cleans lessons.md, re-distils guide.md, checks that every key the guide cites exists, and re-checks the Goal and Plan. The opening also states each memory file's size, as a fact. When a run ends, the framework copies /memory into the run's folder, so nothing a reorganisation removes is lost, and the memory's evolution can be read back. (A crashed run, never sealed, gets no copy; screenshots belong in /run so the copies stay small. /memory is meant to be small text: very large seed files slow every run's opening and copy.) The Review cadence follows the run number, which continues across process restarts, so it also works under `game-r mcp`.
- **Facts are the framework's; judgement is the agent's.** Times, calls, tokens, cost, end reasons and whether the run changed /memory go in `run.json`, `ledger.md`, the `log.md` stamps and the status line. `run.json` is written at run start and completed by every controlled exit (`end_run`, `finish`, `close`). A crashed run therefore shows as interrupted, with last-known totals. `log.md` and `run.json` join the files the agent cannot write. The ledger is also put into each run opening, because /runs shows only run folders.

### The run protocol (framework prompt)

1. **Orient.** Follow the instructions' getting-started plan first, if there is one. On the first run, whatever the time limit, read the game's own help before the first consequential choice: how to play, help screens, manual, tutorial, and any documentation the instructions name (`read_page {url}`). Write what matters in guide.md with its sources, and turn the instructions into README.md's Goal. Later, when a new system or screen appears, look for its help first. The run opening says when /memory is still the template. (The second ToME run skipped reading under a 30-minute limit when the step said only "keep it proportionate", so the step now says it applies whatever the time limit.)
2. **Start of each run.** Read README.md and guide.md, look up the lessons the next steps need, check them against the screen, and write the run's Objective in report.md. After a context refresh or compaction, re-read these files rather than rewriting the Objective.
3. **During the run.**
   - `log` decisions (with their reasons), milestones and surprises as they happen.
   - Check guide.md before consequential choices rather than taking defaults.
   - Record a lesson the moment it is learned.
   - Keep README.md's Now current at each milestone.
   - In a real-time game, pause the clock before long memory work.
4. **End of the run.** Write the Outcome, add or update keyed lessons, update guide.md where the big picture changed, tick goals with evidence, and set Now's next action. Then `end_run`.
   - `goal_met` needs evidence for the whole checklist.
   - Running out of time or runs is not `goal_impossible`. While the goal is unmet but possible, use `new_run`; the framework's limits decide when to stop.
   - **Unless the instructions say otherwise, an end point in the game ends the run:** a death, a win or loss, a finished game or match. The agent is told to do the End step and `end_run` rather than start a new game in the same run, so each end point gets framework facts, a fresh context and, if the agent does its part, a memory update. In a roguelike `runs` then counts deaths, so such campaigns are bounded by `hours`. Round-based games can say in their instructions that a round is not an end point.
   - The End step is the agent's job, but the framework checks one fact: did any file in /memory change during the run (names and change times). If not, the first `end_run` of that run does not end it, and says why. A second call ends it regardless. It is a check on file activity, not on content, and it works the same for every player because the run is still open. The ledger's Memory column records the fact.

5. **Review** (every fifth run, when the opening says so), as above.

If the agent is blocked, it notifies the user with what blocks it, what it tried, and what it will do meanwhile. Notes and openings point at these steps by name ("do the End step now") instead of restating them, and tool descriptions say only what each tool does.

### Run boundaries

`end_run` seals the run: `run.json` and `log.md` are completed and the ledger is regenerated. **The next run starts only when the driver begins the next session**: a new CLI session, or a new conversation for API providers. A late call from the old session is refused with "this run has ended; end your turn", so it can't play the next run or write its report. The invocation's usage is added to the sealed run. Reaching `calls_per_run` seals the run in `Toolbox.call` in the same way, for every player. Under `game-r mcp` there is no driver, so the next run starts at the next tool call.

### Limits: warn, then stop

Limits stay hard: `hours: 0.25` means 15 minutes. **The warning is the buffer**, and no new run starts while the campaign's own warning is on (time within `wrap_up_minutes`, or 90 % of `cost_usd` spent) once a run has been played; a campaign restarted inside that window therefore ends at once. (The third ToME run, with `runs: null`, otherwise spent its last four minutes on 14 empty runs: each saw too little time to play, did its End step and asked for `new_run`.) From `limits.wrap_up_minutes` before the time limit, past 90 % of the cost limit, or with 10 calls left of `calls_per_run`, the status line adds `⚠ wrap up: 4m left, do the End step now`. The same warning is written to `log.md` once. Calls are counted live in `Toolbox.call` for every player. An agent CLI's tokens and cost arrive only when its session ends, so the cost warning uses the cost as of the last session (the status line says so). Making sessions end at each `end_run` keeps that current. After the campaign ends, `files`, `log` and `status` keep working, and an agent CLI gets 60 s to finish before it is interrupted. API players stop at once, because their loop ends with the campaign; for them the warning is the buffer. An interrupted session is recorded as "usage unknown", not zero: while an agent CLI session runs, `run.json` marks the run's usage as pending, so a crash of game-r itself also leaves it unknown.

### Pacing

`pace.seconds_per_call` (default 0, off) makes the game tools wait until at least that long has passed since the previous paced call. That slows the model too, because it waits for each result. Calls take turns, so parallel calls don't all fire at once. Workspace tools are never paced, so note-taking stays cheap. Pacing trades wall time for a lower burn rate, spreading a subscription's 5-hour allowance or an API budget over more hours of play.

- It is capped below the agent CLIs' 900 s tool timeout.
- Waits longer than the prompt cache's lifetime (about 5 minutes) turn every call into a cache write.
- In a real-time game the game keeps running while the agent waits, unless the agent has paused the clock.

### Considered, not adopted

From the user's ai-agent-coder toolkit we keep:

- a fixed brief with an enumerable checklist;
- "Now" as the handoff, with one concrete next action;
- curated, pruned lessons with an "Unverified:" mark;
- evidence for each ticked goal;
- rules written once;
- facts derived from data the controller owns.

We do not keep its supervision: signed state, protected paths, per-step assessments, reviewers and stop enforcers. They would second-guess the agent (§1). Also dropped after review:

- a separate wrap-up state with refusals (the warning ahead does the job);
- a `templates` option (`system_prompt_file` already covers customisation);
- a Progress section in the report (`log.md` holds it).

### On disk, otherwise

Separate campaigns run in parallel, each with its own browser, directory and lock. A campaign is portable: zip its directory and it is all there. Elapsed time and usage are cumulative across processes (read back from `status.json`), so limits hold across restarts.

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
| 3b | §7: status line, `log`, templates and protocol, `run.json` and ledger, run boundaries, `read_page {url}`, `end_run` outcomes, wrap-up warnings, `calls_per_run`, pacing | Unit tests; then 30-minute ToME runs on all three players | **Built** and run |
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
- *Advisor* (the user's idea, 2026-10-31; to ponder, not yet planned): a second model watches the player and, every X calls (5, 10, 50…), may offer an opinion or a suggestion. The player stays in charge and is free to ignore it. See *The advisor idea* below.

**The advisor idea**

*Why:* a spectator sees what the immersed player misses ("the hint says do that, why don't you?"), much as a code review or a manuscript reader does. In `tome-barrow-long` (2026-10-30), six heroes died looking for the Barrow-downs before the seventh found the way in. Help had already said to walk off the edge of an area, and *Recall depths* lists the Barrow-Downs; a watcher with fresh eyes might have pointed either out sooner.

*How it differs from what §1 and §7 rule out:* it advises and never enforces. It doesn't assess steps, block actions or stop the run. It is closest to the *Auditor* above, but it advises on play, not on progress against the instructions.

*Open questions:*

| Question | Options |
|---|---|
| What it sees | The latest screenshot (`live.jpg`), recent transcript calls, `log.md`, the player's /memory, the instructions; read-only `read_page` for the game's docs |
| Its own notes | None (fresh each time); its own notes file; or the player's /memory only |
| Cadence | Every X calls; at run end only (a post-mortem, like the *Reflector*); or when the player seems stuck (but that is stall detection, which the user called brittle) |
| How advice arrives | In the next tool result, as a line like the status line; or in an `inbox.md` (the same channel as human steering above, so an advisor is an automated steering source) |
| Model | A cheaper model than the player, or the same; a different family may see different things |
| Cost | One extra model call per X player calls, carrying an image and some context |
| Risk | Advice that is wrong or game-specific becomes noise; the player may defer to it rather than think |

*Cheapest test before building:* run the same campaign twice, with and without advice, and compare deepest level, deaths per hour and cost per hour. A first version could be a script beside a running campaign that reads its run folder and writes advice into the steering inbox, once that exists. Build it only if the measured difference is clear.

**Measurement and guards**
- Stall detection (state fingerprints, unchanged frames, repeated action patterns) surfaced to the agent as alerts.
- Goal tracking tied to the instructions beyond README.md's checklist (§7), if the checklist proves not enough.
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
