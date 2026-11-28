import type { EnvironmentId } from "@t3tools/contracts";
import { threadLinkRefs } from "@t3tools/shared/threadLinks";
import * as Schema from "effect/Schema";

/** Case-sensitive regexes each successfully launched thread's brief must or must not match. */
export const ThreadBriefsExpect = Schema.Struct({
  must: Schema.optional(Schema.Array(Schema.String)),
  mustNot: Schema.optional(Schema.Array(Schema.String)),
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Call = {
  readonly tool: string;
  readonly input: unknown;
  readonly failed?: boolean;
  readonly output?: string;
};

function launchReceipt(output: string | undefined) {
  try {
    const receipt: unknown = JSON.parse(output ?? "null");
    return isRecord(receipt) ? receipt : undefined;
  } catch {
    return undefined;
  }
}

/** An idle single launch can receive its initial brief in a subsequent send. */
export function firstSentBrief(
  launch: Readonly<Record<string, unknown>>,
  output: string | undefined,
  laterCalls: ReadonlyArray<Call>,
  localEnvironmentId: string,
): unknown {
  if (typeof launch.message === "string" && launch.message.trim() !== "") return launch.message;
  const receipt = launchReceipt(output);
  if (receipt?.status !== null || receipt.runId !== null || typeof receipt.threadId !== "string")
    return undefined;

  const launchEnvironmentId = launch.environmentId ?? localEnvironmentId;
  for (const { tool, input, failed } of laterCalls) {
    if (tool !== "t3_thread_send" || failed === true || !isRecord(input)) continue;
    if (input.threadId !== receipt.threadId) continue;
    if ((input.environmentId ?? localEnvironmentId) !== launchEnvironmentId) continue;
    return input.message;
  }
}

export function hasSingleLaunchHandoff(
  calls: ReadonlyArray<Call>,
  finalText: string,
  localEnvironmentId: EnvironmentId,
): boolean {
  const launches = calls.filter(
    (call) => call.tool === "t3_thread_launch" && call.failed === false,
  );
  if (launches.length !== 1) return false;
  const receipt = launchReceipt(launches[0]?.output);
  if (typeof receipt?.link !== "string") return false;
  const [child] = threadLinkRefs(receipt.link, localEnvironmentId);
  if (child === undefined || child.threadId !== receipt.threadId) return false;
  return threadLinkRefs(finalText, localEnvironmentId).some(
    (link) => link.threadId === child.threadId && link.environmentId === child.environmentId,
  );
}

export function gradeThreadBriefs(
  expect: typeof ThreadBriefsExpect.Type,
  briefs: ReadonlyArray<unknown>,
  add: (label: string, pass: boolean) => void,
) {
  for (const pattern of expect.must ?? []) {
    const match = new RegExp(pattern);
    add(
      `threadBriefs must /${pattern}/`,
      briefs.length > 0 && briefs.every((brief) => typeof brief === "string" && match.test(brief)),
    );
  }
  for (const pattern of expect.mustNot ?? []) {
    const match = new RegExp(pattern);
    add(
      `threadBriefs mustNot /${pattern}/`,
      !briefs.some((brief) => typeof brief === "string" && match.test(brief)),
    );
  }
}
