/**
 * Replay server: serves the replay UI plus run artifacts.
 *   GET /                     → replay UI
 *   GET /api/runs             → list runs (id, event count, start/end, completed)
 *   GET /api/runs/:id/trace   → trace.jsonl (as text)
 *   GET /runs/...             → raw artifacts (screenshots, logs)
 *
 * Usage: node replay/serve.mjs [--port 8787]
 */
import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, statSync, createReadStream } from "node:fs";
import { join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RUNS = join(ROOT, "runs");
const portIdx = process.argv.indexOf("--port");
const PORT = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 8787;

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jsonl": "application/x-ndjson",
  ".json": "application/json",
  ".log": "text/plain",
  ".txt": "text/plain",
};

function listRuns() {
  if (!existsSync(RUNS)) return [];
  return readdirSync(RUNS)
    .filter((d) => existsSync(join(RUNS, d, "trace.jsonl")))
    .map((id) => {
      const tracePath = join(RUNS, id, "trace.jsonl");
      const stat = statSync(tracePath);
      let first = null;
      let count = 0;
      try {
        const lines = readFileSync(tracePath, "utf8").split("\n").filter(Boolean);
        count = lines.length;
        first = lines.length ? JSON.parse(lines[0]).ts : null;
      } catch {}
      return {
        id,
        events: count,
        startedAt: first,
        updatedAt: stat.mtimeMs,
        completed: existsSync(join(RUNS, id, "COMPLETED")),
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(readFileSync(join(HERE, "index.html")));
      return;
    }
    if (path === "/api/runs") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(listRuns()));
      return;
    }
    const traceMatch = path.match(/^\/api\/runs\/([^/]+)\/trace$/);
    if (traceMatch) {
      const file = join(RUNS, traceMatch[1], "trace.jsonl");
      if (!existsSync(file)) {
        res.writeHead(404);
        res.end("no trace");
        return;
      }
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      createReadStream(file).pipe(res);
      return;
    }
    if (path.startsWith("/runs/")) {
      const rel = normalize(path.slice(6)).replace(/^(\.\.[/\\])+/, "");
      const file = join(RUNS, rel);
      if (!file.startsWith(RUNS) || !existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const ext = file.slice(file.lastIndexOf("."));
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
      createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`replay UI: http://localhost:${PORT}`);
});
