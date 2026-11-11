export const isGeneratedDependencyPath = (relativePath: string) =>
  relativePath.split("/").includes("node_modules");

export const isGeneratedBuildRoot = (root: string) =>
  /^apps\/[a-zA-Z0-9_-]+\/dist$/.test(root) || root === "native/resource-monitor/target/debug";

// Standalone cleanup recognizes only verified installs and specific build roots;
// whole-worktree removal also permits these compiler, framework and hook outputs.
const generatedToolDirectories = [
  ".generated",
  ".vite-hooks",
  "dist",
  "dist-electron",
  "target",
  "build",
  "_build",
  ".astro",
  ".tanstack",
];

/** Classify Git's ignored paths without discovering or walking their contents. */
export function isRegenerableIgnoredPath(relativePath: string): boolean {
  const components = relativePath.split("/");
  if (components.some((name) => name === ".codex" || name === ".local" || name.startsWith(".env")))
    return false;
  if (components.at(-1)?.endsWith(".tsbuildinfo")) return true;
  // Vite hook shims ignore their own files, so Git reports them individually.
  if (components.at(-3) === ".vite-hooks" && components.at(-2) === "_") return true;
  // Only Git-reported ignored roots are disposable; an ignored backup beneath tracked output is not.
  if (!relativePath.endsWith("/")) return false;
  const directories = components.slice(0, -1);
  const name = directories.at(-1) ?? "";
  if (isGeneratedDependencyPath(name) || isGeneratedBuildRoot(directories.join("/"))) return true;
  // Root .t3 is seeded, disposable development state.
  return (directories.length === 1 && name === ".t3") || generatedToolDirectories.includes(name);
}
