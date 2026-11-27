import { getDefaultModel } from "./analyzer.js";
import type { Severity, Verdict, WatcherStateSnapshot } from "./types.js";
import { DisruptionWatcher } from "./watcher.js";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
  bgGreen: "\x1b[42m",
  bgBlue: "\x1b[44m",
};

function severityColor(sev: Severity): string {
  switch (sev) {
    case "ok":
      return ANSI.green;
    case "info":
      return ANSI.cyan;
    case "warning":
      return ANSI.yellow;
    case "critical":
      return ANSI.red;
  }
}

function formatVerdict(v: Verdict): string {
  return v.replace(/_/g, " ").toUpperCase();
}

function parseArgs(argv: string[]) {
  let once = false;
  let all = false;
  let json = false;
  let notify = false;
  let intervalSec = 30;
  let model = getDefaultModel();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--once") once = true;
    else if (arg === "--all") all = true;
    else if (arg === "--json") json = true;
    else if (arg === "--notify") notify = true;
    else if (arg === "--interval" && argv[i + 1]) {
      intervalSec = Math.max(5, Number(argv[++i]) || 15);
    } else if (arg === "--model" && argv[i + 1]) {
      model = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(`DisruptionWatcher CLI

Usage:
  npm run cli -- [options]
  npm run scan

Options:
  --once            Run a single scan and exit
  --all             Include non-agent shell terminals
  --interval <sec>  Poll interval in seconds (default: 15)
  --notify          Send macOS notifications on warning/critical verdicts
  --model <name>    Gemini model name (default: ${getDefaultModel()})
  --json            Output raw JSON (best with --once)
`);
      process.exit(0);
    }
  }

  return { once, all, json, notify, intervalSec, model };
}

function renderSnapshot(state: WatcherStateSnapshot, clearScreen: boolean): void {
  if (clearScreen) {
    process.stdout.write("\x1b[2J\x1b[H");
  }

  const timeStr = state.lastPollAt
    ? new Date(state.lastPollAt).toLocaleTimeString()
    : "scanning...";
  const costStr = `$${state.cost.totalCostUsd.toFixed(4)}`;
  console.log(
    `${ANSI.bold}${ANSI.cyan}DisruptionWatcher${ANSI.reset}  ${ANSI.dim}model=${state.config.model}  poll=#${state.pollCount}  every=${Math.round(state.config.pollIntervalMs / 1000)}s  cost=${costStr} (${state.cost.totalCalls} calls)  updated=${timeStr}${state.isScanning ? " (scanning...)" : ""}${ANSI.reset}`
  );
  console.log(`${ANSI.dim}${"─".repeat(86)}${ANSI.reset}`);

  if (state.terminals.length === 0) {
    console.log(
      `${ANSI.dim}No matching Terminal.app agent windows found. Pass --all to include plain shells.${ANSI.reset}`
    );
    return;
  }

  for (const t of state.terminals) {
    const title =
      t.customTitle && t.customTitle !== "Terminal"
        ? t.customTitle
        : t.windowName;
    const agentTag = `${ANSI.magenta}[${t.detectedAgent}]${ANSI.reset}`;

    if (t.analyzing && !t.analysis) {
      console.log(
        `${agentTag} ${ANSI.bold}${title}${ANSI.reset}  ${ANSI.dim}(analyzing with ${state.config.model}...)${ANSI.reset}`
      );
      console.log("");
      continue;
    }

    if (t.lastError && !t.analysis) {
      console.log(
        `${agentTag} ${ANSI.bold}${title}${ANSI.reset}  ${ANSI.red}ERROR: ${t.lastError}${ANSI.reset}`
      );
      console.log("");
      continue;
    }

    const a = t.analysis;
    if (!a) continue;

    const col = severityColor(a.severity);
    const gradeStr = `${col}${ANSI.bold}[${a.grade} ${a.score}]${ANSI.reset}`;
    const verdictStr = `${col}${ANSI.bold}${formatVerdict(a.verdict)}${ANSI.reset}`;
    const diffBadge =
      a.diffMatchesClaims === "mismatch"
        ? ` ${ANSI.red}${ANSI.bold}[DIFF MISMATCH]${ANSI.reset}`
        : a.diffMatchesClaims === "partial"
        ? ` ${ANSI.yellow}[PARTIAL DIFF MATCH]${ANSI.reset}`
        : a.diffMatchesClaims === "yes"
        ? ` ${ANSI.green}[DIFF MATCHES]${ANSI.reset}`
        : "";
    const idleStr =
      t.unchangedSeconds > 0
        ? `${ANSI.dim}unchanged ${t.unchangedSeconds}s${ANSI.reset}`
        : `${ANSI.dim}active${ANSI.reset}`;

    console.log(`${gradeStr} ${verdictStr}${diffBadge}  ${agentTag} ${ANSI.bold}${title}${ANSI.reset}  ${idleStr}`);
    if (t.git) {
      console.log(
        `  ${ANSI.dim}Git:${ANSI.reset} ${t.git.branch} (${t.git.changedFileCount} changed files in ${t.git.repoRoot})`
      );
    }
    if (a.taskGoal) {
      console.log(`  ${ANSI.dim}Goal:${ANSI.reset} ${a.taskGoal}`);
    }
    console.log(`  ${a.summary}`);
    for (const ev of a.evidence.slice(0, 2)) {
      console.log(`  ${ANSI.dim}• ${ev}${ANSI.reset}`);
    }
    if (a.potentialMistakes.length > 0) {
      console.log(`  ${ANSI.yellow}${ANSI.bold}⚠ Potential mistakes:${ANSI.reset}`);
      for (const m of a.potentialMistakes) {
        console.log(`    ${ANSI.yellow}- ${m}${ANSI.reset}`);
      }
    }
    if (a.messageToAgent) {
      console.log(`  ${ANSI.magenta}${ANSI.bold}Tell agent:${ANSI.reset} "${a.messageToAgent}"`);
    }
    console.log(`  ${ANSI.cyan}→ ${a.recommendation}${ANSI.reset}`);
    if (t.lastError) {
      console.log(`  ${ANSI.red}Last error: ${t.lastError}${ANSI.reset}`);
    }
    console.log("");
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const watcher = new DisruptionWatcher({
    includeAllTerminals: opts.all,
    notifyOnBadVerdict: opts.notify,
    pollIntervalMs: opts.intervalSec * 1000,
    model: opts.model,
  });

  if (opts.once) {
    const state = await watcher.pollOnce(true);
    if (opts.json) {
      console.log(JSON.stringify(state, null, 2));
    } else {
      renderSnapshot(state, false);
    }
    return;
  }

  watcher.on("state", (state: WatcherStateSnapshot) => {
    if (!opts.json) {
      renderSnapshot(state, true);
    }
  });

  process.on("SIGINT", () => {
    watcher.stop();
    console.log("\nStopped DisruptionWatcher.");
    process.exit(0);
  });

  watcher.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
