import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { TraceStore } from "../tracing/src/trace.ts";
import { InterceptionProxy, rewriteForUpstream } from "../tracing/src/proxy.ts";
import { FsWatchCollector } from "../tracing/src/collectors.ts";

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

test("proxy flags a safety fallback when the served model differs from requested", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-fallback-"));
  // Upstream echoes a DIFFERENT model than requested — the shape a safety
  // router produces when it reroutes an "unsafe" prompt to a safer model.
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: {"model":"opus-4.8","choices":[{"delta":{"content":"no"}}]}\n\n`);
    res.write(`data: {"model":"opus-4.8","choices":[{"delta":{"content":"pe"}}],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n`);
    res.write(`data: [DONE]\n\n`);
    res.end();
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as { port: number }).port;

  const trace = new TraceStore(dir, "fallback-run");
  const proxy = new InterceptionProxy({ port: 41914, upstreamUrl: `http://127.0.0.1:${upPort}`, trace });
  await proxy.start();
  try {
    await fetch("http://127.0.0.1:41914/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "fable-5", messages: [{ role: "user", content: "…" }], stream: true }),
      headers: { "content-type": "application/json" },
    }).then((r) => r.text());

    const events = trace.read();
    const response = events.find((e) => e.type === "model.response")!;
    const rd = response.data as { requestedModel: string; servedModel: string; fallback: boolean };
    assert.equal(rd.requestedModel, "fable-5");
    assert.equal(rd.servedModel, "opus-4.8");
    assert.equal(rd.fallback, true);

    const fb = events.find((e) => e.type === "model.fallback");
    assert.ok(fb, "emits a dedicated model.fallback event");
    const fbd = fb!.data as { requested: string; served: string; messageCount: number };
    assert.equal(fbd.requested, "fable-5");
    assert.equal(fbd.served, "opus-4.8");
    assert.equal(fbd.messageCount, 1);
  } finally {
    await proxy.stop();
    upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proxy does not flag a fallback when served model matches requested", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-nofallback-"));
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "fable-5", choices: [{ message: { content: "ok" } }] }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as { port: number }).port;

  const trace = new TraceStore(dir, "nofallback-run");
  const proxy = new InterceptionProxy({ port: 41915, upstreamUrl: `http://127.0.0.1:${upPort}`, trace });
  await proxy.start();
  try {
    await fetch("http://127.0.0.1:41915/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "fable-5", messages: [{ role: "user", content: "hi" }] }),
      headers: { "content-type": "application/json" },
    }).then((r) => r.json());

    const events = trace.read();
    const rd = events.find((e) => e.type === "model.response")!.data as { fallback: boolean; servedModel: string };
    assert.equal(rd.servedModel, "fable-5");
    assert.equal(rd.fallback, false);
    assert.ok(!events.some((e) => e.type === "model.fallback"), "no fallback event on a normal turn");
  } finally {
    await proxy.stop();
    upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("per-host rewrites: Azure token rename, Anthropic max_tokens injection, others untouched", () => {
  const mk = (obj: Record<string, unknown>) => Buffer.from(JSON.stringify(obj));
  const parse = (buf: Buffer) => JSON.parse(buf.toString("utf8")) as Record<string, unknown>;

  // Azure: max_tokens renamed to max_completion_tokens.
  const azure = parse(
    rewriteForUpstream("myres.openai.azure.com", mk({ model: "m", max_tokens: 4096 }), {
      model: "m",
      max_tokens: 4096,
    }),
  );
  assert.equal(azure.max_completion_tokens, 4096);
  assert.ok(!("max_tokens" in azure));

  // Anthropic compat: max_tokens REQUIRED — injected when absent…
  const anthropic = parse(
    rewriteForUpstream("api.anthropic.com", mk({ model: "claude-fable-5" }), {
      model: "claude-fable-5",
    }),
  );
  assert.equal(anthropic.max_tokens, 32768);

  // …but never overrides a client-provided value.
  const withTokens = mk({ model: "claude-fable-5", max_tokens: 128000 });
  const untouched = rewriteForUpstream("api.anthropic.com", withTokens, {
    model: "claude-fable-5",
    max_tokens: 128000,
  });
  assert.equal(untouched, withTokens);

  // Every other upstream (OpenRouter, DashScope, Meta, Gemini): bytes pass
  // through identical.
  const orBody = mk({ model: "moonshotai/kimi-k3", max_tokens: 8192 });
  assert.equal(
    rewriteForUpstream("openrouter.ai", orBody, { model: "moonshotai/kimi-k3", max_tokens: 8192 }),
    orBody,
  );
});

test("fswatch records changed paths and honors declared excludes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-fsw-"));
  const watched = join(dir, "watched");
  mkdirSync(join(watched, "excluded-dir"), { recursive: true });
  try {
    const trace = new TraceStore(dir, "fsw-run");
    const collector = new FsWatchCollector(trace, watched, ["excluded-dir"], 60_000);
    collector.start();
    await new Promise((r) => setTimeout(r, 100)); // watcher warm-up
    writeFileSync(join(watched, "NOTES.md"), "agent artifact");
    writeFileSync(join(watched, "excluded-dir", "cache.bin"), "churn");
    await new Promise((r) => setTimeout(r, 300)); // FSEvents delivery
    collector.stop(); // flushes pending

    const fsEvents = trace.read().filter((e) => e.type === "env.fs");
    assert.equal(fsEvents.length, 1);
    const data = fsEvents[0]!.data as { changes: Array<{ path: string }> };
    const paths = data.changes.map((c) => c.path);
    assert.ok(paths.some((p) => p.includes("NOTES.md")), "records the artifact write");
    assert.ok(!paths.some((p) => p.includes("excluded-dir")), "honors the exclude");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proxy extracts usage and text from Responses-API SSE (gpt-5.6 dialect)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-resp-"));
  const frames = [
    `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n`,
    `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel"}\n\n`,
    `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo"}\n\n`,
    `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":11,"output_tokens":4,"total_tokens":15}}}\n\n`,
  ];
  const upstream = createServer((req, res) => {
    assert.ok(req.url?.endsWith("/responses"), "proxy forwards /v1/responses path");
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const f of frames) res.write(f);
    res.end();
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as { port: number }).port;

  const trace = new TraceStore(dir, "resp-run");
  const proxy = new InterceptionProxy({
    port: 41913,
    upstreamUrl: `http://127.0.0.1:${upPort}`,
    trace,
  });
  await proxy.start();
  try {
    await fetch("http://127.0.0.1:41913/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [{ role: "user", content: "hi" }], stream: true }),
      headers: { "content-type": "application/json" },
    }).then((r) => r.text());

    const events = trace.read();
    const request = events.find((e) => e.type === "model.request")!;
    const reqData = request.data as { model: string; messageCount: number };
    assert.equal(reqData.model, "gpt-5.6-sol");
    assert.equal(reqData.messageCount, 1); // counted from "input", not "messages"

    const response = events.find((e) => e.type === "model.response")!;
    const data = response.data as { body: { text: string }; bodyFile: string };
    assert.equal(data.body.text, "Hello");
    assert.equal(proxy.usage.inputTokens, 11); // input_tokens naming
    assert.equal(proxy.usage.outputTokens, 4);

    // Raw SSE side file preserves every event verbatim.
    const rawSse = readFileSync(join(trace.runDir, data.bodyFile), "utf8");
    assert.equal(rawSse, frames.join(""));
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
