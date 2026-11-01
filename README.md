# game-r

**An engine where LLMs play and test HTML web games.** Point it at a URL, give
it instructions — play to the end, hunt for UI bugs and quirks, beat a high
score — and a model plays the game in a real browser for hours or days. It
keeps its own notes, writes its own reports, and starts each new run from what
it learned in the last.

- **Any web game, from its URL.** Nothing game-specific is built in; what the
  agent should do goes in plain-language instructions.
- **Real-time games become turn-based.** The agent can pause the page's game
  clock while it thinks and advance it by exactly as much game time as it
  wants.
- **Runs for days without losing the plot.** The instructions are in front of
  the model all the time, the agent keeps its own memory, and contexts are
  refreshed or compacted before they grow large.
- **Learns across runs.** A memory folder survives every run, and each run can
  read the reports and transcripts of the ones before it.
- **Built for testing.** Console errors surface as the agent plays; phones,
  tablets and orientations are one call away; every screenshot is kept.
- **Runs on your subscriptions.** Claude Code (Claude Pro/Max) or Codex
  (ChatGPT) can be the player, or any OpenAI-compatible API such as OpenCode
  Go, OpenAI, OpenRouter or a local model.
- **MCP.** The same tools are an MCP server, so Claude Code or any MCP client
  can play a game directly.

> **Status:** early. The tools, the MCP server and the engine are tested, and 30-minute campaigns on a real game (ToME) have run on all three players: Claude Code, Codex and OpenCode Go. Three-hour campaigns have run on Claude Code, Codex and local models through the OpenAI-compatible loop; a second game is next.

## Quick start

Requirements: Node.js 22.18+ (or 23.6+), Playwright's Chromium, and whichever
player you want to use:

| Player (`model.provider`) | Needs |
|---|---|
| `claude-code` (default) | [Claude Code](https://code.claude.com/docs) signed in with your Claude subscription (`claude auth login`) |
| `codex` | [Codex CLI](https://github.com/openai/codex) (`npm install -g @openai/codex`) signed in with ChatGPT (`codex login`) |
| `openai-compatible` | An API key named by `model.api_key_env` (e.g. `OPENCODE_API_KEY` for OpenCode Go), in `.env` or the environment |

```zsh
./setup.sh                             # or: npm run setup
```

The setup script is safe to run again at any time. It checks Node, installs the locked npm packages and Playwright's Chromium (skipped if already there), creates `.env` from [`.env.example`](.env.example), reports which players are installed and signed in, validates `game-r.yaml`, checks the notify command, and runs the typecheck and tests (`--skip-tests` skips those).

**API keys** go in `.env` (gitignored, created with mode 600) as `NAME=value` lines, e.g. `OPENCODE_API_KEY=…`. game-r reads the entry named by a campaign's `model.api_key_env` from there, unless an environment variable of that name is set. Keys read from the file are never put in the environment, so the agent CLIs and the notify command don't inherit them. `model.secrets_file` points somewhere else.

The default player is Claude Code with Sonnet on high effort, with limits of 10 runs and 48 hours. The shipped campaigns are `tome-ui`, `tome-barrow` (also `-codex` and `-go`), `drones-score`, and `dodge` (also `-codex` and `-go`) on the bundled test game. `node src/cli.ts list` lists them, and `node src/cli.ts config <campaign>` shows one fully resolved. `run` spends real subscription or API budget; `limits` (`hours`, `runs`, `cost_usd`) bound it.

Edit [`game-r.yaml`](game-r.yaml), or keep your own campaigns in `game-r.local.yaml` (see *Configure a campaign*), then:

```zsh
node src/cli.ts run dodge              # a five-minute smoke test on the bundled test game (Haiku)
node src/cli.ts run tome-ui            # play until done or a limit is reached
node src/cli.ts status                 # how every campaign is doing
node src/cli.ts stop tome-ui           # stop after the current turn
```

With an agent CLI as the player, game-r starts `claude -p` or `codex exec`
headless and gives it only game-r's tools (over a local, token-protected MCP
connection; Claude Code's built-in tools and Codex's shell are switched off).
game-r keeps the campaign: runs, limits, memory, logs, screenshots. If the
agent stops, it is resumed with a nudge; if the CLI fails (for example at a
subscription's usage limit), game-r waits and retries.

## Configure a campaign

Every option lives in `game-r.yaml`: `defaults` apply to every campaign, and a
campaign overrides only what it sets. A campaign needs a `url` and
`instructions`.

**Your own settings and campaigns** go in `game-r.local.yaml` beside it (gitignored). game-r merges it over `game-r.yaml`: its `defaults` deep-merge over the shipped ones, and its campaigns are added, or deep-merged into a shipped campaign of the same name. YAML anchors don't cross files, so repeat any shared block (an `instructions: &name |` text, a `model: &name` block) in the local file; top-level keys starting `x-` can hold such blocks, and any other unknown top-level key is an error. `node src/cli.ts config <campaign>` shows the result.

Instructions work best in three parts. **Goal** is what to achieve, as checkable criteria. **Getting started** is a known plan or direction for the opening, such as what to read first or what usually works; the agent follows it before anything else. **Deliverables** is what to report beyond the framework's own memory and run reports. To start a campaign with knowledge, put files in `runs/<campaign>/memory/` before its first run.

How the agent works through a campaign:

- Each end point in the game (a death, a win, a game over) ends a run. The agent then updates its memory, and the next run starts afresh.
- In a roguelike, `runs` therefore counts deaths, so bound such a campaign by `hours`.
- The agent keeps its memory in `/memory`:
  - `README.md` holds the goal checklist, the current state and the plan.
  - `guide.md` is the big picture of the game and how to play it, kept to a manageable size. It points by key to the detail.
  - `lessons.md` holds the detail: every lesson learned, keyed and grouped by topic.
- Every fifth run starts with a Review that tidies both files. A copy of the memory is kept with each run.
- Each run's report and timeline are in its folder.

```yaml
defaults:
  model: { provider: claude-code, name: sonnet, reasoning: high }   # the benchmark player
  limits: { runs: 10, hours: 24 }

campaigns:
  tome-ui:
    url: https://darrencroton.github.io/tales-of-middle-earth/
    browser: { device: "Pixel 7" }
    instructions: |
      Test ToME as a phone player. Play normally and look for UI bugs and quirks.
      Write each finding to /run/findings.md with steps to reproduce and a screenshot.
      Work for about 6 hours.

  drones-score:
    url: https://simonw.github.io/battledrones/
    model: { provider: codex, name: null }      # null = Codex's default model
    instructions: |
      Win a Skirmish on Riverlands against the Normal AI as fast as you can; beat your best time each run.

  drones-go:
    url: https://simonw.github.io/battledrones/
    model:
      provider: openai-compatible
      name: glm-5.3-flash
      base_url: https://opencode.ai/inference/go/openai/v1
      api_key_env: OPENCODE_API_KEY
      headers: { x-opencode-session: "{conversation}" }
    instructions: |
      …
```

The commented [`game-r.yaml`](game-r.yaml) lists every option: model and
reasoning effort, browser engine and device, headless or headed, video and
traces, access level (`player`, or `developer` to let the agent run JavaScript
in the page), whether the agent may control the clock, `vision: false` for
text-only models, the context refresh size, hard limits (runs, hours, cost,
turns per run) and a notification command.

**Notifications.** `notify.command` runs a shell command with the message in
environment variables (`GAMER_TITLE`, `GAMER_MESSAGE`, `GAMER_LEVEL`,
`GAMER_EVENT`, `GAMER_CAMPAIGN`). Refer to them inside the command; never paste game text into it. The shipped config has none (notifications are only logged); set yours in `game-r.local.yaml`, e.g. a macOS notification:

```yaml
notify:
  command: osascript -e 'display notification (system attribute "GAMER_MESSAGE") with title (system attribute "GAMER_TITLE")'
```

**Long campaigns on a laptop.** Keep it on power and stop it sleeping: `caffeinate -i node src/cli.ts run tome-ui` on macOS.

## What the agent gets

| Tool | Does |
|---|---|
| `look` | Screenshot (image pixels = CSS pixels), optional labelled grid for aiming, zoom, save a copy; notes what can scroll |
| `read_page` | The page's accessibility tree with element refs to click; or a help/documentation page by URL, read in a separate browser |
| `act` | A batch of inputs: click, tap, drag, swipe, pinch, long press, keys (held for a time), type, scroll, wait, navigate |
| `console` | Console messages, page errors, failed requests, dialogs, downloads (saved to `run-NNN/downloads/`) |
| `clock` | Pause, advance and resume game time |
| `browser` | Switch device or orientation, resize, restart |
| `files` | Its workspace: `/memory` (kept across runs), `/run` (this run), `/runs` (earlier runs, read-only); `view` can find lines |
| `status` | The status line plus tokens and cost (every other result already ends with the status line: local time, run, time and calls against the limits, game time, wrap-up warnings) |
| `log` | Add a stamped line to the run's timeline (`/run/log.md`) |
| `notify` | Tell you something now |
| `end_run` | Finish this run: `new_run`, `goal_met` or `goal_impossible` |
| `evaluate` | Run JavaScript in the page (only with `access: developer`) |

## Play through MCP

Serve a campaign's tools to Claude Code (or any MCP client):

```zsh
claude mcp add game-r -- node "$PWD/src/cli.ts" mcp tome-ui --config "$PWD/game-r.yaml"
```

The server's instructions carry the framework prompt and the campaign's
instructions. Output goes to the same campaign folder as `game-r run`.

## Output

```
runs/<campaign>/
  ledger.md          one row per run: start, time, calls, cost, how it ended, summary
  memory/            the agent's memory and your view of the campaign: README.md (goal, now, plan), guide.md (big picture), lessons.md (detail)
  run-001/           report.md (objective, outcome), log.md (stamped timeline), run.json (facts), memory/ (copy at the run's end),
                     transcript.jsonl, shots/ (by default, only those a file names once the agent ends the run), live.jpg, downloads/ (files the game downloads), video/ and trace.zip when enabled, and whatever the agent wrote
  status.json        state, run, calls, tokens, cost, elapsed time, last error
  campaign.lock      one process per campaign at a time; stop.request asks a running campaign to stop
  profile/           the browser profile (in-game saves persist across runs; browser.profile_from seeds it from a save point)
```

Each campaign is self-contained, so several can run at once. Running a campaign
again continues it with a new run; its limits are cumulative.

## Development

```zsh
npm test                      # node:test with real headless Chromium
npm run typecheck             # tsc --noEmit (TypeScript is a dev dependency)
node scripts/drive.ts dodge --headed   # play by hand through the agent's tools (see AGENTS.md)
```

The sources are TypeScript run directly by Node (no build step). Read
[`AGENTS.md`](AGENTS.md) before changing anything: it holds the project's
direction, conventions and hard-won lessons. The design and its future work
are in [`docs/MCP-DESIGN.md`](docs/MCP-DESIGN.md).

## Licence

Apache 2.0 — see [`LICENSE`](LICENSE).
