import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig, saveEnabled } from "../src/config.ts";
import { config, profile } from "./helpers.ts";

test("defaults: disabled, ask mode, 5 seconds, ask true, empty selection hint", () => {
  const c = parseConfig({
    classifier: { provider: "p", model: "m" },
    profiles: [{ ...profile("a"), ask: undefined }],
  });
  assert.equal(c.enabled, false);
  assert.equal(c.mode, "ask");
  assert.equal(c.classifier?.timeoutMs, 5000);
  assert.equal(c.profiles[0]?.ask, true);
  assert.equal(c.selectionHint, "");
});
test("configuration validation and same model with distinct thinking", () => {
  const c = config([profile("a"), profile("deep", "high")]);
  assert.equal(c.profiles.length, 2);
  for (const bad of [
    { ...c, mode: "sometimes" },
    { ...c, enabled: "true" },
    { ...c, selectionHint: null },
    { ...c, classifier: { ...c.classifier, timeoutMs: 0 } },
    { ...c, classifier: { ...c.classifier, timeoutMs: 0.5 } },
    { ...c, classifier: { ...c.classifier, timeoutMs: Infinity } },
    { ...c, classifier: null },
    { ...c, profiles: [] },
    { ...c, classifier: undefined },
    { ...c, profiles: [profile("a"), profile("a", "high")] },
    {
      ...c,
      profiles: [profile("a"), { ...profile("b"), model: profile("a").model }],
    },
    { ...c, profiles: [{ ...profile("a"), ask: "no" }] },
    { ...c, profiles: [{ ...profile("a"), thinking: "extreme" }] },
  ])
    assert.throws(() => parseConfig(bad));
});
test("atomic enabled persistence preserves other values and file permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-decider-"));
  try {
    const path = join(dir, "config.json");
    assert.equal(await loadConfig(path), undefined);
    await writeFile(
      path,
      JSON.stringify({
        ...config(),
        enabled: false,
        custom: { untouched: true },
      }),
      { mode: 0o600 },
    );
    assert.equal((await saveEnabled(path, true)).enabled, true);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).custom, {
      untouched: true,
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await saveEnabled(path, false)).enabled, false);
    assert.deepEqual(await readdir(dir), ["config.json"]);
    await writeFile(path, "{ broken");
    await assert.rejects(saveEnabled(path, true));
    assert.equal(await readFile(path, "utf8"), "{ broken");
    await assert.rejects(loadConfig(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("cannot enable an incomplete config; malformed disabled config is not overwritten", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-decider-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(path, "{}");
    await assert.rejects(saveEnabled(path, true));
    assert.equal(await readFile(path, "utf8"), "{}");
    await writeFile(path, '{"mode":"bad"}');
    await assert.rejects(saveEnabled(path, false));
    assert.equal(await readFile(path, "utf8"), '{"mode":"bad"}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
