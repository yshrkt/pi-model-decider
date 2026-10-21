import { test } from "node:test";
import assert from "node:assert/strict";
import type { FlowHost, Action } from "../src/flow.ts";
import { decide } from "../src/flow.ts";
import type { Current } from "../src/decision.ts";
import { config, answer, profile, deferred } from "./helpers.ts";

function fixture() {
  let state: Current = {
    model: { provider: "test", id: "a" },
    thinking: "medium",
  };
  const requests: string[][] = [];
  const confirmations: boolean[] = [];
  const applied: string[] = [];
  const notices: string[] = [];
  const actions: Action[] = ["approve"];
  let aborted = false;
  const host: FlowHost = {
    current: () => state,
    eligible: () => undefined,
    currentUsable: () => true,
    hasUI: true,
    classify: async (request) => {
      requests.push(
        Object.keys(
          request.questions.profile!.type === "choice"
            ? request.questions.profile!.criteria
            : {},
        ),
      );
      return answer({ a: 0, b: 1, c: 0 });
    },
    confirm: async (_current, _proposed, reselect) => {
      confirmations.push(reselect);
      return actions.shift();
    },
    apply: async (p) => {
      applied.push(p.id);
      state = { model: p.model, thinking: p.thinking };
      return "applied";
    },
    notify: (message) => notices.push(message),
    abort: () => {
      aborted = true;
    },
  };
  return {
    host,
    requests,
    confirmations,
    applied,
    notices,
    actions,
    setCurrent: (c: Current) => {
      state = c;
    },
    aborted: () => aborted,
  };
}
const run = (
  f: ReturnType<typeof fixture>,
  c = config(),
  signal = new AbortController().signal,
) => decide(c, f.host, "task", [], signal);

test("auto, ask, selective and same profile", async () => {
  for (const mode of ["auto", "ask", "selective"] as const) {
    for (const ask of [false, true]) {
      const f = fixture();
      const c = config();
      c.mode = mode;
      c.profiles[1]!.ask = ask;
      assert.equal((await run(f, c)).outcome, "applied");
      assert.equal(
        f.confirmations.length,
        mode === "ask" || (mode === "selective" && ask) ? 1 : 0,
      );
    }
  }
  const f = fixture();
  f.host.classify = async () => answer({ a: 1, b: 0, c: 0 });
  assert.equal((await run(f)).outcome, "unchanged");
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.applied.length, 0);
});
test("thinking-only changes obey selective ask", async () => {
  const f = fixture();
  const c = config([profile("a"), profile("deep", "high")]);
  c.mode = "selective";
  f.host.classify = async () => answer({ a: 0, deep: 1 });
  assert.equal((await run(f, c)).outcome, "applied");
  assert.equal(f.confirmations.length, 1);
});
test("reject, closed UI and missing UI keep current", async () => {
  for (const action of ["reject", undefined] as const) {
    const f = fixture();
    f.actions.splice(0, 1, ...(action ? [action] : []));
    assert.equal((await run(f)).outcome, "rejected");
    assert.equal(f.applied.length, 0);
  }
  const f = fixture();
  f.host.hasUI = false;
  assert.equal((await run(f)).outcome, "rejected");
  assert.equal(f.confirmations.length, 0);
});
test("reselect excludes all previous proposals and re-evaluates confirmation; exclusions reset per request", async () => {
  const f = fixture();
  const c = config([...config().profiles, profile("d")]);
  f.actions.splice(0, 1, "reselect", "reselect", "approve");
  const groups: string[][] = [];
  f.host.classify = async (request) => {
    const q = request.questions.profile!;
    assert.equal(q.type, "choice");
    if (q.type !== "choice") throw Error();
    const ids = Object.keys(q.criteria);
    groups.push(ids);
    const selected =
      groups.length === 1 ? "b" : groups.length === 2 ? "c" : "d";
    return answer(
      Object.fromEntries(ids.map((id) => [id, id === selected ? 1 : 0])),
    );
  };
  assert.equal((await run(f, c)).outcome, "applied");
  assert.deepEqual(groups, [
    ["a", "b", "c", "d"],
    ["a", "c", "d"],
    ["a", "d"],
  ]);
  assert.deepEqual(f.confirmations, [true, true, false]);
  assert.deepEqual(f.applied, ["d"]);
  f.host.classify = async (request) => {
    assert.equal(
      Object.keys((request.questions.profile as { criteria: object }).criteria)
        .length,
      4,
    );
    return answer({ a: 0, b: 0, c: 0, d: 1 });
  };
  assert.equal((await run(f, c)).outcome, "unchanged");
});
test("reselect count boundary, singleton bypass and no candidates", async () => {
  const f = fixture();
  const c = config([profile("a"), profile("b")]);
  f.host.classify = async () => answer({ a: 0, b: 1 });
  await run(f, c);
  assert.deepEqual(f.confirmations, [false]);
  const one = fixture();
  one.setCurrent({ thinking: "off" });
  assert.equal((await run(one, config([profile("a")]))).outcome, "applied");
  assert.deepEqual(one.confirmations, [false]);
  assert.equal(one.requests.length, 0);
  const none = fixture();
  none.host.eligible = () => "unavailable";
  assert.equal((await run(none)).outcome, "failed");
  assert.equal(none.requests.length, 0);
});
test("invalid response, excluded response, errors and timeout fall back", async () => {
  for (const classify of [
    async () => ({}),
    async () => {
      throw Error("unavailable");
    },
    async () => new Promise(() => {}),
  ]) {
    const f = fixture();
    f.host.classify = classify;
    const c = config();
    c.classifier!.timeoutMs = 10;
    assert.equal((await run(f, c)).outcome, "failed");
    assert.equal(f.applied.length, 0);
  }
  const f = fixture();
  f.actions.splice(0, 1, "reselect");
  let calls = 0;
  f.host.classify = async () => {
    calls++;
    return answer({ a: 0, b: 1, c: 0 });
  };
  assert.equal((await run(f)).outcome, "failed");
  assert.equal(calls, 2);
  assert.equal(f.applied.length, 0);
});
test("disabled, cancellation, manual change and unavailable incumbent", async () => {
  const f = fixture();
  const c = config();
  c.enabled = false;
  assert.equal((await run(f, c)).outcome, "disabled");
  assert.equal(f.requests.length, 0);
  const d = deferred<unknown>();
  const g = fixture();
  g.host.classify = () => d.promise;
  const running = run(g);
  g.setCurrent({ model: { provider: "test", id: "manual" }, thinking: "high" });
  d.resolve(answer({ a: 0, b: 1, c: 0 }));
  assert.equal((await running).outcome, "cancelled");
  assert.equal(g.applied.length, 0);
  const h = fixture();
  h.host.currentUsable = () => false;
  h.host.classify = async () => ({});
  assert.equal((await run(h)).outcome, "fatal");
  assert.equal(h.aborted(), true);
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (await run(f, config(), controller.signal)).outcome,
    "cancelled",
  );
});
test("revalidation after approval and aborting during confirmation", async () => {
  const f = fixture();
  let unavailable = false;
  f.host.eligible = (p) =>
    unavailable && p.id === "b" ? "auth removed" : undefined;
  f.host.confirm = async () => {
    unavailable = true;
    return "approve";
  };
  assert.equal((await run(f)).outcome, "failed");
  assert.equal(f.applied.length, 0);
  const g = fixture();
  const controller = new AbortController();
  g.host.confirm = async () => {
    controller.abort();
    return "approve";
  };
  assert.equal(
    (await run(g, config(), controller.signal)).outcome,
    "cancelled",
  );
  assert.equal(g.applied.length, 0);
});
