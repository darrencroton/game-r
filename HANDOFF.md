# Handoff — game-r

For the next session. Read `AGENTS.md` first (the user's direction, conventions
and lessons), then this file. The design is `docs/MCP-DESIGN.md`.

---

## Instructions to human

Work now happens locally on the user's Mac (from 2026-10-30), on `main`.

1. **Setup:** `./setup.sh` (re-runnable). It installs everything, creates `.env` and checks the players and config.
2. **OpenCode Go key:** put `OPENCODE_API_KEY=…` in `.env` (gitignored, mode 600). Don't paste it into the chat.
3. **Signed in already:** Claude Code (claude.ai) and Codex (ChatGPT). Re-check with `./setup.sh --skip-tests`.
4. **Cloud sessions** (if used again): the previous version of this file (git history) has the network allow-list and Codex device sign-in steps.

---

## Where things stand

Merged to `main`. 40 tests pass (`npm test`, about 30 s); typecheck clean.

| Part | State |
|---|---|
| Config (`game-r.yaml`) | Done. Defaults: Claude Code on Opus. Campaigns: `tome-ui`, `drones-score` (Codex), and `dodge`, `dodge-codex`, `dodge-go` on the local test game |
| Tools, workspace, session | Done: look, read_page, act, console, clock, browser, evaluate (developer), files, status, notify, end_run |
| `game-r mcp` (stdio) | Done, tested with the MCP client SDK |
| `game-r run` with an **agent CLI** (`claude-code`, `codex`) | Done. game-r serves the tools over HTTP MCP on loopback with a bearer token, runs the CLI headless, resumes its session with a nudge when it stops, starts a fresh session for each new run, backs off and retries on failures (subscription limits), stops idle agents, enforces limits |
| `game-r run` with **openai-compatible** | Done: own loop, append-only conversations, context refresh via /memory, `headers` with `{conversation}`, `vision: false` for text-only models |
| Anthropic API provider | Not built; not needed while you use subscriptions |

**Verified for real:**
- **Claude Code:** a smoke run of the `dodge` game on Haiku, in the cloud
  session (6 tool calls). It looked, read the page, clicked Start, wrote
  /memory and ended the campaign. Vision works.
- **The tools by hand:** paused-clock play on the fixture game.

**Not yet verified for real:**
- **Codex:** not installed here. Its flags come from the Codex source
  (`codex-rs/exec/src/cli.rs`, `codex-rs/config/src/mcp_types.rs`): `exec
  --json`, `resume <id>`, `-c mcp_servers.gamer.url=…`, `bearer_token_env_var`,
  `default_tools_approval_mode="approve"`, `features.shell_tool=false`,
  `developer_instructions`. Tested against a fake CLI only.
- **OpenCode Go:** no key here, and opencode.ai was blocked. The endpoint
  `https://opencode.ai/inference/go/openai/v1`, the `x-opencode-session` header
  and the model ids come from `sst/models.dev`
  (`providers/opencode-go`, accessed 2026-10-15).
- **The example games:** github.io was blocked.

---

## Next steps, in order

1. **Check access.** *Done locally 2026-10-30: both github.io games reachable, Codex signed in; OpenCode key pending in `.env`.* Run `curl -sI https://simonw.github.io/battledrones/`,
   `curl -sI https://darrencroton.github.io/tales-of-middle-earth/` and
   `curl -s https://opencode.ai/inference/go/v1/models -H "Authorization: Bearer $OPENCODE_API_KEY" | head`.
   Also `codex --version`, and `codex login --device-auth` if it isn't signed
   in (relay the link and code to the user). Report anything still blocked.

2. **Hand-played tests of the tools.** Use `scripts/drive.ts` (`AGENTS.md` →
   *Playing hands-on from a session*). Play `tome-ui` and `drones-score` a
   little each, with `browser {device}` on desktop and phone. Look for what the
   tools get wrong on real games and fix it generically. Things to check:
   - **read_page:** is it readable on these pages (size, noise)?
   - **Screenshots:** timing during animation; WebGL/canvas in headless.
   - **ToME:** touch gestures; sheets and cards; the WASM engine under a paused
     clock (workers aren't covered).
   - **Battle Drones:** drag selection boxes; wheel zoom; does pausing freeze
     the simulation?
   - **Both:** dialogs, service workers, install prompts.

   Record lessons in `AGENTS.md`.

3. **Each provider on the small test game**, short and cheap:
   - `node src/cli.ts run dodge`, then `dodge-codex`, then `dodge-go`.
   - Read each `runs/<campaign>/run-*/transcript.jsonl` and the agent's
     /memory.
   - **Codex:** confirm it sees the `gamer` tools, its shell tool is off, it
     can see screenshots (MCP image results), and `resume` works.
   - **OpenCode Go:** confirm the model id and that `x-opencode-session` is
     accepted.
   - **Both:** fix the flags in `src/agent.ts` / `game-r.yaml` where reality
     differs.

4. **Fix what steps 2 and 3 found.** Run `npm test` (2–3 times if browser
   code changed) and the typecheck. Commit.

5. **First live campaign**, with the user's choice of game and provider. Keep
   it short to start, e.g. `limits: { runs: 2, hours: 1 }`. Watch it with
   `game-r status` and the transcript, then read the agent's reports and
   /memory together. Tune `src/prompt.ts` only where the agent clearly needs
   it.

6. Then the build order's step 4 (multi-run learning) and the *Future work*
   list in `docs/MCP-DESIGN.md`, with the user.

---

## To do (from the user, 2026-10-30)

Address these together with the issues and lessons from the first `tome-barrow` run (15 min sample).

**Status:** items 1, 2, 3, 5 and 6 are built as design step 3b (`docs/MCP-DESIGN.md` §7). Pacing is `pace.seconds_per_call`; soft limits are `limits.wrap_up_minutes` warnings; there is a templated memory and a run protocol; a status line ends every result; `end_run` takes `new_run`, `goal_met` or `goal_impossible`. Item 4 waits for a 30-minute rerun of `tome-barrow`, compared with the first.

| # | Item | Notes |
|---|---|---|
| 1 | **Pacing option** | A user setting to make the agent work at most every X seconds (e.g. `limits.min_seconds_per_call` or a `pace` block), default off. For expensive models: spreads use across a subscription's 5-hour window and trades wall time for cost. Nothing like it exists yet (limits are runs, hours, cost and tool calls per run). Decide where the delay goes (between tool calls in `Toolbox.call`, or between model turns), make it work for agent CLIs and API providers alike, and keep real-time games safe (pause the clock while waiting, or document it). |
| 2 | **Soft limits** | A limit should not cut the agent off mid-thought. Warn it ahead (e.g. a few minutes or a set fraction before `hours` or `cost_usd`) so it can save /memory and call `end_run`, then stop hard after a grace period. Make sure usage and cost are still recorded when an agent CLI is interrupted (`claude -p` may print no final JSON on SIGINT; Claude Code's own session log in `~/.claude/projects/` has per-message usage). |
| 3 | **Orientation doc** | Check whether the agent writes itself a context doc unprompted (game purpose, core mechanics, style, controls, objectives beyond the task). If it doesn't, consider a general first step for every campaign: build or refresh `/memory/context.md` (or similar) before playing, and re-read it at each run start and after each refresh. A sentence in the framework prompt is preferred over a new mechanism. |
| 4 | **Cost estimate** | From the first run's usage, estimate the cost per hour and per dungeon level for Opus. Compare with Sonnet before long campaigns. |
| 5 | **Agent's sense of time** | First run: the agent never called `status`, believed its 15 minutes were up after 3.4, invented clock times in its log, and ended the campaign. Candidate fix: show wall time used against the limit in every tool result's status line (e.g. `run 3m24s of 15m`), so time is always in view without a call. |
| 6 | **`done` too early** | It ended with `next: done` although the goal was unmet. Candidate fix: one framework-prompt sentence: `done` only when the instructions are complete or cannot be completed; otherwise `new_run`. |

### First `tome-barrow` run (2026-10-30, Opus, medium effort, Pixel 7)

- **Usage:** 3.4 min, 41 tool calls (about 12 a minute), $0.76 Claude Code estimate (1.06M cache-read, 47k cache-write, 8.5k output tokens), about 26k tokens of context per call. That is about $13 an hour at the start, rising as the context grows until Claude Code compacts.
- **Character creation:** smooth, about 1 minute and 9 calls, but it accepted the defaults (Beorning Warrior) by tapping *Choose* on each screen rather than choosing a build.
- **Play:** the contextual toolbar button did most of the work ("Way down" walks from Bree to the dungeon). It went down without wearing its starting chain mail and without potions, and a newt took it to 0 HP on level 1. It survived, rested, and wore the armour after that.
- **Notes:** `/memory/notes.md` (written 2.3 minutes in) holds UI coordinates, status and lessons, but no orientation (game purpose, mechanics, how to survive). It never opened the game's *How to play*. This supports item 3.
- **Tools:** no tool errors. Taps by coordinate, typing, waits and `look_after` all worked; `read_page` was used once; the clock was never paused (turn-based game). `ping-me` delivered the milestone. Screenshots render the game cleanly in headed Chromium.
- **The hero:** Bram is alive at 50 ft. `profile: campaign` keeps the browser storage, so the next run can probably continue him.

---

## Things to keep in mind

- Keep the framework thin; resist adding supervision. If a real run shows the
  agent needs help, prefer a small tool or a sentence in the framework prompt.
- Any new user option goes in `game-r.yaml` (commented) and `src/config.ts`.
- Model conversations stay append-only (preserved thinking).
- Agent CLIs run on the user's subscriptions: never start one from tests (the
  test helper points agent CLIs at a non-existent command; keep it that way).
  Keep real checks tiny (Haiku, low effort, `hours: 0.03`) and say so.
- Update `README.md` and the design doc's build-order table as steps land.
