import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MetaApiError, MetaGraphClient } from "../tools/meta-ads-mcp/src/client.ts";
import {
  loadMetaRuntimeConfig,
  META_GRAPH_BASE_URL,
  normalizeAccountId,
  type MetaRuntimeConfig,
} from "../tools/meta-ads-mcp/src/config.ts";
import { createMetaAdsServer } from "../tools/meta-ads-mcp/src/server.ts";

function config(overrides: Partial<MetaRuntimeConfig> = {}): MetaRuntimeConfig {
  return {
    accessToken: "secret-meta-token",
    accountId: "act_123456",
    allowActivation: false,
    graphApiVersion: "v25.0",
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
  assert.ok(requestUrl.startsWith(`${META_GRAPH_BASE_URL}/v25.0/`));
  assert.ok(!requestUrl.includes("secret-meta-token"));
  assert.match(requestUrl, /appsecret_proof=/);
});

test("loaded runtime pins the official Graph origin", () => {
  const loaded = loadMetaRuntimeConfig({
    META_CREDENTIALS_FILE: "/definitely/not/a/credential/file",
    META_GRAPH_BASE_URL: "https://attacker.example",
  });
  assert.equal(META_GRAPH_BASE_URL, "https://graph.facebook.com");
  assert.equal("graphBaseUrl" in loaded, false);
});

test("Graph client enforces account and Page allowlists", () => {
  const client = new MetaGraphClient(config());
  assert.equal(client.accountId(), "act_123456");
  assert.throws(() => client.accountId("act_999999"), /outside the configured/);
  assert.doesNotThrow(() => client.assertBudgetMinor(5000, "daily_budget"));
  assert.doesNotThrow(() => client.assertBudgetMinor(50_000, "lifetime_budget"));
  assert.throws(() => client.assertBudgetMinor(-1, "daily_budget"), /non-negative integer/);
  assert.throws(() => client.assertBudgetMinor(1.5, "lifetime_budget"), /non-negative integer/);
  assert.throws(() => client.assertPageAllowed("112233"), /outside META_PAGE_IDS/);
});

test("writes, creative Pages, and activation fail closed", () => {
  const unscoped = new MetaGraphClient(config({ accountId: undefined }));
  assert.throws(
    () => unscoped.writeAccountId("act_123456"),
    /META_AD_ACCOUNT_ID is not configured/,
  );

  const noPages = new MetaGraphClient(config({ pageIds: new Set() }));
  assert.throws(() => noPages.assertPageAllowed("998877"), /META_PAGE_IDS is not configured/);

  const pausedOnly = new MetaGraphClient(config());
  assert.throws(() => pausedOnly.assertActivationAllowed("ACTIVE"), /META_ALLOW_ACTIVATION=true/);

  const activationReady = new MetaGraphClient(config({ allowActivation: true }));
  assert.doesNotThrow(() => activationReady.assertActivationAllowed(" ACTIVE "));
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
  assert.ok(names.includes("get_mcp_status"));
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

test("MCP status proves direct local provenance without exposing secrets", async () => {
  const { server } = createMetaAdsServer(
    config({ allowActivation: true }),
    (() => {
      throw new Error("status must not access the network");
    }) as typeof fetch,
  );
  const client = new Client({ name: "meta-status-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const listed = await client.listTools();
  const statusTool = listed.tools.find((tool) => tool.name === "get_mcp_status");
  assert.equal(statusTool?.annotations?.readOnlyHint, true);
  const response = await client.callTool({ name: "get_mcp_status", arguments: {} });
  const text = (response.content as Array<{ text: string }>)[0]!.text;
  const status = JSON.parse(text) as {
    identity: string;
    transport: string;
    upstream: { origin: string; hosted_mcp_broker: boolean };
    ready: { activation: boolean };
  };
  assert.equal(status.identity, "founderbench-local-meta-ads");
  assert.equal(status.transport, "local stdio");
  assert.equal(status.upstream.origin, "https://graph.facebook.com");
  assert.equal(status.upstream.hosted_mcp_broker, false);
  assert.equal(status.ready.activation, true);
  assert.ok(!text.includes("secret-meta-token"));

  await client.close();
  await server.close();
});

test("MCP refuses caller-selected write accounts and unallowlisted creative identity", async () => {
  let fetchCalls = 0;
  const mockFetch = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ id: "unexpected" }), { status: 200 });
  }) as typeof fetch;
  const { server } = createMetaAdsServer(config({ accountId: undefined }), mockFetch);
  const client = new Client({ name: "meta-guards-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const campaign = await client.callTool({
    name: "create_campaign",
    arguments: {
      account_id: "act_123456",
      confirm: true,
      name: "Must fail",
      objective: "OUTCOME_TRAFFIC",
    },
  });
  assert.equal(campaign.isError, true);
  assert.match((campaign.content as Array<{ text: string }>)[0]!.text, /META_AD_ACCOUNT_ID/);
  assert.equal(fetchCalls, 0);

  await client.close();
  await server.close();

  let creativeBody: URLSearchParams | undefined;
  const creativeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    creativeBody = init?.body as URLSearchParams;
    return new Response(JSON.stringify({ id: "creative-1" }), { status: 200 });
  }) as typeof fetch;
  const scoped = createMetaAdsServer(config(), creativeFetch);
  const scopedClient = new Client({ name: "creative-guard-test", version: "1.0.0" });
  const [scopedClientTransport, scopedServerTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    scoped.server.connect(scopedServerTransport),
    scopedClient.connect(scopedClientTransport),
  ]);

  const rejected = await scopedClient.callTool({
    name: "create_ad_creative",
    arguments: {
      confirm: true,
      name: "Wrong Page",
      spec: { object_story_id: "112233_445566" },
    },
  });
  assert.equal(rejected.isError, true);
  assert.match((rejected.content as Array<{ text: string }>)[0]!.text, /outside META_PAGE_IDS/);

  const accepted = await scopedClient.callTool({
    name: "create_ad_creative",
    arguments: {
      confirm: true,
      name: "Allowed Page",
      spec: { object_story_id: "998877_445566" },
    },
  });
  assert.equal(accepted.isError, undefined);
  assert.equal(creativeBody?.get("object_story_id"), "998877_445566");

  await scopedClient.close();
  await scoped.server.close();
});

test("parent-scoped reads verify ownership before traversing the edge", async () => {
  const requested: string[] = [];
  const mockFetch = (async (input: string | URL | Request) => {
    requested.push(String(input));
    return new Response(JSON.stringify({ id: "campaign-9", account_id: "999999" }), {
      status: 200,
    });
  }) as typeof fetch;
  const { server } = createMetaAdsServer(config(), mockFetch);
  const client = new Client({ name: "meta-read-owner-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const response = await client.callTool({
    name: "get_adsets",
    arguments: { campaign_id: "campaign-9" },
  });
  assert.equal(response.isError, true);
  assert.equal(requested.length, 1);
  assert.ok(!requested[0]!.includes("/campaign-9/adsets"));

  await client.close();
  await server.close();
});
