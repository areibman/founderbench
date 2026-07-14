/**
 * Standalone proxy runner — for testing the interception proxy without the
 * orchestrator, or for pointing any OpenAI-compatible client at a traced upstream.
 *
 * Usage:
 *   MODEL_UPSTREAM_URL=https://api.z.ai/api/paas/v4 MODEL_API_KEY=... \
 *     npm run proxy -- --port 41500 --run-id proxy-test
 */
import { InterceptionProxy } from "./proxy.ts";
import { TraceStore } from "./trace.ts";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const arg = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const upstream = process.env.MODEL_UPSTREAM_URL;
if (!upstream) {
  console.error("MODEL_UPSTREAM_URL is required");
  process.exit(1);
}

const trace = new TraceStore(join(root, "runs"), arg("run-id", `proxy-${Date.now()}`));
const proxy = new InterceptionProxy({
  port: Number(arg("port", "41500")),
  upstreamUrl: upstream,
  upstreamApiKey: process.env.MODEL_API_KEY,
  trace,
});

await proxy.start();
console.log(`interception proxy on http://127.0.0.1:${arg("port", "41500")} → ${upstream}`);
console.log(`trace: ${trace.tracePath}`);
