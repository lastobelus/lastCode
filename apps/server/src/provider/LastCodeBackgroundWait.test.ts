import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { CodexSettings, EnvironmentId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexClient from "effect-codex-app-server/client";
import { McpSchema } from "effect/ai";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import {
  buildCodexTurnStartParams,
  CODEX_DEFAULT_INSTANCE_ID,
  makeCodexAdapterV2,
} from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeClaudeQueryOptions } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES } from "./CodexDeveloperInstructions.ts";
import {
  codexBackgroundWaitForAttachedSession,
  readLastCodeBackgroundWaitEnabled,
} from "./LastCodeBackgroundWait.ts";

const defaultCodexSettings = Schema.decodeSync(CodexSettings)({});

it.effect("advertises background wait by default and honors the Codex session opt-out", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const adapter = yield* makeCodexAdapterV2({
      instanceId: CODEX_DEFAULT_INSTANCE_ID,
      settings: defaultCodexSettings,
      environment: {},
      clientFactory: {
        open: () =>
          CodexClient.make(
            Stdio.make({
              args: Effect.succeed([]),
              stdin: Stream.never,
              stdout: () => Sink.drain,
              stderr: () => Sink.drain,
            }),
            {},
            Effect.never,
          ),
      },
      digest: yield* Digest.Digest,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* makeReplayServerConfig("lastcode-codex-background-wait"),
      readBackgroundWait: readLastCodeBackgroundWaitEnabled(settings.getSettings),
    });
    const threadId = ThreadId.make("thread-background-wait");
    const environmentId = EnvironmentId.make("background-wait-environment");
    const modelSelection = { instanceId: CODEX_DEFAULT_INSTANCE_ID, model: "gpt-5.4" };
    const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: "/workspace",
    });
    const open = (providerSessionId: string) =>
      adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(providerSessionId),
        modelSelection,
        runtimePolicy,
      });
    const mcpCapabilities = (supported: boolean) =>
      new Set<McpInvocationContext.McpCapability>(
        supported ? ["orchestration", "background-wait"] : ["orchestration"],
      );
    const enabledWhen = Context.getOrUndefined(
      OrchestratorToolkit.tools.t3_background_wait.annotations,
      McpSchema.EnabledWhen,
    );
    const toolVisible = (supported: boolean | undefined) =>
      Effect.sync(
        () => enabledWhen?.({ protocolVersion: "2025-06-18", capabilities: {} }) ?? true,
      ).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "codex-background-wait",
          issuedAt: 0,
          thread: {
            threadId,
            providerSessionId: "codex-background-wait",
            providerInstanceId: CODEX_DEFAULT_INSTANCE_ID,
          },
          client: undefined,
          capabilities: mcpCapabilities(supported === true),
        }),
      );
    const configuredSupport = adapter
      .getCapabilities()
      .pipe(Effect.map((capabilities) => capabilities.tools.supportsBackgroundWait === true));
    const configuredToolVisible = configuredSupport.pipe(Effect.flatMap(toolVisible));
    const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
    const prepareCredential = Effect.gen(function* () {
      yield* mcpSessions.set({
        environmentId,
        threadId,
        providerSessionId: "codex-background-wait-mcp",
        providerInstanceId: CODEX_DEFAULT_INSTANCE_ID,
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer fixture",
        browserToolsAvailable: false,
        capabilities: mcpCapabilities(yield* configuredSupport),
      });
    });
    NodeAssert.equal(yield* configuredToolVisible, true);
    yield* settings.updateSettings({ lastcodeBackgroundWaitEnabled: false });
    NodeAssert.equal(yield* configuredToolVisible, false);
    yield* prepareCredential;
    yield* settings.updateSettings({ lastcodeBackgroundWaitEnabled: true });
    NodeAssert.equal(yield* configuredToolVisible, true);
    // The first credential was issued before the setting changed.
    const before = yield* open("wait-disabled");
    NodeAssert.equal(before.awaitBackgroundTasks, undefined);
    NodeAssert.equal(yield* toolVisible(codexBackgroundWaitForAttachedSession(before)), false);
    yield* prepareCredential;
    const after = yield* open("wait-enabled");
    NodeAssert.equal(typeof after.awaitBackgroundTasks, "function");
    yield* settings.updateSettings({ lastcodeBackgroundWaitEnabled: false });
    NodeAssert.equal(yield* configuredToolVisible, false);
    NodeAssert.equal(yield* toolVisible(codexBackgroundWaitForAttachedSession(after)), true);

    for (const session of [before, after]) {
      const enabled = session.awaitBackgroundTasks !== undefined;
      const params = yield* buildCodexTurnStartParams({
        nativeThreadId: "native-background-wait",
        codexInput: [],
        modelSelection,
        runtimePolicy,
        hasT3Mcp: true,
        backgroundWaitAvailable: enabled,
        projectActionLaunchDisabled: enabled,
      });
      const instructions = params.additionalContext?.t3_code_runtime?.value ?? "";
      NodeAssert.equal(instructions.includes("t3_background_wait"), enabled);
      const codexText = Object.values(params.additionalContext ?? {})
        .map(({ value }) => value)
        .join("\n");
      const claude = makeClaudeQueryOptions({
        modelSelection: { ...modelSelection, model: "claude-haiku-5-5" },
        nativeThreadId: "native-background-wait",
        cwd: "/workspace",
        resume: false,
        mcpServers: {},
        projectActionLaunchDisabled: enabled,
      });
      const prompt = claude.systemPrompt;
      NodeAssert.ok(
        prompt && typeof prompt === "object" && "type" in prompt && prompt.type === "preset",
      );
      const claudeText = prompt.append ?? "";
      for (const text of [codexText, claudeText]) {
        NodeAssert.equal(text.includes("appOwnedActionContinuationVersion"), false);
        NodeAssert.equal(text.includes("run_project_action_and_resume"), false);
        NodeAssert.equal(text.includes("Project Action launch tools are unavailable"), enabled);
        NodeAssert.ok(text.includes("watch_pull_request"));
      }
      NodeAssert.ok(
        Buffer.byteLength(instructions, "utf8") <= CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
      );
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest(),
        McpProviderSessions.layer,
        IdAllocator.layer,
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  ),
);
