import type {
  ClassifierChoiceAnswer,
  ClassifierResult,
} from "@earendil-works/pi-ai";
import type { DecisionAttempt, DecisionTrace } from "./logging.ts";
import type { Config, Profile } from "./config.ts";
import {
  buildRequest,
  currentProfile,
  matches,
  selectProfile,
  withDeadline,
} from "./decision.ts";
import type { Classifier, Current } from "./decision.ts";

export type Action = "approve" | "reject" | "reselect";
export interface FlowHost {
  current(): Current;
  eligible(profile: Profile): string | undefined;
  currentUsable(): boolean;
  classify: Classifier;
  hasUI: boolean;
  confirm(
    current: Current,
    proposed: Profile,
    reselect: boolean,
    signal: AbortSignal,
  ): Promise<Action | undefined>;
  apply(
    profile: Profile,
  ): Promise<"applied" | "failed" | "cancelled" | "fatal">;
  notify(message: string): void;
  abort(): void;
}
export type Outcome =
  | "disabled"
  | "unchanged"
  | "rejected"
  | "applied"
  | "failed"
  | "cancelled"
  | "fatal";
export interface Decision {
  outcome: Outcome;
  profileId?: string;
  reason?: string;
}
export async function decide(
  config: Config,
  host: FlowHost,
  prompt: string,
  messages: readonly unknown[],
  signal: AbortSignal,
  trace: DecisionTrace = { attempts: [] },
): Promise<Decision> {
  if (!config.enabled) return { outcome: "disabled" };
  const current = host.current();
  const unchanged = () =>
    JSON.stringify(host.current()) === JSON.stringify(current);
  const cancelled = () => signal.aborted || !unchanged();
  const fallback = (reason: string): Decision => {
    if (cancelled()) return { outcome: "cancelled" };
    host.notify(reason);
    if (!host.currentUsable()) {
      host.abort();
      return { outcome: "fatal", reason: "Current model is unavailable" };
    }
    return { outcome: "failed", reason };
  };
  try {
    if (cancelled()) return { outcome: "cancelled" };
    const eligible = config.profiles.filter((p) => {
      const reason = host.eligible(p);
      if (reason) host.notify(`${p.id}: ${reason}`);
      return !reason;
    });
    if (!eligible.length)
      return fallback("No usable profiles; keeping current model");
    const excluded = new Set<string>();
    while (true) {
      if (cancelled()) return { outcome: "cancelled" };
      const candidates = eligible.filter(
        (p) => !excluded.has(p.id) && !host.eligible(p),
      );
      if (!candidates.length) return fallback("No remaining usable profiles");
      const attempt: DecisionAttempt = {
        candidates: candidates.map((p) => p.id),
        source: candidates.length === 1 ? "single_candidate" : "classifier",
        proposedProfile: null,
        probabilities: null,
        durationMs: 0,
      };
      trace.attempts.push(attempt);
      let selected: Profile;
      const started = performance.now();
      try {
        if (candidates.length === 1) selected = candidates[0]!;
        else {
          const result = await withDeadline(
            (s) =>
              host.classify(
                buildRequest(config, candidates, current, prompt, messages),
                s,
              ),
            config.classifier?.timeoutMs ?? 5000,
            signal,
          );
          if (cancelled()) return { outcome: "cancelled" };
          selected = selectProfile(
            result,
            candidates,
            currentProfile(current, config.profiles),
          );
          // Only retain the validated distribution, never a raw provider response.
          const answer = (result as ClassifierResult).answers
            .profile as ClassifierChoiceAnswer;
          attempt.probabilities = { ...answer.probabilities };
        }
        attempt.proposedProfile = {
          id: selected.id,
          model: { ...selected.model },
          thinking: selected.thinking,
        };
      } catch (error) {
        attempt.error =
          error instanceof Error ? error.message : "Classifier failed";
        throw error;
      } finally {
        attempt.durationMs = Math.max(0, performance.now() - started);
      }
      if (matches(current, selected))
        return { outcome: "unchanged", profileId: selected.id };
      if (
        config.mode === "ask" ||
        (config.mode === "selective" && selected.ask)
      ) {
        if (!host.hasUI) {
          attempt.confirmation = "unavailable";
          if (!host.currentUsable())
            return fallback("Cannot confirm and current model is unavailable");
          return {
            outcome: "rejected",
            profileId: selected.id,
            reason: "Confirmation UI unavailable",
          };
        }
        const remaining = candidates.filter((p) => p.id !== selected.id).length;
        const action = await host.confirm(
          current,
          selected,
          remaining >= 2,
          signal,
        );
        attempt.confirmation = action ?? "dismissed";
        if (cancelled()) return { outcome: "cancelled" };
        if (action === "reselect" && remaining >= 2) {
          excluded.add(selected.id);
          continue;
        }
        if (action !== "approve") {
          if (!host.currentUsable())
            return fallback("Rejected change and current model is unavailable");
          return { outcome: "rejected", profileId: selected.id };
        }
      } else {
        attempt.confirmation = "auto";
      }
      if (cancelled()) return { outcome: "cancelled" };
      const reason = host.eligible(selected);
      if (reason)
        return fallback(`Proposed profile is no longer usable: ${reason}`);
      const outcome = await host.apply(selected);
      if (outcome === "fatal") host.abort();
      return { outcome, profileId: selected.id };
    }
  } catch (error) {
    return fallback(error instanceof Error ? error.message : "Decision failed");
  }
}
