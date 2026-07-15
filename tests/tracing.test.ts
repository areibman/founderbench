import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { TraceStore } from "../tracing/src/trace.ts";
import { InterceptionProxy } from "../tracing/src/proxy.ts";

test("TraceStore appends and reads back typed events", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-trace-"));
  try {
    const store = new TraceStore(dir, "test-run");
    const a = store.emit("run.start", "test", { hello: 1 });
    store.emit("model.request", "proxy", { big: "x".repeat(10) }, { parentId: a.id });
    const events = store.read();
    assert.equal(events.length, 2);
    assert.equal(events[0]!.type, "run.start");
    assert.equal(events[1]!.parentId, a.id);
    assert.ok(existsSync(join(dir, "test-run", "screenshots")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveBody persists payloads verbatim with no truncation", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-body-"));
  try {
    const store = new TraceStore(dir, "body-run");
    const huge = "y".repeat(3_000_000); // way past the old 200k clip limit
    const rel = store.saveBody("r1.req.json", huge);
    const readBack = readFileSync(join(store.runDir, rel), "utf8");
    assert.equal(readBack.length, huge.length);
    assert.equal(readBack, huge);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proxy forwards JSON requests, traces both sides, extracts usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-proxy-"));
  // Fake OpenAI-compatible upstream.
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      assert.ok(req.url?.endsWith("/chat/completions"));
      assert.equal(req.headers.authorization, "Bearer upstream-key");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "pong" } }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
      );
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as { port: number }).port;

  const trace = new TraceStore(dir, "proxy-run");
  const proxy = new InterceptionProxy({
    port: 41911,
    upstreamUrl: `http://127.0.0.1:${upPort}`,
    upstreamApiKey: "upstream-key",
    trace,
  });
  await proxy.start();
  try {
    const res = await fetch("http://127.0.0.1:41911/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer client-key" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "ping" }] }),
    });
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(json.choices[0]!.message.content, "pong");

    const events = trace.read();
    const types = events.map((e) => e.type);
    assert.ok(types.includes("model.request"));
    assert.ok(types.includes("model.response"));
    assert.ok(types.includes("model.usage"));
    assert.equal(proxy.usage.inputTokens, 7);
    assert.equal(proxy.usage.outputTokens, 3);

    // Raw request body persisted verbatim as a side file.
    const reqEvent = events.find((e) => e.type === "model.request")!;
    const reqData = reqEvent.data as { bodyFile: string; model?: string; messageCount?: number };
    assert.ok(reqData.bodyFile);
    const rawReq = JSON.parse(readFileSync(join(trace.runDir, reqData.bodyFile), "utf8")) as {
      model: string;
      messages: Array<{ content: string }>;
    };
    assert.equal(rawReq.model, "m");
    assert.equal(rawReq.messages[0]!.content, "ping");
    assert.equal(reqData.model, "m");
    assert.equal(reqData.messageCount, 1);
  } finally {
    await proxy.stop();
    upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proxy tees SSE streams and collapses them for the trace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-sse-"));
  const frames = [
    `data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n`,
    `data: {"choices":[{"delta":{"content":"lo"}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n`,
    `data: [DONE]\n\n`,
  ];
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const f of frames) res.write(f);
    res.end();
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as { port: number }).port;

  const trace = new TraceStore(dir, "sse-run");
  const proxy = new InterceptionProxy({
    port: 41912,
    upstreamUrl: `http://127.0.0.1:${upPort}`,
    trace,
  });
  await proxy.start();
  try {
    const res = await fetch("http://127.0.0.1:41912/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
      headers: { "content-type": "application/json" },
    });
    const raw = await res.text();
    assert.ok(raw.includes("[DONE]"), "client receives the raw SSE stream");

    const events = trace.read();
    const response = events.find((e) => e.type === "model.response");
    assert.ok(response);
    const data = response!.data as {
      streaming: boolean;
      body: { text: string };
      bodyFile: string;
    };
    assert.equal(data.streaming, true);
    assert.equal(data.body.text, "Hello");
    assert.equal(proxy.usage.inputTokens, 5);

    // Raw SSE preserved byte-for-byte (every frame, [DONE] included).
    assert.ok(data.bodyFile.endsWith(".res.sse"));
    const rawSse = readFileSync(join(trace.runDir, data.bodyFile), "utf8");
    assert.equal(rawSse, frames.join(""));
  } finally {
    await proxy.stop();
    upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
