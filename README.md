<p align="center">
  <img src="assets/sentinel-banner.jpg" alt="Sentinel — AI Agent Terminal Supervisor" width="100%" />
</p>

# Sentinel

**Real-time supervisor for AI coding agents running in your terminals.**

Sentinel watches AI coding agents (`claude`, `codex`, `agy`, `aider`, `gemini`, `opencode`, `cursor`) across your macOS Terminal.app windows, cross-checks their actual `git diff` against what they claim to be doing, and grades their work with **Gemini 4 Hydrogen** (`gemini-4-hydrogen`).

## What Sentinel Checks

- **Live terminal progress & verdicts:**
  - `going_well` — Steady, on-task progress; file edits match claims
  - `waiting_for_user` — Paused waiting for approval or next instruction
  - `completed` — Task finished cleanly
  - `potential_mistake` — Likely bug, misunderstanding, or discrepancy between claims and actual edits
  - `stuck_in_loop` — Repeating the same failing commands, edits, or reasoning
  - `stuck_at_something` — Blocked on an error, hung process, or stalled while busy
  - `ignoring_instructions` — Contradicting explicit user constraints visible in the terminal
  - `taking_bad_initiative` — Making unrequested risky changes or going off-script
  - `sabotaging_work` — Destructive or dishonest actions (weakening tests, deleting needed files, bypassing checks, etc.)
- **Git diff vs. agent claims verification:** Resolves each terminal's working directory (via TTY `ps`/`lsof` with window-title fallback), captures `git status`, `git diff HEAD`, and recent commits, and checks whether actual file changes match what the agent says (`yes` | `partial` | `mismatch` | `no_diff`).
- **Actionable nudges:** Flags concrete `potentialMistakes` and drafts a ready-to-paste `messageToAgent` when you should warn or redirect an agent.
- **Adjustable live watch & cost tracking:** Polls on an adjustable interval (default `30s`, live toggle & presets in the dashboard), skips unchanged screens/diffs to save API calls, and tracks total Gemini 4 Hydrogen USD cost and token usage live.

## Quick Start

```bash
npm install
```

Set a Gemini or OpenRouter API key in your environment (or `.env`):
- `GEMINI_EXPERIMENTAL` / `GEMINI_API_KEY` / `GOOGLE_GEMINI_API_KEY` (Google AI Studio)
- `OPEN_ROUTER_API_KEY` / `OPENROUTER_API_KEY` (automatic fallback to `google/gemini-4-hydrogen`)

Optional environment variables:
- `GEMINI_MODEL` (default: `gemini-4-hydrogen`)
- `GEMINI_PROVIDER` (`google` or `openrouter`)
- `DISRUPTION_CODE_ROOTS` (colon-separated extra roots for repo lookup fallback, defaults to `~/Code:~/Projects:~/src:~/dev:~`)
- `PORT` (default: `4321`)
- `POLL_INTERVAL_MS` (default: `30000`)

### Web Dashboard (Live SSE + Focus Terminal Window)

```bash
npm run dev
# Open http://localhost:4321
```

### CLI Monitor

```bash
# One-shot scan of all active agent terminals
npm run scan

# Live updating terminal dashboard (default every 30s)
npm run cli

# Include non-agent shells + macOS notifications
npm run cli -- --all --notify --interval 30

# JSON output
npm run cli -- --once --json
```

## License

Licensed under the [Apache License 2.0](LICENSE).
