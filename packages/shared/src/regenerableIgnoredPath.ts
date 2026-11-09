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
  ".astro",
  ".tanstack",
];

/** Classify Git's ignored paths without discovering or walking their contents. */
export function isRegenerableIgnoredPath(relativePath: string): boolean {
  const components = relativePath.split("/");
  if (components.some((name) => name === ".codex" || name === ".local" || name.startsWith(".env")))
    return false;
  if (components.at(-1)?.endsWith(".tsbuildinfo")) return true;
  // The last component is a file or empty for Git's collapsed directory entries.
  const directories = components.slice(0, -1);
  if (isGeneratedDependencyPath(directories.join("/"))) return true;
  for (let depth = 1; depth <= directories.length; depth++) {
    if (isGeneratedBuildRoot(directories.slice(0, depth).join("/"))) return true;
  }
  // Root .t3 is seeded, disposable development state.
  return (
    directories[0] === ".t3" || directories.some((name) => generatedToolDirectories.includes(name))
  );
}
