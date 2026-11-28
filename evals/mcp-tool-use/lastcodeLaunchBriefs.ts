import * as Schema from "effect/Schema";

/** Case-sensitive regexes each successfully launched thread's brief must or must not match. */
export const ThreadBriefsExpect = Schema.Struct({
  must: Schema.optional(Schema.Array(Schema.String)),
  mustNot: Schema.optional(Schema.Array(Schema.String)),
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Call = { readonly tool: string; readonly input: unknown; readonly failed?: boolean };

/** An idle single launch can receive its initial brief in a subsequent send. */
export function firstSentBrief(
  launch: Readonly<Record<string, unknown>>,
  output: string | undefined,
  laterCalls: ReadonlyArray<Call>,
): unknown {
  if (typeof launch.message === "string" && launch.message.trim() !== "") return launch.message;
  let receipt: unknown;
  try {
    receipt = JSON.parse(output ?? "null");
  } catch {
    return undefined;
  }
  if (!isRecord(receipt) || receipt.status !== "idle" || typeof receipt.threadId !== "string")
    return undefined;

  for (const { tool, input, failed } of laterCalls) {
    if (tool !== "t3_thread_send" || failed === true || !isRecord(input)) continue;
    if (input.threadId !== receipt.threadId) continue;
    if (
      launch.environmentId !== undefined &&
      input.environmentId !== undefined &&
      input.environmentId !== launch.environmentId
    )
      continue;
    return input.message;
  }
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
