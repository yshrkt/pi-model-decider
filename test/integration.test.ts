import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  fauxProvider,
  fauxAssistantMessage,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import type { ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { decisionLogPath } from "../src/logging.ts";
import { register } from "../src/extension.ts";
import { config, profile, answer } from "./helpers.ts";

test("real Pi 1.2 extension loader, classifier registry, model/thinking events, UI and commands (no network)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-decider-sdk-"));
  const c = config([profile("a"), profile("deep", "high")]);
  c.profiles[1]!.model.id = "b";
  c.classifier = { provider: "test", model: "judge", timeoutMs: 5000 };
  const configFile = join(dir, "config.json");
  await writeFile(configFile, JSON.stringify(c));
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(dir, "models-store.json"),
    refreshOnCreate: false,
  });
  const faux = fauxProvider({
    provider: "test",
    models: [
      { id: "a", reasoning: true },
      { id: "b", reasoning: true },
    ],
    tokensPerSecond: Infinity,
  });
  const judge: ClassifierModel<string> = {
    type: "classifier",
    provider: "test",
    id: "judge",
    name: "Judge",
    api: "test-classifier",
    input: ["text"],
    baseUrl: "http://unused.invalid",
    contextWindow: 32000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let classifications = 0;
  runtime.registerNativeProvider({
    ...faux.provider,
    getAllModels: () => [...faux.models, judge],
    classify: async (_model, request, options) => {
      classifications++;
      assert.equal(request.questions.profile?.type, "choice");
      assert.equal(options?.maxRetries, 0);
      return {
        ...answer({ a: 0, deep: 1 }),
        api: judge.api,
        provider: judge.provider,
        model: judge.id,
        timestamp: Date.now(),
      } as ClassifierResult;
    },
  });
  await runtime.refresh({ allowNetwork: false });
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    defaultThinkingLevel: "low",
    modelThinkingLevels: { "test/a": "minimal" },
  });
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [(pi) => register(pi, { path: configFile })],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime: runtime,
    model: faux.models[0],
    thinkingLevel: "medium",
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(dir),
    noTools: "all",
  });
  const errors: unknown[] = [];
  const choices: string[][] = [];
  try {
    await session.bindExtensions({
      mode: "rpc",
      onError: (error) => errors.push(error),
      uiContext: {
        select: async (_title: string, options: string[]) => {
          choices.push(options);
          return "Approve";
        },
        notify: () => {},
        setStatus: () => {},
      } as any,
    });
    faux.setResponses([fauxAssistantMessage("done")]);
    await session.prompt("Implement this task");
    assert.equal(classifications, 1);
    assert.equal(session.model?.id, "b");
    assert.equal(session.thinkingLevel, "high");
    assert.equal(choices.length, 1);
    assert.deepEqual(choices[0], ["Approve", "Reject"]);
    assert.deepEqual(errors, []);
    assert.equal(settings.getDefaultThinkingLevel(), "low");
    const lines = (await readFile(decisionLogPath(configFile), "utf8"))
      .trim()
      .split("\n");
    assert.equal(lines.length, 1);
    const log = JSON.parse(lines[0]!);
    assert.equal(log.instruction, "Implement this task");
    assert.equal(log.proposedProfile.id, "deep");
    assert.deepEqual(log.probabilities, { a: 0, deep: 1 });
    assert.equal(log.result.outcome, "applied");
    assert.equal(log.finalSelection.thinking, "high");

    await session.prompt("/model-decider off");
    assert.equal(JSON.parse(await readFile(configFile, "utf8")).enabled, false);
    faux.setResponses([fauxAssistantMessage("done again")]);
    await session.prompt("Another task");
    assert.equal(classifications, 1);
    assert.equal(session.thinkingLevel, "high");
    // Also verify the actual package entry can be loaded by Pi's TypeScript extension loader.
    const entryLoader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      additionalExtensionPaths: [resolve("index.ts")],
    });
    await entryLoader.reload();
    assert.deepEqual(entryLoader.getExtensions().errors, []);
    assert.equal(entryLoader.getExtensions().extensions.length, 1);
  } finally {
    session.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
