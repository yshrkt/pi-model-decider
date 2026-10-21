import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRequest,
  currentProfile,
  selectProfile,
  withDeadline,
} from "../src/decision.ts";
import { answer, config, deferred } from "./helpers.ts";

test("strict distribution validation; max, current tie, then config order", () => {
  const { profiles } = config();
  assert.equal(
    selectProfile(answer({ a: 0.2, b: 0.7, c: 0.1 }), profiles, "a").id,
    "b",
  );
  assert.equal(
    selectProfile(answer({ a: 0.5, b: 0.5, c: 0 }), profiles, "b").id,
    "b",
  );
  assert.equal(
    selectProfile(answer({ a: 0.5, b: 0.5, c: 0 }), profiles, null).id,
    "a",
  );
  for (const bad of [
    null,
    { stopReason: "error" },
    {},
    answer({ a: 1, b: 0 }),
    answer({ a: 1, b: 0, x: 0 }),
    answer({ a: 1, b: 0, c: NaN }),
    answer({ a: 1.2, b: -0.2, c: 0 }),
    answer({ a: 0, b: 0, c: 0 }),
    answer({ a: 0.9, b: 0.1, c: 0 }, "b"),
    { ...answer({ a: 1, b: 0, c: 0 }), stopReason: "aborted" },
    { stopReason: "stop", answers: { profile: { type: "score" } } },
  ])
    assert.throws(() => selectProfile(bad, profiles, null));
});
test("context is bounded, branch input is filtered, thinking and binary excluded", () => {
  const c = config();
  const request = buildRequest(
    c,
    c.profiles,
    { model: { provider: "other", id: "m" }, thinking: "low" },
    '"'.repeat(20000),
    [
      { role: "system", content: "SECRET_SYSTEM" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "SECRET_THINKING" },
          { type: "toolCall", arguments: { secret: "SECRET_ARGS" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "image", data: "SECRET_IMAGE" },
          { type: "text", text: "question" },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        isError: true,
        content: [{ type: "text", text: "useful result" }],
      },
    ],
  );
  const json = JSON.stringify(request);
  assert.ok(json.length <= 32000);
  assert.ok(!json.includes("SECRET"));
  assert.ok(json.includes("useful result"));
  assert.equal(request.state.truncated, true);
  assert.equal(
    currentProfile(
      { model: { provider: "other", id: "m" }, thinking: "low" },
      c.profiles,
    ),
    null,
  );
  c.selectionHint = "x".repeat(40000);
  assert.throws(() =>
    buildRequest(c, c.profiles, { thinking: "off" }, "task", []),
  );
});
test("deadline handles providers ignoring abort and cancels transport; no retry", async () => {
  const d = deferred<unknown>();
  let calls = 0;
  let transport: AbortSignal | undefined;
  await assert.rejects(
    withDeadline(
      (signal) => {
        calls++;
        transport = signal;
        return d.promise;
      },
      10,
      new AbortController().signal,
    ),
    /timed out/,
  );
  assert.equal(transport?.aborted, true);
  assert.equal(calls, 1);
  d.resolve(answer({ a: 1 }));
});
test("parent cancellation and already cancelled calls", async () => {
  const parent = new AbortController();
  const task = withDeadline(() => new Promise(() => {}), 5000, parent.signal);
  parent.abort();
  await assert.rejects(task, /cancelled/);
  let called = false;
  await assert.rejects(
    withDeadline(
      async () => {
        called = true;
      },
      10,
      parent.signal,
    ),
    /cancelled/,
  );
  assert.equal(called, false);
});
