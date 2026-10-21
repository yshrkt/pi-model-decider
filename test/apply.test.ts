import { test } from "node:test";
import assert from "node:assert/strict";
import { applyProfile } from "../src/apply.ts";
import type { ApplyHost, ModelRef } from "../src/apply.ts";
import type { Thinking } from "../src/config.ts";
import { profile, deferred } from "./helpers.ts";
function fixture() {
  let model: ModelRef = { provider: "test", id: "a" };
  let thinking: Thinking = "medium";
  let valid = true;
  const original = model;
  const changes: string[] = [];
  const host: ApplyHost<ModelRef> = {
    getModel: () => model,
    getThinking: () => thinking,
    resolve: (p) => p.model,
    setModel: async (m) => {
      changes.push(m.id);
      model = m;
      return true;
    },
    setThinking: (t) => {
      thinking = t;
    },
    valid: () => valid,
    usable: () => true,
    notify: () => {},
  };
  return {
    host,
    original,
    changes,
    invalidate: () => {
      valid = false;
    },
    setModel: (m: ModelRef) => {
      model = m;
    },
  };
}
test("apply model then thinking; thinking-only does not call setModel", async () => {
  const f = fixture();
  assert.equal(await applyProfile(profile("b"), f.host), "applied");
  assert.deepEqual(f.changes, ["b"]);
  const g = fixture();
  assert.equal(await applyProfile(profile("deep", "high"), g.host), "applied");
  assert.deepEqual(g.changes, []);
  assert.equal(g.host.getThinking(), "high");
});
test("model failure keeps original thinking; thinking mismatch restores model and thinking", async () => {
  const f = fixture();
  f.host.setModel = async () => false;
  assert.equal(await applyProfile(profile("b"), f.host), "failed");
  assert.equal(f.host.getModel(), f.original);
  const g = fixture();
  const set = g.host.setThinking;
  g.host.setThinking = (t) => set(t === "high" ? "low" : t);
  const p = { ...profile("b"), thinking: "high" as const };
  assert.equal(await applyProfile(p, g.host), "failed");
  assert.equal(g.host.getModel(), g.original);
  assert.equal(g.host.getThinking(), "medium");
  assert.deepEqual(g.changes, ["b", "a"]);
});
test("restore failure is fatal and cancellation never writes into a new session", async () => {
  const f = fixture();
  const set = f.host.setModel;
  f.host.setModel = async (m) => (m.id === "a" ? false : set(m));
  f.host.setThinking = () => {
    throw Error("failure");
  };
  assert.equal(await applyProfile(profile("b"), f.host), "fatal");
  const g = fixture();
  const d = deferred<boolean>();
  g.host.setModel = async () => d.promise;
  const running = applyProfile(profile("b"), g.host);
  g.invalidate();
  g.setModel({ provider: "new-session", id: "manual" });
  d.resolve(true);
  assert.equal(await running, "cancelled");
  assert.equal(g.host.getModel()?.provider, "new-session");
  assert.deepEqual(g.changes, []);
});
