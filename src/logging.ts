import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config, Profile } from "./config.ts";
import type { Current } from "./decision.ts";
import type { Action, Decision } from "./flow.ts";

export interface DecisionAttempt {
  candidates: string[];
  source: "classifier" | "single_candidate";
  proposedProfile: Pick<Profile, "id" | "model" | "thinking"> | null;
  probabilities: Record<string, number> | null;
  durationMs: number;
  confirmation?: Action | "auto" | "unavailable" | "dismissed";
  error?: string;
}
export interface DecisionTrace {
  attempts: DecisionAttempt[];
}
export interface Selection extends Current {
  profileId: string | null;
}
export interface DecisionLog {
  timestamp: string;
  extension: "pi-model-decider";
  stream: "decisions";
  event: "decision_completed";
  requestId: string;
  sessionId: string;
  startedAt: string;
  instruction: string;
  classifier: Config["classifier"];
  mode: Config["mode"];
  current: Selection;
  proposedProfile: DecisionAttempt["proposedProfile"];
  probabilities: DecisionAttempt["probabilities"];
  durationMs: number;
  classifierDurationMs: number;
  attempts: DecisionAttempt[];
  result: Decision;
  finalSelection: Selection | null;
}
export type LogWriter = (entry: DecisionLog) => Promise<void>;
export const decisionLogPath = (configurationPath: string) =>
  join(dirname(configurationPath), "logs", "pi-model-decider-decisions.jsonl");

export function createLogWriter(path: string): LogWriter {
  let pending = Promise.resolve();
  return (entry) => {
    // Serialize immediately so a queued write cannot observe later trace mutations.
    const line = `${JSON.stringify(entry)}\n`;
    const write = async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const handle = await open(path, "a", 0o600);
      try {
        await handle.writeFile(line, "utf8");
      } finally {
        await handle.close();
      }
    };
    // One failed append must not prevent later requests from logging.
    pending = pending.catch(() => {}).then(write);
    return pending;
  };
}
