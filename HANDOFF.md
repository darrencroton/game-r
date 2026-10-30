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

On `main`. 45 tests pass (`npm test`, about 15–30 s); typecheck clean.

| Part | State |
|---|---|
| Config (`game-r.yaml`) | Done. Defaults: Claude Code on Sonnet, high effort (the benchmark). Campaigns: `tome-barrow` (and `-codex`, `-go`), `tome-ui`, `tome-barrow`, `drones-score` (Codex), and `dodge`, `dodge-codex`, `dodge-go` on the local test game |
| Tools, workspace, session | Done: look, read_page (also docs by URL), act, console, clock, browser, evaluate (developer), files, status, log, notify, end_run; status line on every result |
| Memory and reporting (design §7) | Done: templates, run protocol, report.md, stamped log.md, run.json, ledger.md, end_run outcomes, run sealing, wrap-up warnings, calls_per_run, pacing |
| `game-r mcp` (stdio) | Done, tested with the MCP client SDK |
| `game-r run` with an **agent CLI** (`claude-code`, `codex`) | Done: tools over loopback HTTP MCP with a bearer token, headless CLI, resume with a nudge, a fresh session per run, retries with backoff, idle stop, limits enforced (also while the CLI is silent) |
| `game-r run` with **openai-compatible** | Done: own loop, append-only conversations, context refresh, `headers` with `{conversation}`, `vision: false` |
| Anthropic API provider | Not built; not needed while you use subscriptions |

**Verified for real (locally, 2026-10-30):**

- **Claude Code:** ToME campaigns on Opus (a 15-minute sample, a 30-minute rerun) and on Sonnet high (30 minutes, 21 runs); the test game on Haiku earlier in the cloud.
- **Codex** (`gpt-6.1-terra`) and **OpenCode Go** (`deepseek-v4.1-flash`): the test game, then 30-minute ToME campaigns (results below).
- **The tools by hand** on the test game, the docs reader on GitHub, `ping-me` notifications.

**Not yet verified for real:** the hours limit on a long run (the 2.1 h run met its goal first), a CLI session resume, game-r's API-loop context refresh, Battle Drones. See *Release readiness*.

---

## Release readiness (2026-10-30)

**Not yet.** The core (tools, workspace, memory and reporting, run lifecycle, limits, logging) is built, reviewed by the external panel and tested. But a release needs these first, in order of importance:

| # | Gap | Why it is critical | Check |
|---|---|---|---|
| R1 | **A long unattended run.** *Mostly done 2026-10-30:* the crash check passed, and `tome-barrow-long` played 2.1 h unattended and met its goal (see *The long run* below). It showed two things to fix: context growth in CLI sessions, and screenshot retention | Still not exercised for real: the wrap-up warning and hours limit (the goal was met first), a CLI resume, a CLI crash or subscription-limit retry | Fix the two findings, then a run that reaches its hours limit |
| R2 | ~~Codex as a player, for real~~ **Done 2026-10-30** | Played the test game and 30 min of ToME; sees images; tokens match ccusage. Still unexercised: a session resume | Watch for a resume in the long run |
| R3 | ~~OpenCode Go, for real~~ **Done 2026-10-30** | Played the test game and 30 min of ToME through game-r's own loop, with images and `reasoning_content`. Still unexercised: the loop's context refresh (needs a long run) | A long Go run |
| R4 | **The protocol on a second game** | Only ToME has been played; the protocol must hold for any game and goal | A short Battle Drones (real-time, pause the clock) campaign |

Not critical for a first release: the Anthropic API provider, live steering, a dashboard, the *Future work* list.

## Next steps, in order

1. **Fix what the long run showed** (with the user; see *The long run* below):
   - **Context growth in agent CLI sessions** (agreed; options for Claude Code, Codex and OpenCode being investigated): `context.refresh_tokens` applies only to game-r's own API loop. Claude Code never compacted, so a long run's cost per call doubled.
   - **Screenshot retention** (agreed; being built): screenshots are 96% of a run folder, and no ToME report has cited one.
   - Instructions stay as they are: the user liked the creative Word of Recall route.
2. **R1, the rest:** a run that reaches its hours limit (the wrap-up warning and the stop), ideally with a CLI resume.
3. **R4**: a short Battle Drones campaign (real-time; pause the clock), to check the protocol on a second game.
4. Then the items still open below, multi-run learning (§10 step 4) and *Future work* (including the user's *Advisor* idea, design §11), with the user.

To run a long campaign: keep the Mac on power, check subscription headroom (`/usage`), and run `caffeinate -i node src/cli.ts run <campaign>` in the background; check it hourly with `node src/cli.ts status <campaign>` and the ledger.

The earlier steps (access checks, hand-played tool tests, the first live campaigns, R2, R3, the crash check) are done; their results are below and in `AGENTS.md`.

---

## The long run (R1), 2026-10-30

Campaign `tome-barrow-long`: Claude Code on Sonnet, high effort, Pixel 7, headed, `runs: null`, `hours: 3`, fresh state. It played the ToME build from PR #24, which has the new searchable Help, and *Explore* no longer leads to dungeon entrances on the land. *Getting started* said to read Help (*Your first adventure* first), visit every shop, then explore west for the Barrow-downs. A first start was stopped after 1 minute for that build and trashed.

**Result: goal met in run 9 after 2.10 h.** Hamfast (Dwarf Unbeliever) reached Barrow-Downs level 10 (500 ft) alive, at character level 6 with 51/59 HP. The campaign took 9 runs (8 deaths), 1,844 tool calls and $38.63, with no tool errors. All 37 notifications were sent (no `notify_failed`).

| Run | Time | Calls | Cost | $/call | Peak context | Outcome |
|---|---|---|---|---|---|---|
| 1–6 | 57 min | 915 | $14.00 | ≈ $0.015 | 128k–229k | All died overland before dungeon level 1: Old Forest ×2, world-map ambush ×3, Thieves' Hideout behind Bree's `>` |
| 7 | 38 min | 486 | $15.13 | $0.031 | **514k** | First Word of Recall from Bree → level 8 at character level 9; died of poison |
| 8 | 7 min | 115 | $1.66 | $0.014 | 137k | Recalled to level 1 and died to a crow |
| 9 | 23 min | 328 | $7.84 | $0.024 | 348k | Recalled; levels 1→10 in 23 min; goal met |

**Cost and context** (from Claude Code's session logs in `~/.claude/projects/`):

- $18.4/h overall, against $10.4/h in the 30-minute sample. Speed was about 15 calls a minute.
- **Claude Code never compacted.** Context grew by about 1.1k tokens per call (mostly screenshots), from 18k at the start to 514k in run 7. Cache reads are about 80% of the cost, so a run's cost grows with the square of its length: run 7 cost twice as much per call as the short runs.
- A cap at about 200k tokens, as `context.refresh_tokens` gives the API loop, would have cut run 7 by roughly 60% and the campaign by roughly a quarter. game-r doesn't apply it to agent CLIs (`src/agent.ts` starts a new session only per run).

**Memory and learning:**

| Snapshot | guide.md | lessons.md |
|---|---|---|
| Run 1 | 40 lines, 3.1 KB | 24 lines, 3.7 KB |
| Run 4 | 51 lines, 6.3 KB | 52 lines, 11.1 KB |
| Run 5 (Review) | 41 lines, 4.7 KB | 52 lines, 8.8 KB |
| Run 9 | 63 lines, 8.6 KB | 100 lines, 20.0 KB |

- **The run 5 Review worked:** it cleaned lessons.md first and shrank both files. The next Review (run 10) never came, so lessons.md doubled after it.
- **Help:** the agent read *Your first adventure* and seven more topics before creating its hero, and went back to Help in runs 5 and 7. In run 5 it found the *walk off the edge* rule that it had missed.
- **Learning across runs:** each death became a keyed lesson with a location ("where NOT to go"). Run 7 found *Knowledge → Recall depths* and a discounted Word of Recall. From then on `guide.md` opens with "THE ROUTE THAT WORKS": farm gold in Bree with *No selling* on, buy Word of Recall, read it in Bree.
- **The overland route was never found.** Run 7 followed the path west from Bree to the Grasslands, decided it wasn't the way, and memory now says the entrance is "not needed". That is legitimate play, but it skips what *Getting started* asked for. The next campaign's instructions should say whether to go on foot.
- **Phone play:** 457 key presses (arrow keys, Home, PageUp…) against about 2,800 taps or clicks. The agent walked the world map with arrow keys although the instructions said to play as a phone player would. Say "touch only" in the instructions if that matters.
- In-game initiative: on level 8 it switched *Settings → Dungeon levels* to "New each visit" to get past a level it called sealed.

**Disk:** 111 MB in 2.1 h. Screenshots are 63 MB of the 66 MB in the run folders (about 30 MB/h at this pace); the browser profile is a fixed 47 MB; transcripts are under 1 MB a run. Across all campaigns only 8 references to a saved screenshot exist in reports or memory, all from the `dodge` test games. Each Claude Code session log is 12–45 MB as well, outside `runs/`.

**Not exercised:** the wrap-up warning and the hours limit (the goal was met first), a CLI resume or retry (each run was one session that ended with `end_run`), and a subscription limit.

**Proposals:**

1. **Cap context in agent CLI sessions.** Either use each CLI's own compaction setting, if it has one (Codex's `model_auto_compact_token_limit`; Claude Code's is to be probed), or have game-r end the session after a set number of calls in a run and continue with the existing *refresh* opening. Probe first.
2. **Screenshot retention:** a `game-r.yaml` option (e.g. `keep_shots: referenced | all`, default `referenced`). At each seal, keep the screenshots that `/run` files, `log.md` or `/memory` name, and drop the rest. `all` is for debugging what the agent saw.
3. ~~**Instructions**: whether the first descent must be on foot, and "touch only".~~ Declined: the user liked the creative solution.

---

## To do (from the user, 2026-10-30)

Address these together with the issues and lessons from the first `tome-barrow` run (15 min sample).

**Status:** items 7 and 8 are addressed (Orient now applies whatever the time limit and follows a Getting started plan; an end point in the game ends the run; the framework records whether a run changed /memory and says so at `end_run`; `tome-barrow` has `runs: null`). Item 9: Sonnet on high effort is now the default and the benchmark. Items 1, 2, 3, 5 and 6 are built as design step 3b (`docs/MCP-DESIGN.md` §7). Pacing is `pace.seconds_per_call`; soft limits are `limits.wrap_up_minutes` warnings; there is a templated memory and a run protocol; a status line ends every result; `end_run` takes `new_run`, `goal_met` or `goal_impossible`. Item 4 waits for a 30-minute rerun of `tome-barrow`, compared with the first.

| # | Item | Notes |
|---|---|---|
| 1 | **Pacing option** | A user setting to make the agent work at most every X seconds (e.g. `limits.min_seconds_per_call` or a `pace` block), default off. For expensive models: spreads use across a subscription's 5-hour window and trades wall time for cost. Nothing like it exists yet (limits are runs, hours, cost and tool calls per run). Decide where the delay goes (between tool calls in `Toolbox.call`, or between model turns), make it work for agent CLIs and API providers alike, and keep real-time games safe (pause the clock while waiting, or document it). |
| 2 | **Soft limits** | A limit should not cut the agent off mid-thought. Warn it ahead (e.g. a few minutes or a set fraction before `hours` or `cost_usd`) so it can save /memory and call `end_run`, then stop hard after a grace period. Make sure usage and cost are still recorded when an agent CLI is interrupted (`claude -p` may print no final JSON on SIGINT; Claude Code's own session log in `~/.claude/projects/` has per-message usage). |
| 3 | **Orientation doc** | Check whether the agent writes itself a context doc unprompted (game purpose, core mechanics, style, controls, objectives beyond the task). If it doesn't, consider a general first step for every campaign: build or refresh `/memory/context.md` (or similar) before playing, and re-read it at each run start and after each refresh. A sentence in the framework prompt is preferred over a new mechanism. |
| 4 | **Cost estimate** | From the first run's usage, estimate the cost per hour and per dungeon level for Opus. Compare with Sonnet before long campaigns. |
| 5 | **Agent's sense of time** | First run: the agent never called `status`, believed its 15 minutes were up after 3.4, invented clock times in its log, and ended the campaign. Candidate fix: show wall time used against the limit in every tool result's status line (e.g. `run 3m24s of 15m`), so time is always in view without a call. |
| 7 | **Orientation skipped** | Second run: never read the game's help despite "Orient first". Options: make step 1 explicit that it applies whatever the time limit, and name what to open first (the game's own help, manual or tutorial); or have the first-run opening say so concretely. Prefer a prompt sentence to any mechanism; test it with a longer limit, since 30 minutes invited rushing. |
| 8 | **`runs` in roguelikes** | A death ends a run, so `runs` counts deaths. Set `runs: null` for such campaigns and bound them by `hours`; say so in `game-r.yaml`. |
| 9 | **Sonnet comparison** | Same campaign on Sonnet (about half the price) to compare play and cost per hour. |
| 6 | **`done` too early** | It ended with `next: done` although the goal was unmet. Candidate fix: one framework-prompt sentence: `done` only when the instructions are complete or cannot be completed; otherwise `new_run`. |

### First `tome-barrow` run (2026-10-30, Opus, medium effort, Pixel 7)

- **Usage:** 3.4 min, 41 tool calls (about 12 a minute), $0.76 Claude Code estimate (1.06M cache-read, 47k cache-write, 8.5k output tokens), about 26k tokens of context per call. That is about $13 an hour at the start, rising as the context grows until Claude Code compacts.
- **Character creation:** smooth, about 1 minute and 9 calls, but it accepted the defaults (Beorning Warrior) by tapping *Choose* on each screen rather than choosing a build.
- **Play:** the contextual toolbar button did most of the work ("Way down" walks from Bree to the dungeon). It went down without wearing its starting chain mail and without potions, and a newt took it to 0 HP on level 1. It survived, rested, and wore the armour after that.
- **Notes:** `/memory/notes.md` (written 2.3 minutes in) holds UI coordinates, status and lessons, but no orientation (game purpose, mechanics, how to survive). It never opened the game's *How to play*. This supports item 3.
- **Tools:** no tool errors. Taps by coordinate, typing, waits and `look_after` all worked; `read_page` was used once; the clock was never paused (turn-based game). `ping-me` delivered the milestone. Screenshots render the game cleanly in headed Chromium.
- **The hero:** Bram is alive at 50 ft. (That campaign was cleared for a fresh rerun.)

### Second `tome-barrow` run, after step 3b (2026-10-30, Opus, medium effort, Pixel 7, fresh state)

`limits: { runs: 3, hours: 0.5 }`. Every hero died, and each death ended a run, so the 3-run limit ended the campaign after 18 minutes.

| | First run | Second (3 runs) |
|---|---|---|
| Time, calls | 3.4 min, 41 | 18 min, 227 (42 + 94 + 91) |
| Cost (Claude Code estimate) | $0.76 (≈ $13/h) | $4.83 (≈ $16/h); context per call ≈ 28k in a short run, ≈ 50k in a 7-minute run |
| Deepest / outcome | DL1, alive; ended "done" with the goal unmet | DL2 (runs 2 and 3); all three heroes died; every run ended `new_run` correctly |
| Time-keeping | Invented times; thought 15 min had passed after 3.4 | Correct throughout: it planned against the status line ("17 min left") |
| Memory | One flat file of screen coordinates | A goal checklist with evidence paths, Now with a concrete next action, a real guide, and 15 specific lessons, some marked Unverified |
| Learning across runs | — | Yes. Run 2 wore its armour; run 3 bought supplies, levelled on DL1 first, avoided a sleeping out-of-depth monster and routed around breeding worms |
| Orientation | None | **None.** It never opened *How to play* or read documentation, although the opening said "Orient first". It traded reading for speed under the short limit, and never found the Alchemist for healing potions |

**What this says:**

- The structure works: the memory, the lessons and the time-keeping are much better.
- **Orientation still didn't happen.** A short time limit visibly pushed the agent to rush; the protocol's Orient step reads as optional.
- In a roguelike, **`runs` counts deaths**. The default of 10 runs (and 3 here) ends a campaign quickly. Hours, not runs, should bound such campaigns.
- Cost per call grows with the run's context (each run is one CLI session), so long runs cost more per call.

### Third `tome-barrow` run, after step 3c (2026-10-30, Sonnet high, Pixel 7, fresh state, `runs: null`, Getting started given)

30 minutes: 7 real runs, one hero per run, plus 14 empty runs at the end (a framework bug, now fixed).

| | Second (Opus) | Third (Sonnet high) |
|---|---|---|
| Rate in real play | ≈ $16/h, ≈ 12.6 calls/min, ≈ $0.021/call | **≈ $10.4/h**, ≈ 16 calls/min, ≈ $0.011/call (runs 1–7: $4.46, 414 calls, 26 min) |
| Orientation | None | **Yes**: guide.md cites "Menu → How to play; More → Help" (Help only skimmed) |
| Deepest / outcome | DL2; 3 deaths | DL2 alive (run 7, a Mage via the Way down route); 6 deaths |
| End points | Each death ended a run | Each death ended a run, with memory updated every time (ledger Memory column) |
| Learning | Yes | Yes, and specific. Runs 1–5: Bree's `>` drops a new hero into a level-5 prison ambush; it identified the trigger and tried other classes. Run 6 tried levelling in town and died to a mercenary. Run 7 found that "Way down" leads to level 1 and survived |

**Bug found and fixed:** with `runs: null`, the agent obeyed the wrap-up warning (too little time to play, End step, `new_run`) and the framework started another run every time: 14 empty runs in the last 4 minutes, about $1 of overhead and 14 browser restarts. Now no new run starts while the campaign's time or cost warning is on, once a run has been played.

**What this says:** Sonnet high is a good benchmark. It costs about two-thirds as much per hour, plays faster per call, follows the protocol and the Getting started direction, and learns across runs. The game is hard at level 1 in its default setup; that is game knowledge for the instructions or memory, not the framework.

### The same campaign on Codex and OpenCode Go (2026-10-30, 30 min each, fresh state)

`tome-barrow-codex` (Codex `gpt-6.1-terra`, high) and `tome-barrow-go` (OpenCode Go `deepseek-v4.1-flash`, high) ran side by side, with the same instructions as `tome-barrow`.

| | Sonnet high | Codex `gpt-6.1-terra` high | DeepSeek V4.1 Flash high |
|---|---|---|---|
| Cost (API-equivalent) | ≈ $10.4/h | ≈ $4.9/h ($2.03 for 25 min, by ccusage; the ledger shows $0 because the run started before prices were set) | ≈ $0.34/h ($0.16 for 28 min at the list prices) |
| Speed | 16 calls/min | 18 calls/min | 8 calls/min |
| Runs, deaths | 7, 6 | 2, 0 | 3, 1 |
| Best | DL2 alive | DL2 (100 ft) at CL3 alive, saved at the wrap-up to continue | DL1 route found; died in run 1 with its gear unworn |
| Help read | How to play, Help (skimmed) | How to play, Help and its Newbie Guide | How to play and Help, quoted in the guide |
| Memory at the end | grew every run | 57 lines in total | 101 lines |

- **R2 and R3 are verified for real.**
  - Codex sees MCP images, and its shell is off.
  - The ledger's Codex tokens equal ccusage's per session, so there is no double counting. The resume path is still unexercised, because each run was one session.
  - OpenCode Go works through game-r's own loop, with images and `reasoning_content`.
- **Codex played most deliberately.** It ended a run on purpose to restart with better settings, and saved a live hero at the wrap-up warning. The persistent browser profile lets the next run continue that hero.
- **DeepSeek is very cheap** and documents well, but acts on what it read less reliably.
- **The wrap-up fix held:** both campaigns ended with "no new run in the wrap-up window".

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
