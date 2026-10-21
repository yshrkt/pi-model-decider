import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createLogWriter, decisionLogPath } from "../src/logging.ts";
import type { DecisionLog, DecisionTrace } from "../src/logging.ts";
import { configPath } from "../src/config.ts";
import { decide } from "../src/flow.ts";
import type { FlowHost } from "../src/flow.ts";
import { answer, config, profile } from "./helpers.ts";

const entry = (id: string): DecisionLog => ({
  timestamp: new Date().toISOString(),
  extension: "pi-model-decider",
  stream: "decisions",
  event: "decision_completed",
  requestId: id,
  sessionId: "session",
  startedAt: new Date().toISOString(),
  instruction: '指示\n"quoted"',
  classifier: config().classifier,
  mode: "ask",
  current: { profileId: null, thinking: "off" },
  proposedProfile: null,
  probabilities: null,
  durationMs: 1,
  classifierDurationMs: 1,
  attempts: [],
  result: { outcome: "failed" },
  finalSelection: { profileId: null, thinking: "off" },
});
test("default log path lives under the extension's configuration directory", () => {
  assert.equal(
    decisionLogPath(configPath()),
    join(
      homedir(),
      ".pi/agent/extensions/pi-model-decider/logs/pi-model-decider-decisions.jsonl",
    ),
  );
});
test("JSONL writer appends complete records in order and creates private files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-decider-log-"));
  try {
    const path = decisionLogPath(join(dir, "config.json"));
    const write = createLogWriter(path);
    const first = entry("first");
    const writing = write(first);
    first.instruction = "mutated later";
    await Promise.all([writing, write(entry("second")), write(entry("third"))]);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 3);
    const records = lines.map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map((r) => r.requestId),
      ["first", "second", "third"],
    );
    assert.equal(records[0].instruction, '指示\n"quoted"');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "logs"))).mode & 0o777, 0o700);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("failed write does not poison subsequent writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-decider-log-"));
  try {
    const path = decisionLogPath(join(dir, "config.json"));
    await writeFile(join(dir, "logs"), "blocked");
    const write = createLogWriter(path);
    await assert.rejects(write(entry("failed")));
    await unlink(join(dir, "logs"));
    await write(entry("recovered"));
    assert.equal(
      JSON.parse((await readFile(path, "utf8")).trim()).requestId,
      "recovered",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function host(): FlowHost {
  return {
    current: () => ({
      model: { provider: "test", id: "a" },
      thinking: "medium",
    }),
    eligible: () => undefined,
    currentUsable: () => true,
    classify: async () => answer({ a: 0, b: 1, c: 0 }),
    hasUI: true,
    confirm: async () => "approve",
    apply: async () => "applied",
    notify: () => {},
    abort: () => {},
  };
}
test("trace includes every reselect attempt, candidate set and confirmation action", async () => {
  const h = host();
  const trace: DecisionTrace = { attempts: [] };
  let calls = 0;
  h.classify = async () =>
    ++calls === 1 ? answer({ a: 0, b: 1, c: 0 }) : answer({ a: 0, c: 1 });
  h.confirm = async () => (calls === 1 ? "reselect" : "approve");
  assert.equal(
    (await decide(config(), h, "task", [], new AbortController().signal, trace))
      .outcome,
    "applied",
  );
  assert.deepEqual(
    trace.attempts.map((a) => a.proposedProfile?.id),
    ["b", "c"],
  );
  assert.deepEqual(
    trace.attempts.map((a) => a.candidates),
    [
      ["a", "b", "c"],
      ["a", "c"],
    ],
  );
  assert.deepEqual(
    trace.attempts.map((a) => a.confirmation),
    ["reselect", "approve"],
  );
  assert.deepEqual(trace.attempts[1]?.probabilities, { a: 0, c: 1 });
});
test("timeout and invalid responses do not log invented probabilities or raw responses", async () => {
  for (const classify of [
    async () => new Promise(() => {}),
    async () => ({ secretRawResponse: "do not log" }),
  ]) {
    const h = host();
    h.classify = classify;
    const c = config();
    c.classifier!.timeoutMs = 10;
    const trace: DecisionTrace = { attempts: [] };
    const result = await decide(
      c,
      h,
      "task",
      [],
      new AbortController().signal,
      trace,
    );
    assert.equal(result.outcome, "failed");
    assert.equal(trace.attempts[0]?.probabilities, null);
    assert.equal(trace.attempts[0]?.proposedProfile, null);
    assert.ok(trace.attempts[0]?.error);
    assert.ok(!JSON.stringify(trace).includes("secretRawResponse"));
  }
});
test("singleton, rejection and no-UI outcomes have accurate traces", async () => {
  const h = host();
  const trace: DecisionTrace = { attempts: [] };
  await decide(
    config([profile("b")]),
    h,
    "task",
    [],
    new AbortController().signal,
    trace,
  );
  assert.equal(trace.attempts[0]?.source, "single_candidate");
  assert.equal(trace.attempts[0]?.probabilities, null);
  h.confirm = async () => "reject";
  const rejected: DecisionTrace = { attempts: [] };
  assert.equal(
    (
      await decide(
        config(),
        h,
        "task",
        [],
        new AbortController().signal,
        rejected,
      )
    ).outcome,
    "rejected",
  );
  assert.equal(rejected.attempts[0]?.confirmation, "reject");
  h.hasUI = false;
  const noUI: DecisionTrace = { attempts: [] };
  await decide(config(), h, "task", [], new AbortController().signal, noUI);
  assert.equal(noUI.attempts[0]?.confirmation, "unavailable");
});
