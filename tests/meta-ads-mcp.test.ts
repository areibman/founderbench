import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MetaApiError, MetaGraphClient } from "../tools/meta-ads-mcp/src/client.ts";
import { normalizeAccountId, type MetaRuntimeConfig } from "../tools/meta-ads-mcp/src/config.ts";
import { createMetaAdsServer } from "../tools/meta-ads-mcp/src/server.ts";

function config(overrides: Partial<MetaRuntimeConfig> = {}): MetaRuntimeConfig {
  return {
    accessToken: "secret-meta-token",
    accountId: "act_123456",
    graphApiVersion: "v25.0",
    graphBaseUrl: "https://graph.facebook.com",
    pageIds: new Set(["998877"]),
    ...overrides,
  };
}

test("normalizes and validates ad account IDs", () => {
  assert.equal(normalizeAccountId("123456"), "act_123456");
  assert.equal(normalizeAccountId("act_123456"), "act_123456");
  assert.throws(() => normalizeAccountId("business_123"), /Invalid Meta ad account/);
});

test("Graph client sends tokens only in the Authorization header", async () => {
  let requestUrl = "";
  let authorization = "";
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({ id: "act_123456" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const client = new MetaGraphClient(config({ appSecret: "app-secret" }), mockFetch);
  await client.get("act_123456", { fields: "id" });

  assert.equal(authorization, "Bearer secret-meta-token");
  assert.ok(!requestUrl.includes("secret-meta-token"));
  assert.match(requestUrl, /appsecret_proof=/);
});

test("Graph client enforces the configured account and budget cap", () => {
  const client = new MetaGraphClient(config({ maxDailyBudgetMinor: 5000 }));
  assert.equal(client.accountId(), "act_123456");
  assert.throws(() => client.accountId("act_999999"), /outside the configured/);
  assert.doesNotThrow(() => client.enforceDailyBudget(5000));
  assert.throws(() => client.enforceDailyBudget(5001), /exceeds/);
  assert.throws(() => client.assertPageAllowed("112233"), /outside META_PAGE_IDS/);
});

test("Meta errors preserve useful codes but redact the access token", async () => {
  const mockFetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: 200,
          error_subcode: 1815694,
          fbtrace_id: "trace-1",
          message: "bad token secret-meta-token",
        },
      }),
      { status: 400 },
    )) as typeof fetch;
  const client = new MetaGraphClient(config(), mockFetch);

  await assert.rejects(
    () => client.get("act_123456"),
    (error: unknown) => {
      assert.ok(error instanceof MetaApiError);
      assert.equal(error.code, 200);
      assert.equal(error.subcode, 1815694);
      assert.ok(!error.message.includes("secret-meta-token"));
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});

test("MCP lists direct tools and forces new campaigns to PAUSED", async () => {
  let postBody: URLSearchParams | undefined;
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/act_123456/campaigns")) {
      assert.equal(init?.method, "POST");
      postBody = init?.body as URLSearchParams;
      return new Response(JSON.stringify({ id: "campaign-1" }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;

  const { server } = createMetaAdsServer(config(), mockFetch);
  const client = new Client({ name: "meta-ads-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  assert.ok(names.includes("get_ad_creatives"));
  assert.ok(names.includes("delete_ad_image"));
  assert.ok(!names.includes("graph_request"));

  const created = await client.callTool({
    name: "create_campaign",
    arguments: {
      confirm: true,
      extra: { status: "ACTIVE" },
      name: "Test campaign",
      objective: "OUTCOME_TRAFFIC",
    },
  });
  assert.equal(created.isError, undefined);
  assert.equal(postBody?.get("status"), "PAUSED");
  assert.equal(postBody?.get("name"), "Test campaign");

  await client.close();
  await server.close();
});
