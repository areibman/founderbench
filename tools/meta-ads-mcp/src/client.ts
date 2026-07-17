import { createHmac } from "node:crypto";
import {
  META_GRAPH_BASE_URL,
  normalizeAccountId,
  type MetaRuntimeConfig,
} from "./config.ts";

export type GraphScalar = string | number | boolean | null | undefined;
export type GraphValue = GraphScalar | Record<string, unknown> | unknown[];
export type GraphParams = Record<string, GraphValue>;

interface GraphRequestOptions {
  body?: GraphParams;
  method?: "GET" | "POST" | "DELETE";
  query?: GraphParams;
}

interface MetaErrorBody {
  error?: {
    code?: number;
    error_subcode?: number;
    error_user_msg?: string;
    error_user_title?: string;
    fbtrace_id?: string;
    message?: string;
    type?: string;
  };
}

export class MetaApiError extends Error {
  readonly code?: number;
  readonly subcode?: number;
  readonly traceId?: string;

  constructor(status: number, body: MetaErrorBody | undefined) {
    const meta = body?.error;
    const details = [
      meta?.error_user_title,
      meta?.error_user_msg,
      meta?.message,
      meta?.code ? `code=${meta.code}` : undefined,
      meta?.error_subcode ? `subcode=${meta.error_subcode}` : undefined,
      meta?.fbtrace_id ? `fbtrace_id=${meta.fbtrace_id}` : undefined,
    ].filter(Boolean);
    super(details.length ? details.join(" | ") : `Meta Graph API request failed with HTTP ${status}`);
    this.name = "MetaApiError";
    this.code = meta?.code;
    this.subcode = meta?.error_subcode;
    this.traceId = meta?.fbtrace_id;
  }
}

function encodeValue(value: GraphValue): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function appendParams(target: URLSearchParams, params: GraphParams | undefined): void {
  if (!params) return;
  for (const [key, value] of Object.entries(params)) {
    const encoded = encodeValue(value);
    if (encoded !== undefined) target.set(key, encoded);
  }
}

function safeObjectId(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_:-]+$/.test(trimmed)) throw new Error(`Invalid Meta object ID: ${value}`);
  return trimmed;
}

export class MetaGraphClient {
  constructor(
    readonly config: MetaRuntimeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private requireToken(): string {
    if (!this.config.accessToken) {
      throw new Error(
        "META_ACCESS_TOKEN is not configured. Add a direct Meta access token to the gitignored credentials.env file.",
      );
    }
    return this.config.accessToken;
  }

  accountId(requested?: string): string {
    const configured = this.config.accountId;
    const accountId = requested ? normalizeAccountId(requested) : configured;
    if (!accountId) {
      throw new Error("META_AD_ACCOUNT_ID is not configured and no account_id was supplied");
    }
    if (configured && accountId !== configured) {
      throw new Error(`Account ${accountId} is outside the configured Meta account allowlist`);
    }
    return accountId;
  }

  writeAccountId(requested?: string): string {
    const configured = this.config.accountId;
    if (!configured) {
      throw new Error(
        "META_AD_ACCOUNT_ID is not configured; refusing every Meta write even when account_id is supplied",
      );
    }
    const accountId = requested ? normalizeAccountId(requested) : configured;
    if (accountId !== configured) {
      throw new Error(`Account ${accountId} is outside the configured Meta account allowlist`);
    }
    return configured;
  }

  assertPageAllowed(pageId: string): void {
    if (this.config.pageIds.size === 0) {
      throw new Error("META_PAGE_IDS is not configured; refusing creative write");
    }
    if (!this.config.pageIds.has(pageId)) {
      throw new Error(`Page ${pageId} is outside META_PAGE_IDS`);
    }
  }

  /** Validate budget fields as minor-currency integers. Amounts are unconstrained
   * here — Meta account spend caps are the blast-radius control. */
  assertBudgetMinor(value: unknown, field: "daily_budget" | "lifetime_budget"): void {
    if (value === undefined || value === null) return;
    const budget = Number(value);
    if (!Number.isSafeInteger(budget) || budget < 0) {
      throw new Error(`${field} must be a non-negative integer in the account's minor unit`);
    }
  }

  assertActivationAllowed(status: unknown): void {
    if (typeof status !== "string" || status.trim().toUpperCase() !== "ACTIVE") return;
    if (!this.config.allowActivation) {
      throw new Error("META_ALLOW_ACTIVATION=true is required before setting status ACTIVE");
    }
  }

  async assertObjectOwned(objectId: string, accountId?: string): Promise<void> {
    const allowedAccount = this.accountId(accountId);
    const object = await this.get<{ account_id?: string; id?: string }>(safeObjectId(objectId), {
      fields: "id,account_id",
    });
    if (!object.account_id) {
      throw new Error(`Meta object ${objectId} did not expose account_id; refusing scoped operation`);
    }
    if (normalizeAccountId(object.account_id) !== allowedAccount) {
      throw new Error(`Meta object ${objectId} does not belong to ${allowedAccount}`);
    }
  }

  async get<T = unknown>(path: string, query?: GraphParams): Promise<T> {
    return this.request<T>(path, { method: "GET", query });
  }

  async post<T = unknown>(path: string, body?: GraphParams): Promise<T> {
    return this.request<T>(path, { method: "POST", body });
  }

  async delete<T = unknown>(path: string, query?: GraphParams): Promise<T> {
    return this.request<T>(path, { method: "DELETE", query });
  }

  async request<T = unknown>(path: string, options: GraphRequestOptions = {}): Promise<T> {
    const token = this.requireToken();
    const cleanPath = path.replace(/^\/+/, "");
    const url = new URL(`${META_GRAPH_BASE_URL}/${this.config.graphApiVersion}/${cleanPath}`);
    appendParams(url.searchParams, options.query);

    if (this.config.appSecret) {
      url.searchParams.set(
        "appsecret_proof",
        createHmac("sha256", this.config.appSecret).update(token).digest("hex"),
      );
    }

    const method = options.method ?? "GET";
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    let body: URLSearchParams | undefined;
    if (method === "POST") {
      body = new URLSearchParams();
      appendParams(body, options.body);
      headers.set("content-type", "application/x-www-form-urlencoded");
    }

    const response = await this.fetchImpl(url, { method, headers, body });
    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = undefined;
    }

    if (!response.ok || (parsed && typeof parsed === "object" && "error" in parsed)) {
      const error = new MetaApiError(response.status, parsed as MetaErrorBody | undefined);
      if (token && error.message.includes(token)) {
        error.message = error.message.replaceAll(token, "[REDACTED]");
      }
      throw error;
    }
    return parsed as T;
  }
}

export function sanitizeChanges(changes: Record<string, unknown>): Record<string, GraphValue> {
  const blocked = new Set(["access_token", "account_id", "appsecret_proof", "id"]);
  const result: Record<string, GraphValue> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (blocked.has(key)) throw new Error(`Field ${key} cannot be supplied to a Meta mutation`);
    result[key] = value as GraphValue;
  }
  return result;
}
