import * as SecureRandom from "effect/crypto/SecureRandom";
import {
  McpCapabilityUnavailableError,
  EnvironmentId,
  ProjectId,
  ThreadId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ThreadTagVocabularyInput,
  ThreadTagVocabularyResult,
  ThreadTagVocabularyEntry,
  ThreadTagQueryInput,
  ThreadTagSetInput,
  ThreadTagDiscoveryError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
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
const tags = Tool.make("t3_thread_tags", {
  description:
    "Omit tag to list tags in exact spelling: query fuzzy-matches names, projectId filters projects, preferredProjectId only ranks, and count includes slash descendants, so Work is listed even when only Work/Client is assigned. Pass tag to list its threads: exact case, no leading #; Work matches Work and Work/Client, not Worker or work; mode:exact matches Work alone. Either way, omit projectId for all projects; unarchived by default, settled included; archived:true is archive only.",
  parameters: Schema.Struct({
    ...ThreadTagVocabularyInput.mapFields(Struct.omit(["uiVisibility"])).fields,
    tag: Schema.optionalKey(ThreadTagQueryInput.fields.tag),
    mode: ThreadTagQueryInput.fields.mode,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: Schema.Union([
    Schema.Struct({
      ...ThreadTagVocabularyResult.fields,
      entries: Schema.Array(ThreadTagVocabularyEntry.mapFields(Struct.omit(["preferredProject"]))),
    }),
    Schema.Struct({
      threads: Schema.Array(
        Schema.Struct({
          threadId: ThreadId,
          projectId: ProjectId,
          environmentId: EnvironmentId,
          title: Schema.String,
          tags: Schema.Array(Schema.String),
          settled: Schema.Boolean,
          link: Schema.String,
        }),
      ),
      nextCursor: ThreadTagVocabularyResult.fields.nextCursor,
    }),
  ]),
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);
const set = Tool.make("t3_thread_tag_set", {
  description:
    "Add (tagged:true) or remove (tagged:false) one tag, only when the user asks; a hashtag in a message is not a request. tag is exact, no leading #; if unsure of spelling, list tags with t3_thread_tags first. Parent and child tags stay as they are. A returned sequence means the change is saved.",
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
export const ThreadTagsToolkit = Toolkit.make(tags, set);
