# game-r

An engine where LLMs play and test HTML web games. Point it at a URL, give it
instructions — play to the end, hunt for UI bugs, beat a high score — and it
plays in a real browser, keeps its own notes, and learns from run to run.

Design: [`docs/MCP-DESIGN.md`](docs/MCP-DESIGN.md).

> Status: step 1 of 4. The game tools and the MCP server work; the engine's own
> model loop (`game-r run`) is next.

## Requirements

- Node.js ≥ 22.18 (runs the TypeScript sources directly)
- Playwright's Chromium: `npx playwright install chromium` (once)

```zsh
npm install
npm test
```

## Configure

Everything lives in [`game-r.yaml`](game-r.yaml): `defaults` for every
campaign, then named campaigns that override what they need. A campaign needs
only a `url` and `instructions`.

```zsh
node src/cli.ts list              # campaigns in game-r.yaml
node src/cli.ts config tome-ui    # a campaign's resolved settings
node src/cli.ts status            # status of every campaign
```

## Play through MCP (Claude Code or any MCP client)

```zsh
claude mcp add game-r -- node "$PWD/src/cli.ts" mcp tome-ui --config "$PWD/game-r.yaml"
```

The server's instructions carry the framework prompt and the campaign's
instructions; ask the client to follow them. Tools: `look`, `read_page`, `act`,
`console`, `clock`, `browser`, `files`, `status`, `notify`, `end_run` (and
`evaluate` with `access: developer`).

## Output

Each campaign writes to `runs/<campaign>/`: `memory/` (the agent's notes,
kept across runs), `run-NNN/` (transcript, every screenshot, whatever the agent
writes there), `status.json` and the browser profile. Campaigns run side by
side; one campaign runs in one process at a time.
