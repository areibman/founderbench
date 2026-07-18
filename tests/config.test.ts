import { test, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRunConfig, loadCredentialsEnv, FB_ROOT } from "../orchestrator/src/config.ts";

before(() => {
  process.env.MODEL_ID ??= "gpt-5.6-sol";
  process.env.MODEL_UPSTREAM_URL ??= "https://example.openai.azure.com/openai/v1";
});

for (const file of ["smoke-2h.toml", "pilot-24h.toml"]) {
  test(`run config ${file} loads and has required fields`, () => {
    const cfg = loadRunConfig(join(FB_ROOT, "configs", file));
    assert.ok(cfg.run.name);
    assert.ok(cfg.run.duration_hours > 0);
    assert.equal(cfg.model.model_id, process.env.MODEL_ID);
    assert.equal(cfg.model.upstream_url, process.env.MODEL_UPSTREAM_URL);
    assert.ok(cfg.model.proxy_port > 1024);
    assert.ok(cfg.opencode.port > 1024);
    assert.notEqual(cfg.model.proxy_port, cfg.opencode.port);
    assert.ok(cfg.heartbeat.stall_after_minutes > 0);
    assert.ok(cfg.prompts.kickoff.length > 20);
    assert.ok(cfg.prompts.continue.length > 10);
    assert.ok(cfg.prompts.wrapup.length > 20);
    assert.ok(Object.keys(cfg.metrics.commands).length > 0);
  });
}

test("workspace dir expands home", () => {
  const cfg = loadRunConfig(join(FB_ROOT, "configs", "smoke-2h.toml"));
  assert.ok(cfg.workspace.dir.length > 1);
  assert.notEqual(cfg.workspace.dir, "~");
  assert.ok(!cfg.workspace.dir.includes("$HOME"));
});

test("loadCredentialsEnv parses dotenv format (quotes, inline comments)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-cred-"));
  const p = join(dir, "credentials.env");
  writeFileSync(
    p,
    [
      'FB_TEST_QUOTED="abc" # inline comment',
      "FB_TEST_SINGLE='def'",
      "FB_TEST_PLAIN=ghi # comment",
      'FB_TEST_HASH="a#b"',
      "FB_TEST_PRESET=from-file",
    ].join("\n"),
  );
  process.env.FB_TEST_PRESET = "from-env";
  try {
    loadCredentialsEnv(p);
    assert.equal(process.env.FB_TEST_QUOTED, "abc");
    assert.equal(process.env.FB_TEST_SINGLE, "def");
    assert.equal(process.env.FB_TEST_PLAIN, "ghi");
    assert.equal(process.env.FB_TEST_HASH, "a#b");
    // Real environment wins over the file, like node --env-file.
    assert.equal(process.env.FB_TEST_PRESET, "from-env");
  } finally {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("FB_TEST_")) delete process.env[k];
    }
  }
});

test("missing MODEL_ID throws", () => {
  const saved = process.env.MODEL_ID;
  delete process.env.MODEL_ID;
  try {
    assert.throws(
      () => loadRunConfig(join(FB_ROOT, "configs", "smoke-2h.toml")),
      /MODEL_ID missing/,
    );
  } finally {
    process.env.MODEL_ID = saved;
  }
});
