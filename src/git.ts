import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitWorkspaceSnapshot } from "./types.js";

const execFileAsync = promisify(execFile);

async function runQuiet(
  cmd: string,
  args: string[],
  cwd?: string,
  timeout = 4_000
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Resolve the working directory of a Terminal tab from its TTY via ps + lsof.
 */
async function resolveCwdFromTty(tty: string): Promise<string | null> {
  if (!tty) return null;
  const shortTty = tty.replace(/^\/dev\/tty/, "").replace(/^\/dev\//, "");
  if (!shortTty) return null;

  const psOut = await runQuiet("ps", ["-t", shortTty, "-o", "pid="]);
  if (!psOut) return null;

  const pids = psOut
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
  if (pids.length === 0) return null;

  const lsofOut = await runQuiet("lsof", [
    "-a",
    "-d",
    "cwd",
    "-p",
    pids.join(","),
    "-Fn",
  ]);
  if (!lsofOut) return null;

  // Prefer the deepest/most recent non-root directory
  const dirs = lsofOut
    .split("\n")
    .filter((line) => line.startsWith("n/"))
    .map((line) => line.slice(1).trim())
    .filter((d) => d.length > 1 && existsSync(d));

  if (dirs.length === 0) return null;
  return dirs[dirs.length - 1];
}

/**
 * Fallback: infer project directory from the Apple Terminal window title prefix
 * (e.g. "trice — ..." -> ~/Code/trice).
 */
function resolveCwdFromWindowName(windowName: string): string | null {
  const firstSegment = windowName.split("—")[0]?.trim();
  if (!firstSegment || firstSegment.includes("/") || firstSegment === "~") {
    return null;
  }

  const home = homedir();
  const extraRoots = (process.env.DISRUPTION_CODE_ROOTS || "")
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);

  const roots = [
    ...extraRoots,
    join(home, "Code"),
    join(home, "Projects"),
    join(home, "src"),
    join(home, "dev"),
    home,
  ];

  for (const root of roots) {
    const candidate = join(root, firstSegment);
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Ignore permission errors
    }
  }
  return null;
}

export async function captureGitWorkspace(
  tty: string,
  windowName: string
): Promise<GitWorkspaceSnapshot | null> {
  const cwd =
    (await resolveCwdFromTty(tty)) || resolveCwdFromWindowName(windowName);
  if (!cwd) return null;

  const repoRootRaw = await runQuiet(
    "git",
    ["rev-parse", "--show-toplevel"],
    cwd
  );
  if (!repoRootRaw) return null;
  const repoRoot = repoRootRaw.trim();
  if (!repoRoot) return null;

  const [branchRaw, statusRaw, diffStatRaw, diffRaw, commitsRaw] =
    await Promise.all([
      runQuiet("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot),
      runQuiet("git", ["status", "--short"], repoRoot),
      runQuiet("git", ["diff", "HEAD", "--stat"], repoRoot),
      runQuiet(
        "git",
        ["diff", "HEAD", "--unified=2", "--no-color"],
        repoRoot,
        6_000
      ),
      runQuiet(
        "git",
        ["log", "-n", "3", "--stat", "--oneline", "--no-color"],
        repoRoot
      ),
    ]);

  const branch = (branchRaw || "").trim() || "HEAD";
  const statusShort = (statusRaw || "").trim();
  const diffStat = (diffStatRaw || "").trim();
  const diffFull = (diffRaw || "").trim();
  const recentCommits = (commitsRaw || "").trim();

  const MAX_DIFF_CHARS = 4500;
  const diffSnippet =
    diffFull.length > MAX_DIFF_CHARS
      ? `${diffFull.slice(0, MAX_DIFF_CHARS)}\n... [diff truncated, ${diffFull.length} chars total]`
      : diffFull;

  const changedFileCount = statusShort
    ? statusShort.split("\n").filter(Boolean).length
    : 0;

  const gitHash = createHash("sha1")
    .update(`${branch}\n${statusShort}\n${diffStat}\n${recentCommits}`)
    .digest("hex")
    .slice(0, 12);

  return {
    cwd,
    repoRoot,
    branch,
    statusShort,
    diffStat,
    diffSnippet,
    recentCommits,
    changedFileCount,
    gitHash,
  };
}
