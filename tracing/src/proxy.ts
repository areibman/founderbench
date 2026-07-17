/**
 * LLM interception proxy — FounderBench's version of the verifiers v1 interception
 * server. OpenCode's provider baseURL points here; we record every model request and
 * response (including streamed SSE bodies) before forwarding to the real upstream.
 *
 * Design: opaque HTTP passthrough. Works with any OpenAI-compatible upstream
 * (Azure OpenAI, OpenAI, MiniMax, GLM/Zhipu, etc.). Streaming responses are teed: bytes flow to the client
 * unmodified while being accumulated in full for the trace.
 *
 * NO DATA LOSS: request and response bodies are persisted verbatim as side files
 * (runs/<id>/bodies/<requestId>.req.json / .res.sse|.res.json); trace.jsonl carries
 * the light index (ids, status, usage, timing) plus a convenience text summary.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { TraceStore } from "./trace.ts";

export interface ProxyOptions {
  port: number;
  upstreamUrl: string; // e.g. https://YOUR-RESOURCE.openai.azure.com/openai/v1
  /** If set, replaces the incoming Authorization header. */
  upstreamApiKey?: string;
  trace: TraceStore;
}

export interface ProxyUsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export class InterceptionProxy {
  private server: Server | null = null;
  readonly usage: ProxyUsageTotals = { requests: 0, inputTokens: 0, outputTokens: 0 };

  constructor(private readonly opts: ProxyOptions) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.opts.trace.emit("env.error", "proxy", { message: String(err) });
        if (!res.headersSent) res.writeHead(502);
        res.end(JSON.stringify({ error: "proxy_error", message: String(err) }));
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(this.opts.port, "127.0.0.1", resolve),
    );
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  private upstreamFor(path: string): string {
    const base = this.opts.upstreamUrl.replace(/\/$/, "");
    // OpenCode's openai-compatible provider prefixes /v1; upstreams often already
    // include their versioned base path. Strip a leading /v1 if the base has a path.
    const baseHasPath = new URL(base).pathname !== "/";
    const cleanPath = baseHasPath ? path.replace(/^\/v1(?=\/|$)/, "") : path;
    return base + cleanPath;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const started = Date.now();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bodyRaw = Buffer.concat(chunks);
    const bodyText = bodyRaw.toString("utf8");

    let bodyJson: unknown = undefined;
    try {
      bodyJson = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      /* non-JSON body — trace raw */
    }

    const url = this.upstreamFor(req.url ?? "/");
    // Raw request bytes, verbatim — this is the agent's full context window.
    const reqBodyFile = bodyRaw.length
      ? this.opts.trace.saveBody(`${requestId}.req.json`, bodyRaw)
      : null;
    // Chat Completions carries "messages"; the Responses API carries "input".
    const parsed = bodyJson as { model?: string; messages?: unknown[]; input?: unknown } | undefined;
    const items = Array.isArray(parsed?.messages)
      ? parsed.messages
      : Array.isArray(parsed?.input)
        ? parsed.input
        : undefined;
    this.opts.trace.emit(
      "model.request",
      "proxy",
      {
        requestId,
        method: req.method,
        path: req.url,
        upstream: url,
        bodyFile: reqBodyFile,
        model: parsed?.model,
        messageCount: items?.length,
      },
      { parentId: requestId },
    );

    // Forward headers, minus hop-by-hop; optionally override auth.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v !== "string") continue;
      if (["host", "connection", "content-length", "accept-encoding"].includes(k)) continue;
      headers[k] = v;
    }
    if (this.opts.upstreamApiKey) {
      headers["authorization"] = `Bearer ${this.opts.upstreamApiKey}`;
      // Azure OpenAI: the v1 endpoint accepts Bearer, but older api-version
      // surfaces only take the api-key header — send both when targeting Azure.
      if (new URL(url).hostname.endsWith(".azure.com")) {
        headers["api-key"] = this.opts.upstreamApiKey;
      }
    }

    const upstreamRes = await fetch(url, {
      method: req.method ?? "POST",
      headers,
      body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : bodyRaw,
    });

    // Relay status + headers (skip encodings we didn't preserve).
    const outHeaders: Record<string, string> = {};
    upstreamRes.headers.forEach((v, k) => {
      if (["content-encoding", "content-length", "transfer-encoding"].includes(k)) return;
      outHeaders[k] = v;
    });
    res.writeHead(upstreamRes.status, outHeaders);

    // Tee the body: stream to client, accumulate in full (no cap) for the trace.
    const accumulated: Buffer[] = [];
    if (upstreamRes.body) {
      const reader = upstreamRes.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        accumulated.push(Buffer.from(value));
      }
    }
    res.end();

    const responseRaw = Buffer.concat(accumulated);
    const responseText = responseRaw.toString("utf8");
    const isSSE = (upstreamRes.headers.get("content-type") ?? "").includes("text/event-stream");
    const usage = extractUsage(responseText, isSSE);
    if (usage) {
      this.usage.inputTokens += usage.inputTokens;
      this.usage.outputTokens += usage.outputTokens;
    }
    this.usage.requests += 1;

    // Raw response bytes, verbatim: for SSE this preserves every frame — tool-call
    // deltas and reasoning content included, which the collapsed text does not carry.
    const resBodyFile = responseRaw.length
      ? this.opts.trace.saveBody(`${requestId}${isSSE ? ".res.sse" : ".res.json"}`, responseRaw)
      : null;

    this.opts.trace.emit(
      "model.response",
      "proxy",
      {
        requestId,
        status: upstreamRes.status,
        durationMs: Date.now() - started,
        streaming: isSSE,
        usage,
        bodyFile: resBodyFile,
        // Convenience summary only — the lossless record is bodyFile.
        body: isSSE ? sseToText(responseText) : safeJson(responseText),
      },
      { parentId: requestId },
    );
    if (usage) {
      this.opts.trace.emit("model.usage", "proxy", { requestId, ...usage, totals: { ...this.usage } });
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Collapse an SSE stream into the concatenated assistant text + a frame count.
 * Understands both dialects: Chat Completions (`choices[].delta.content`) and
 * the Responses API (`response.output_text.delta` events). Convenience only —
 * the lossless record is always the raw side file.
 */
function sseToText(sse: string): { text: string; frames: number } {
  let text = "";
  let frames = 0;
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data:")) continue;
    frames++;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") continue;
    try {
      const j = JSON.parse(payload) as {
        // chat-completions dialect
        choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
        // responses dialect
        type?: string;
        delta?: string;
      };
      if (j.type === "response.output_text.delta" && typeof j.delta === "string") {
        text += j.delta;
        continue;
      }
      const delta = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content;
      if (delta) text += delta;
    } catch {
      /* ignore malformed frames */
    }
  }
  return { text, frames };
}

interface WireUsage {
  // chat-completions naming
  prompt_tokens?: number;
  completion_tokens?: number;
  // responses-API naming
  input_tokens?: number;
  output_tokens?: number;
}

/**
 * Pull token usage out of a JSON or SSE response body. Handles both dialects:
 * Chat Completions (`usage.prompt_tokens/completion_tokens`, in the final SSE
 * frames) and the Responses API (`usage.input_tokens/output_tokens`, top-level
 * when non-streaming, under `response.usage` in the `response.completed` event
 * when streaming). Budget enforcement depends on this — keep both paths green.
 */
function extractUsage(
  body: string,
  isSSE: boolean,
): { inputTokens: number; outputTokens: number } | null {
  const fromWire = (u: WireUsage | undefined): { inputTokens: number; outputTokens: number } | null => {
    if (!u) return null;
    if (u.prompt_tokens != null || u.completion_tokens != null) {
      return { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 };
    }
    if (u.input_tokens != null || u.output_tokens != null) {
      return { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 };
    }
    return null;
  };
  const tryUsage = (obj: unknown): { inputTokens: number; outputTokens: number } | null => {
    const o = obj as { usage?: WireUsage; response?: { usage?: WireUsage } } | undefined;
    return fromWire(o?.usage) ?? fromWire(o?.response?.usage);
  };
  if (!isSSE) {
    try {
      return tryUsage(JSON.parse(body));
    } catch {
      return null;
    }
  }
  // SSE: usage arrives in one of the final frames (chat) or in the
  // response.completed event (responses). Scan from the end.
  const lines = body.split("\n").filter((l) => l.startsWith("data:"));
  for (let i = lines.length - 1; i >= 0; i--) {
    const payload = lines[i]!.slice(5).trim();
    if (payload === "[DONE]") continue;
    try {
      const usage = tryUsage(JSON.parse(payload));
      if (usage) return usage;
    } catch {
      /* skip */
    }
  }
  return null;
}
