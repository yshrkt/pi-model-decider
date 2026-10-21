import { randomUUID } from "node:crypto";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Config, Profile, Thinking } from "./config.ts";
import { configPath, loadConfig, saveEnabled } from "./config.ts";
import { currentProfile } from "./decision.ts";
import { applyProfile } from "./apply.ts";
import { decide } from "./flow.ts";
import type { Decision } from "./flow.ts";
import { createLogWriter, decisionLogPath } from "./logging.ts";
import type { DecisionTrace, LogWriter } from "./logging.ts";

export interface Dependencies {
  path?: string;
  load?: typeof loadConfig;
  save?: typeof saveEnabled;
  writeLog?: LogWriter;
}
export function register(pi: ExtensionAPI, deps: Dependencies = {}) {
  const path = deps.path ?? configPath();
  const load = deps.load ?? loadConfig;
  const save = deps.save ?? saveEnabled;
  const logPath = decisionLogPath(path);
  const writeLog = deps.writeLog ?? createLogWriter(logPath);
  let logWarningShown = false;
  let config: Config | undefined;
  let last: Decision | undefined;
  let active: AbortController | undefined;
  let epoch = 0;
  let expectedModel: { provider: string; id: string } | undefined;
  const expectedThinking: Array<{ previous: Thinking; level: Thinking }> = [];
  let sessionOwner = {};
  let commandQueue = Promise.resolve();
  let unsubscribe: (() => void) | undefined;
  let confirming = false;
  const invalidate = () => {
    epoch++;
    active?.abort();
    active = undefined;
  };
  const current = (ctx: ExtensionContext) => ({
    model: ctx.model
      ? { provider: ctx.model.provider, id: ctx.model.id }
      : undefined,
    thinking: pi.getThinkingLevel() as Thinking,
  });
  const notify = (ctx: ExtensionContext, message: string) =>
    ctx.ui.notify(`model-decider: ${message}`, "warning");
  const status = (ctx: ExtensionContext) =>
    ctx.ui.setStatus(
      "model-decider",
      `decider:${config?.enabled ? "on" : "off"}${config ? ` · ${currentProfile(current(ctx), config.profiles) ?? "unmanaged"}` : ""}`,
    );
  const usable = (ctx: ExtensionContext) =>
    !!ctx.model &&
    !!ctx.modelRegistry.find(ctx.model.provider, ctx.model.id) &&
    ctx.modelRegistry.hasConfiguredAuth(ctx.model) &&
    getSupportedThinkingLevels(ctx.model).includes(pi.getThinkingLevel());
  async function initialize(ctx: ExtensionContext) {
    invalidate();
    last = undefined;
    logWarningShown = false;
    sessionOwner = {};
    const owner = sessionOwner;
    unsubscribe?.();
    unsubscribe = undefined;
    config = undefined;
    try {
      const next = await load(path);
      if (owner !== sessionOwner) return;
      config = next;
    } catch (error) {
      if (owner !== sessionOwner) return;
      notify(
        ctx,
        `Invalid configuration: ${error instanceof Error ? error.message : "read failed"}`,
      );
    }
    if (ctx.mode === "tui") {
      // The run's AbortSignal may not exist yet in before_agent_start on Pi 1.2.
      // Esc in the confirmation selector means reject; elsewhere it cancels the starting run.
      unsubscribe = ctx.ui.onTerminalInput((data) => {
        if (
          active &&
          (data === "\u0003" || (data === "\u001b" && !confirming))
        ) {
          invalidate();
          ctx.abort();
        }
        return undefined;
      });
    }
    status(ctx);
  }
  pi.on("session_start", async (_event, ctx) => {
    await initialize(ctx);
  });
  pi.on("session_before_switch", () => {
    invalidate();
    sessionOwner = {};
  });
  pi.on("session_before_fork", () => {
    invalidate();
    sessionOwner = {};
  });
  pi.on("session_before_tree", () => {
    invalidate();
    sessionOwner = {};
  });
  pi.on("session_tree", (_event, ctx) => {
    invalidate();
    last = undefined;
    status(ctx);
  });
  pi.on("session_shutdown", () => {
    invalidate();
    sessionOwner = {};
    unsubscribe?.();
    unsubscribe = undefined;
  });
  pi.on("model_select", (event, ctx) => {
    if (
      !expectedModel ||
      event.source !== "set" ||
      event.model.provider !== expectedModel.provider ||
      event.model.id !== expectedModel.id
    )
      invalidate();
    status(ctx);
  });
  pi.on("thinking_level_select", (event, ctx) => {
    const index = expectedThinking.findIndex(
      (e) => e.level === event.level && e.previous === event.previousLevel,
    );
    if (index < 0) invalidate();
    else expectedThinking.splice(index, 1);
    status(ctx);
  });
  pi.registerCommand("model-decider", {
    description: "Classifier routing: on | off | status (on/off are saved)",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "status") {
        ctx.ui.notify(
          `model-decider: ${config?.enabled ? "on" : "off"}\nConfig: ${path}\nLog: ${logPath}\nCurrent: ${JSON.stringify(current(ctx))}\nProfile: ${config ? (currentProfile(current(ctx), config.profiles) ?? "unmanaged") : "unmanaged"}\nLast: ${last ? JSON.stringify(last) : "none"}`,
          "info",
        );
        return;
      }
      if (action !== "on" && action !== "off") {
        notify(ctx, "Usage: /model-decider on|off|status");
        return;
      }
      const owner = sessionOwner;
      const command = async () => {
        if (owner !== sessionOwner) return;
        try {
          const next = await save(path, action === "on");
          // A successfully saved preference takes effect only in the session owning this command.
          if (sessionOwner !== owner) return;
          invalidate();
          config = next;
          status(ctx);
          ctx.ui.notify(
            `model-decider: ${next.enabled ? "on" : "off"} (saved)`,
            "info",
          );
        } catch (error) {
          if (sessionOwner === owner)
            notify(
              ctx,
              `Could not save; state unchanged: ${error instanceof Error ? error.message : "write failed"}`,
            );
        }
      };
      commandQueue = commandQueue.then(command, command);
      await commandQueue;
    },
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (event.messageType !== "user" || !config?.enabled) return;
    invalidate();
    const controller = new AbortController();
    active = controller;
    const generation = epoch;
    const valid = () => epoch === generation && !controller.signal.aborted;
    const runConfig = config;
    const owner = sessionOwner;
    const started = performance.now();
    const startedAt = new Date().toISOString();
    const requestId = randomUUID();
    const sessionId = ctx.sessionManager.getSessionId();
    const initial = {
      ...current(ctx),
      profileId: currentProfile(current(ctx), runConfig.profiles),
    };
    const trace: DecisionTrace = { attempts: [] };
    let decision: Decision = { outcome: "cancelled" };
    const parent = ctx.signal;
    const onAbort = () => controller.abort();
    parent?.addEventListener("abort", onAbort, { once: true });
    if (parent?.aborted) controller.abort();
    try {
      const messages = buildSessionContext(
        ctx.sessionManager.getBranch(),
      ).messages;
      const needsImages =
        !!event.images?.length ||
        messages.some(
          (m) =>
            "content" in m &&
            Array.isArray(m.content) &&
            m.content.some((b) => b.type === "image"),
        );
      const resolve = (p: Profile) =>
        ctx.modelRegistry.find(p.model.provider, p.model.id);
      const eligible = (p: Profile) => {
        const model = resolve(p);
        if (!model) return "model not registered";
        if (!ctx.modelRegistry.hasConfiguredAuth(model))
          return "authentication not configured";
        if (!getSupportedThinkingLevels(model).includes(p.thinking))
          return "thinking level not supported";
        if (needsImages && !model.input.includes("image"))
          return "image input not supported";
        return undefined;
      };
      decision = await decide(
        runConfig,
        {
          current: () => current(ctx),
          eligible,
          currentUsable: () =>
            usable(ctx) &&
            (!needsImages || !!ctx.model?.input.includes("image")),
          hasUI: ctx.hasUI,
          classify: async (request, signal) => {
            const c = runConfig.classifier;
            if (!c) throw new Error("Classifier is not configured");
            const model = ctx.modelRegistry.findOfType(
              "classifier",
              c.provider,
              c.model,
            );
            if (!model) throw new Error("Classifier is not registered");
            return ctx.modelRegistry.classify(model, request, {
              signal,
              timeoutMs: c.timeoutMs,
              maxRetries: 0,
            });
          },
          confirm: async (from, proposed, reselect, signal) => {
            confirming = true;
            try {
              const choice = await ctx.ui.select(
                `model-decider: ${currentProfile(from, runConfig.profiles) ?? "unmanaged"} (${from.model?.provider}/${from.model?.id}, ${from.thinking}) → ${proposed.id} (${proposed.model.provider}/${proposed.model.id}, ${proposed.thinking})`,
                ["Approve", "Reject", ...(reselect ? ["Reselect"] : [])],
                { signal },
              );
              return choice === "Approve"
                ? "approve"
                : choice === "Reselect"
                  ? "reselect"
                  : "reject";
            } finally {
              confirming = false;
            }
          },
          apply: async (profile) => {
            const result = await applyProfile(profile, {
              getModel: () => ctx.model,
              getThinking: () => pi.getThinkingLevel() as Thinking,
              resolve,
              valid,
              usable: (model) => ctx.modelRegistry.hasConfiguredAuth(model),
              setModel: async (model) => {
                expectedModel = model;
                // Pi may clamp thinking as part of setModel and emit that level first.
                const settings = pi.getSettings();
                const before = pi.getThinkingLevel() as Thinking;
                const level = clampThinkingLevel(
                  model,
                  settings.modelThinkingLevels?.[
                    `${model.provider}/${model.id}`
                  ] ??
                    settings.defaultThinkingLevel ??
                    before,
                ) as Thinking;
                const expected = { previous: before, level };
                if (before !== level) expectedThinking.push(expected);
                try {
                  return await pi.setModel(model);
                } finally {
                  expectedModel = undefined;
                  if (pi.getThinkingLevel() !== level) {
                    const index = expectedThinking.indexOf(expected);
                    if (index >= 0) expectedThinking.splice(index, 1);
                  }
                }
              },
              setThinking: (level) => {
                const before = pi.getThinkingLevel() as Thinking;
                if (before !== level)
                  expectedThinking.push({ previous: before, level });
                pi.setThinkingLevel(level);
              },
              notify: (message) => notify(ctx, message),
            });
            return result;
          },
          notify: (message) => notify(ctx, message),
          abort: () => ctx.abort(),
        },
        event.prompt,
        messages,
        controller.signal,
        trace,
      );
      if (valid()) {
        last = decision;
        status(ctx);
      }
    } catch {
      if (valid()) {
        decision = {
          outcome: usable(ctx) ? "failed" : "fatal",
          reason: "Unexpected routing failure",
        };
        last = decision;
        notify(ctx, "Unexpected routing failure; keeping current model");
        if (!usable(ctx)) ctx.abort();
      }
    } finally {
      parent?.removeEventListener("abort", onAbort);
      if (active === controller) active = undefined;
      const proposal = trace.attempts.at(-1);
      // A replaced session's ctx is stale. Do not inspect it while finishing the old log.
      const finalSelection =
        owner === sessionOwner
          ? {
              ...current(ctx),
              profileId: currentProfile(current(ctx), runConfig.profiles),
            }
          : null;
      try {
        await writeLog({
          timestamp: new Date().toISOString(),
          extension: "pi-model-decider",
          stream: "decisions",
          event: "decision_completed",
          requestId,
          sessionId,
          startedAt,
          instruction: event.prompt,
          classifier: runConfig.classifier,
          mode: runConfig.mode,
          current: initial,
          proposedProfile: proposal?.proposedProfile ?? null,
          probabilities: proposal?.probabilities ?? null,
          durationMs: Math.max(0, performance.now() - started),
          classifierDurationMs: trace.attempts
            .filter((a) => a.source === "classifier")
            .reduce((sum, a) => sum + a.durationMs, 0),
          attempts: trace.attempts,
          result: decision,
          finalSelection,
        });
      } catch {
        if (owner === sessionOwner && !logWarningShown) {
          logWarningShown = true;
          notify(ctx, `Could not write decision log: ${logPath}`);
        }
      }
    }
  });
}
