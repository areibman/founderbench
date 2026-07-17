import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
export const FB_ROOT = resolve(SOURCE_DIR, "../../..");
export const META_GRAPH_BASE_URL = "https://graph.facebook.com";

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Load the gitignored FounderBench credential file without overriding the process environment. */
export function loadCredentialsFile(
  env: NodeJS.ProcessEnv = process.env,
  path = env.META_CREDENTIALS_FILE || resolve(FB_ROOT, "credentials.env"),
): void {
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;

    const key = trimmed.slice(0, separator).trim();
    if (key in env) continue;
    const rawValue = unquote(trimmed.slice(separator + 1).trim());
    env[key] = rawValue.replace(/^\$HOME|^~(?=\/)/, env.HOME ?? "~");
  }
}

export function normalizeAccountId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Meta ad account ID is empty");
  const digits = trimmed.startsWith("act_") ? trimmed.slice(4) : trimmed;
  if (!/^\d+$/.test(digits)) {
    throw new Error(`Invalid Meta ad account ID: ${trimmed}`);
  }
  return `act_${digits}`;
}

function commaSeparated(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function explicitTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export interface MetaRuntimeConfig {
  accessToken: string;
  accountId?: string;
  appSecret?: string;
  allowActivation: boolean;
  businessId?: string;
  graphApiVersion: string;
  pageIds: Set<string>;
}

export function loadMetaRuntimeConfig(env: NodeJS.ProcessEnv = process.env): MetaRuntimeConfig {
  loadCredentialsFile(env);

  const graphApiVersion = env.META_GRAPH_API_VERSION || "v25.0";
  if (!/^v\d+\.\d+$/.test(graphApiVersion)) {
    throw new Error("META_GRAPH_API_VERSION must look like v25.0");
  }

  return {
    accessToken: env.META_ACCESS_TOKEN?.trim() ?? "",
    accountId: env.META_AD_ACCOUNT_ID ? normalizeAccountId(env.META_AD_ACCOUNT_ID) : undefined,
    appSecret: env.META_APP_SECRET?.trim() || undefined,
    allowActivation: explicitTrue(env.META_ALLOW_ACTIVATION),
    businessId: env.META_BUSINESS_ID?.trim() || undefined,
    graphApiVersion,
    pageIds: commaSeparated(env.META_PAGE_IDS),
  };
}
