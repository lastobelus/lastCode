// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";

import { checkActionCatalog, codexCatalogProbe } from "./actionPolicy.ts";
import { cases, taskPrompt, type Arm, type Scenario } from "./cases.ts";
import {
  printCases,
  requireCompleteSamples,
  type Results,
  type Sample,
  type ThreadLaunch,
} from "./metrics.ts";
import { readCodexActionCatalog, record } from "./observe.ts";
import { existingFile, isInside, positive } from "./paths.ts";
import {
  isQuiescent,
  observeFamily,
  readThreadEvidence,
  sampleMetrics,
  standing,
  type Snapshot,
} from "./sample.ts";
import {
  cli,
  configureFixtureAction,
  git,
  guidance,
  makeProject,
  registerProject,
  root,
  serverCliOverride,
  wrapperWaitInstruction,
} from "./project.ts";

const usage = `Usage: node evals/background-wait/run.ts --base-dir <dir> --arm a|b
  --init [--provider codex]
  --model <slug> --out <name> [--provider codex]
  [--case <id[,id...]>] [--samples <20>] [--concurrency <2>] [--effort <level>]
  [--duration-scale <1>] [--timeout-seconds <900>] [--dry-run]

--init creates an empty Codex eval home.
--dry-run prints the run plan without opening or creating any state.`;

function options() {
  return NodeUtil.parseArgs({
    options: {
      "base-dir": { type: "string" },
      arm: { type: "string" },
      out: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      case: { type: "string" },
      samples: { type: "string", default: "20" },
      concurrency: { type: "string", default: "2" },
      "duration-scale": { type: "string", default: "1" },
      "timeout-seconds": { type: "string", default: "900" },
      init: { type: "boolean" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean" },
    },
  }).values;
}

/** Reject links for generated directories and keep all state reads inside the chosen home. */
function contained(base: string, name: string): string {
  const path = NodePath.resolve(base, name);
  if (!isInside(base, path)) throw new Error("Eval path must be inside --base-dir.");
  let part = path;
  while (part !== base) {
    try {
      if (NodeFS.lstatSync(part).isSymbolicLink())
        throw new Error(`Symlink in eval state path: ${part}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    part = NodePath.dirname(part);
  }
  return path;
}

function initialize(base: string, arm: Arm) {
  NodeFS.mkdirSync(base, { mode: 0o700 });
  const home = "codex-home";
  for (const dir of ["userdata", home]) NodeFS.mkdirSync(NodePath.join(base, dir), { mode: 0o700 });
  NodeFS.writeFileSync(
    NodePath.join(base, "background-wait-eval-home.json"),
    JSON.stringify({ arm }),
    {
      mode: 0o600,
    },
  );
  NodeFS.writeFileSync(
    NodePath.join(base, "userdata/settings.json"),
    JSON.stringify(
      {
        lastcodeBackgroundWaitEnabled: arm === "b",
        defaultRuntimeMode: "full-access",
        worktreesDirectory: NodePath.join(base, "worktrees"),
        providerInstances: {
          codex: {
            driver: "codex",
            enabled: true,
            config: { homePath: NodePath.join(base, home) },
          },
          claudeAgent: { driver: "claudeAgent", enabled: false },
        },
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
}

function checkHome(base: string, arm: Arm) {
  const readJson = (name: string) =>
    record(JSON.parse(NodeFS.readFileSync(contained(base, name), "utf8")));
  const marker = readJson("background-wait-eval-home.json");
  if (marker.arm !== arm) throw new Error("Eval home arm does not match --arm.");
  const settings = readJson("userdata/settings.json");
  if ((settings.lastcodeBackgroundWaitEnabled === true) !== (arm === "b")) {
    throw new Error("Running dev home has the wrong lastcodeBackgroundWaitEnabled setting.");
  }
  if (settings.worktreesDirectory !== contained(base, "worktrees")) {
    throw new Error("The eval worktree root must remain under --base-dir.");
  }
  const home = contained(base, "codex-home");
  const instance = record(record(settings.providerInstances).codex);
  if (
    instance.enabled === false ||
    record(instance.config).homePath !== home ||
    record(instance.config).shadowHomePath
  ) {
    throw new Error("The selected provider must use the managed eval home below --base-dir.");
  }
  const runtime = readJson("userdata/server-runtime.json");
  const origin = new URL(String(runtime.origin));
  if (
    typeof runtime.devUrl !== "string" ||
    runtime.serviceManaged === true ||
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
    typeof runtime.pid !== "number"
  ) {
    throw new Error("Start a loopback dev instance with --no-seed in this eval home.");
  }
  if (runtime.pid < 1 || !Number.isInteger(runtime.pid)) throw new Error("Invalid dev server PID.");
  process.kill(runtime.pid, 0);
  return origin;
}

async function show(base: string, threadId: string): Promise<Snapshot> {
  return JSON.parse(
    await cli(base, ["thread", "show"], ["--messages", "3", "--json", threadId]),
  ) as Snapshot;
}

async function main() {
  const flags = options();
  if (flags.help) {
    console.log(usage);
    return;
  }
  if (
    !flags["base-dir"] ||
    (flags.arm !== "a" && flags.arm !== "b") ||
    NodePath.isAbsolute(flags["base-dir"]) === false
  )
    throw new Error(usage);
  const arm = flags.arm;
  const provider = flags.provider ?? "codex";
  if (provider === "claudeAgent") {
    throw new Error(
      "Launch Claude samples through delegate_task. Use make-fixture.ts and grade-sample.ts.",
    );
  }
  if (provider !== "codex") throw new Error(usage);
  const baseArgument = NodePath.resolve(flags["base-dir"]);
  if (flags.init) {
    if (flags["dry-run"]) throw new Error("--dry-run and --init are mutually exclusive.");
    initialize(
      NodePath.join(
        NodeFS.realpathSync(NodePath.dirname(baseArgument)),
        NodePath.basename(baseArgument),
      ),
      arm,
    );
    return;
  }

  const model = flags.model;
  const out = flags.out;
  if (!model || !out || !/^[a-zA-Z0-9_-]+$/u.test(out)) throw new Error(usage);
  const waitInstruction = wrapperWaitInstruction();
  const scale = positive(flags["duration-scale"], "duration-scale", false);
  const samples = positive(flags.samples, "samples");
  const concurrency = positive(flags.concurrency, "concurrency");
  const timeoutMs = positive(flags["timeout-seconds"], "timeout-seconds") * 1000;
  const selected = flags.case?.split(",") ?? cases.map(({ id }) => id);
  const chosen = selected.map((id) => {
    const scenario = cases.find((entry) => entry.id === id);
    if (scenario === undefined) throw new Error(`Unknown case: ${id}`);
    return scenario;
  });
  if (new Set(selected).size !== selected.length) throw new Error("Duplicate case id.");
  const seconds = (scenario: Scenario) => Math.max(1, Math.round(scenario.seconds * scale));
  const standingByCase = new Map(
    chosen.map((scenario) => [scenario.id, standing(arm, scenario, provider)]),
  );
  if (flags["dry-run"]) {
    console.log(
      JSON.stringify(
        {
          base: baseArgument,
          arm,
          provider,
          model,
          effort: flags.effort,
          serverCli: serverCliOverride,
          ...(arm === "b" ? { waitInstruction } : {}),
          out,
          samples,
          concurrency,
          cases: chosen.map((scenario) => ({
            id: scenario.id,
            fixtureSeconds: seconds(scenario),
            expectedStages: "stages" in scenario ? scenario.stages : 1,
            delegated: "delegated" in scenario,
            guidanceBytes: Buffer.byteLength(guidance(arm)),
            standing: standingByCase.get(scenario.id)!,
            prompt: taskPrompt(scenario, arm, model, flags.effort),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  const base = NodeFS.realpathSync(baseArgument);
  if (base === root || isInside(root, base))
    throw new Error("Use a dedicated eval home outside the source checkout.");
  checkHome(base, arm);
  const output = contained(base, NodePath.join("background-wait-eval", out));
  const resultsPath = contained(base, NodePath.join(output, "results.json"));
  const lock = contained(base, NodePath.join(output, "running.lock"));
  NodeFS.mkdirSync(output, { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(lock, String(process.pid) + "\n", { flag: "wx", mode: 0o600 });
  let signal: NodeJS.Signals | undefined;
  const onSignal = (received: NodeJS.Signals) => {
    signal ??= received;
    stopping = true;
  };
  let stopping = false;
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const db = new NodeSqlite.DatabaseSync(
      existingFile(base, NodePath.join(base, "userdata/statev2.sqlite")),
      {
        readOnly: true,
      },
    );
    try {
      const config: Results["config"] = {
        arm,
        provider,
        model,
        ...(flags.effort ? { effort: flags.effort } : {}),
        head: git(["rev-parse", "HEAD"]).trim(),
        ...(serverCliOverride === undefined ? {} : { serverCli: serverCliOverride }),
        scale,
        base,
      };
      const data: Results = NodeFS.existsSync(resultsPath)
        ? (JSON.parse(NodeFS.readFileSync(resultsPath, "utf8")) as Results)
        : { version: 2, config, samples: [] };
      if (data.version !== 2 || JSON.stringify(data.config) !== JSON.stringify(config)) {
        throw new Error(
          "Results have a different revision or run protocol. Choose a new --out name or resume from the recorded revision.",
        );
      }
      const save = () => {
        const temporary = resultsPath + "." + NodeCrypto.randomUUID();
        NodeFS.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", {
          flag: "wx",
          mode: 0o600,
        });
        NodeFS.renameSync(temporary, resultsPath);
      };
      const work = chosen.flatMap((scenario) =>
        Array.from({ length: samples }, (_, i) => ({ scenario, index: i + 1 })),
      );
      for (const { scenario, index } of work) {
        if (
          !data.samples.some((sample) => sample.caseId === scenario.id && sample.index === index)
        ) {
          data.samples.push({
            caseId: scenario.id,
            index,
            title: `bw-${scenario.id}-${index}-${NodeCrypto.randomUUID().slice(0, 12)}`,
            holds: [],
          });
        }
      }
      save();

      const findLaunched = db.prepare(
        "SELECT thread_id FROM orchestration_v2_projection_threads WHERE project_id = ? AND title = ?",
      );
      async function ensureProject(scenario: Scenario, sample: Sample) {
        if (sample.workspace === undefined) {
          const directory = NodeFS.mkdtempSync(NodePath.join(output, "sample-"));
          const workspace = NodePath.join(directory, "project");
          makeProject(workspace, arm, scenario, seconds(scenario));
          sample.workspace = workspace;
          save();
        }
        if (sample.projectId === undefined) {
          sample.projectId = await registerProject(base, sample.workspace, scenario);
          save();
        }
        return sample.projectId;
      }

      async function ensureThread(entry: ThreadLaunch, projectId: string, prompt: string) {
        if (entry.threadId !== undefined) return entry.threadId;
        if (entry.launchedAt !== undefined) {
          const found = findLaunched.all(projectId, entry.title);
          if (found.length !== 1) {
            throw new Error(
              `Cannot reconcile the earlier start for ${entry.title}; refusing to launch a duplicate.`,
            );
          }
          entry.threadId = String(found[0]!.thread_id);
          save();
          return entry.threadId;
        }
        entry.launchedAt = Date.now();
        save();
        const started = JSON.parse(
          await cli(
            base,
            ["thread", "start"],
            [
              "--provider",
              config.provider,
              "--model",
              config.model,
              ...(config.effort
                ? [
                    "--option",
                    `${config.provider === "codex" ? "reasoningEffort" : "effort"}=${config.effort}`,
                  ]
                : []),
              "--title",
              entry.title,
              "--json",
              projectId,
              prompt,
            ],
          ),
        ) as { threadId?: string };
        if (!started.threadId) throw new Error(`No thread receipt for ${entry.title}.`);
        entry.threadId = started.threadId;
        save();
        return entry.threadId;
      }

      async function verifyCatalog(scenario: Scenario, sample: Sample) {
        if (data.catalogProbe === undefined) {
          const projectId = await ensureProject(scenario, sample);
          if (stopping) return;
          data.catalogProbe = {
            title: `bw-catalog-${NodeCrypto.randomUUID().slice(0, 12)}`,
            projectId,
          };
          save();
        }
        const probe = data.catalogProbe;
        if (probe.tools === undefined) {
          const threadId = await ensureThread(probe, probe.projectId!, codexCatalogProbe);
          const deadline = Date.now() + timeoutMs;
          let snapshot = await show(base, threadId);
          while (!isQuiescent(snapshot) && Date.now() < deadline) {
            await NodeTimersPromises.setTimeout(2_000);
            snapshot = await show(base, threadId);
          }
          const { thread } = snapshot;
          if (
            thread.status !== "completed" ||
            thread.providerInstanceId !== config.provider ||
            thread.model !== config.model
          ) {
            throw new Error(
              `Catalog probe ${probe.title} did not complete on ${config.model}. Repeat the same command to resume.`,
            );
          }
          const { trace } = readThreadEvidence(base, thread, "codex");
          const tools = readCodexActionCatalog(trace ?? []);
          if (tools !== undefined) {
            probe.tools = tools;
            save();
          }
        }
        const catalog = checkActionCatalog(probe.tools, arm === "b");
        if (catalog !== "verified") {
          throw new Error(
            `Run incomplete: separate Action catalog probe ${catalog}. Inspect ${probe.title} and the eval arm's server settings.`,
          );
        }
        console.log(`Action catalog verified in separate probe ${probe.title}.`);
      }

      async function runSample(scenario: Scenario, sample: Sample) {
        const projectId = await ensureProject(scenario, sample);
        if (sample.launchedAt === undefined) {
          const origin = checkHome(base, arm);
          await configureFixtureAction(base, origin, db, projectId, scenario.actionId);
          if (stopping) return;
        }
        await ensureThread(
          sample,
          projectId,
          taskPrompt(scenario, arm, config.model, config.effort),
        );
        const observations = await observeFamily({
          sample,
          scenario,
          arm,
          db,
          timeoutMs,
          save,
          read: (ids) => Promise.all(ids.map((id) => show(base, id))),
        });
        if (!observations.settled) {
          throw new Error(
            "Sample is still active at the observation deadline. Resume the run to keep observing it.",
          );
        }
        sample.result = sampleMetrics({
          base,
          sample,
          scenario,
          config,
          observations,
          waitInstruction,
          standingEstimate: standingByCase.get(scenario.id)!,
        });
        save();
        console.log(
          `${sample.caseId} ${sample.index}/${samples}: ${sample.result.correct ? "correct" : sample.result.problems.join(" ")}`,
        );
      }

      const scheduled = work.map(({ scenario, index }) => ({
        scenario,
        sample: data.samples.find(
          (sample) => sample.caseId === scenario.id && sample.index === index,
        )!,
      }));
      const queue = scheduled.filter(({ sample }) => sample.result === undefined);
      const inFlight = queue.filter(({ sample }) => sample.launchedAt !== undefined);
      if (inFlight.length > concurrency)
        throw new Error(
          "Resume with concurrency at least as high as the number of in-flight samples.",
        );
      const pending = [...inFlight, ...queue.filter((item) => !inFlight.includes(item))];
      if (pending.length > 0 && !stopping) {
        const { scenario, sample } = pending[0]!;
        await verifyCatalog(scenario, sample);
      }
      const errors: string[] = [];
      const workers = await Promise.allSettled(
        Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
          while (!stopping && pending.length > 0) {
            const { scenario, sample } = pending.shift()!;
            try {
              await runSample(scenario, sample);
            } catch (error) {
              errors.push(
                `${sample.title}: ${error instanceof Error ? error.message : String(error)}`,
              );
              stopping = true;
            }
          }
        }),
      );
      for (const worker of workers)
        if (worker.status === "rejected") errors.push(String(worker.reason));
      printCases(data);
      console.log(resultsPath);
      if (errors.length > 0) throw new Error(errors.join("\n"));
      requireCompleteSamples(
        scheduled.map(({ sample }) => sample),
        signal,
      );
    } finally {
      db.close();
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    NodeFS.unlinkSync(lock);
  }
}

if (import.meta.main) await main();
