import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
export type ConnectionStatus = { phase: string; error: string | null };
export function classifyLastCodeSecondaryConnections(
  secondaries: readonly DesktopEnvironmentBootstrap[],
  localEnvByUrl: ReadonlyMap<string, ConnectionStatus>,
) {
  const connecting: string[] = [];
  const failed: Array<{ label: string; error: string | null }> = [];
  for (const bootstrap of secondaries) {
    const env =
      bootstrap.httpBaseUrl !== null ? localEnvByUrl.get(bootstrap.httpBaseUrl) : undefined;
    if (env?.phase === "connected") continue;
    if (env?.phase === "error") {
      failed.push({ label: bootstrap.label, error: env.error });
      continue;
    }
    connecting.push(bootstrap.label);
  }
  return { connecting, failed };
}
