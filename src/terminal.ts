import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { AgentType, TerminalTabSnapshot } from "./types.js";

const execFileAsync = promisify(execFile);

interface RawTabData {
  windowId: number;
  windowName: string;
  tabIndex: number;
  tty: string;
  busy: boolean;
  processes: string[];
  customTitle: string;
  contents: string;
}

const JXA_CAPTURE_SCRIPT = `
const term = Application("Terminal");
if (!term.running()) {
  JSON.stringify([]);
} else {
  const wins = term.windows();
  const out = [];
  for (let i = 0; i < wins.length; i++) {
    const w = wins[i];
    let winId = 0;
    let winName = "";
    try {
      winId = w.id();
      winName = String(w.name() || "");
    } catch (e) {
      continue;
    }
    let tabs = [];
    try {
      tabs = w.tabs();
    } catch (e) {
      continue;
    }
    for (let j = 0; j < tabs.length; j++) {
      const t = tabs[j];
      try {
        out.push({
          windowId: winId,
          windowName: winName,
          tabIndex: j + 1,
          tty: String(t.tty() || ""),
          busy: Boolean(t.busy()),
          processes: (t.processes() || []).map(String),
          customTitle: String(t.customTitle() || ""),
          contents: String(t.contents() || "")
        });
      } catch (e) {
        // Tab closed mid-iteration
      }
    }
  }
  JSON.stringify(out);
}
`;

function normalizeTerminalText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hashContent(text: string): string {
  // Strip volatile spinner/timer fragments so minor clock ticks don't spam API calls
  const stabilized = text
    .replace(/\b\d+m\s*\d+s\b/g, "<TIME>")
    .replace(/\(\d+[smh]\)/g, "(<TIME>)")
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✳✶✻✽✢·]/g, "");
  return createHash("sha1").update(stabilized).digest("hex").slice(0, 12);
}

const AGENT_PATTERNS: Array<{ type: AgentType; regex: RegExp }> = [
  { type: "claude", regex: /\bclaude\b/i },
  { type: "codex", regex: /\bcodex\b/i },
  { type: "agy", regex: /\bagy\b|antigravity/i },
  { type: "gemini", regex: /\bgemini\b/i },
  { type: "aider", regex: /\baider\b/i },
  { type: "opencode", regex: /\bopencode\b/i },
  { type: "cursor", regex: /\bcursor(-agent)?\b/i },
];

export function detectAgent(
  processes: string[],
  windowName: string,
  customTitle: string,
  contents: string,
  busy: boolean
): { detectedAgent: AgentType; isAgentSession: boolean } {
  const procStr = processes.join(" ");
  const metaStr = `${procStr} ${windowName} ${customTitle}`;

  for (const { type, regex } of AGENT_PATTERNS) {
    if (regex.test(metaStr)) {
      return { detectedAgent: type, isAgentSession: true };
    }
  }

  const nonShell = processes.filter(
    (p) => !/^(login|-?zsh|-?bash|-?sh|-?fish)$/i.test(p)
  );

  // Fallback: look for well-known TUI signatures only when a process is active
  if (busy || nonShell.length > 0) {
    const tail = contents.slice(-600);
    if (/auto mode on|shift\+tab to cycle|claude code/i.test(tail)) {
      return { detectedAgent: "claude", isAgentSession: true };
    }
    if (/← for agents|codex|f2 to view/i.test(tail)) {
      return { detectedAgent: "codex", isAgentSession: true };
    }
    if (/esc to cancel.*gemini/i.test(tail)) {
      return { detectedAgent: "agy", isAgentSession: true };
    }
  }

  if (nonShell.length === 0) {
    return { detectedAgent: "shell", isAgentSession: false };
  }
  return { detectedAgent: "other", isAgentSession: false };
}

function isSelfTerminal(raw: RawTabData): boolean {
  const haystack = `${raw.windowName} ${raw.customTitle} ${raw.processes.join(" ")}`;
  if (/disruptionWatcher|disruption-watcher/i.test(haystack)) {
    return true;
  }
  if (process.env.SSH_TTY && raw.tty === process.env.SSH_TTY) {
    return true;
  }
  return false;
}

export async function captureTerminalTabs(): Promise<TerminalTabSnapshot[]> {
  const { stdout } = await execFileAsync(
    "osascript",
    ["-l", "JavaScript", "-e", JXA_CAPTURE_SCRIPT],
    { maxBuffer: 10 * 1024 * 1024, timeout: 15_000 }
  );

  const rawTabs = JSON.parse(stdout.trim() || "[]") as RawTabData[];
  const now = new Date().toISOString();

  return rawTabs.map((raw) => {
    const contents = normalizeTerminalText(raw.contents);
    const { detectedAgent, isAgentSession } = detectAgent(
      raw.processes,
      raw.windowName,
      raw.customTitle,
      contents,
      raw.busy
    );
    const id = raw.tty
      ? raw.tty.replace(/[^a-zA-Z0-9_-]/g, "_")
      : `win-${raw.windowId}-tab-${raw.tabIndex}`;

    return {
      id,
      windowId: raw.windowId,
      windowName: raw.windowName,
      tabIndex: raw.tabIndex,
      tty: raw.tty,
      busy: raw.busy,
      processes: raw.processes,
      customTitle: raw.customTitle,
      contents,
      contentHash: hashContent(contents),
      detectedAgent,
      isAgentSession,
      isSelf: isSelfTerminal(raw),
      capturedAt: now,
    };
  });
}

export async function focusTerminalTab(
  windowId: number,
  tabIndex: number
): Promise<boolean> {
  const script = `
const term = Application("Terminal");
term.activate();
const wins = term.windows();
let found = false;
for (let i = 0; i < wins.length; i++) {
  const w = wins[i];
  if (w.id() === ${Number(windowId)}) {
    w.index = 1;
    const tabs = w.tabs();
    const idx = ${Math.max(0, Number(tabIndex) - 1)};
    if (tabs[idx]) {
      tabs[idx].selected = true;
    }
    found = true;
    break;
  }
}
String(found);
`;
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-l",
      "JavaScript",
      "-e",
      script,
    ]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function sendMacNotification(
  title: string,
  subtitle: string,
  message: string
): Promise<void> {
  const esc = (s: string) =>
    s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ").slice(0, 200);
  const script = `display notification "${esc(message)}" with title "${esc(title)}" subtitle "${esc(subtitle)}"`;
  try {
    await execFileAsync("osascript", ["-e", script], { timeout: 5_000 });
  } catch {
    // Non-fatal if notifications are blocked
  }
}
