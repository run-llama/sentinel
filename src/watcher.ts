import { EventEmitter } from "node:events";
import { analyzeTerminalWithGemini, getDefaultModel } from "./analyzer.js";
import { captureGitWorkspace } from "./git.js";
import { captureTerminalTabs, sendMacNotification } from "./terminal.js";
import type {
  GitWorkspaceSnapshot,
  MonitoredTerminal,
  Severity,
  TerminalTabSnapshot,
  WatcherConfig,
  WatcherStateSnapshot,
} from "./types.js";

const DEFAULT_CONFIG: WatcherConfig = {
  pollIntervalMs: 15_000,
  stallRecheckMs: 120_000,
  includeAllTerminals: false,
  notifyOnBadVerdict: true,
  model: getDefaultModel(),
  maxFramesPerTab: 6,
};

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  ok: 3,
};

export class DisruptionWatcher extends EventEmitter {
  private config: WatcherConfig;
  private terminals = new Map<string, MonitoredTerminal>();
  private lastAnalyzedHash = new Map<string, string>();
  private startedAt = new Date().toISOString();
  private lastPollAt: string | null = null;
  private pollCount = 0;
  private isScanning = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(partialConfig: Partial<WatcherConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...partialConfig };
  }

  public getConfig(): WatcherConfig {
    return { ...this.config };
  }

  public updateConfig(patch: Partial<WatcherConfig>): WatcherConfig {
    const prevInterval = this.config.pollIntervalMs;
    this.config = { ...this.config, ...patch };
    if (this.timer && patch.pollIntervalMs && patch.pollIntervalMs !== prevInterval) {
      this.stop();
      this.start();
    }
    this.emitState();
    return this.getConfig();
  }

  public getSnapshot(): WatcherStateSnapshot {
    const list = Array.from(this.terminals.values())
      .filter((t) => !t.isSelf)
      .filter((t) => this.config.includeAllTerminals || t.isAgentSession)
      .sort((a, b) => {
        const sevA = a.analysis ? SEVERITY_ORDER[a.analysis.severity] : 2;
        const sevB = b.analysis ? SEVERITY_ORDER[b.analysis.severity] : 2;
        if (sevA !== sevB) return sevA - sevB;
        if (a.isAgentSession !== b.isAgentSession) {
          return a.isAgentSession ? -1 : 1;
        }
        return a.windowName.localeCompare(b.windowName);
      });

    return {
      startedAt: this.startedAt,
      lastPollAt: this.lastPollAt,
      pollCount: this.pollCount,
      isScanning: this.isScanning,
      config: this.getConfig(),
      terminals: list,
    };
  }

  public start(): void {
    if (this.timer) return;
    void this.pollOnce(false);
    this.timer = setInterval(() => {
      void this.pollOnce(false);
    }, this.config.pollIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private mergeSnapshot(
    snap: TerminalTabSnapshot,
    git: GitWorkspaceSnapshot | null
  ): MonitoredTerminal {
    const existing = this.terminals.get(snap.id);
    const nowMs = Date.parse(snap.capturedAt);

    if (!existing) {
      const created: MonitoredTerminal = {
        id: snap.id,
        windowId: snap.windowId,
        windowName: snap.windowName,
        tabIndex: snap.tabIndex,
        tty: snap.tty,
        busy: snap.busy,
        processes: snap.processes,
        customTitle: snap.customTitle,
        detectedAgent: snap.detectedAgent,
        isAgentSession: snap.isAgentSession,
        isSelf: snap.isSelf,
        lastCapturedAt: snap.capturedAt,
        lastChangedAt: snap.capturedAt,
        unchangedSeconds: 0,
        latestContents: snap.contents,
        recentFrames: [
          {
            capturedAt: snap.capturedAt,
            contentHash: snap.contentHash,
            contents: snap.contents,
          },
        ],
        git,
        analysis: null,
        analyzing: false,
        lastError: null,
        history: [],
      };
      this.terminals.set(snap.id, created);
      return created;
    }

    const lastFrame = existing.recentFrames[existing.recentFrames.length - 1];
    const screenChanged = !lastFrame || lastFrame.contentHash !== snap.contentHash;
    const gitChanged = (existing.git?.gitHash || "") !== (git?.gitHash || "");

    existing.windowId = snap.windowId;
    existing.windowName = snap.windowName;
    existing.tabIndex = snap.tabIndex;
    existing.tty = snap.tty;
    existing.busy = snap.busy;
    existing.processes = snap.processes;
    existing.customTitle = snap.customTitle;
    existing.detectedAgent = snap.detectedAgent;
    existing.isAgentSession = snap.isAgentSession;
    existing.isSelf = snap.isSelf;
    existing.lastCapturedAt = snap.capturedAt;
    existing.latestContents = snap.contents;
    existing.git = git;

    if (screenChanged || gitChanged) {
      existing.lastChangedAt = snap.capturedAt;
      existing.unchangedSeconds = 0;
      if (screenChanged) {
        existing.recentFrames.push({
          capturedAt: snap.capturedAt,
          contentHash: snap.contentHash,
          contents: snap.contents,
        });
        if (existing.recentFrames.length > this.config.maxFramesPerTab) {
          existing.recentFrames = existing.recentFrames.slice(
            -this.config.maxFramesPerTab
          );
        }
      }
    } else {
      const changedMs = Date.parse(existing.lastChangedAt);
      existing.unchangedSeconds = Math.max(
        0,
        Math.round((nowMs - changedMs) / 1000)
      );
    }

    return existing;
  }

  private combinedHash(term: MonitoredTerminal): string {
    const frameHash =
      term.recentFrames[term.recentFrames.length - 1]?.contentHash ?? "";
    const gitHash = term.git?.gitHash ?? "";
    return `${frameHash}:${gitHash}`;
  }

  private shouldAnalyze(term: MonitoredTerminal, forceAll: boolean): boolean {
    if (term.isSelf) return false;
    if (!this.config.includeAllTerminals && !term.isAgentSession) return false;
    if (term.analyzing) return false;
    if (forceAll) return true;
    if (!term.analysis) return true;

    const prevHash = this.lastAnalyzedHash.get(term.id);
    if (this.combinedHash(term) !== prevHash) {
      return true;
    }

    // If terminal is busy and unchanged for longer than stallRecheckMs, re-evaluate
    if (term.busy && term.unchangedSeconds * 1000 >= this.config.stallRecheckMs) {
      const lastAnalyzedMs = Date.parse(term.analysis.analyzedAt);
      if (Date.now() - lastAnalyzedMs >= this.config.stallRecheckMs) {
        return true;
      }
    }

    return false;
  }

  public async analyzeOne(id: string): Promise<MonitoredTerminal | null> {
    const term = this.terminals.get(id);
    if (!term) return null;
    await this.runAnalysis(term);
    return term;
  }

  private async runAnalysis(term: MonitoredTerminal): Promise<void> {
    if (term.analyzing) return;
    term.analyzing = true;
    term.lastError = null;
    this.emitState();

    const prevVerdict = term.analysis?.verdict;
    const latestHash = this.combinedHash(term);

    try {
      const result = await analyzeTerminalWithGemini(term, this.config.model);
      term.analysis = result;
      term.lastError = null;
      this.lastAnalyzedHash.set(term.id, latestHash);

      term.history.unshift({
        analyzedAt: result.analyzedAt,
        verdict: result.verdict,
        severity: result.severity,
        grade: result.grade,
        score: result.score,
        diffMatchesClaims: result.diffMatchesClaims,
        summary: result.summary,
      });
      if (term.history.length > 20) {
        term.history = term.history.slice(0, 20);
      }

      const isBad =
        result.severity === "critical" ||
        result.severity === "warning" ||
        result.diffMatchesClaims === "mismatch" ||
        result.potentialMistakes.length > 0;
      if (
        this.config.notifyOnBadVerdict &&
        isBad &&
        prevVerdict !== result.verdict
      ) {
        void sendMacNotification(
          `DisruptionWatcher: ${result.verdict.replace(/_/g, " ")}`,
          `${term.detectedAgent.toUpperCase()} · ${term.customTitle || term.windowName}`,
          result.potentialMistakes[0] || result.summary
        );
      }
    } catch (err) {
      term.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      term.analyzing = false;
      this.emitState();
    }
  }

  public async pollOnce(forceAnalyze = false): Promise<WatcherStateSnapshot> {
    if (this.isScanning && !forceAnalyze) {
      return this.getSnapshot();
    }
    this.isScanning = true;
    this.emitState();

    try {
      const tabs = await captureTerminalTabs();
      const seenIds = new Set<string>();

      const gitSnapshots = await Promise.all(
        tabs.map((tab) =>
          tab.isSelf || (!this.config.includeAllTerminals && !tab.isAgentSession)
            ? Promise.resolve(null)
            : captureGitWorkspace(tab.tty, tab.windowName)
        )
      );

      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        seenIds.add(tab.id);
        this.mergeSnapshot(tab, gitSnapshots[i]);
      }

      // Remove closed tabs
      for (const id of Array.from(this.terminals.keys())) {
        if (!seenIds.has(id)) {
          this.terminals.delete(id);
          this.lastAnalyzedHash.delete(id);
        }
      }

      this.lastPollAt = new Date().toISOString();
      this.pollCount += 1;
      this.emitState();

      const targets = Array.from(this.terminals.values()).filter((t) =>
        this.shouldAnalyze(t, forceAnalyze)
      );

      // Run with bounded concurrency of 4
      const concurrency = 4;
      let idx = 0;
      const workers = Array.from(
        { length: Math.min(concurrency, targets.length) },
        async () => {
          while (idx < targets.length) {
            const current = targets[idx++];
            await this.runAnalysis(current);
          }
        }
      );
      await Promise.all(workers);
    } finally {
      this.isScanning = false;
      this.emitState();
    }

    return this.getSnapshot();
  }

  private emitState(): void {
    this.emit("state", this.getSnapshot());
  }
}
