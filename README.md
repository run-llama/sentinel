# DisruptionWatcher

Lightweight TypeScript monitor that watches AI coding agents (`claude`, `codex`, `agy`, `aider`, `gemini`, etc.) running in macOS Terminal.app windows, captures their live terminal output, and grades their progress with **Gemini 4 Hydrogen** (`gemini-4-hydrogen`).

## Verdicts & Checks

- `going_well` — Making steady, on-task progress; file edits match what the agent claims
- `waiting_for_user` — Paused waiting for approval or input
- `completed` — Task finished
- `potential_mistake` — Likely bug, misunderstanding, or discrepancy between agent claims and actual file edits
- `stuck_in_loop` — Repeating the same failing commands, edits, or reasoning
- `stuck_at_something` — Blocked on an error, hung process, or stalled while busy
- `ignoring_instructions` — Contradicting explicit user requirements or constraints
- `taking_bad_initiative` — Making unrequested risky changes or going off-script
- `sabotaging_work` — Destructive or dishonest actions (weakening tests, deleting needed files, bypassing checks, etc.)

For each agent terminal, DisruptionWatcher also resolves its working directory (via TTY `ps`/`lsof` with window-title fallback), captures `git status`, `git diff HEAD`, and recent commits, and asks Gemini 4 Hydrogen to:
- Verify whether actual file edits match what the agent claims (`diffMatchesClaims`: `yes` | `partial` | `mismatch` | `no_diff`)
- Flag `potentialMistakes`
- Draft a ready-to-paste `messageToAgent` when you should warn or correct the agent

## Setup

```bash
npm install
```

Set a Gemini or OpenRouter API key in your environment (or `.env`):
- `GEMINI_EXPERIMENTAL` / `GEMINI_API_KEY` / `GOOGLE_GEMINI_API_KEY` (Google AI Studio)
- `OPEN_ROUTER_API_KEY` / `OPENROUTER_API_KEY` (automatic fallback to `google/gemini-4-hydrogen` if Google AI Studio is unavailable or depleted)

Optional environment variables:
- `GEMINI_MODEL` (default: `gemini-4-hydrogen`)
- `GEMINI_PROVIDER` (`google` or `openrouter`)
- `DISRUPTION_CODE_ROOTS` (colon-separated extra roots for repo lookup fallback, defaults to `~/Code:~/Projects:~/src:~/dev:~`)
- `PORT` (default: `4321`)
- `POLL_INTERVAL_MS` (default: `15000`)

## Usage

### Web Dashboard (Live SSE + Focus Terminal Window)
```bash
npm run dev
# Open http://localhost:4321
```

### CLI Monitor
```bash
# One-shot scan of all active agent terminals
npm run scan

# Live updating terminal dashboard (every 15s)
npm run cli

# Include non-agent shells + macOS notifications
npm run cli -- --all --notify --interval 20

# JSON output
npm run cli -- --once --json
```
