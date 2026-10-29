# game-r — MCP design (draft 0.1)

An engine where any LLM plays and tests HTML web-app games from a URL, under a
fixed objective, for hours to days, and gets better from run to run without
drifting from what it was asked to do.

> Status: design for review. Nothing is built yet. Decisions marked **(rec.)**
> are recommendations awaiting sign-off; open questions are collected in §16.

---

## 1. Goals and non-goals

### Goals

- **Point and play.** `model + URL + objective` is enough to start. Game-specific
  help (adapters, notes) makes it better but is never required.
- **Any objective.** Play to the end of mode X; maximise score; explore for UI
  bugs and quirks; regression-test a known path; compare models.
- **Long-horizon stability.** Turn 10,000 is reasoned about as well as turn 10.
  Context size, cost per turn and adherence to the objective stay flat.
- **Learning across runs.** Each run leaves lessons, skills and coverage behind;
  the next run starts from them, but never from a changed objective.
- **Evidence, not claims.** Progress, bugs and scores are measured by code
  wherever possible; every finding carries a reproducible trace.
- **Model-agnostic.** Anthropic, OpenAI, Google and OpenAI-compatible local
  models through one interface; different models per role.
- **MCP-first.** Every capability is an MCP tool, so Claude Code (or any MCP
  client) can play, supervise or inspect directly.

### Non-goals (for now)

- Native/mobile apps, non-browser games, emulators.
- Online multiplayer against real people (both example games have online
  modes; we play their local/AI modes).
- Training model weights. "Learning" means memory, skills and prompts.

---

## 2. Prior art and what we adopt

| Source | Idea | Adopted as |
|---|---|---|
| **Claude Plays Pokémon** (Anthropic) | Prompt rebuilt each step from instructions + knowledge base + recent history; KB capped (~8k tokens); summarise every ~30 actions; a second model audits the KB for stale/wrong entries; a navigator tool so the model doesn't hand-steer every step | §6 turn assembly, §6.3 Archivist, §5.1 `act` macros |
| **Gemini Plays Pokémon / Continual Harness** (DeepMind, 2026) | Screenshot + overlays + minimap; model-built sub-agents, `run_code`, custom tools; outer loop refines the harness itself while the inner loop plays | §10 skill library, §8.3 adapter bootstrap, §7.3 reflex controllers |
| **Battle Drones `AGENT-BATTLES.md`** (simonw) | Fresh context each round + agent's own ≤2 KB notes (flat cost instead of quadratic); compact text observation with stable ids (~½ the tokens of JSON); fixed rounds of game time so model latency doesn't matter; `wait(n)` that breaks early on urgent events; tools-only seats so the model can't cheat; budgets per round | §6 (fresh context), §5.1 `observe` format, §7 stepped time, §13 fair play |
| **Playwright MCP** (Microsoft) | Accessibility snapshot with element refs; opt-in vision (xy mouse) caps; console/network tools | §8 perception ladder, §5.1 refs |
| **Voyager** (Wang et al.) | Skill library of verified code, automatic curriculum, self-verification | §10.2 skills, §10.4 curriculum |
| **Reflexion / ExpeL** | Verbal post-mortems after each trial; distilled insights retrieved later | §10.1 lessons |
| **lmgame-Bench / GamingAgent** (ICLR 2026) | Switchable perception and memory modules; symbolic text tables beat raw pixels for spatial games | §8 perception ladder, adapter `text()` |
| **TITAN** and LLM game-QA papers | State abstraction, reflection, oracle-based bug detection | §9 oracles |
| **Bug0 / Stagehand** | Cache successful action sequences and replay them deterministically; LLM only on cache miss | §10.2 skills as cached replays |
| **Goal-drift research** (Arike et al., AIES 2025; Dongre et al.) | Drift grows with context length and pattern-matching; goal reminders and prompt structure reduce it; drift often shows as *inaction* | §6.2 anti-drift measures |
| **"Model proposes, code decides"** QA agents | The LLM chooses actions; deterministic code judges pass/fail | §9, §10.1 utility scoring |

### Where game-r goes further

1. **Virtual time** (§7). Playwright's clock pauses `requestAnimationFrame`,
   timers and `performance.now()` and advances them on demand (verified in this
   repo's container: paused for 1.5 s wall time → 0 frames; `runFor(1000)` → 63
   frames, 10 `setInterval` ticks). Any real-time game becomes turn-based
   without touching its code — the Battle Drones round model, generalised to
   any URL.
2. **Deterministic replay** (§9.3). Frozen clock + seeded `Math.random` +
   fixed viewport + recorded inputs = a run that replays exactly, so bugs are
   verified by re-running them and **repro steps are shrunk automatically**
   (delta debugging).
3. **Measured lessons** (§10.1). Lessons carry a utility score updated from
   run outcomes; lessons that don't help are demoted, harmful ones retired.
4. **Charter-bound learning** (§6.2). Learning can change *how* the agent
   plays, never *what it is for*: the objective is an immutable charter, every
   goal must cite it, and an Auditor rejects goals that don't.
5. **Coverage as a first-class metric** (§9.4). State fingerprints build a map
   of screens and states reached; QA runs are driven towards the unvisited.

---

## 3. Architecture

```
┌──────────────────────── MCP clients ─────────────────────────┐
│ Claude Code / Desktop · any MCP client · game-r CLI · web UI │
└──────────────┬──────────────────────────────┬────────────────┘
               │ control (supervise)          │ play (direct, optional)
┌──────────────▼──────────────────────────────▼────────────────┐
│                         game-r engine                        │
│                                                              │
│  ┌───────────── Director (per campaign) ─────────────┐       │
│  │ turn loop · context assembly · budgets · roles:   │       │
│  │  Player · Auditor · Archivist · Reflector ·       │       │
│  │  Verifier        ── model gateway (any provider)  │       │
│  └──────┬────────────────────┬──────────────────┬────┘       │
│         │ tools              │ tools            │ events     │
│  ┌──────▼──────┐   ┌─────────▼────────┐  ┌──────▼─────────┐  │
│  │ Play server │   │  Memory server   │  │ Control server │  │
│  │ browser,    │   │ charter, plan,   │  │ games, cam-    │  │
│  │ time, ora-  │   │ KB, lessons,     │  │ paigns, runs,  │  │
│  │ cles, check-│   │ skills, findings │  │ findings, re-  │  │
│  │ points      │   │                  │  │ ports, steer   │  │
│  └──────┬──────┘   └─────────┬────────┘  └──────┬─────────┘  │
│         │                    └───── store ──────┘            │
│  ┌──────▼──────────────┐   ┌─────────────────────────────┐   │
│  │ Playwright browsers │   │ SQLite event log + artefact │   │
│  │ + game adapters     │   │ dir (shots, traces, saves)  │   │
│  └─────────────────────┘   └─────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

**Three MCP servers in one process (rec.)**, each mountable on its own:

| Server | Who uses it | Purpose |
|---|---|---|
| `game-r-play` | the Player (Director's model, or Claude Code directly) | See and act in the game; control time; save/load; report findings |
| `game-r-memory` | the Player and the support roles | Read the charter; manage plan, knowledge base, lessons, skills |
| `game-r-control` | a human, Claude Code, CI | Register games; create/run/steer campaigns; read findings and reports |

Transport: stdio for local clients, Streamable HTTP on loopback with a
per-session token for remote/long-running use (same pattern as Battle Drones'
`/mcp/<seat-token>`).

**Two ways to play (rec.: both, Director by default).**

- **Director mode** — the engine runs its own loop against a model API. This is
  the mode for hours-to-days runs: we control context, caching, budgets,
  roles and recovery, so results compare cleanly across models.
- **Client mode** — Claude Code (or any client) mounts `game-r-play` +
  `game-r-memory` and plays itself. Great for exploratory sessions and for
  developing adapters; long-run stability then depends on that client's own
  harness.

---

## 4. Core concepts

| Concept | Definition |
|---|---|
| **Game** | A registered target: URL(s), optional adapter, device profiles, static notes (controls, modes), allowed hosts. |
| **Charter** | The immutable objective of a campaign: objective(s) with ids, success criteria, constraints, fair-play policy, budgets, stop conditions. Changed only by a human, via a versioned amendment. |
| **Campaign** | A charter applied to a game over many runs. Owns lessons, skills, coverage and findings. |
| **Run** | One episode: fresh page (or a checkpoint), from start to a terminal state (won, lost, budget, stall, timeout). |
| **Turn** | One decision cycle: observe → think → act (a batch) → time advances → end turn with a digest. |
| **Chapter** | A group of turns (~25–50) compacted into one summary. |
| **Observation** | Compact text (+ optional image) describing what is perceivable now, plus what changed and harness alerts. |
| **Finding** | A bug, quirk, UX issue or balance observation, with evidence and a verification status. |
| **Lesson** | A distilled, evidence-linked insight from past runs, scoped and scored. |
| **Skill** | A named, parameterised, verified action routine (macro, replay or script). |

---

## 5. MCP tools

Conventions: every result is compact text first (structured JSON available via
`format: "json"`); ids are stable within a run; every tool call is logged with
the turn id; refusals return a reason the model can act on.

### 5.1 `game-r-play`

| Tool | Arguments | Returns |
|---|---|---|
| `session_open` | `game` or `url`, `device` (e.g. `pixel-7`, `desktop-1440`), `seed`, `time_mode` (`stepped`/`realtime`/`slowmo`), `checkpoint?` | session id, viewport, adapter tier detected, time mode in force |
| `observe` | `detail` (`brief`/`full`), `include` (`text`, `screenshot`, `grid`, `a11y`, `adapter`, `events`) | the observation (§8.4) |
| `look` | `ref` or `region {x,y,w,h}`, `zoom` | a cropped high-res image and the elements in that region |
| `act` | `actions: Action[]`, `advance_ms?`, `stop_on?` (events that abort the rest of the batch) | per-action `ok`/reason, then a diff observation |
| `advance` | `ms`, or `until` (`state_change`, `text`, `adapter_event`, `idle`), `max_ms` | what happened while time ran; breaks early on urgent events (Battle Drones' `wait`) |
| `checkpoint_save` | `label` | checkpoint id (storage + IndexedDB + adapter save + input-log position) |
| `checkpoint_load` | `id` | restored observation |
| `inspect` | `expression` | read-only page evaluation — **only if the charter allows** (QA mode); always logged |
| `report_finding` | `kind`, `severity`, `title`, `description`, `expected`, `actual` | finding id; harness attaches screenshot, last N inputs, console, seed, checkpoint |
| `end_turn` | `digest` (≤ 300 chars), `intent_next`, `goal_id` | ends the turn; digest becomes history |

`Action` union (one schema, validated with zod):

```ts
type Target = { ref: string } | { xy: [number, number] } | { cell: string };   // cell = grid label "F7"
type Action =
  | { click: Target; button?: 'left' | 'right'; count?: number }
  | { tap: Target } | { long_press: Target; ms?: number }
  | { drag: { from: Target; to: Target; ms?: number } }
  | { swipe: { from: Target; dir: 'up' | 'down' | 'left' | 'right'; px?: number } }
  | { pinch: { at: Target; scale: number } }
  | { key: string; hold_ms?: number } | { keys: string[] }        // chord
  | { type: string }
  | { wheel: { at: Target; dy: number; dx?: number } }
  | { wait_ms: number }                                            // game time in stepped mode
  | { adapter: string; args?: unknown }                            // adapter action, e.g. { adapter: 'tapCell', args: [12, 7] }
  | { skill: string; args?: Record<string, unknown> };
```

Batching (rec.): the Player commits several actions per turn, as Battle Drones
orders do. Fewer round-trips, and in stepped mode the batch is a plan executed
over game time.

### 5.2 `game-r-memory`

| Tool | Purpose |
|---|---|
| `charter_get` | Read the charter (also always in the prompt; the tool exists for client mode). |
| `plan_get` / `plan_update` | Goal stack: `{id, parent, cites: objectiveId, text, status, success_check}`. A goal without a valid `cites` is refused. |
| `kb_read` / `kb_write` / `kb_delete` | Game knowledge base, sectioned (controls, map, mechanics, UI, hazards…). Hard size cap; every entry carries `evidence` (run/turn ids) and `confidence`. Write over the cap is refused with "prune first". |
| `notes_write` | Short scratchpad for the current run (≤ 2 KB), handed back each turn. |
| `lessons_search` | Cross-run lessons for this game/objective, ranked by relevance × utility. |
| `skill_list` / `skill_define` / `skill_get` | Skill library (§10.2). `skill_define` creates a *candidate*; the harness verifies before it can be used. |
| `coverage_get` | Visited states/screens and frontier (§9.4). |

### 5.3 `game-r-control`

| Tool | Purpose |
|---|---|
| `game_register` / `game_update` / `game_list` | Targets, adapters, device profiles, notes. |
| `campaign_create` | Game + charter + role→model map + budgets + schedule. Returns the campaign id. |
| `campaign_start` / `pause` / `resume` / `stop` | Lifecycle. Resume is exact (from the event log). |
| `campaign_status` | Objective progress (measured), current run/turn/goal, cost, health, last N digests, live screenshot. |
| `campaign_steer` | Operator note to the Player. Tagged *operator*, shown in its own prompt slot; it can direct within the charter but cannot amend it. |
| `charter_amend` | Versioned charter change (human only); recorded and reflected in reports. |
| `findings_list` / `finding_get` / `finding_verify` / `finding_export` | Triage; re-run repro; export as Markdown or GitHub issue body. |
| `run_report` / `campaign_report` / `campaign_compare` | Summaries, metrics, model comparisons. |
| `replay` | Deterministic replay of a run (or a range of turns) headed, for watching. |

---

## 6. The Director loop

### 6.1 Turn assembly

Every turn's prompt is **rebuilt from durable state**, never an ever-growing
transcript. Cost per turn and attention per turn stay flat for days.

```
[cached] system: role, rules, tool docs
[cached] CHARTER (objectives with ids, criteria, constraints, fair-play)
[cached] GAME BRIEF (static notes, controls, adapter description)
[semi]   KNOWLEDGE BASE (≤ ~8k tokens, curated)          ← changes per chapter
[semi]   LESSONS (top-k for current goal, ≤ ~2k tokens)
[semi]   CHAPTER SUMMARIES (last 2–3) + run-so-far one-liner
         PLAN (goal stack with statuses)
         RECENT TURNS (last ~10 digests + last 2 full tool exchanges)
         OPERATOR NOTES (if any)
         HARNESS ALERTS (stall, oracle hits, budget, auditor verdict)
         OBSERVATION (now) + run notes
```

Cache breakpoints after the game brief and after the KB (rec.), matching the
Anthropic guidance of stable content first and dynamic content last. Per-turn
budget: e.g. ≤ 8 tool calls and an output-token cap; a turn that exceeds it
ends with whatever was committed.

### 6.2 Staying on purpose (anti-drift)

| Risk (seen in prior art) | Measure |
|---|---|
| Objective fades as context grows | Charter re-injected verbatim every turn at a fixed position; context never grows. |
| Busywork goals | Every goal cites a charter objective id; the Auditor rejects orphans and asks "how does this advance O2?". |
| Hallucinated progress ("I've cleared level 3") | Progress metrics are computed by code (adapter, DOM checks, score readers, coverage) and shown in alerts; self-reports are never trusted for stopping conditions. |
| Loops and stalls | Stall detector: state-fingerprint novelty, score delta, repeated action n-grams, unchanged frames. Escalation ladder: alert → Auditor replan → load checkpoint → end run with post-mortem. |
| Wrong beliefs fossilising in memory | KB entries are evidence-linked; the Archivist re-checks them against recent observations each chapter and prunes contradictions. |
| Drift by inaction | Auditor checks time-since-last-progress per objective, not only bad actions. |
| Learning rewrites the mission | Lessons/skills are subordinate to the charter; anything conflicting with it is rejected at write time. |
| Prompt injection from game text | Observed text is quoted and labelled as game content; it is never placed in instruction slots. |

### 6.3 Roles

| Role | When | Default model class | Output |
|---|---|---|---|
| **Player** | every turn | strong, vision-capable | actions, digest |
| **Auditor** | every N turns (≈20) and on alerts | cheaper/fast | verdict: `continue` / `replan` / `checkpoint` / `end_run`, with reasons |
| **Archivist** | each chapter end | mid | chapter summary; KB edits (prune, merge, verify) |
| **Reflector** | each run end | strong | post-mortem, candidate lessons and skills, next-run focus |
| **Verifier** | on each new finding | none/cheap (mostly code) | reproduce, minimise, classify |

All roles read the same charter. Models are set per role in the campaign, so
"Opus plays, Haiku audits" or "GPT plays, Claude audits" are both one-line
configs.

---

## 7. Time control

### 7.1 Modes

| Mode | How | Use |
|---|---|---|
| **`stepped`** (rec. default) | `page.clock.install()` + `pauseAt`; each `act`/`advance` runs `clock.runFor(ms)`. The game is frozen while the model thinks. | Any objective where the question is decision quality, not reflexes. Makes runs reproducible and model latency irrelevant. |
| **`slowmo`** | Clock advanced in small increments at k× wall speed (e.g. 0.25×). | Action games where continuous motion matters but humans' speed is too fast for a model. |
| **`realtime`** | Native clock. | Measuring real latency, network/online features, or games that break under virtual time. |

### 7.2 Caveats and detection

Not covered by the virtual clock: Web Audio's `currentTime`, CSS
animations/transitions (mitigated with `prefers-reduced-motion` emulation or an
injected style), timers inside Web Workers, WASM threads, network latency.
The harness measures **clock leakage** (frames or adapter ticks advancing while
paused) at session start and reports the game as *stepped-safe*,
*stepped-with-caveats* or *realtime-only*.

### 7.3 Reflex controllers (opt-in, charter-gated)

For twitch mechanics the Player can write a small JS policy (e.g. "keep the
ship centred and fire at the nearest enemy") that runs in-page between turns,
with a time limit and sandbox. It is code-as-policy à la Voyager: the model
plays the strategy, its controller plays the reflexes. Charters for fair
"human-like" play disable this.

---

## 8. Perception and game adapters

### 8.1 Perception ladder

Each session uses the highest tier available and mixes lower tiers in:

1. **Adapter** — structured state, legal actions, score, status from the game
   itself. Cheapest, most accurate.
2. **DOM / accessibility snapshot** with refs (Playwright MCP style) — for menus,
   HUDs, dialogs, settings.
3. **Vision** — screenshot with an optional labelled grid (`A1…`) or
   set-of-marks over detected interactive regions; `look` for zoom. Needed for
   canvas/WebGL boards.

### 8.2 Adapter contract

An adapter is an object the harness can call, either **in-page** (injected
script, or a `window.__gameR` the game ships) or **external** (an HTTP/MCP
endpoint, e.g. Battle Drones' existing arena seat API).

```ts
interface GameAdapter {
  name: string;
  version: string;
  describe(): { modes: string[]; actions: ActionSpec[]; notes?: string };
  status(): 'loading' | 'menu' | 'playing' | 'paused' | 'won' | 'lost' | 'over';
  text(): string;                          // compact text state, stable ids
  state?(): unknown;                       // structured state (for metrics/fingerprints)
  score?(): number | Record<string, number>;
  scene?(): string;                        // screen/scene id for coverage
  legal?(): string[];                      // current legal actions
  do?(action: string, args?: unknown): Promise<{ ok: boolean; reason?: string }>;
  events?(): GameEvent[];                  // drained since last call
  save?(): Promise<string>; load?(s: string): Promise<void>;
  seed?(n: number): void;
  playerView?: boolean;                    // true if text() only shows what a player could see
}
```

Both example games already have most of this:

- **ToME** — `window.__tome` exposes `screenText()`, `sendText()`, `mode()`,
  `actions()`, `tapCell(x,y)`, `exploreStop()`, `travelling()`,
  `lastStopCause()`, and `?wizard` exists for test setups. A thin adapter wraps
  these. It is turn-based, so stepped time matters less than macro skills
  (Explore, travel).
- **Battle Drones** — a deterministic headless sim and a fog-of-war-respecting
  `observe`/`orders` protocol already exist (`AGENT-BATTLES.md`). An external
  adapter can reuse the arena seat API; the browser build is then used for UI
  and QA objectives.

### 8.3 Adapter bootstrap (later phase)

In a sandboxed dev run, the agent may read the page (and source, if given) and
draft an adapter. The harness validates it (no throws; state changes correlate
with inputs; `status` agrees with the screen) and a human approves it before
campaigns use it. This is the Continual Harness idea with a gate.

### 8.4 Observation format

```
T 0:42.250 (stepped) · run 7 turn 183 · status playing · scene dungeon/moria-3
SCORE 1,240 (+60)   HP 31/45   OBJ O1 progress: depth 3/10 (measured)
CHANGED  hp -6 · new message "The orc hits you." · toolbar Attack→Explore
UI  [b1] button "Explore"  [b2] button "Rest"  [b3] button "Menu"  [m1] map (canvas 390×620, grid 8×12)
ADAPTER  @ hero 12,7 · orc#41 13,7 awake 60% · stairs> 20,3 · ...
EVENTS   console.warn ×1 "texture not ready"
ALERTS   none
NOTES    (your run notes)
```

Images are attached only when asked for or when the text tier is weak (no
adapter, canvas-only). Image detail and frequency are budgeted.

---

## 9. Testing: oracles, findings, coverage

### 9.1 Oracles (deterministic, always on)

| Oracle | Detects |
|---|---|
| `pageerror`, `console.error`, unhandled rejections | JS errors (with stack) |
| Failed/slow network requests | missing assets, 404s, CORS |
| Frame timing (rAF deltas in realtime), long tasks | jank, freezes |
| JS heap growth across checkpoints | leaks |
| Layout checks: elements outside viewport/safe area, overlapping hit targets, clipped text, tap targets < 44 px | responsive/UI bugs |
| Unresponsive input (action had no visible/state effect) | dead buttons, focus traps |
| Visual stall (identical frames while `playing`) | hangs |
| `axe-core` (optional) | accessibility |
| Adapter invariants (game-specific, e.g. HP ≤ max) | logic bugs |
| Device/orientation sweep at checkpoints | portrait/landscape/tablet differences |

The Player adds judgement-based findings (`report_finding`): odd copy,
confusing flows, balance issues, things that "feel wrong".

### 9.2 Findings pipeline

```
raise → dedupe (signature: stack hash / DOM path / perceptual hash + title embedding)
      → verify (replay from nearest checkpoint, same seed)
      → minimise (delta-debug the input list to the shortest repro)
      → classify: confirmed · flaky (k/n) · not reproduced · by design (human)
      → report (Markdown / GitHub issue body with steps, shots, trace, seed)
```

### 9.3 Determinism

Init script before any page code: seeded `Math.random` (and optionally
`crypto.getRandomValues`), virtual clock, fixed viewport/DPR/locale/timezone,
`prefers-reduced-motion` as configured, optional network record/replay
(HAR). All inputs are logged with their game-time stamp. Combined, a run is a
replayable file — essential for verification and for days-long runs that must
survive crashes.

### 9.4 Coverage

A state fingerprint = URL + scene id (adapter) + normalised DOM structure hash
+ coarse perceptual hash. The coverage graph (fingerprints as nodes, actions as
edges) gives: % of known screens visited, frontier states with untried actions,
and a "novelty" signal for the stall detector. QA charters set the Player's
goals from the frontier; score charters use it only for stall detection.

---

## 10. Learning across runs

### 10.1 Lessons

The Reflector writes candidate lessons at run end:

```yaml
id: L-0042
scope: { game: tome, mode: "normal", objective: O1 }
text: "Buy Flasks of Oil in Bree before descending past depth 5; throw them at packs."
evidence: [run-6/turn-412, run-6/turn-455]
status: candidate        # candidate → active → retired
utility: { applied: 0, helped: 0, hurt: 0 }
```

Lessons become `active` after the Auditor/Reflector confirms evidence. When a
lesson is in the prompt for a run, the run's outcome updates its utility
(relative to the campaign's running baseline). Low-utility lessons drop out of
retrieval; harmful ones are retired. Retrieval ranks by relevance to the
current goal × utility, within a token cap.

### 10.2 Skills

Three kinds, all named and parameterised, all **verified before use**:

| Kind | Example | Verified by |
|---|---|---|
| **Macro** | "open inventory, sort by weight" — an action list with ref/semantic targets | replay from a matching state reaches the postcondition |
| **Cached path** | a menu path recorded from a successful run (Bug0/Stagehand cache) | exact replay; on miss, the LLM takes over and the cache heals |
| **Script** | a JS routine against the adapter or DOM | sandboxed run with time limit, postcondition check |

Skills carry preconditions (scene/status), postconditions and a success rate.
They let the Player stop spending turns on solved sub-problems.

### 10.3 Knowledge base hygiene

The KB (game facts) is distinct from lessons (strategies). The Archivist keeps
it under its cap, merges duplicates, removes entries contradicted by recent
evidence, and records why.

### 10.4 Curriculum across runs

At run end the Reflector proposes the next run's focus *within the charter*
(e.g. "O3 explore: Settings → Audio and the soundtrack sheet are unvisited";
"O1 score: try the Industry opener on Archipelago"). The Auditor checks it cites
an objective. Optionally the next run starts from a checkpoint near the
frontier instead of the title screen.

---

## 11. Durability for hours-to-days

- **Event-sourced store.** Every turn appends: prompt hash, tool calls and
  results (large results by reference), inputs with game time, metrics,
  tokens, cost. SQLite (`node:sqlite`, no extra dependency) + an artefact
  directory.
- **Exact resume.** After a crash or restart: reload the last checkpoint and
  replay inputs since, then continue at the next turn.
- **Browser hygiene.** Recycle the browser every N turns or when heap/RSS
  crosses a threshold; restore from checkpoint.
- **Provider resilience.** Backoff on rate limits/overload without consuming the
  turn budget; optional failover model per role (recorded, since it affects
  comparisons).
- **Budgets and stops.** Per-turn, per-run and per-campaign limits on tokens,
  cost, wall time and game time; hard stop with a report.
- **Heartbeat and health.** `campaign_status` shows turns/hour, cost/hour,
  stall score, last error; optional push/Slack/email notifications on
  milestones, findings and stalls.

---

## 12. Charter: objective types

```yaml
charter: 1
game: tome
objectives:
  - id: O1
    kind: complete          # complete | score | explore | regress | compare
    text: "Win a game in Normal mode as a Hobbit Burglar."
    success: { adapter: "status == 'won'" }
  - id: O2
    kind: explore
    text: "Find UI bugs and quirks on phone portrait and landscape."
    focus: [inventory, character sheet, shops, settings]
constraints:
  - "Do not use wizard/debug mode."
  - "Do not change Settings → Difficulty."
fair_play:
  observation: player-view   # player-view | adapter | omniscient
  inspect: false
  reflex_controllers: false
time_mode: stepped
devices: [pixel-7, pixel-7-landscape]
budgets: { cost_usd: 50, wall_hours: 48, turns_per_run: 3000 }
stop: { when: "O1 met or budget", min_runs: 3 }
roles:
  player: claude-opus-5-5
  auditor: claude-haiku-5-5
  archivist: claude-sonnet-5-5
  reflector: claude-opus-5-5
```

Templates ship for: *play to the end*, *maximise score*, *explore for bugs*,
*regression path*, *model vs model* (same charter, same seeds, swapped sides).

---

## 13. Safety and integrity

- **Allowed hosts** per game; the browser blocks everything else (no wandering
  off to other sites, no data exfiltration).
- **No credentials**: we don't log in anywhere unless a game profile supplies a
  test account.
- **Fair play enforced by the harness**, not by trust (as in Battle Drones):
  in `player-view`, `inspect` and omniscient adapter fields are not exposed at
  all.
- **Game text is untrusted** (§6.2): labelled and quoted, never an instruction.
- **Loopback + token** for the HTTP transport; control tools that change state
  require the control token.

---

## 14. Tech stack (rec.)

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript on Node ≥ 22 | Playwright and the MCP SDK are native here; both example games are TS. |
| Browser | Playwright (Chromium default; WebKit/Firefox for QA sweeps) | Clock API, devices, tracing, a11y snapshots. |
| MCP | `@modelcontextprotocol/sdk` (stdio + Streamable HTTP) | Official. |
| Models | Thin `fetch` adapters per provider (Anthropic Messages, OpenAI Responses, Gemini, OpenAI-compatible) | Few dependencies; local models work offline. |
| Validation | `zod` | Shared with MCP SDK. |
| Store | `node:sqlite` + files | Built in. |
| UI | Static dashboard served by the engine (status, live frame, findings, run timeline) | Optional; MCP control tools come first. |

No packages are installed until the stack is agreed.

---

## 15. Phased roadmap

| Phase | Deliverable | Done when |
|---|---|---|
| **P0 — Play server** | `game-r-play`: session, observe (text + a11y + screenshot/grid), act, advance, stepped clock, error/network oracles, checkpoints | Claude Code, mounting only this server, plays ToME's first dungeon level and a Battle Drones skirmish menu flow locally |
| **P1 — Director** | Turn loop, context assembly, memory server (charter, plan, KB, notes), Auditor, stall detector, budgets, event log, resume | An unattended 8-hour run with flat per-turn tokens and no orphan goals |
| **P2 — Campaigns** | Runs, Reflector, lessons with utility, skills (macro/cached), coverage, findings pipeline with verify + minimise, reports | Run *n+1* measurably beats run *n* on a score objective; a seeded bug is found, verified and minimised |
| **P3 — Adapters and scale** | ToME and Battle Drones adapters, adapter bootstrap, reflex controllers, device sweeps, model comparisons, dashboard | Multi-day campaign on each game; model-vs-model report |

---

## 16. Open questions

1. **Who drives long runs?** Director (own loop over model APIs, rec.), client
   mode (Claude Code plays via MCP), or both?
2. **Models and providers** to support first, and is there a per-campaign cost
   ceiling you have in mind?
3. **Where long runs live** — your Mac, a cloud VM, CI? Headless only, or a
   watchable headed browser too?
4. **Game modification** — may we add/extend adapter hooks in ToME (yours)?
   Battle Drones is simonw's: treat as black-box, or use its arena seat API?
5. **Fair play default** — `player-view` (honest, comparable) vs
   `adapter`/`omniscient` (stronger, better for QA)?
6. **Time** — is `stepped` (game frozen while the model thinks) acceptable as the
   default for score objectives on real-time games, or do you want a
   human-equivalent `realtime` baseline as well?
7. **Findings output** — local reports only, or file GitHub issues on the game
   repo (with your approval per issue)?
8. **Human in the loop** — live dashboard and `campaign_steer`, or fully
   autonomous with notifications?
9. **Language** — TypeScript (rec.) or Python (closer to `llm`, which Battle
   Drones uses)?

---

## Sources

- Battle Drones, [`AGENT-BATTLES.md`](https://github.com/simonw/battledrones/blob/main/AGENT-BATTLES.md)
- ToME, [`AGENTS.md`](https://github.com/darrencroton/tales-of-middle-earth/blob/main/AGENTS.md) (`window.__tome`)
- Anthropic, [Harnessing Claude's intelligence](https://claude.com/blog/harnessing-claudes-intelligence)
- [Claude Plays Pokémon write-up (Latent Space)](https://latent.space/reading/claude-plays-pokemon/); [ZenML summary](https://www.zenml.io/llmops-database/building-and-deploying-a-pokemon-playing-llm-agent-at-anthropic); [Michael Liu's notes](https://michaelyliu6.github.io/posts/claude-plays-pokemon)
- [Continual Harness (arXiv 2605.09998)](https://arxiv.org/html/2605.09998v1); [D. Breunig on Gemini Plays Pokémon](https://www.dbreunig.com/2025/06/17/an-agentic-case-study-playing-pokémon-with-gemini.html)
- [Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [lmgame-Bench (ICLR 2026)](https://arxiv.org/html/2505.15146v2)
- [Leveraging LLM Agents for Automated Video Game Testing](https://arxiv.org/pdf/2509.22170)
- [Evaluating Goal Drift in LM Agents](https://arxiv.org/pdf/2505.02709); [Drift No More?](https://arxiv.org/html/2510.07777v2)
- [Bug0 cached Playwright replays (InfoQ)](https://www.infoq.com/news/2026/10/bug0-agent-testing-cached-replay/)
- Voyager (Wang et al., 2023); Reflexion (Shinn et al., 2023); ExpeL (Zhao et al., 2023)
