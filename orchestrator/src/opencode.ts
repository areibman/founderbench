/**
 * Thin OpenCode server client + process supervisor.
 * Targets the documented HTTP API (https://opencode.ai/docs/server/).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";

export interface OpenCodeOptions {
  port: number;
  cwd: string; // agent workspace (app repo)
  logDir: string;
  env?: Record<string, string>;
}

export interface SessionStatusMap {
  [sessionID: string]: { type?: string; [k: string]: unknown };
}

export class OpenCodeServer {
  private proc: ChildProcess | null = null;
  readonly baseUrl: string;

  constructor(private readonly opts: OpenCodeOptions) {
    this.baseUrl = `http://127.0.0.1:${opts.port}`;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  async start(): Promise<void> {
    const log = createWriteStream(join(this.opts.logDir, "opencode.log"), { flags: "a" });
    this.proc = spawn("opencode", ["serve", "--port", String(this.opts.port)], {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc.stdout?.pipe(log);
    this.proc.stderr?.pipe(log);
    await this.waitHealthy(60_000);
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 2000));
    if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
    this.proc = null;
  }

  /** True if the child process is still running. */
  alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  onExit(cb: (code: number | null) => void): void {
    this.proc?.on("exit", cb);
  }

  async waitHealthy(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const res = await fetch(`${this.baseUrl}/global/health`);
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error("opencode serve did not become healthy");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 500)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ── sessions ────────────────────────────────────────────────────────────
  async createSession(title: string): Promise<{ id: string }> {
    return this.json("/session", { method: "POST", body: JSON.stringify({ title }) });
  }

  async listSessions(): Promise<Array<{ id: string; title?: string }>> {
    return this.json("/session");
  }

  async sessionStatus(): Promise<SessionStatusMap> {
    return this.json("/session/status");
  }

  async abortSession(id: string): Promise<void> {
    await this.json(`/session/${id}/abort`, { method: "POST" });
  }

  /** Fire-and-forget prompt; responses arrive on the SSE bus. */
  async promptAsync(
    sessionId: string,
    text: string,
    opts: { agent?: string; model?: { providerID: string; modelID: string } } = {},
  ): Promise<void> {
    await this.json(`/session/${sessionId}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({
        ...(opts.agent ? { agent: opts.agent } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        parts: [{ type: "text", text }],
      }),
    });
  }

  async messages(sessionId: string, limit = 20): Promise<unknown[]> {
    return this.json(`/session/${sessionId}/message?limit=${limit}`);
  }

  /** Auto-approve a permission request (safety net; config should already allow-all). */
  async respondPermission(sessionId: string, permissionId: string): Promise<void> {
    await this.json(`/session/${sessionId}/permissions/${permissionId}`, {
      method: "POST",
      body: JSON.stringify({ response: "always" }),
    });
  }
}
