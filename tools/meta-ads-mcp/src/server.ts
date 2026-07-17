import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  MetaGraphClient,
  sanitizeChanges,
  type GraphParams,
  type GraphValue,
} from "./client.ts";
import {
  loadMetaRuntimeConfig,
  META_GRAPH_BASE_URL,
  type MetaRuntimeConfig,
} from "./config.ts";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const accountIdSchema = z
  .string()
  .optional()
  .describe("Meta ad account ID. Defaults to META_AD_ACCOUNT_ID and cannot override it.");
const cursorSchema = z.string().optional().describe("Meta pagination cursor from paging.cursors.after");
const limitSchema = z.number().int().min(1).max(500).optional().describe("Maximum records");
const confirmSchema = z
  .literal(true)
  .describe("Explicit acknowledgement that this call changes live Meta state");
const changesSchema = z.record(z.string(), z.unknown());

function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

async function run<T>(operation: () => Promise<T>) {
  try {
    return result(await operation());
  } catch (error) {
    return failure(error);
  }
}

function listParams(limit: number | undefined, after: string | undefined): GraphParams {
  return { limit: limit ?? 100, after };
}

function pageIdValue(value: unknown): string | undefined {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return undefined;
}

function objectStoryPageId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^(\d+)_\d+$/.exec(value.trim())?.[1];
}

function extractCreativePageIds(spec: Record<string, unknown>): Set<string> {
  const pageIds = new Set<string>();
  const rootPageId = pageIdValue(spec.page_id);
  const rootStoryPageId = objectStoryPageId(spec.object_story_id);
  if (rootPageId) pageIds.add(rootPageId);
  if (rootStoryPageId) pageIds.add(rootStoryPageId);

  const story = spec.object_story_spec;
  if (story && typeof story === "object") {
    const storySpec = story as Record<string, unknown>;
    const storyPageId = pageIdValue(storySpec.page_id);
    const nestedStoryPageId = objectStoryPageId(storySpec.object_story_id);
    if (storyPageId) pageIds.add(storyPageId);
    if (nestedStoryPageId) pageIds.add(nestedStoryPageId);
  }
  return pageIds;
}

function objectFields(fields: string | undefined, defaults: string): string {
  return fields?.trim() || defaults;
}

async function readOwnedObject(
  client: MetaGraphClient,
  objectId: string,
  accountId: string | undefined,
  fields: string,
) {
  const allowedAccount = client.accountId(accountId);
  const allFields = fields.split(",").includes("account_id") ? fields : `${fields},account_id`;
  const object = await client.get<Record<string, unknown>>(objectId, { fields: allFields });
  const actualAccount = object.account_id;
  if (typeof actualAccount !== "string" || client.accountId(actualAccount) !== allowedAccount) {
    throw new Error(`Meta object ${objectId} is not owned by ${allowedAccount}`);
  }
  return object;
}

export function createMetaAdsServer(
  config: MetaRuntimeConfig = loadMetaRuntimeConfig(),
  fetchImpl: typeof fetch = fetch,
) {
  const client = new MetaGraphClient(config, fetchImpl);
  const server = new McpServer({ name: "founderbench-meta-ads", version: "1.0.0" });

  server.registerTool(
    "get_mcp_status",
    {
      description:
        "Report local MCP provenance and credential/allowlist readiness without making a network request or revealing secrets.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () =>
      run(async () => ({
        identity: "founderbench-local-meta-ads",
        transport: "local stdio",
        upstream: {
          provider: "official Meta Graph/Marketing API",
          origin: META_GRAPH_BASE_URL,
          graph_api_version: config.graphApiVersion,
          hosted_mcp_broker: false,
        },
        configured: {
          access_token: Boolean(config.accessToken),
          app_secret: Boolean(config.appSecret),
          ad_account_allowlist: Boolean(config.accountId),
          page_allowlist: config.pageIds.size > 0,
          page_allowlist_count: config.pageIds.size,
          activation_opt_in: config.allowActivation,
        },
        ready: {
          reads: Boolean(config.accessToken),
          writes: Boolean(config.accessToken && config.accountId),
          creative_writes: Boolean(
            config.accessToken && config.accountId && config.pageIds.size > 0,
          ),
          activation: Boolean(
            config.accessToken && config.accountId && config.allowActivation,
          ),
        },
      })),
  );

  server.registerTool(
    "get_ad_accounts",
    {
      description:
        "List Meta ad accounts visible to the direct access token. When META_AD_ACCOUNT_ID is set, only that account is returned.",
      inputSchema: { after: cursorSchema, limit: limitSchema },
      annotations: READ_ONLY,
    },
    ({ after, limit }) =>
      run(async () => {
        const response = await client.get<{ data?: Array<Record<string, unknown>> }>(
          "me/adaccounts",
          {
            ...listParams(limit, after),
            fields:
              "id,account_id,name,account_status,disable_reason,amount_spent,balance,currency,timezone_name,business,spend_cap,user_tasks",
          },
        );
        if (config.accountId && response.data) {
          response.data = response.data.filter((item) => item.id === config.accountId);
        }
        return response;
      }),
  );

  server.registerTool(
    "get_account_info",
    {
      description: "Read the configured Meta ad account, including status, balance and spend.",
      inputSchema: { account_id: accountIdSchema, fields: z.string().optional() },
      annotations: READ_ONLY,
    },
    ({ account_id, fields }) =>
      run(() =>
        client.get(client.accountId(account_id), {
          fields: objectFields(
            fields,
            "id,account_id,name,account_status,disable_reason,amount_spent,balance,currency,timezone_name,business,funding_source,spend_cap,user_tasks",
          ),
        }),
      ),
  );

  server.registerTool(
    "get_account_pages",
    {
      description: "List Facebook Pages promotable by the configured ad account.",
      inputSchema: { account_id: accountIdSchema, after: cursorSchema, limit: limitSchema },
      annotations: READ_ONLY,
    },
    ({ account_id, after, limit }) =>
      run(() =>
        client.get(`${client.accountId(account_id)}/promote_pages`, {
          ...listParams(limit, after),
          fields: "id,name,username,category,link,picture",
        }),
      ),
  );

  server.registerTool(
    "get_instagram_accounts",
    {
      description: "List Instagram accounts connected to the configured ad account.",
      inputSchema: { account_id: accountIdSchema, after: cursorSchema, limit: limitSchema },
      annotations: READ_ONLY,
    },
    ({ account_id, after, limit }) =>
      run(() =>
        client.get(`${client.accountId(account_id)}/instagram_accounts`, {
          ...listParams(limit, after),
          fields: "id,username,profile_pic",
        }),
      ),
  );

  server.registerTool(
    "get_campaigns",
    {
      description: "List campaigns account-wide, including configured and effective status.",
      inputSchema: {
        account_id: accountIdSchema,
        after: cursorSchema,
        effective_statuses: z.array(z.string()).optional(),
        limit: limitSchema,
      },
      annotations: READ_ONLY,
    },
    ({ account_id, after, effective_statuses, limit }) =>
      run(() =>
        client.get(`${client.accountId(account_id)}/campaigns`, {
          ...listParams(limit, after),
          fields:
            "id,account_id,name,status,effective_status,objective,buying_type,daily_budget,lifetime_budget,budget_remaining,special_ad_categories,created_time,updated_time,start_time,stop_time",
          filtering: effective_statuses?.length
            ? [{ field: "effective_status", operator: "IN", value: effective_statuses }]
            : undefined,
        }),
      ),
  );

  server.registerTool(
    "get_campaign_details",
    {
      description: "Read one campaign after verifying it belongs to the configured account.",
      inputSchema: {
        account_id: accountIdSchema,
        campaign_id: z.string(),
        fields: z.string().optional(),
      },
      annotations: READ_ONLY,
    },
    ({ account_id, campaign_id, fields }) =>
      run(() =>
        readOwnedObject(
          client,
          campaign_id,
          account_id,
          objectFields(
            fields,
            "id,account_id,name,status,effective_status,objective,buying_type,daily_budget,lifetime_budget,budget_remaining,special_ad_categories,created_time,updated_time,start_time,stop_time",
          ),
        ),
      ),
  );

  server.registerTool(
    "get_adsets",
    {
      description: "List ad sets account-wide.",
      inputSchema: {
        account_id: accountIdSchema,
        after: cursorSchema,
        campaign_id: z.string().optional(),
        limit: limitSchema,
      },
      annotations: READ_ONLY,
    },
    ({ account_id, after, campaign_id, limit }) =>
      run(async () => {
        const account = client.accountId(account_id);
        if (campaign_id) await client.assertObjectOwned(campaign_id, account);
        const edge = campaign_id ? `${campaign_id}/adsets` : `${account}/adsets`;
        return client.get(edge, {
          ...listParams(limit, after),
          fields:
            "id,account_id,campaign_id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining,bid_strategy,billing_event,optimization_goal,targeting,promoted_object,start_time,end_time,created_time,updated_time",
        });
      }),
  );

  server.registerTool(
    "get_adset_details",
    {
      description: "Read one ad set after verifying it belongs to the configured account.",
      inputSchema: { account_id: accountIdSchema, adset_id: z.string(), fields: z.string().optional() },
      annotations: READ_ONLY,
    },
    ({ account_id, adset_id, fields }) =>
      run(() =>
        readOwnedObject(
          client,
          adset_id,
          account_id,
          objectFields(
            fields,
            "id,account_id,campaign_id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining,bid_strategy,billing_event,optimization_goal,targeting,promoted_object,start_time,end_time,created_time,updated_time",
          ),
        ),
      ),
  );

  server.registerTool(
    "get_ads",
    {
      description: "List ads account-wide, including their creative IDs and effective status.",
      inputSchema: {
        account_id: accountIdSchema,
        adset_id: z.string().optional(),
        after: cursorSchema,
        campaign_id: z.string().optional(),
        limit: limitSchema,
      },
      annotations: READ_ONLY,
    },
    ({ account_id, adset_id, after, campaign_id, limit }) =>
      run(async () => {
        if (adset_id && campaign_id) {
          throw new Error("Supply either adset_id or campaign_id, not both");
        }
        const account = client.accountId(account_id);
        if (adset_id) await client.assertObjectOwned(adset_id, account);
        if (campaign_id) await client.assertObjectOwned(campaign_id, account);
        const edge = adset_id
          ? `${adset_id}/ads`
          : campaign_id
            ? `${campaign_id}/ads`
            : `${account}/ads`;
        return client.get(edge, {
          ...listParams(limit, after),
          fields:
            "id,account_id,campaign_id,adset_id,name,status,effective_status,creative,created_time,updated_time,tracking_specs",
        });
      }),
  );

  server.registerTool(
    "get_ad_details",
    {
      description: "Read one ad after verifying it belongs to the configured account.",
      inputSchema: { account_id: accountIdSchema, ad_id: z.string(), fields: z.string().optional() },
      annotations: READ_ONLY,
    },
    ({ account_id, ad_id, fields }) =>
      run(() =>
        readOwnedObject(
          client,
          ad_id,
          account_id,
          objectFields(
            fields,
            "id,account_id,campaign_id,adset_id,name,status,effective_status,creative,created_time,updated_time,tracking_specs",
          ),
        ),
      ),
  );

  server.registerTool(
    "get_ad_creatives",
    {
      description:
        "List creatives account-wide or for a specific ad. Account-wide discovery includes orphaned and historical creative records.",
      inputSchema: {
        account_id: accountIdSchema,
        ad_id: z.string().optional(),
        after: cursorSchema,
        limit: limitSchema,
      },
      annotations: READ_ONLY,
    },
    ({ account_id, ad_id, after, limit }) =>
      run(async () => {
        const account = client.accountId(account_id);
        if (ad_id) await client.assertObjectOwned(ad_id, account);
        return client.get(ad_id ? `${ad_id}/adcreatives` : `${account}/adcreatives`, {
          ...listParams(limit, after),
          fields:
            "id,account_id,name,status,thumbnail_url,image_hash,image_url,object_story_spec,asset_feed_spec,effective_object_story_id,object_type,url_tags,body,title,created_time",
        });
      }),
  );

  server.registerTool(
    "list_ad_images",
    {
      description: "List every image in the configured ad account media library.",
      inputSchema: { account_id: accountIdSchema, after: cursorSchema, limit: limitSchema },
      annotations: READ_ONLY,
    },
    ({ account_id, after, limit }) =>
      run(() =>
        client.get(`${client.accountId(account_id)}/adimages`, {
          ...listParams(limit, after),
          fields: "id,account_id,hash,name,url,url_128,width,height,status,created_time,updated_time",
        }),
      ),
  );

  server.registerTool(
    "get_pixels",
    {
      description: "List Meta Pixels owned by the configured ad account.",
      inputSchema: { account_id: accountIdSchema, after: cursorSchema, limit: limitSchema },
      annotations: READ_ONLY,
    },
    ({ account_id, after, limit }) =>
      run(() =>
        client.get(`${client.accountId(account_id)}/adspixels`, {
          ...listParams(limit, after),
          fields: "id,name,creation_time,last_fired_time,is_unavailable",
        }),
      ),
  );

  server.registerTool(
    "get_insights",
    {
      description: "Read Meta Ads performance insights for the configured account.",
      inputSchema: {
        account_id: accountIdSchema,
        after: cursorSchema,
        breakdowns: z.array(z.string()).optional(),
        date_preset: z.string().optional(),
        fields: z.array(z.string()).optional(),
        level: z.enum(["account", "campaign", "adset", "ad"]).optional(),
        limit: limitSchema,
        time_range: z.object({ since: z.string(), until: z.string() }).optional(),
      },
      annotations: READ_ONLY,
    },
    ({ account_id, after, breakdowns, date_preset, fields, level, limit, time_range }) =>
      run(() =>
        client.get(`${client.accountId(account_id)}/insights`, {
          ...listParams(limit, after),
          breakdowns: breakdowns?.join(","),
          date_preset: time_range ? undefined : date_preset || "last_30d",
          fields:
            fields?.join(",") ||
            "account_id,campaign_id,adset_id,ad_id,impressions,reach,clicks,spend,cpm,cpc,ctr,actions,cost_per_action_type",
          level: level || "account",
          time_range,
        }),
      ),
  );

  server.registerTool(
    "get_account_activities",
    {
      description: "Read the Meta Ads activity log for the configured account.",
      inputSchema: {
        account_id: accountIdSchema,
        after: cursorSchema,
        category: z.string().optional(),
        limit: limitSchema,
        since: z.string().optional(),
        until: z.string().optional(),
      },
      annotations: READ_ONLY,
    },
    ({ account_id, after, category, limit, since, until }) =>
      run(() =>
        client.get(`${client.accountId(account_id)}/activities`, {
          ...listParams(limit, after),
          business_id: config.businessId,
          category,
          fields:
            "event_time,event_type,actor_id,actor_name,application_id,application_name,object_id,object_name,object_type,extra_data",
          since,
          until,
        }),
      ),
  );

  server.registerTool(
    "search_targeting",
    {
      description: "Search official Meta targeting options such as interests or locations.",
      inputSchema: {
        country_code: z.string().optional(),
        limit: limitSchema,
        q: z.string(),
        type: z.enum(["adinterest", "adgeolocation", "adlocale", "adTargetingCategory"]),
      },
      annotations: READ_ONLY,
    },
    ({ country_code, limit, q, type }) =>
      run(() =>
        client.get("search", {
          country_code,
          limit: limit ?? 50,
          q,
          type,
        }),
      ),
  );

  server.registerTool(
    "create_campaign",
    {
      description: "Create a campaign in PAUSED state. New campaigns can never launch directly.",
      inputSchema: {
        account_id: accountIdSchema,
        confirm: confirmSchema,
        extra: changesSchema.optional(),
        name: z.string().min(1),
        objective: z.string(),
        special_ad_categories: z.array(z.string()).optional(),
      },
      annotations: WRITE,
    },
    ({ account_id, extra, name, objective, special_ad_categories }) =>
      run(() => {
        const account = client.writeAccountId(account_id);
        const safeExtra = sanitizeChanges(extra ?? {});
        client.assertBudgetMinor(safeExtra.daily_budget, "daily_budget");
        client.assertBudgetMinor(safeExtra.lifetime_budget, "lifetime_budget");
        return client.post(`${account}/campaigns`, {
          ...safeExtra,
          name,
          objective,
          special_ad_categories: special_ad_categories ?? [],
          status: "PAUSED",
        });
      }),
  );

  server.registerTool(
    "create_adset",
    {
      description: "Create an ad set in PAUSED state under a campaign owned by this account.",
      inputSchema: {
        account_id: accountIdSchema,
        billing_event: z.string(),
        campaign_id: z.string(),
        confirm: confirmSchema,
        daily_budget: z.number().int().positive().optional(),
        end_time: z.string().optional(),
        extra: changesSchema.optional(),
        lifetime_budget: z.number().int().positive().optional(),
        name: z.string().min(1),
        optimization_goal: z.string(),
        promoted_object: changesSchema.optional(),
        start_time: z.string().optional(),
        targeting: changesSchema,
      },
      annotations: WRITE,
    },
    ({
      account_id,
      billing_event,
      campaign_id,
      daily_budget,
      end_time,
      extra,
      lifetime_budget,
      name,
      optimization_goal,
      promoted_object,
      start_time,
      targeting,
    }) =>
      run(async () => {
        const account = client.writeAccountId(account_id);
        await client.assertObjectOwned(campaign_id, account);
        client.assertBudgetMinor(daily_budget, "daily_budget");
        client.assertBudgetMinor(lifetime_budget, "lifetime_budget");
        return client.post(`${account}/adsets`, {
          ...sanitizeChanges(extra ?? {}),
          billing_event,
          campaign_id,
          daily_budget,
          end_time,
          lifetime_budget,
          name,
          optimization_goal,
          promoted_object,
          start_time,
          status: "PAUSED",
          targeting,
        });
      }),
  );

  server.registerTool(
    "create_ad_creative",
    {
      description:
        "Create an ad creative directly through Meta. spec must identify exactly one Page in the required META_PAGE_IDS allowlist.",
      inputSchema: {
        account_id: accountIdSchema,
        confirm: confirmSchema,
        name: z.string().min(1),
        spec: changesSchema,
      },
      annotations: WRITE,
    },
    ({ account_id, name, spec }) =>
      run(() => {
        const account = client.writeAccountId(account_id);
        const pageIds = extractCreativePageIds(spec);
        if (pageIds.size === 0) {
          throw new Error(
            "Creative spec must identify one allowlisted Page using page_id, object_story_spec.page_id, or object_story_id",
          );
        }
        if (pageIds.size > 1) {
          throw new Error("Creative spec contains conflicting Page identities");
        }
        const pageId = pageIds.values().next().value;
        if (!pageId) throw new Error("Creative spec does not contain a valid Page ID");
        client.assertPageAllowed(pageId);
        return client.post(`${account}/adcreatives`, {
          ...sanitizeChanges(spec),
          name,
        });
      }),
  );

  server.registerTool(
    "create_ad",
    {
      description: "Create an ad in PAUSED state using an owned ad set and creative.",
      inputSchema: {
        account_id: accountIdSchema,
        adset_id: z.string(),
        confirm: confirmSchema,
        creative_id: z.string(),
        extra: changesSchema.optional(),
        name: z.string().min(1),
      },
      annotations: WRITE,
    },
    ({ account_id, adset_id, creative_id, extra, name }) =>
      run(async () => {
        const account = client.writeAccountId(account_id);
        await client.assertObjectOwned(adset_id, account);
        await client.assertObjectOwned(creative_id, account);
        return client.post(`${account}/ads`, {
          ...sanitizeChanges(extra ?? {}),
          adset_id,
          creative: { creative_id },
          name,
          status: "PAUSED",
        });
      }),
  );

  server.registerTool(
    "upload_ad_image",
    {
      description: "Upload base64 image bytes directly to the configured Meta ad account.",
      inputSchema: {
        account_id: accountIdSchema,
        confirm: confirmSchema,
        image_base64: z.string(),
        name: z.string().optional(),
      },
      annotations: WRITE,
    },
    ({ account_id, image_base64, name }) =>
      run(() => {
        const base64 = image_base64.replace(/^data:image\/[A-Za-z0-9.+-]+;base64,/, "");
        const bytes = Buffer.from(base64, "base64");
        if (bytes.length === 0) throw new Error("image_base64 is empty or invalid");
        if (bytes.length > 20 * 1024 * 1024) throw new Error("Image exceeds the 20 MiB local limit");
        return client.post(`${client.writeAccountId(account_id)}/adimages`, {
          bytes: base64,
          name,
        });
      }),
  );

  const registerUpdate = (
    name: "update_campaign" | "update_adset" | "update_ad",
    idName: "campaign_id" | "adset_id" | "ad_id",
    description: string,
  ) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: {
          account_id: accountIdSchema,
          changes: changesSchema,
          confirm: confirmSchema,
          [idName]: z.string(),
        },
        annotations: WRITE,
      },
      (args) =>
        run(async () => {
          const account = client.writeAccountId(args.account_id);
          const objectId = args[idName] as string;
          const changes = sanitizeChanges(args.changes);
          await client.assertObjectOwned(objectId, account);
          client.assertActivationAllowed(changes.status);
          client.assertBudgetMinor(changes.daily_budget, "daily_budget");
          client.assertBudgetMinor(changes.lifetime_budget, "lifetime_budget");
          if (typeof changes.creative_id === "string") {
            await client.assertObjectOwned(changes.creative_id, account);
            changes.creative = { creative_id: changes.creative_id };
            delete changes.creative_id;
          }
          return client.post(objectId, changes);
        }),
    );
  };

  registerUpdate(
    "update_campaign",
    "campaign_id",
    "Update an owned campaign. Set status to ACTIVE, PAUSED or DELETED explicitly in changes.",
  );
  registerUpdate(
    "update_adset",
    "adset_id",
    "Update an owned ad set, including status, schedule, targeting or budget.",
  );
  registerUpdate(
    "update_ad",
    "ad_id",
    "Update an owned ad, including status, name or creative_id.",
  );

  server.registerTool(
    "delete_ad_creative",
    {
      description: "Permanently delete an owned ad creative.",
      inputSchema: {
        account_id: accountIdSchema,
        confirm: confirmSchema,
        creative_id: z.string(),
      },
      annotations: DESTRUCTIVE,
    },
    ({ account_id, creative_id }) =>
      run(async () => {
        const account = client.writeAccountId(account_id);
        await client.assertObjectOwned(creative_id, account);
        return client.delete(creative_id);
      }),
  );

  server.registerTool(
    "delete_ad_image",
    {
      description: "Permanently delete an image hash from the configured ad account library.",
      inputSchema: {
        account_id: accountIdSchema,
        confirm: confirmSchema,
        image_hash: z.string(),
      },
      annotations: DESTRUCTIVE,
    },
    ({ account_id, image_hash }) =>
      run(() =>
        client.delete(`${client.writeAccountId(account_id)}/adimages`, { hash: image_hash }),
      ),
  );

  server.registerTool(
    "create_pixel",
    {
      description: "Create a Meta Pixel owned by the configured ad account.",
      inputSchema: {
        account_id: accountIdSchema,
        confirm: confirmSchema,
        name: z.string().min(1),
      },
      annotations: WRITE,
    },
    ({ account_id, name }) =>
      run(() => client.post(`${client.writeAccountId(account_id)}/adspixels`, { name })),
  );

  return { client, server };
}

export async function main(): Promise<void> {
  const { server } = createMetaAdsServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("FounderBench direct Meta Ads MCP running over stdio");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
