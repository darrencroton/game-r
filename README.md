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
  the model on every request; the context is refreshed from the agent's own
  memory before it grows large, so the cost per turn stays flat.
- **Learns across runs.** A memory folder survives every run, and each run can
  read the reports and transcripts of the ones before it.
- **Built for testing.** Console errors surface as the agent plays; phones,
  tablets and orientations are one call away; every screenshot is kept.
- **Any model.** Any OpenAI-compatible API (OpenAI, Gemini, OpenRouter,
  Ollama, LM Studio); Anthropic's API next.
- **MCP.** The same tools are an MCP server, so Claude Code or any MCP client
  can play a game directly.

> **Status:** early. The tools, the MCP server and the engine loop work and are
> tested; the Anthropic provider and live runs on real games are next (see
> [`HANDOFF.md`](HANDOFF.md)).

## Quick start

Requirements: Node.js 22.18 or newer, and Playwright's Chromium.

```zsh
npm install
npx playwright install chromium
npm test
```

Edit [`game-r.yaml`](game-r.yaml), then:

```zsh
export OPENAI_API_KEY=…                # or whichever key your campaign's model.api_key_env names
node src/cli.ts run my-campaign        # play until done or a limit is reached
node src/cli.ts status                 # how every campaign is doing
node src/cli.ts stop my-campaign       # stop after the current turn
```

## Configure a campaign

Every option lives in `game-r.yaml`: `defaults` apply to every campaign, and a
campaign overrides only what it sets. A campaign needs a `url` and
`instructions`:

```yaml
defaults:
  model:
    provider: openai-compatible
    name: <model id>                       # as your provider names it
    base_url: https://api.openai.com/v1    # or OpenRouter, Gemini's compatible endpoint, a local server…
    api_key_env: OPENAI_API_KEY
    price_per_mtok: { input: <USD>, output: <USD> }   # per million tokens, from your provider's price list
  limits: { runs: 10, hours: 24, cost_usd: 40 }

campaigns:
  tome-ui:
    url: https://darrencroton.github.io/tales-of-middle-earth/
    browser: { device: "Pixel 7" }
    instructions: |
      Test ToME as a phone player. Play normally and look for UI bugs and quirks.
      Write each finding to /run/findings.md with steps to reproduce and a screenshot.
      Work for about 6 hours.
```

The commented [`game-r.yaml`](game-r.yaml) lists every option: model and
reasoning effort, browser engine and device, headless or headed, video and
traces, access level (`player`, or `developer` to let the agent run JavaScript
in the page), whether the agent may control the clock, the context refresh
size, hard limits (runs, hours, cost, turns per run) and a notification
command.

**Notifications.** `notify.command` runs a shell command with the message in
environment variables (`GAMER_TITLE`, `GAMER_MESSAGE`, `GAMER_LEVEL`,
`GAMER_EVENT`, `GAMER_CAMPAIGN`). On macOS:

```yaml
notify:
  command: osascript -e 'display notification (system attribute "GAMER_MESSAGE") with title (system attribute "GAMER_TITLE")'
```

## What the agent gets

| Tool | Does |
|---|---|
| `look` | Screenshot (image pixels = CSS pixels), optional labelled grid for aiming, zoom, save a copy |
| `read_page` | The page's accessibility tree with element refs to click |
| `act` | A batch of inputs: click, tap, drag, swipe, pinch, long press, keys (held for a time), type, scroll, wait, navigate |
| `console` | Console messages, page errors, failed requests, dialogs |
| `clock` | Pause, advance and resume game time |
| `browser` | Switch device or orientation, resize, restart |
| `files` | Its workspace: `/memory` (kept across runs), `/run` (this run), `/runs` (earlier runs, read-only) |
| `status` | Time, run, turns, tokens, cost and limits |
| `notify` | Tell you something now |
| `end_run` | Finish this run and start the next, or end the campaign |
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
  memory/            the agent's notes, kept across runs
  run-001/           transcript.jsonl, shots/, live.jpg, end.json, and whatever the agent wrote
  status.json        state, run, turns, tokens, cost, elapsed time, last error
  profile/           the browser profile (in-game saves persist across runs)
```

Each campaign is self-contained, so several can run at once. Running a campaign
again continues it with a new run; its limits are cumulative.

## Development

```zsh
npm test                      # node:test with real headless Chromium
npx tsc --noEmit              # typecheck (TypeScript is not a dependency)
```

The sources are TypeScript run directly by Node (no build step). Read
[`AGENTS.md`](AGENTS.md) before changing anything: it holds the project's
direction, conventions and hard-won lessons. The design and its future work
are in [`docs/MCP-DESIGN.md`](docs/MCP-DESIGN.md).

## Licence

Apache 2.0 — see [`LICENSE`](LICENSE).
