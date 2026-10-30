# Handoff — game-r

For the next session. Read `AGENTS.md` first (the user's direction, conventions
and lessons), then this file. The design is `docs/MCP-DESIGN.md`.

---

## Instructions to human

Do these before starting the next cloud session. Each one is independent: skip
any you don't need yet.

All the settings below are in this environment's settings: the cloud
environment menu in the session's title bar, then **Edit**
([docs](https://code.claude.com/docs/en/cloud-environments#network-access)).

1. **Network access.** Under the *Limited* level, add these to *Allowed domains*
   (leave *Allow package managers* ticked):

   | Domain | Needed for |
   |---|---|
   | `*.github.io` | Both example games (ToME, Battle Drones) |
   | `opencode.ai` | OpenCode Go (its API) |
   | `chatgpt.com`, `auth.openai.com`, `api.openai.com` | Codex on your ChatGPT subscription (login and model calls) |
   | `developers.openai.com` | Optional: Codex documentation, so the session can check flags |

2. **Claude subscription.** Nothing to do for cloud sessions: a nested
   `claude -p` already runs on your subscription there (tested). On your Mac,
   `claude auth login` once. For unattended runs on another machine,
   `claude setup-token` gives a one-year token to set as
   `CLAUDE_CODE_OAUTH_TOKEN` there.

3. **Codex (ChatGPT subscription).**
   - Add `npm install -g @openai/codex` to the environment's **Setup script**,
     so new sessions have the `codex` command (or tell the next session it may
     install it).
   - Sign-in happens inside the session: ask Claude to run
     `codex login --device-auth`. It will give you a link and a code. Open the
     link on your phone or computer, sign in with ChatGPT and enter the code.
     If ChatGPT asks you to allow device-code sign-in for Codex, allow it.
     Each new cloud container needs this once.

4. **OpenCode Go.** Add your key as an environment variable named
   `OPENCODE_API_KEY` in the environment's settings. Don't paste it into the
   chat.

5. **Start the next session** on this repository (branch `main`) with:

   > Read HANDOFF.md and AGENTS.md, then work through "Next steps" with me:
   > first the hand-played tests, then fixes, then a live campaign.

---

## Where things stand

Merged to `main`. 34 tests pass (`npm test`, about 30 s); typecheck clean.

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

1. **Check access.** Run `curl -sI https://simonw.github.io/battledrones/`,
   `curl -sI https://darrencroton.github.io/tales-of-middle-earth/` and
   `curl -s https://opencode.ai/inference/go/v1/models -H "Authorization: Bearer $OPENCODE_API_KEY" | head`.
   Also `codex --version`, and `codex login --device-auth` if it isn't signed
   in (relay the link and code to the user). Report anything still blocked.

2. **Hand-played tests of the tools.** Use the driver in `AGENTS.md` →
   *Playing hands-on from a session*. Play `tome-ui` and `drones-score` a
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

## Things to keep in mind

- Keep the framework thin; resist adding supervision. If a real run shows the
  agent needs help, prefer a small tool or a sentence in the framework prompt.
- Any new user option goes in `game-r.yaml` (commented) and `src/config.ts`.
- Model conversations stay append-only (preserved thinking).
- Agent CLIs run on the user's subscriptions: never start one from tests (the
  test helper points agent CLIs at a non-existent command; keep it that way).
  Keep real checks tiny (Haiku, low effort, `hours: 0.03`) and say so.
- Update `README.md` and the design doc's build-order table as steps land.
