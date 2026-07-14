import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadRunConfig, FB_ROOT } from "../orchestrator/src/config.ts";

for (const file of ["smoke-2h.toml", "pilot-24h.toml"]) {
  test(`run config ${file} loads and has required fields`, () => {
    const cfg = loadRunConfig(join(FB_ROOT, "configs", file));
    assert.ok(cfg.run.name);
    assert.ok(cfg.run.duration_hours > 0);
    assert.ok(cfg.model.upstream_url.startsWith("https://"));
    assert.ok(cfg.model.proxy_port > 1024);
    assert.ok(cfg.opencode.port > 1024);
    assert.notEqual(cfg.model.proxy_port, cfg.opencode.port);
    assert.ok(cfg.heartbeat.stall_after_minutes > 0);
    assert.ok(cfg.budget.max_token_spend_usd > 0);
    assert.ok(cfg.prompts.kickoff.length > 50);
    assert.ok(cfg.prompts.continue.length > 20);
    assert.ok(cfg.prompts.wrapup.length > 20);
    assert.ok(Object.keys(cfg.metrics.commands).length > 0);
  });
}

test("smoke config forbids business spending", () => {
  const cfg = loadRunConfig(join(FB_ROOT, "configs", "smoke-2h.toml"));
  assert.equal(cfg.budget.max_business_spend_usd, 0);
});
