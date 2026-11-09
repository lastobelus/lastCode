export const isGeneratedDependencyPath = (relativePath: string) =>
  relativePath.split("/").includes("node_modules");

export const isGeneratedBuildRoot = (root: string) =>
  /^apps\/[a-zA-Z0-9_-]+\/dist$/.test(root) || root === "native/resource-monitor/target/debug";

/** Classify Git's ignored paths without discovering or walking their contents. */
export function isRegenerableIgnoredPath(relativePath: string): boolean {
  const components = relativePath.split("/");
  if (components.some((name) => name === ".codex" || name === ".local" || name.startsWith(".env")))
    return false;
  // The last component is a file or empty for Git's collapsed directory entries.
  const directories = components.slice(0, -1);
  if (isGeneratedDependencyPath(directories.join("/"))) return true;
  for (let depth = 1; depth <= directories.length; depth++) {
    if (isGeneratedBuildRoot(directories.slice(0, depth).join("/"))) return true;
  }
  // Standalone cleanup recognizes only verified installs and specific build roots;
  // whole-worktree removal also permits hook/cache output, other dist roots and seeded dev state.
  return (
    directories[0] === ".t3" ||
    directories.some((name) => name === ".generated" || name === ".vite-hooks" || name === "dist")
  );
}
