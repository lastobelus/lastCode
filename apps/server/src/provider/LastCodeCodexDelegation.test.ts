import { CommandId, MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { buildCodexTurnStartParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { appOwnedTaskPrompt } from "../orchestration-v2/LastCodeDelegatedTaskPrompt.ts";

it.effect("sends task assignment provenance separately from the Codex prompt", () =>
  Effect.gen(function* () {
    const brief =
      '[T3 Code: the agent in T3 thread "parent" sent this message, not the user.]\n\nRead README.md.';
    const codexInput = [{ type: "text", text: brief }] as const;
    const source = { commandId: CommandId.make("command:mcp:parent:delegate-task:test") };
    const parentThreadId = ThreadId.make("parent");
    const taskId = derive.delegatedTaskNode(source);
    const messageId = derive.delegatedTaskMessage(source);
    const delegation = {
      appThread: {
        id: derive.delegatedTaskThread(source),
        forkedFrom: { type: "node", nodeId: taskId },
        lineage: {
          parentThreadId,
          relationshipToParent: "subagent",
          rootThreadId: parentThreadId,
        },
      },
      message: {
        id: messageId,
        senderThreadId: parentThreadId,
        createdBy: "agent",
        creationSource: "mcp",
      },
    } as const;
    const build = (source: Parameters<typeof appOwnedTaskPrompt>[0]) => {
      const input = {
        nativeThreadId: "native-thread",
        codexInput,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
        } as const,
        appOwnedTaskPrompt: appOwnedTaskPrompt(source),
      };
      return buildCodexTurnStartParams(input);
    };

    const pasted = yield* build({
      appThread: {
        id: ThreadId.make("ordinary-thread"),
        forkedFrom: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentThreadId },
      },
      message: { id: messageId, createdBy: "user", creationSource: "web" },
    });
    assert.isUndefined(pasted.additionalContext?.t3_code_delegated_task);
    assert.deepEqual(pasted.input, codexInput);

    const assigned = yield* build(delegation);
    const context = assigned.additionalContext?.t3_code_delegated_task;
    assert.equal(context?.kind, "application");
    assert.include(context?.value ?? "", "delegate_task");
    assert.notInclude(context?.value ?? "", brief);
    assert.deepEqual(assigned.input, codexInput);

    const replacementMessageId = MessageId.make("message:restart-steer");
    const later = yield* build({
      ...delegation,
      message: { ...delegation.message, id: replacementMessageId },
    });
    assert.equal(later.additionalContext?.t3_code_delegated_task?.kind, "application");
    assert.notInclude(
      later.additionalContext?.t3_code_delegated_task?.value ?? "",
      "delegate_task",
    );
    assert.deepEqual(later.input, codexInput);
  }),
);
