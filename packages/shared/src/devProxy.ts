/** Vite's proxy and the server's dev 404 handler must share prefixes to avoid index.html responses or redirect loops. */
export const DEV_PROXIED_PATH_PREFIXES = ["/api", "/oauth", "/.well-known", "/ws", "/mcp"] as const;

/** Preserve origins for OAuth metadata validation and /ws cookie-session Origin/Host checks. */
export const DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES: ReadonlySet<string> = new Set([
  "/oauth",
  "/.well-known",
  "/mcp",
  "/ws",
]);

export const SHARED_DEV_LOOPBACK_HOST = "127.0.0.1";

export function resolveWebDevServerHost(input: {
  readonly explicitHost: string | undefined;
  readonly sharedBindHost: string | undefined;
}): string {
  return input.sharedBindHost || input.explicitHost || "localhost";
}

export function isDevProxiedPath(pathname: string): boolean {
  return DEV_PROXIED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
