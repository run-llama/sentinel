import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getDefaultModel,
  getDefaultOllamaUrl,
  getDefaultProvider,
  getGeminiApiKey,
  getOpenRouterApiKey,
  listOllamaModels,
  MODEL_PRESETS,
} from "./analyzer.js";
import { focusTerminalTab } from "./terminal.js";
import type {
  AuditorProvider,
  WatcherConfig,
  WatcherStateSnapshot,
} from "./types.js";
import { DisruptionWatcher } from "./watcher.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = resolve(__dirname, "../public/index.html");
const PORT = Number(process.env.PORT) || 4321;

const watcher = new DisruptionWatcher({
  liveWatch: process.env.LIVE_WATCH !== "0",
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 30_000,
  includeAllTerminals: process.env.INCLUDE_ALL === "1",
  notifyOnBadVerdict: process.env.NOTIFY !== "0",
  provider: getDefaultProvider(),
  model: getDefaultModel(),
  ollamaBaseUrl: getDefaultOllamaUrl(),
});

const sseClients = new Set<ServerResponse>();

function broadcastState(state: WatcherStateSnapshot): void {
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

watcher.on("state", broadcastState);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const method = req.method || "GET";

  try {
    if (method === "GET" && url.pathname === "/") {
      const html = readFileSync(HTML_PATH, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (method === "GET" && url.pathname === "/api/state") {
      sendJson(res, 200, watcher.getSnapshot());
      return;
    }

    if (method === "GET" && url.pathname === "/api/models") {
      const cfg = watcher.getConfig();
      const ollamaModels = await listOllamaModels(cfg.ollamaBaseUrl);
      sendJson(res, 200, {
        presets: MODEL_PRESETS,
        ollamaModels,
        ollamaBaseUrl: cfg.ollamaBaseUrl,
        hasGoogleKey: Boolean(getGeminiApiKey()),
        hasOpenRouterKey: Boolean(getOpenRouterApiKey()),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(watcher.getSnapshot())}\n\n`);
      sseClients.add(res);
      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/scan") {
      const force = url.searchParams.get("force") === "1";
      const state = await watcher.pollOnce(force);
      sendJson(res, 200, state);
      return;
    }

    if (method === "PATCH" && url.pathname === "/api/config") {
      const body = await readJsonBody(req);
      const patch: Partial<WatcherConfig> = {};
      if (typeof body.liveWatch === "boolean") {
        patch.liveWatch = body.liveWatch;
      }
      if (typeof body.includeAllTerminals === "boolean") {
        patch.includeAllTerminals = body.includeAllTerminals;
      }
      if (typeof body.notifyOnBadVerdict === "boolean") {
        patch.notifyOnBadVerdict = body.notifyOnBadVerdict;
      }
      if (typeof body.pollIntervalMs === "number" && body.pollIntervalMs >= 5000) {
        patch.pollIntervalMs = Math.round(body.pollIntervalMs);
      }
      if (
        typeof body.provider === "string" &&
        ["auto", "google", "openrouter", "ollama"].includes(body.provider)
      ) {
        patch.provider = body.provider as AuditorProvider;
      }
      if (typeof body.model === "string" && body.model.trim()) {
        patch.model = body.model.trim();
      }
      if (typeof body.ollamaBaseUrl === "string" && body.ollamaBaseUrl.trim()) {
        patch.ollamaBaseUrl = body.ollamaBaseUrl.trim().replace(/\/+$/, "");
      }
      const updated = watcher.updateConfig(patch);
      if (typeof body.includeAllTerminals === "boolean") {
        void watcher.pollOnce(false);
      }
      sendJson(res, 200, updated);
      return;
    }

    const analyzeMatch = url.pathname.match(/^\/api\/terminals\/([^/]+)\/analyze$/);
    if (method === "POST" && analyzeMatch) {
      const id = decodeURIComponent(analyzeMatch[1]);
      const term = await watcher.analyzeOne(id);
      if (!term) {
        sendJson(res, 404, { error: "Terminal not found" });
        return;
      }
      sendJson(res, 200, term);
      return;
    }

    const focusMatch = url.pathname.match(/^\/api\/terminals\/([^/]+)\/focus$/);
    if (method === "POST" && focusMatch) {
      const id = decodeURIComponent(focusMatch[1]);
      const state = watcher.getSnapshot();
      const term = state.terminals.find((t) => t.id === id);
      if (!term) {
        sendJson(res, 404, { error: "Terminal not found" });
        return;
      }
      const ok = await focusTerminalTab(term.windowId, term.tabIndex);
      sendJson(res, 200, { focused: ok });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

server.listen(PORT, () => {
  console.log(`DisruptionWatcher dashboard running at http://localhost:${PORT}`);
  console.log(`Model: ${watcher.getConfig().model} | Poll interval: ${watcher.getConfig().pollIntervalMs / 1000}s`);
  watcher.start();
});

process.on("SIGINT", () => {
  watcher.stop();
  server.close(() => process.exit(0));
});
