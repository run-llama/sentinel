export type Verdict =
  | "going_well"
  | "waiting_for_user"
  | "completed"
  | "potential_mistake"
  | "stuck_in_loop"
  | "stuck_at_something"
  | "ignoring_instructions"
  | "taking_bad_initiative"
  | "sabotaging_work"
  | "unknown";

export type Severity = "ok" | "info" | "warning" | "critical";

export type LetterGrade = "A" | "B" | "C" | "D" | "F" | "-";

export type DiffMatchStatus = "yes" | "partial" | "mismatch" | "no_diff";

export type AgentType =
  | "claude"
  | "codex"
  | "agy"
  | "gemini"
  | "aider"
  | "opencode"
  | "cursor"
  | "shell"
  | "other";

export interface GitWorkspaceSnapshot {
  cwd: string;
  repoRoot: string;
  branch: string;
  statusShort: string;
  diffStat: string;
  diffSnippet: string;
  recentCommits: string;
  changedFileCount: number;
  gitHash: string;
}

export interface TerminalTabSnapshot {
  /** Stable key for a tab, e.g. "_dev_ttys011" */
  id: string;
  windowId: number;
  windowName: string;
  tabIndex: number;
  tty: string;
  busy: boolean;
  processes: string[];
  customTitle: string;
  /** Visible screen text from Terminal.app contents() */
  contents: string;
  /** Hash of normalized contents to detect changes */
  contentHash: string;
  detectedAgent: AgentType;
  isAgentSession: boolean;
  isSelf: boolean;
  capturedAt: string;
}

export interface ContentFrame {
  capturedAt: string;
  contentHash: string;
  contents: string;
}

export interface AnalysisResult {
  verdict: Verdict;
  severity: Severity;
  grade: LetterGrade;
  score: number;
  taskGoal: string;
  summary: string;
  evidence: string[];
  diffMatchesClaims: DiffMatchStatus;
  potentialMistakes: string[];
  messageToAgent: string;
  recommendation: string;
  model: string;
  analyzedAt: string;
  latencyMs: number;
}

export interface VerdictHistoryEntry {
  analyzedAt: string;
  verdict: Verdict;
  severity: Severity;
  grade: LetterGrade;
  score: number;
  diffMatchesClaims: DiffMatchStatus;
  summary: string;
}

export interface MonitoredTerminal {
  id: string;
  windowId: number;
  windowName: string;
  tabIndex: number;
  tty: string;
  busy: boolean;
  processes: string[];
  customTitle: string;
  detectedAgent: AgentType;
  isAgentSession: boolean;
  isSelf: boolean;
  lastCapturedAt: string;
  lastChangedAt: string;
  unchangedSeconds: number;
  latestContents: string;
  /** Rolling history of distinct screen frames */
  recentFrames: ContentFrame[];
  /** Actual git workspace state for verifying file changes against agent claims */
  git: GitWorkspaceSnapshot | null;
  analysis: AnalysisResult | null;
  analyzing: boolean;
  lastError: string | null;
  history: VerdictHistoryEntry[];
}

export interface WatcherConfig {
  pollIntervalMs: number;
  /** Re-analyze even if screen is unchanged after this many ms while busy */
  stallRecheckMs: number;
  includeAllTerminals: boolean;
  notifyOnBadVerdict: boolean;
  model: string;
  maxFramesPerTab: number;
}

export interface WatcherStateSnapshot {
  startedAt: string;
  lastPollAt: string | null;
  pollCount: number;
  isScanning: boolean;
  config: WatcherConfig;
  terminals: MonitoredTerminal[];
}
