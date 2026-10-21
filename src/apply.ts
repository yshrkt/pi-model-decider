import type { Profile, Thinking } from "./config.ts";
export interface ModelRef {
  provider: string;
  id: string;
}
export interface ApplyHost<M extends ModelRef> {
  getModel(): M | undefined;
  getThinking(): Thinking;
  resolve(profile: Profile): M | undefined;
  setModel(model: M): Promise<boolean>;
  setThinking(level: Thinking): void;
  valid(): boolean;
  usable(model: M): boolean;
  notify(message: string): void;
}
const same = (a: ModelRef | undefined, b: ModelRef | undefined) =>
  a?.provider === b?.provider && a?.id === b?.id;
export async function applyProfile<M extends ModelRef>(
  profile: Profile,
  host: ApplyHost<M>,
): Promise<"applied" | "failed" | "cancelled" | "fatal"> {
  const original = host.getModel();
  const thinking = host.getThinking();
  const target = host.resolve(profile);
  if (!host.valid()) return "cancelled";
  if (!target || !host.usable(target))
    return original && host.usable(original) ? "failed" : "fatal";
  try {
    if (!same(original, target) && !(await host.setModel(target)))
      throw new Error("Model change was rejected");
    if (!host.valid()) return "cancelled";
    host.setThinking(profile.thinking);
    if (
      !same(host.getModel(), target) ||
      host.getThinking() !== profile.thinking
    )
      throw new Error("Model/thinking did not match the profile");
    return "applied";
  } catch {
    // Never restore into a replaced session or over a manual selection.
    if (!host.valid()) return "cancelled";
    host.notify("Profile change failed; restoring the previous model/thinking");
    try {
      if (!original || !host.usable(original))
        throw new Error("Original model unavailable");
      if (!same(host.getModel(), original) && !(await host.setModel(original)))
        throw new Error("Restore rejected");
      if (!host.valid()) return "cancelled";
      host.setThinking(thinking);
      if (!same(host.getModel(), original) || host.getThinking() !== thinking)
        throw new Error("Restore mismatch");
      return "failed";
    } catch {
      if (!host.valid()) return "cancelled";
      host.notify(
        "Cannot restore the previous model/thinking; stopping the run",
      );
      return "fatal";
    }
  }
}
