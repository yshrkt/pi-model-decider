import { parseConfig } from "../src/config.ts";
import type { Profile } from "../src/config.ts";
export const profile = (
  id: string,
  thinking: Profile["thinking"] = "medium",
  ask = true,
): Profile => ({
  id,
  model: { provider: "test", id: thinking === "medium" ? id : "a" },
  thinking,
  hint: `Use ${id}`,
  ask,
});
export const config = (profiles = [profile("a"), profile("b"), profile("c")]) =>
  parseConfig({
    enabled: true,
    classifier: { provider: "test", model: "judge" },
    profiles,
  });
export const answer = (
  probabilities: Record<string, number>,
  choice = Object.keys(probabilities).reduce((a, b) =>
    probabilities[a]! >= probabilities[b]! ? a : b,
  ),
) => ({
  stopReason: "stop",
  answers: {
    profile: {
      type: "choice",
      choice,
      probabilities,
      confidence: probabilities[choice],
    },
  },
});
export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
