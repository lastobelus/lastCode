// @effect-diagnostics nodeBuiltinImport:off - Quick CI inspects Git before a runtime exists.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

export interface QuickCiScope {
  readonly kind: "full" | "affected" | "none";
  readonly packages: ReadonlyArray<string>;
  readonly reason: string;
  readonly changedFiles: ReadonlyArray<string>;
}

interface Workspace {
  readonly name: string;
  readonly directory: string;
  readonly typecheck: boolean;
  readonly manifest: Record<string, unknown>;
}

interface ConfigInput {
  readonly directory: string;
  readonly pattern: string;
}

interface ConfigScope {
  readonly inputs: ReadonlyArray<ConfigInput>;
  readonly aliases: ReadonlyArray<ConfigInput>;
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|astro|vue|svelte)$/i;
const STATIC_FILE = /\.(?:png|jpe?g|gif|webp|avif|svg|icns|ico|woff2?|ttf|otf|mp[34]|wav)$/i;

function git(repoRoot: string, args: ReadonlyArray<string>, input?: string): Buffer {
  // Provider Git variables must not redirect a scope query to another worktree.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd: repoRoot,
    env,
    input,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Cannot resolve Quick CI scope: ${result.stderr.toString().trim()}`);
  }
  return result.stdout;
}

function jsonObject(text: string): Record<string, unknown> {
  // JSONC without executing configuration. Keep quoted strings intact while
  // removing comments and trailing commas; malformed input falls back to full.
  let json = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"') {
      const start = index;
      for (index++; index < text.length; index++) {
        if (text[index] === "\\") index++;
        else if (text[index] === '"') break;
      }
      json += text.slice(start, index + 1);
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      json += "\n";
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Unterminated configuration comment");
      index = end + 1;
      json += " ";
    } else if (char !== "," || !/^\s*[}\]]/.test(text.slice(index + 1))) {
      json += char;
    }
  }
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object in configuration");
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("Unsupported configuration list");
  }
  return value;
}

function normalize(path: string): string {
  return NodePath.posix.normalize(path).replace(/^\.\//, "");
}

/** Git paths use slash separators; installed configuration paths use the host's native format. */
export function resolveQuickCiConfigReference(file: string, reference: string): string {
  const paths =
    /^[a-z]:[\\/]/i.test(file) || file.startsWith("\\\\") ? NodePath.win32 : NodePath.posix;
  return paths.normalize(paths.join(paths.dirname(file), reference));
}

function configDirectory(file: string): string {
  return (
    /^[a-z]:[\\/]/i.test(file) || file.startsWith("\\\\") ? NodePath.win32 : NodePath.posix
  ).dirname(file);
}

function patternRegex(pattern: string): RegExp {
  if (/[[\]{}!\\]/.test(pattern)) throw new Error(`Unsupported scope pattern ${pattern}`);
  // This limited grammar consumes **/ before ** and *; repeated stars remain separate tokens.
  const wildcards: Readonly<Record<string, string>> = {
    "**/": "(?:.*/)?",
    "**": ".*",
    "*": "[^/]*",
    "?": "[^/]",
  };
  const regex = pattern.replace(
    /\*\*\/|\*\*|\*|\?|[.+^$()|]/g,
    (token) => wildcards[token] ?? `\\${token}`,
  );
  return new RegExp(`^${regex}$`);
}

function matchesInput(file: string, input: ConfigInput): boolean {
  const pattern = normalize(NodePath.posix.join(input.directory, input.pattern));
  if (pattern.startsWith("../") || pattern.startsWith("/")) {
    throw new Error(`Configuration input escapes the repository: ${pattern}`);
  }
  if (patternRegex(pattern).test(file)) return true;
  return !/[?*]/.test(pattern) && file.startsWith(`${pattern}/`);
}

function isInertFile(file: string): boolean {
  // Keep this allowlist conservative: text locations are case-sensitive, static locations are not.
  if (/^(?:AGENTS|CONTRIBUTING|CHANGELOG|LICENSE|SECURITY)(?:\.[^/]+)?$/i.test(file)) {
    return true;
  }
  if (/\.(?:md|rst|txt)$/i.test(file)) {
    return (
      /(?:^|\/)(?:docs|\.agents|\.github\/ISSUE_TEMPLATE)\//.test(file) ||
      /(?:^|\/)README(?:\.[^/]+)?$/i.test(file)
    );
  }
  return STATIC_FILE.test(file) && /(?:^|\/)(?:docs|public|assets|resources)\//i.test(file);
}

function readWorkspacePatterns(text: string): ReadonlyArray<string> {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^packages:\s*(?:#.*)?$/.test(line));
  if (start < 0) throw new Error("Unsupported or missing workspace package list");
  const patterns: Array<string> = [];
  for (const line of lines.slice(start + 1)) {
    const content = line.trimStart();
    if (!content || content.startsWith("#")) continue;
    if (/^\S/.test(line)) break;
    // This limited list grammar produces one nonempty capture. Keep capture order
    // and validate before advancing: full-CI diagnostics depend on the first bad entry.
    const match = /^\s+-\s+(?:'([^']+)'|"([^"]+)"|([^#\s]+))\s*(?:#.*)?$/.exec(line);
    const pattern = match?.slice(1).find(Boolean);
    if (!pattern) throw new Error("Unsupported workspace package pattern");
    patternRegex(pattern);
    patterns.push(pattern);
  }
  if (!patterns.length) throw new Error("Workspace package list is empty");
  return patterns;
}

function readSnapshot(repoRoot: string, commit: string) {
  const entries = new Map<string, { readonly oid: string; readonly mode: string }>();
  for (const entry of git(repoRoot, ["ls-tree", "-r", "-z", "--full-tree", commit])
    .toString()
    .split("\0")) {
    if (!entry) continue;
    const match = /^(\d+) blob ([a-f\d]+)\t([\s\S]+)$/.exec(entry);
    if (match) entries.set(match[3]!, { mode: match[1]!, oid: match[2]! });
    else throw new Error("Unsupported Git tree entry");
  }
  const contents = new Map<string, string>();
  let bytesRead = 0;
  const readFiles = (
    files: ReadonlyArray<string>,
    consume?: (file: string, source: string) => void,
  ): void => {
    if (consume)
      for (const file of new Set(files)) {
        const source = contents.get(file);
        if (source !== undefined) consume(file, source);
      }
    const wanted = [...new Set(files)].filter((file) => !contents.has(file) && entries.has(file));
    if (!wanted.length) return;
    const input = wanted.map((file) => entries.get(file)!.oid).join("\n") + "\n";
    const sizes = git(repoRoot, ["cat-file", "--batch-check=%(objectsize)"], input)
      .toString()
      .trim()
      .split("\n");
    for (const [index, size] of sizes.entries()) {
      if (!/^\d+$/.test(size)) throw new Error("Cannot size Git snapshot blob");
      const file = wanted[index]!;
      const entry = entries.get(file)!;
      if (entry.mode !== "100644" && entry.mode !== "100755")
        throw new Error(`Unsupported symlink ${file}`);
      bytesRead += Number(size);
    }
    // Check size before reading bodies. Unrelated tracked/vendor blobs never
    // enter this list, and an unexpectedly huge relevant input fails closed.
    if (bytesRead > 96 * 1024 * 1024)
      throw new Error("Relevant CI inputs exceed the 96 MiB snapshot budget");
    for (let start = 0; start < wanted.length;) {
      let end = start;
      let batchBytes = 0;
      while (end < wanted.length && batchBytes + Number(sizes[end]) <= 8 * 1024 * 1024) {
        batchBytes += Number(sizes[end]);
        end++;
      }
      if (end === start) throw new Error("Relevant CI input exceeds the 8 MiB blob budget");
      const batch = wanted.slice(start, end);
      const buffer = git(
        repoRoot,
        ["cat-file", "--batch"],
        batch.map((file) => entries.get(file)!.oid).join("\n") + "\n",
      );
      let offset = 0;
      for (const file of batch) {
        const headerEnd = buffer.indexOf(10, offset);
        const header = buffer.subarray(offset, headerEnd).toString();
        const match = /^[a-f\d]+ blob (\d+)$/.exec(header);
        if (!match) throw new Error("Cannot read Git snapshot blob");
        const length = Number(match[1]);
        offset = headerEnd + 1;
        const source = buffer.subarray(offset, offset + length).toString();
        if (consume) consume(file, source);
        else contents.set(file, source);
        offset += length + 1;
      }
      start = end;
    }
  };
  const read = (file: string): string | undefined => {
    readFiles([file]);
    return contents.get(file);
  };
  return { entries, contents, read, readFiles };
}

function changedPaths(repoRoot: string, base: string, head: string): ReadonlyArray<string> {
  const fields = git(repoRoot, ["diff", "--name-status", "-z", "--find-renames", base, head, "--"])
    .toString()
    .split("\0");
  const paths = new Set<string>();
  // R/C records consume two paths; never interpret their destination as the next status.
  for (let index = 0; fields[index];) {
    const status = fields[index++]!;
    const path = fields[index++];
    if (!path || !/^[ACDMRTUXB]\d*$/.test(status)) throw new Error("Unsupported Git diff status");
    paths.add(path);
    if (!/^[RC]/.test(status)) continue;
    const destination = fields[index++];
    if (!destination) throw new Error("Missing rename destination");
    paths.add(destination);
  }
  return [...paths].sort();
}

/** Select whole workspace typechecks from an exact commit range, failing closed on unknown ownership. */
export function resolveQuickCiScope(
  repoRoot: string,
  baseCommit: string,
  headCommit: string,
): QuickCiScope {
  const base = git(repoRoot, ["rev-parse", "--verify", `${baseCommit}^{commit}`])
    .toString()
    .trim();
  const head = git(repoRoot, ["rev-parse", "--verify", `${headCommit}^{commit}`])
    .toString()
    .trim();
  const changedFiles = changedPaths(repoRoot, base, head);
  let allPackages: ReadonlyArray<string> = [];
  const full = (reason: string): QuickCiScope => ({
    kind: "full",
    packages: allPackages,
    reason,
    changedFiles,
  });
  if (!changedFiles.length)
    return { kind: "none", packages: [], reason: "No files changed", changedFiles };

  try {
    const { entries, contents, read, readFiles } = readSnapshot(repoRoot, head);
    const workspaceText = read("pnpm-workspace.yaml");
    if (!workspaceText) return full("Workspace configuration is unavailable");
    const patterns = readWorkspacePatterns(workspaceText);
    readFiles(
      [...entries.keys()].filter(
        (file) =>
          file.endsWith("/package.json") &&
          patterns.some((pattern) => patternRegex(pattern).test(NodePath.posix.dirname(file))),
      ),
    );
    const workspaces: Array<Workspace> = [];
    for (const [file, text] of contents) {
      if (!file.endsWith("/package.json")) continue;
      const directory = NodePath.posix.dirname(file);
      if (!patterns.some((pattern) => patternRegex(pattern).test(directory))) continue;
      const manifest = jsonObject(text);
      if (typeof manifest.name !== "string") throw new Error(`Unnamed workspace ${directory}`);
      const scripts = manifest.scripts as Record<string, unknown> | undefined;
      workspaces.push({
        name: manifest.name,
        directory,
        manifest,
        typecheck: typeof scripts?.typecheck === "string",
      });
    }
    allPackages = workspaces
      .filter((workspace) => workspace.typecheck)
      .map((workspace) => workspace.name)
      .sort();
    if (
      !workspaces.length ||
      new Set(workspaces.map((workspace) => workspace.name)).size !== workspaces.length
    ) {
      return full("Workspace ownership is ambiguous");
    }
    workspaces.sort((left, right) => right.directory.length - left.directory.length);
    const owner = (file: string) =>
      workspaces.find(
        (workspace) => file === workspace.directory || file.startsWith(`${workspace.directory}/`),
      );
    const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
    // File/link modules can live inside a workspace without being workspaces
    // themselves. Register their import names against that owning workspace.
    for (const workspace of workspaces) {
      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        const values = workspace.manifest[field];
        if (!values || typeof values !== "object" || Array.isArray(values)) continue;
        for (const [name, specifier] of Object.entries(values)) {
          if (typeof specifier !== "string" || !/^(?:file|link):/.test(specifier)) continue;
          const directory = normalize(
            NodePath.posix.join(workspace.directory, specifier.replace(/^[^:]+:/, "")),
          );
          const target = owner(directory);
          if (!target || !entries.has(`${directory}/package.json`))
            throw new Error(`Unresolved local dependency ${name}`);
          const existing = byName.get(name);
          if (existing && existing.name !== target.name)
            throw new Error(`Ambiguous local dependency ${name}`);
          byName.set(name, target);
        }
      }
    }
    const dependencies = new Map(
      workspaces.map((workspace) => [workspace.name, new Set<string>()]),
    );
    const configPaths = new Set<string>();
    const configs = new Map<string, ConfigScope>();

    const readConfig = (
      file: string,
      seen = new Set<string>(),
      extendingDirectory = configDirectory(file),
    ): ConfigScope => {
      if (seen.has(file)) throw new Error(`Circular TypeScript configuration ${file}`);
      seen.add(file);
      const absolute = NodePath.isAbsolute(file);
      const text = absolute ? NodeFS.readFileSync(file, "utf8") : read(file);
      if (!text) throw new Error(`Unresolved TypeScript configuration ${file}`);
      if (!absolute) configPaths.add(file);
      const config = jsonObject(text);
      const directory = configDirectory(file);
      let inherited: ConfigScope = { inputs: [], aliases: [] };
      if (config.extends !== undefined) {
        const bases =
          typeof config.extends === "string" ? [config.extends] : strings(config.extends);
        for (const reference of bases) {
          let target: string | undefined;
          if (reference.startsWith(".")) {
            const path = resolveQuickCiConfigReference(file, reference);
            target = [path, `${path}.json`, `${path}/tsconfig.json`].find((candidate) =>
              absolute ? NodeFS.existsSync(candidate) : entries.has(candidate),
            );
          } else {
            // Installed bases are pinned by the unchanged lockfile. Resolving them
            // is read-only; missing or unsupported bases retain the full gate.
            let search = absolute ? directory : NodePath.join(repoRoot, directory);
            while (true) {
              const path = NodePath.join(search, "node_modules", reference);
              target = [path, `${path}.json`, NodePath.join(path, "tsconfig.json")].find(
                (candidate) => NodeFS.existsSync(candidate) && NodeFS.statSync(candidate).isFile(),
              );
              if (target || search === NodePath.dirname(search)) break;
              search = NodePath.dirname(search);
            }
          }
          if (!target) throw new Error(`Unresolved TypeScript extends ${reference}`);
          const resolved = readConfig(target, new Set(seen), extendingDirectory);
          inherited = {
            inputs: [...inherited.inputs, ...resolved.inputs],
            aliases: [...inherited.aliases, ...resolved.aliases],
          };
        }
      }
      const inputs =
        config.include === undefined && config.files === undefined
          ? [...inherited.inputs]
          : [
              ...(config.include === undefined ? [] : strings(config.include)),
              ...(config.files === undefined ? [] : strings(config.files)),
            ].map((pattern) =>
              pattern.startsWith("${configDir}/")
                ? { directory: extendingDirectory, pattern: pattern.slice("${configDir}/".length) }
                : { directory, pattern },
            );
      // Include and files inherit independently. Keep inherited inputs even
      // when another input field is replaced; extra consumers are safer than
      // dropping a declaration still included by the compiler.
      for (const input of inherited.inputs) {
        if (!inputs.includes(input)) inputs.push(input);
      }
      const aliases = [...inherited.aliases];
      const options = config.compilerOptions as Record<string, unknown> | undefined;
      for (const field of ["rootDirs", "typeRoots"]) {
        if (options?.[field] !== undefined) {
          for (const path of strings(options[field])) {
            aliases.push({
              directory: normalize(NodePath.posix.join(directory, path)),
              pattern: "**/*",
            });
          }
        }
      }
      const typePackages = [...(options?.types === undefined ? [] : strings(options.types))];
      if (typeof options?.jsxImportSource === "string") typePackages.push(options.jsxImportSource);
      for (const name of typePackages) {
        if (/^[./]|^[a-z]:[\\/]|\\/i.test(name))
          throw new Error(`Unsupported relative TypeScript type package ${name}`);
        const target = [...byName].find(
          ([alias]) => name === alias || name.startsWith(`${alias}/`),
        )?.[1];
        if (target) aliases.push({ directory: target.directory, pattern: "**/*" });
      }
      if (options?.baseUrl !== undefined) {
        if (typeof options.baseUrl !== "string") throw new Error("Unsupported TypeScript baseUrl");
        aliases.push({
          directory: normalize(NodePath.posix.join(directory, options.baseUrl)),
          pattern: "**/*",
        });
      }
      if (options?.paths !== undefined) {
        if (!options.paths || typeof options.paths !== "object" || Array.isArray(options.paths))
          throw new Error("Unsupported TypeScript paths");
        const baseUrl = options.baseUrl === undefined ? "." : options.baseUrl;
        if (typeof baseUrl !== "string") throw new Error("Unsupported TypeScript baseUrl");
        for (const targets of Object.values(options.paths)) {
          for (const pattern of strings(targets))
            aliases.push({
              directory: normalize(NodePath.posix.join(directory, baseUrl)),
              pattern,
            });
        }
      }
      if (config.references !== undefined) {
        if (!Array.isArray(config.references)) throw new Error("Unsupported TypeScript references");
        for (const reference of config.references) {
          const path = (reference as Record<string, unknown>)?.path;
          if (typeof path !== "string") throw new Error("Unsupported TypeScript reference");
          const target = normalize(NodePath.posix.join(directory, path));
          const resolved = readConfig(
            entries.has(target) ? target : `${target}/tsconfig.json`,
            new Set(seen),
          );
          inputs.push(...resolved.inputs);
          aliases.push(...resolved.aliases);
        }
      }
      return { inputs, aliases };
    };

    for (const workspace of workspaces) {
      const edges = dependencies.get(workspace.name)!;
      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        const values = workspace.manifest[field];
        if (values === undefined) continue;
        if (!values || typeof values !== "object" || Array.isArray(values))
          throw new Error(`Unsupported dependencies for ${workspace.name}`);
        for (const [name, specifier] of Object.entries(values)) {
          if (byName.has(name)) edges.add(byName.get(name)!.name);
          else if (typeof specifier === "string" && specifier.startsWith("workspace:"))
            throw new Error(`Unresolved workspace dependency ${name}`);
          else if (typeof specifier === "string" && /^(?:file|link):/.test(specifier)) {
            const directory = normalize(
              NodePath.posix.join(workspace.directory, specifier.replace(/^[^:]+:/, "")),
            );
            const target = owner(directory);
            if (!target) throw new Error(`Unresolved local dependency ${name}`);
            edges.add(target.name);
          }
        }
      }
      // Import keys may be aliases: keep first registered name and recursive value order.
      const addImportTargets = (value: unknown): void => {
        if (value && typeof value === "object") {
          for (const target of Object.values(value)) addImportTargets(target);
          return;
        }
        if (typeof value !== "string") return;
        const target = value.startsWith(".")
          ? owner(normalize(NodePath.posix.join(workspace.directory, value)))
          : [...byName].find(([name]) => value === name || value.startsWith(`${name}/`))?.[1];
        if (target) edges.add(target.name);
      };
      addImportTargets(workspace.manifest.imports);
      if (!workspace.typecheck) continue;
      const files = [...entries.keys()].filter(
        (file) => owner(file)?.name === workspace.name && /(?:^|\/)tsconfig[^/]*\.json$/.test(file),
      );
      const typecheck = (workspace.manifest.scripts as Record<string, string>).typecheck!;
      if (
        !/^(?:(?:tsc|tsgo)(?:\s+(?:--noEmit|(?:-p|--project)(?:\s+|=)[\w./-]+))*|astro check)$/.test(
          typecheck,
        )
      ) {
        throw new Error(`Unsupported typecheck invocation for ${workspace.name}`);
      }
      const project = /(?:^|\s)(?:-p|--project)(?:\s+|=)([^\s;&|]+)/.exec(typecheck)?.[1];
      if (project) {
        if (/["'$`]/.test(project))
          throw new Error(`Unsupported typecheck project for ${workspace.name}`);
        const path = normalize(NodePath.posix.join(workspace.directory, project));
        files.push(entries.has(path) ? path : `${path}/tsconfig.json`);
      }
      if (!files.length) throw new Error(`No TypeScript configuration for ${workspace.name}`);
      const scopes = files.map((file) => readConfig(file));
      const scope = {
        inputs: scopes.flatMap((config) => config.inputs),
        aliases: scopes.flatMap((config) => config.aliases),
      };
      if (!scope.inputs.length)
        scope.inputs.push({ directory: workspace.directory, pattern: "**/*" });
      configs.set(workspace.name, scope);
      for (const input of [...scope.inputs, ...scope.aliases]) {
        const pattern = normalize(NodePath.posix.join(input.directory, input.pattern));
        if (NodePath.isAbsolute(pattern) || pattern.startsWith("../"))
          throw new Error(`Unsupported external TypeScript input ${pattern}`);
        patternRegex(pattern);
      }
      // Alias targets can consume another workspace without declaring a dependency.
      for (const alias of scope.aliases) {
        const path = normalize(NodePath.posix.join(alias.directory, alias.pattern)).split(
          /[?*]/,
        )[0]!;
        for (const target of workspaces) {
          if (path.startsWith(`${target.directory}/`) || target.directory.startsWith(path))
            edges.add(target.name);
        }
      }
    }

    const affected = new Set<string>();
    for (const file of changedFiles) {
      if (
        NodePath.posix.basename(file) === "package.json" ||
        /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|\.?mise\.toml|\.tool-versions|\.node-version|\.npmrc|\.pnpmfile\.[cm]?js)$/.test(
          file,
        ) ||
        configPaths.has(file) ||
        /(?:^|\/)tsconfig[^/]*\.json$/.test(file)
      )
        return full(`Workspace or TypeScript configuration changed: ${file}`);
      const explicitConsumers = workspaces.filter((workspace) =>
        configs
          .get(workspace.name)
          ?.inputs.some(
            (input) =>
              matchesInput(file, input) &&
              (SOURCE_FILE.test(file) ||
                NodePath.posix.extname(input.pattern) === NodePath.posix.extname(file)),
          ),
      );
      if (isInertFile(file) && !explicitConsumers.length) continue;
      const workspace = owner(file);
      if (!workspace) return full(`Changed path has no supported workspace owner: ${file}`);
      if (entries.get(file)?.mode === "120000") return full(`Changed path is a symlink: ${file}`);
      affected.add(workspace.name);
      for (const consumer of explicitConsumers) affected.add(consumer.name);
    }
    // Validate configs and explicit inputs before skipping inert changes; no
    // source imports can make documentation content part of a typecheck.
    if (!affected.size)
      return {
        kind: "none",
        packages: [],
        reason: "Only documentation or static assets changed",
        changedFiles,
      };

    const consumers = (file: string) =>
      workspaces.filter(
        (workspace) =>
          owner(file)?.name === workspace.name ||
          [
            ...(configs.get(workspace.name)?.inputs ?? []),
            ...(configs.get(workspace.name)?.aliases ?? []),
          ].some((input) => matchesInput(file, input)),
      );
    const sourceUsers = new Map<string, Set<string>>();
    const queue: Array<string> = [];
    const addSource = (file: string, users: ReadonlyArray<string>): void => {
      const current = sourceUsers.get(file) ?? new Set<string>();
      if (!users.some((user) => !current.has(user))) return;
      for (const user of users) current.add(user);
      sourceUsers.set(file, current);
      queue.push(file);
    };
    for (const file of entries.keys()) {
      if (SOURCE_FILE.test(file))
        addSource(
          file,
          consumers(file).map((workspace) => workspace.name),
        );
    }
    const processed = new Map<string, Set<string>>();
    const importedSources = (path: string) => {
      const stem = path.replace(/\.[cm]?jsx?$/i, "");
      const extension = NodePath.posix.extname(path);
      return [
        ...new Set([
          path,
          ...(extension ? [`${path.slice(0, -extension.length)}.d${extension}.ts`] : []),
          ...[
            "ts",
            "tsx",
            "mts",
            "cts",
            "d.ts",
            "d.mts",
            "d.cts",
            "js",
            "jsx",
            "mjs",
            "cjs",
          ].flatMap((extension) => [`${stem}.${extension}`, `${path}/index.${extension}`]),
        ]),
      ].filter((candidate) => entries.has(candidate) && SOURCE_FILE.test(candidate));
    };
    // Load the lightweight TypeScript preprocessor only after inert changes
    // have returned. It reads actual module syntax without building an AST.
    const typescript = NodeModule.createRequire(import.meta.url)(
      "typescript-legacy",
    ) as typeof import("typescript-legacy");
    const namespaceScanner = typescript.createScanner(typescript.ScriptTarget.Latest, true);
    const scanSource = (file: string, source: string): void => {
      const done = processed.get(file) ?? new Set<string>();
      const users = [...sourceUsers.get(file)!].filter((user) => !done.has(user));
      if (!users.length) return;
      for (const user of users) done.add(user);
      processed.set(file, done);
      const info = typescript.preProcessFile(source, true, true);
      const imports = new Set(
        [...info.importedFiles, ...info.typeReferenceDirectives].map(
          (reference) => reference.fileName,
        ),
      );
      // The installed preprocessor omits `export * as name from ...`; cover
      // that syntax with its token scanner, preserving string/comment handling.
      namespaceScanner.setText(source);
      let state = 0;
      let braces = 0;
      const templates: Array<number> = [];
      for (
        let token = namespaceScanner.scan();
        token !== typescript.SyntaxKind.EndOfFileToken;
        token = namespaceScanner.scan()
      ) {
        if (token === typescript.SyntaxKind.TemplateHead) {
          templates.push(braces);
          state = 0;
          continue;
        }
        if (token === typescript.SyntaxKind.OpenBraceToken) braces++;
        if (token === typescript.SyntaxKind.CloseBraceToken) {
          if (templates.at(-1) === braces) {
            const template = namespaceScanner.reScanTemplateToken(false);
            if (template === typescript.SyntaxKind.TemplateTail) templates.pop();
            state = 0;
            continue;
          }
          braces--;
        }
        if (state === 1 && token === typescript.SyntaxKind.TypeKeyword) continue;
        if (state === 1 && token === typescript.SyntaxKind.AsteriskToken) state = 2;
        else if (state === 2 && token === typescript.SyntaxKind.AsKeyword) state = 3;
        else if (
          state === 3 &&
          (token === typescript.SyntaxKind.Identifier ||
            token === typescript.SyntaxKind.StringLiteral ||
            (token >= typescript.SyntaxKind.FirstKeyword &&
              token <= typescript.SyntaxKind.LastKeyword))
        )
          state = 4;
        else if (state === 4 && token === typescript.SyntaxKind.FromKeyword) state = 5;
        else {
          if (state === 5 && token === typescript.SyntaxKind.StringLiteral)
            imports.add(namespaceScanner.getTokenValue());
          state = token === typescript.SyntaxKind.ExportKeyword ? 1 : 0;
        }
      }
      namespaceScanner.setText("");
      const references = [...imports].map((specifier) => ({ specifier, fileRelative: false }));
      references.push(
        ...info.referencedFiles.map((reference) => ({
          specifier: reference.fileName,
          fileRelative: true,
        })),
      );
      for (const { specifier, fileRelative } of references) {
        const relativePath =
          fileRelative || specifier.startsWith(".")
            ? normalize(NodePath.posix.join(NodePath.posix.dirname(file), specifier))
            : undefined;
        const targets = relativePath
          ? [owner(relativePath)]
          : [...byName]
              .filter(([name]) => specifier === name || specifier.startsWith(`${name}/`))
              .map(([, workspace]) => workspace);
        for (const user of users)
          for (const target of targets) if (target) dependencies.get(user)!.add(target.name);
        // Imported tracked helpers outside workspaces still participate in the
        // importing project's typecheck, even without an explicit include.
        // Bundler raw/URL imports expose an asset value rather than importing
        // the asset's body as a TypeScript module.
        const assetValue = /\?(?:raw|url)(?:$|[&#])/.test(specifier);
        if (relativePath && !owner(relativePath)) {
          const sources = importedSources(relativePath);
          if (
            !sources.length &&
            !assetValue &&
            (!NodePath.posix.extname(relativePath) || SOURCE_FILE.test(relativePath))
          ) {
            throw new Error(`Unresolved source outside workspaces: ${relativePath}`);
          }
          for (const target of sources) addSource(target, users);
        }
      }
    };
    for (let index = 0; index < queue.length;) {
      const batch = queue.slice(index);
      index = queue.length;
      readFiles(batch, scanSource);
    }
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const [name, edges] of dependencies) {
        if (!affected.has(name) && [...edges].some((dependency) => affected.has(dependency))) {
          affected.add(name);
          expanded = true;
        }
      }
    }
    const packages = allPackages.filter((name) => affected.has(name));
    return packages.length
      ? {
          kind: "affected",
          packages,
          reason: "Changed workspaces and their source/configuration consumers",
          changedFiles,
        }
      : {
          kind: "none",
          packages,
          reason:
            "Only documentation/static assets or workspaces without typecheck consumers changed",
          changedFiles,
        };
  } catch (error) {
    return full(
      `Cannot safely narrow typecheck: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
