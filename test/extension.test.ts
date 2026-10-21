import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { register } from "../src/extension.ts";
import type { Dependencies } from "../src/extension.ts";
import type { Config, Thinking } from "../src/config.ts";
import type { DecisionLog } from "../src/logging.ts";
import { config, answer, deferred } from "./helpers.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
function fixture(c = config(), dependencies: Dependencies = {}) {
  const handlers = new Map<string, Handler[]>();
  let command!: (args: string, ctx: any) => Promise<void>;
  const model = (id: string) => ({
    provider: "test",
    id,
    reasoning: true,
    input: ["text", "image"],
    thinkingLevelMap: {},
  });
  let selected = model("a");
  let thinking: Thinking = "medium";
  let classifierCalls = 0;
  let aborts = 0;
  const changes: string[] = [];
  const notices: string[] = [];
  const saves: boolean[] = [];
  const logs: DecisionLog[] = [];
  let response: () => Promise<unknown> = async () =>
    answer({ a: 0, b: 1, c: 0 });
  let choice: string | undefined = "Approve";
  let terminal: ((data: string) => unknown) | undefined;
  const emit = async (name: string, event: Record<string, unknown> = {}) => {
    for (const handler of handlers.get(name) ?? [])
      await handler({ type: name, ...event }, ctx);
  };
  const registry = {
    find: (_p: string, id: string) =>
      id === "missing" ? undefined : model(id),
    findOfType: () => ({ provider: "test", id: "judge" }),
    hasConfiguredAuth: () => true,
    classify: async () => {
      classifierCalls++;
      return response();
    },
  };
  const ctx = {
    mode: "rpc",
    hasUI: true,
    signal: undefined,
    get model() {
      return selected;
    },
    ui: {
      notify: (text: string) => notices.push(text),
      setStatus: () => {},
      onTerminalInput: (handler: (data: string) => unknown) => {
        terminal = handler;
        return () => {
          terminal = undefined;
        };
      },
      select: async () => choice,
    },
    sessionManager: { getSessionId: () => "session", getBranch: () => [] },
    modelRegistry: registry,
    abort: () => {
      aborts++;
    },
  } as unknown as ExtensionContext;
  const pi = {
    on: (event: string, fn: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    registerCommand: (_name: string, options: { handler: typeof command }) => {
      command = options.handler;
    },
    getThinkingLevel: () => thinking,
    getSettings: () => ({ defaultThinkingLevel: "low" }),
    setModel: async (next: typeof selected) => {
      const previousModel = selected;
      selected = next;
      changes.push(next.id);
      const previousLevel = thinking;
      thinking = "low";
      // Mimic Pi's asynchronous event draining for implicit thinking changes.
      if (previousLevel !== thinking)
        void emit("thinking_level_select", { previousLevel, level: thinking });
      await emit("model_select", { previousModel, model: next, source: "set" });
      return true;
    },
    setThinkingLevel: (level: Thinking) => {
      const previousLevel = thinking;
      thinking = level;
      if (previousLevel !== level)
        void emit("thinking_level_select", { previousLevel, level });
    },
  } as unknown as ExtensionAPI;
  register(pi, {
    path: "/unused/config.json",
    load: async () => c,
    save: async (_path, enabled) => {
      saves.push(enabled);
      return { ...c, enabled };
    },
    writeLog: async (entry) => {
      logs.push(entry);
    },
    ...dependencies,
  });
  return {
    emit,
    ctx,
    registry,
    notices,
    changes,
    saves,
    logs,
    command: (s: string) => command(s, ctx),
    calls: () => classifierCalls,
    aborts: () => aborts,
    response: (fn: typeof response) => {
      response = fn;
    },
    choice: (value: string | undefined) => {
      choice = value;
    },
    selected: () => selected,
    terminal: (data: string) => terminal?.(data),
    manual: async (id: string) => {
      selected = model(id);
      await emit("model_select", { model: selected, source: "cycle" });
    },
  };
}
const start = (f: ReturnType<typeof fixture>) =>
  f.emit("before_agent_start", { messageType: "user", prompt: "task" });

test("registers once per user run, respects model/implicit thinking events, skips custom and tools", async () => {
  const f = fixture();
  await f.emit("session_start");
  await start(f);
  assert.deepEqual(f.changes, ["b"]);
  assert.equal(f.calls(), 1);
  await f.emit("tool_result");
  await f.emit("turn_start");
  await f.emit("agent_start");
  await f.emit("before_agent_start", { messageType: "custom" });
  assert.equal(f.calls(), 1);
  await f.command("status");
  assert.equal(f.calls(), 1);
  assert.ok(f.notices.at(-1)?.includes("applied"));
});
test("persistent on/off and saving failure leaves runtime state unchanged", async () => {
  const f = fixture();
  await f.emit("session_start");
  await f.command("off");
  await start(f);
  assert.equal(f.calls(), 0);
  assert.deepEqual(f.saves, [false]);
  await f.command("on");
  await start(f);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.saves, [false, true]);
  const g = fixture(config(), {
    save: async () => {
      throw Error("disk full");
    },
  });
  await g.emit("session_start");
  await g.command("off");
  await start(g);
  assert.equal(g.calls(), 1);
  assert.ok(g.notices.some((x) => x.includes("disk full")));
});
test("late classifier results after off, manual selection, tree, shutdown, or session replacement are ignored", async () => {
  for (const operation of [
    "off",
    "manual",
    "session_before_tree",
    "session_shutdown",
    "session_start",
  ]) {
    const f = fixture();
    await f.emit("session_start");
    const d = deferred<unknown>();
    f.response(() => d.promise);
    const running = start(f);
    await new Promise((resolve) => setImmediate(resolve));
    if (operation === "off") await f.command("off");
    else if (operation === "manual") await f.manual("manual");
    else await f.emit(operation);
    await running;
    d.resolve(answer({ a: 0, b: 1, c: 0 }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.changes.length, 0, operation);
  }
});
test("invalid configuration and disabled state never call classifier", async () => {
  const c = config();
  c.enabled = false;
  const f = fixture(c);
  await f.emit("session_start");
  await start(f);
  await f.command("status");
  assert.equal(f.calls(), 0);
  const g = fixture(config(), {
    load: async () => {
      throw Error("invalid JSON");
    },
  });
  await g.emit("session_start");
  await start(g);
  assert.equal(g.calls(), 0);
  assert.ok(g.notices.some((x) => x.includes("invalid JSON")));
});
test("authentication, unsupported thinking, images and missing models filter candidates", async () => {
  const c = config();
  c.profiles[1]!.model.id = "missing";
  c.profiles[2]!.thinking = "xhigh";
  const f = fixture(c);
  await f.emit("session_start");
  await start(f);
  assert.equal(f.calls(), 0);
  assert.equal(f.changes.length, 0);
  assert.ok(f.notices.some((x) => x.includes("thinking level")));
  const g = fixture();
  g.registry.hasConfiguredAuth = () => false;
  await g.emit("session_start");
  await start(g);
  assert.equal(g.calls(), 0);
  assert.equal(g.aborts(), 1);
});
test("command save finishing after session replacement cannot change new runtime", async () => {
  const d = deferred<Config>();
  const f = fixture(config(), { save: () => d.promise });
  await f.emit("session_start");
  const saving = f.command("off");
  await new Promise((resolve) => setImmediate(resolve));
  await f.emit("session_start");
  d.resolve({ ...config(), enabled: false });
  await saving;
  await start(f);
  assert.equal(f.calls(), 1);
});

test("TUI Escape cancels a pending classifier, while confirmation dismissal is rejection", async () => {
  const f = fixture();
  Object.assign(f.ctx, { mode: "tui" });
  await f.emit("session_start");
  const d = deferred<unknown>();
  f.response(() => d.promise);
  const running = start(f);
  await new Promise((resolve) => setImmediate(resolve));
  f.terminal("\u001b");
  await running;
  d.resolve(answer({ a: 0, b: 1, c: 0 }));
  assert.equal(f.changes.length, 0);
  assert.equal(f.aborts(), 1);
  const g = fixture();
  Object.assign(g.ctx, { mode: "tui" });
  await g.emit("session_start");
  const dialog = deferred<string | undefined>();
  g.ctx.ui.select = () => dialog.promise;
  const confirming = start(g);
  await new Promise((resolve) => setImmediate(resolve));
  g.terminal("\u001b");
  dialog.resolve(undefined);
  await confirming;
  assert.equal(g.aborts(), 0);
  assert.equal(g.changes.length, 0);
});

test("decision log records instruction, proposal, validated probabilities, timing, and final state", async () => {
  const f = fixture();
  await f.emit("session_start");
  await start(f);
  assert.equal(f.logs.length, 1);
  const log = f.logs[0]!;
  assert.equal(log.instruction, "task");
  assert.equal(log.sessionId, "session");
  assert.equal(log.extension, "pi-model-decider");
  assert.equal(log.stream, "decisions");
  assert.equal(log.proposedProfile?.id, "b");
  assert.deepEqual(log.probabilities, { a: 0, b: 1, c: 0 });
  assert.equal(log.current.profileId, "a");
  assert.equal(log.finalSelection?.profileId, "b");
  assert.equal(log.result.outcome, "applied");
  assert.ok(log.durationMs >= log.classifierDurationMs);
  assert.ok(log.classifierDurationMs >= 0);
  assert.equal(log.attempts[0]?.confirmation, "approve");
  await f.command("off");
  await start(f);
  await f.command("status");
  assert.equal(f.logs.length, 1);
  assert.ok(f.notices.at(-1)?.includes("pi-model-decider-decisions.jsonl"));
});

test("log write failure does not change selection and warns only once per session", async () => {
  let writes = 0;
  const f = fixture(config(), {
    writeLog: async () => {
      writes++;
      throw Error("disk full");
    },
  });
  await f.emit("session_start");
  await start(f);
  await start(f);
  assert.deepEqual(f.changes, ["b"]);
  assert.equal(writes, 2);
  assert.equal(
    f.notices.filter((n) => n.includes("Could not write decision log")).length,
    1,
  );
});

test("cancelled decisions retain original session metadata without reading replaced context", async () => {
  const f = fixture();
  await f.emit("session_start");
  const d = deferred<unknown>();
  f.response(() => d.promise);
  const running = start(f);
  await new Promise((resolve) => setImmediate(resolve));
  await f.emit("session_shutdown");
  await running;
  const log = f.logs[0]!;
  assert.equal(log.result.outcome, "cancelled");
  assert.equal(log.sessionId, "session");
  assert.equal(log.finalSelection, null);
  assert.equal(log.probabilities, null);
  d.resolve(answer({ a: 0, b: 1, c: 0 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.logs.length, 1);
});
