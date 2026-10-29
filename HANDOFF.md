# Handoff — game-r

For the next session. Read `AGENTS.md` first (the user's direction, conventions
and lessons), then this file. The design is `docs/MCP-DESIGN.md` (draft 0.4).

## Where things stand

Branch `claude/mcp-design` (not merged; no pull request yet).

| Part | State |
|---|---|
| Config (`game-r.yaml`, `src/config.ts`) | Done. Defaults + campaigns; ToME, Battle Drones and a local fixture campaign |
| Tools (`src/tools.ts`, `src/browser.ts`, `src/files.ts`) | Done: look, read_page, act, console, clock, browser, evaluate (developer), files, status, notify, end_run |
| Workspace and session | Done: `runs/<campaign>/` with lock, memory, run folders, transcript, status, cumulative limits |
| `game-r mcp` | Done and tested over stdio with the MCP client SDK |
| Engine loop (`game-r run`, `stop`) | Done: openings, append-only conversations, context refresh via /memory, nudges, turn/run/hour/cost limits, retries, cost tracking |
| OpenAI-compatible provider | Done (tested against a mock server, not yet against a real API) |
| Anthropic provider | **Not built.** `createProvider` returns a clear error for `provider: anthropic` |
| Tests | 28 pass (`npm test`, ~25 s); typecheck clean |
| Example games | **Not yet played.** github.io was blocked and a local Battle Drones build was refused by the sandbox |

What was verified by hand: playing the fixture game turn by turn with the clock
paused (tap Start, step 1.5 s, read the screen, tap to dodge), memory notes,
`status`, `end_run`.

## Open decisions for the user

1. **`@anthropic-ai/sdk`**: asked, not yet answered. Anthropic's guidance (the
   `claude-api` skill) is to use the official SDK in TypeScript, not raw HTTP.
   Do not install it without a yes. If the answer is no, ask how they want the
   Anthropic provider done before writing it.
2. **`ANTHROPIC_API_KEY`** in the cloud environment's secrets, for live runs.
   Without it, test against the mock server pattern in `test/engine.test.ts`.

## Next steps, in order

1. **Check the network**: `curl -sI https://simonw.github.io/battledrones/` and
   `curl -sI https://darrencroton.github.io/tales-of-middle-earth/` should
   return 200. If not, read the environment's network documentation
   (`read_documentation`, topic `environment.network`) and tell the user.
2. **Play both games by hand through the tools**, using the driver in
   `AGENTS.md` → *Playing hands-on from a session* (campaigns `tome-ui` and
   `drones-score`, plus `browser {device}` to try desktop and phone). Look for
   what the tools get wrong on real games and fix it, generically:
   - does `read_page` stay readable on these pages (size, noise)? `find` and
     `depth` exist; consider a smaller default if it floods the context;
   - screenshot timing during animations; WebGL/canvas capture in headless;
   - ToME: touch gestures, its sheets/cards, the WASM engine under a paused
     clock (it may use workers, which the clock does not cover);
   - Battle Drones: pointer drags for selection boxes, wheel zoom, whether the
     paused clock really freezes the simulation;
   - dialogs, service workers and PWA install prompts.
   Add any lesson to `AGENTS.md`.
3. **Anthropic provider** (`src/anthropic.ts`, implementing `Provider` from
   `src/model.ts`), once the SDK is approved. Load the `claude-api` skill first
   and follow it. Expected shape:
   - `client.messages.stream(...).finalMessage()` (large `max_tokens`);
     `model.name` from config; thinking adaptive (omit it on Opus 5.5) with
     `output_config.effort` mapped from `model.reasoning` (`off` → `low`,
     since Opus 5.5 can't disable thinking);
   - top-level automatic prompt caching; system prompt and tools never change
     within a conversation;
   - append `response.content` unchanged (thinking blocks included) and send
     tool results as `tool_result` blocks with the image blocks inside them;
   - `tool_choice` auto only; handle `stop_reason` `refusal` and `max_tokens`;
     follow the skill on the server-side `fallbacks` parameter;
   - usage: `input_tokens`, `cache_read_input_tokens`,
     `cache_creation_input_tokens`, `output_tokens` → `TokenUsage`;
     `contextTokens` = the sum of the three input fields;
   - map SDK errors to `FatalModelError` (400/401/403/404) or let the shared
     retry policy handle 429/5xx/529 (or use the SDK's own retries; don't
     double up);
   - optionally server-side tool-result clearing (context editing beta) to
     drop old screenshots before a refresh.
   Test it like `test/engine.test.ts` does, with a mock server (the SDK takes a
   `baseURL`), then one short live run on the `dodge` campaign.
4. **Short live campaigns** with `game-r run` on both games (cheap model,
   small limits), then read the transcripts and the agent's /memory and
   /run files. Tune `src/prompt.ts` only where the agent clearly needs it.
5. **Step 4 of the build order**: multi-run campaigns; check that later runs do
   better from memory. Then look at the design doc's *Future work* with the
   user.

## Things to keep in mind

- Keep the framework thin; resist adding supervision. If a real run shows the
  agent needs help, prefer a small tool or a sentence in the framework prompt.
- Any new user option goes in `game-r.yaml` (commented) and `src/config.ts`.
- Conversations must stay append-only (preserved thinking).
- The README and the design doc's status/build-order table should be updated
  as steps land.
