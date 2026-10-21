import { readFile, open, rename, unlink, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];
export type Mode = "auto" | "ask" | "selective";
export interface Profile {
  id: string;
  model: { provider: string; id: string };
  thinking: Thinking;
  hint: string;
  ask: boolean;
}
export interface Config {
  enabled: boolean;
  classifier?: { provider: string; model: string; timeoutMs: number };
  selectionHint: string;
  mode: Mode;
  profiles: Profile[];
}
export const configPath = () =>
  join(homedir(), ".pi/agent/extensions/pi-model-decider/config.json");
export function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name}: expected object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()))
    throw new Error(`${name}: expected ${empty ? "" : "nonempty "}string`);
  return value;
}
function boolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name}: expected boolean`);
  return value;
}
export function parseConfig(value: unknown): Config {
  const raw = object(value, "config");
  const enabled = boolean(raw.enabled, "enabled", false);
  const mode = raw.mode === undefined ? "ask" : raw.mode;
  if (!["auto", "ask", "selective"].includes(mode as string))
    throw new Error("mode: expected auto, ask or selective");
  let classifier: Config["classifier"];
  if (raw.classifier !== undefined) {
    const c = object(raw.classifier, "classifier");
    const timeoutMs = c.timeoutMs === undefined ? 5000 : c.timeoutMs;
    if (
      typeof timeoutMs !== "number" ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 2147483647
    ) {
      throw new Error(
        "classifier.timeoutMs: expected positive integer <= 2147483647",
      );
    }
    classifier = {
      provider: string(c.provider, "classifier.provider"),
      model: string(c.model, "classifier.model"),
      timeoutMs,
    };
  }
  if (raw.profiles !== undefined && !Array.isArray(raw.profiles))
    throw new Error("profiles: expected array");
  const ids = new Set<string>();
  const combinations = new Set<string>();
  const profiles = ((raw.profiles ?? []) as unknown[]).map(
    (value, i): Profile => {
      const p = object(value, `profiles[${i}]`);
      const model = object(p.model, `profiles[${i}].model`);
      const id = string(p.id, `profiles[${i}].id`);
      if (ids.has(id)) throw new Error(`Duplicate profile ID: ${id}`);
      ids.add(id);
      const provider = string(model.provider, `${id}.model.provider`);
      const modelId = string(model.id, `${id}.model.id`);
      if (!THINKING_LEVELS.includes(p.thinking as Thinking))
        throw new Error(`${id}.thinking: invalid level`);
      const combination = JSON.stringify([provider, modelId, p.thinking]);
      if (combinations.has(combination))
        throw new Error(`Duplicate model/thinking combination: ${id}`);
      combinations.add(combination);
      return {
        id,
        model: { provider, id: modelId },
        thinking: p.thinking as Thinking,
        hint: string(p.hint, `${id}.hint`, true),
        ask: boolean(p.ask, `${id}.ask`, true),
      };
    },
  );
  if (enabled && (!classifier || !profiles.length))
    throw new Error("enabled requires classifier and at least one profile");
  return {
    enabled,
    classifier,
    selectionHint:
      raw.selectionHint === undefined
        ? ""
        : string(raw.selectionHint, "selectionHint", true),
    mode: mode as Mode,
    profiles,
  };
}
export async function loadConfig(path: string): Promise<Config | undefined> {
  try {
    return parseConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// Re-read before writing: preserve values unknown to this extension, and never replace malformed JSON.
export async function saveEnabled(
  path: string,
  enabled: boolean,
): Promise<Config> {
  const original = await readFile(path, "utf8");
  const raw = object(JSON.parse(original), "config");
  parseConfig(raw);
  const next = { ...raw, enabled };
  const config = parseConfig(next);
  const mode = (await stat(path)).mode & 0o777;
  const temporary = join(dirname(path), `.config-${randomUUID()}.tmp`);
  let committed = false;
  try {
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await readFile(path, "utf8")) !== original)
      throw new Error("Configuration changed while saving; retry the command");
    await rename(temporary, path);
    committed = true;
    return config;
  } finally {
    if (!committed) await unlink(temporary).catch(() => {});
  }
}
