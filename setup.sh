#!/usr/bin/env bash
# game-r setup: installs dependencies and the browser, creates .env, checks the players, runs the tests.
# Safe to run again at any time. Usage: ./setup.sh [--skip-tests]
set -uo pipefail
cd "$(dirname "$0")" || exit 1

ok()   { printf '  \033[32m✔\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✘\033[0m %s\n' "$1"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

step "Node.js"
command -v node >/dev/null || fail "Node.js not found. Install Node 22.18 or newer (https://nodejs.org or 'brew install node')."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a===22&&b>=18)||(a===23&&b>=6)||a>23?0:1)' \
  || fail "Node $(node --version) can't run TypeScript directly: game-r needs 22.18+ or 23.6+."
ok "Node $(node --version)"

step "Dependencies"
if [ -f node_modules/.package-lock.json ] && [ ! package-lock.json -nt node_modules/.package-lock.json ] && npm ls --all >/dev/null 2>&1; then
  ok "npm packages up to date"
else
  npm ci --no-fund --no-audit >/dev/null || fail "npm ci failed (run it by hand to see why)."
  ok "npm packages installed from package-lock.json"
fi

step "Browser"
launch='import("playwright").then(async (p) => { await (await p.chromium.launch()).close(); })'
if node -e "$launch" >/dev/null 2>&1; then
  ok "Chromium launches"
elif [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
  fail "Chromium won't launch from the preinstalled PLAYWRIGHT_BROWSERS_PATH ($PLAYWRIGHT_BROWSERS_PATH); not installing over it. Is playwright still pinned to the version those browsers match?"
else
  npx playwright install chromium || fail "Could not install Playwright's Chromium."
  node -e "$launch" || fail "Chromium was installed but won't launch."
  ok "Chromium installed"
fi

step "Secrets"
if [ -f .env ]; then
  ok ".env exists"
  [ -z "$(find .env \( -perm -040 -o -perm -004 \) 2>/dev/null)" ] \
    || warn ".env is readable by other users: chmod 600 .env"
else
  (umask 077 && cp .env.example .env) || fail "Could not create .env from .env.example."
  ok "Created .env from .env.example: add API keys there (it is gitignored)"
fi

step "Players (at least one is needed)"
if command -v claude >/dev/null; then
  auth=$(claude auth status 2>/dev/null)
  if [[ "$auth" == *'"loggedIn": true'* ]]; then ok "Claude Code signed in (provider: claude-code)"
  else warn "Claude Code installed but not signed in: run 'claude auth login'"; fi
else
  warn "Claude Code not found (provider: claude-code): see https://code.claude.com/docs"
fi
if command -v codex >/dev/null; then
  if codex login status >/dev/null 2>&1; then ok "Codex signed in (provider: codex)"
  else warn "Codex installed but not signed in: run 'codex login' (or 'codex login --device-auth' on a headless machine)"; fi
else
  warn "Codex not found (provider: codex): 'npm install -g @openai/codex'"
fi
if node --input-type=module -e "import { apiKey } from './src/model.ts'; apiKey({ api_key_env: 'OPENCODE_API_KEY', secrets_file: '.env' })" >/dev/null 2>&1; then ok "OPENCODE_API_KEY set (provider: openai-compatible, OpenCode Go)"
else warn "No OPENCODE_API_KEY in .env (only needed for OpenCode Go campaigns such as dodge-go)"; fi

step "Config"
notify=$(node --input-type=module -e "
  import { listCampaigns, loadConfig } from './src/config.ts';
  for (const name of await listCampaigns('game-r.yaml')) await loadConfig('game-r.yaml', name);
  const [first] = await listCampaigns('game-r.yaml');
  console.log(first ? (await loadConfig('game-r.yaml', first)).notify.command ?? '' : '');
") || fail "game-r.yaml (or game-r.local.yaml) is invalid (see the error above)."
ok "game-r.yaml is valid$( [ -f game-r.local.yaml ] && echo ', with game-r.local.yaml merged over it')"
if [ -z "$notify" ]; then
  warn "notify.command is not set: notifications are only logged (set yours in game-r.local.yaml)"
elif command -v "${notify%% *}" >/dev/null; then
  ok "notify.command: $notify"
else
  warn "notify.command uses '${notify%% *}', which is not on PATH: change notify.command (in game-r.local.yaml)"
fi

if [ "${1:-}" != "--skip-tests" ]; then
  step "Checks"
  npx tsc --noEmit || fail "Typecheck failed."
  ok "Typecheck clean"
  npm test >/dev/null 2>&1 || fail "Tests failed: run 'npm test' to see which."
  ok "Tests pass"
fi

printf '\nReady. Try: node src/cli.ts run dodge   (a short run on the bundled test game, on Claude Code with Haiku)\n'
