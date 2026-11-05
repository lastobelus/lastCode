import * as SecureRandom from "effect/crypto/SecureRandom";
import {
  McpCapabilityUnavailableError,
  EnvironmentId,
  OrchestrationV2ThreadShell,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ThreadTagVocabularyInput,
  ThreadTagVocabularyResult,
  ThreadTagQueryInput,
  ThreadTagSetInput,
  ThreadTagDiscoveryError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadTags from "../../../orchestration-v2/ThreadTags.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  SecureRandom.SecureRandom,
  ThreadTags.ThreadTags,
  ThreadManagement.ThreadManagementService,
  McpInvocationContext.McpInvocationContext,
];
const failure = Schema.Union([
  OrchestratorMcpFailure,
  ThreadTagDiscoveryError,
  McpCapabilityUnavailableError,
]);
const vocabulary = Tool.make("t3_thread_tag_vocabulary", {
  description:
    "Discover thread tags without reading transcripts. query fuzzy-finds exact spellings and derived parent paths. Omit projectId for all projects; preferredProjectId ranks its tags first. Default: unarchived threads, settled included; archived:true: archive only. count counts threads with that tag or slash descendants; projectCount counts projects. Derived parents are not necessarily assigned tags. Pass nextCursor as cursor until null.",
  parameters: Schema.Struct({
    ...ThreadTagVocabularyInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: ThreadTagVocabularyResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);
const query = Tool.make("t3_thread_tag_query", {
  description:
    "Find thread shells with links by tag, without transcripts. tag: exact case, no leading #. Default mode:subtree: Work matches Work and Work/Client, not Worker or work. mode:exact matches only Work. projectId, archived and nextCursor work as in t3_thread_tag_vocabulary.",
  parameters: Schema.Struct({
    ...ThreadTagQueryInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: Schema.toCodecJson(
    Schema.Struct({
      threads: Schema.Array(
        Schema.Struct({
          ...OrchestrationV2ThreadShell.fields,
          environmentId: EnvironmentId,
          link: Schema.String,
        }),
      ),
      nextCursor: Schema.NullOr(Schema.Number),
    }),
  ),
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);
const set = Tool.make("t3_thread_tag_set", {
  description:
    "Add (tagged:true) or remove (tagged:false) one exact tag on threadId, no leading #. Use exact spelling and case; if unsure, check t3_thread_tag_vocabulary. Parent and child tags stay untouched. Call only when the user explicitly asks; a hashtag in other text is not a request.",
  parameters: Schema.Struct({
    ...ThreadTagSetInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: Schema.Struct({ sequence: Schema.Number }),
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);
export const ThreadTagsToolkit = Toolkit.make(vocabulary, query, set);
