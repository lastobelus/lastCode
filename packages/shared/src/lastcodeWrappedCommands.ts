export const LASTCODE_BACKGROUND_WAIT_ENV = "LASTCODE_BACKGROUND_WAIT";
export const LASTCODE_WRAPPED_COMMAND = "scripts/lastcode-run.ts";

export type LastCodeWrappedAction =
  | { readonly kind: "prepare" }
  | { readonly kind: "prepare-checkpoint"; readonly upstream: string }
  | { readonly kind: "ci"; readonly mode: "--quick" | "--full" }
  | { readonly kind: "wait-checkpoint" }
  | { readonly kind: "package"; readonly tag: string };

export function parseLastCodeWrappedAction(
  args: readonly string[],
): LastCodeWrappedAction | undefined {
  const [kind, option, value] = args;
  if ((kind === "prepare" || kind === "wait-checkpoint") && args.length === 1) {
    return { kind };
  }
  if (kind === "ci" && args.length === 2 && (option === "--quick" || option === "--full")) {
    return { kind, mode: option };
  }
  if (args.length !== 3 || value === undefined) return undefined;
  if (kind === "prepare-checkpoint" && option === "--upstream" && /^[0-9a-f]{40}$/u.test(value)) {
    return { kind, upstream: value };
  }
  if (
    kind === "package" &&
    option === "--tag" &&
    /^lastcode\/(?:checkpoint|revision)\/v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+(?:\.\d+)?$/u.test(value)
  ) {
    return { kind, tag: value };
  }
  return undefined;
}
