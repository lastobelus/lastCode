// @effect-diagnostics nodeBuiltinImport:off -- Filesystem fixtures exercise the standalone preview preparation adapter.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";

import { preparePreviewSettings } from "./prepare-preview-settings.ts";

async function fixture() {
  const root = await NodeFSP.mkdtemp(
    NodePath.join(await NodeFSP.realpath(NodeOS.tmpdir()), "preview-settings-"),
  );
  const sourceStateDir = NodePath.join(root, "source", "userdata");
  const sourceBrowserProfile = NodePath.join(root, "browser-profile");
  const targetHome = NodePath.join(root, "preview");
  await NodeFSP.mkdir(sourceStateDir, { recursive: true });
  await NodeFSP.mkdir(sourceBrowserProfile);
  await NodeFSP.writeFile(NodePath.join(sourceStateDir, "client-settings.json"), "{}");
  return {
    root,
    options: {
      sourceStateDir,
      sourceBrowserProfile,
      targetHome,
      sourceOrigin: "http://localhost:4000",
    },
    async [Symbol.asyncDispose]() {
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

it("copies complete saved preference documents without changing their bytes or source", async () => {
  await using setup = await fixture();
  const { options } = setup;
  const settings = { sidebarProjectsAsGrid: true, futurePreference: { nested: [1, "two"] } };
  const documents = {
    "client-settings.json": `${JSON.stringify({ settings }, null, 2)}\n`,
    "settings.json": '{ "futureServerPreference": { "enabled": true } }\n',
    "keybindings.json": '{ "bindings": [{ "command": "new.command", "key": "meta+k" }] }\n',
    "desktop-settings.json": '{ "futureDesktopPreference": "saved" }\n',
  };
  for (const [name, bytes] of Object.entries(documents)) {
    await NodeFSP.writeFile(NodePath.join(options.sourceStateDir, name), bytes);
  }
  const result = await preparePreviewSettings(options, async () => new Map());
  expect(result.copiedFiles.sort()).toEqual(Object.keys(documents).sort());
  for (const [name, bytes] of Object.entries(documents)) {
    expect(
      await NodeFSP.readFile(NodePath.join(options.targetHome, "userdata", name), "utf8"),
    ).toBe(bytes);
    expect(await NodeFSP.readFile(NodePath.join(options.sourceStateDir, name), "utf8")).toBe(bytes);
  }
  const seed = JSON.parse(await NodeFSP.readFile(result.settingsPath, "utf8"));
  expect(JSON.parse(seed.localStorage["t3code:client-settings:v1"])).toEqual(settings);
});

it("replaces stale preview preferences when the source now uses defaults", async () => {
  await using setup = await fixture();
  const state = NodePath.join(setup.options.targetHome, "userdata");
  await NodeFSP.mkdir(NodePath.join(state, "themes"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(state, "settings.json"), '{"old":true}');
  await NodeFSP.writeFile(NodePath.join(state, "themes", "old.json"), "{}");
  await NodeFSP.writeFile(NodePath.join(state, "themes", "keep.txt"), "unrelated");
  await preparePreviewSettings(setup.options, async () => new Map());
  await expect(NodeFSP.readFile(NodePath.join(state, "settings.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await NodeFSP.readdir(NodePath.join(state, "themes"))).toEqual(["keep.txt"]);
});

it("seeds default client preferences and removes the stale copy when the source file is absent", async () => {
  await using setup = await fixture();
  await NodeFSP.unlink(NodePath.join(setup.options.sourceStateDir, "client-settings.json"));
  const targetFile = NodePath.join(setup.options.targetHome, "userdata", "client-settings.json");
  await NodeFSP.mkdir(NodePath.dirname(targetFile), { recursive: true });
  await NodeFSP.writeFile(targetFile, '{"lastcodeSidebarEnabled":true}');
  const result = await preparePreviewSettings(setup.options, async () => new Map());
  const seed = JSON.parse(await NodeFSP.readFile(result.settingsPath, "utf8"));
  expect(JSON.parse(seed.localStorage["t3code:client-settings:v1"])).toEqual({});
  expect(result.copiedFiles).not.toContain("client-settings.json");
  await expect(NodeFSP.stat(targetFile)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    NodeFSP.stat(NodePath.join(setup.options.sourceStateDir, "client-settings.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves non-missing client settings read errors without writing preview state", async () => {
  await using setup = await fixture();
  const sourceFile = NodePath.join(setup.options.sourceStateDir, "client-settings.json");
  await NodeFSP.unlink(sourceFile);
  await NodeFSP.mkdir(sourceFile);
  await expect(preparePreviewSettings(setup.options, async () => new Map())).rejects.toMatchObject({
    code: "EISDIR",
  });
  await expect(NodeFSP.stat(setup.options.targetHome)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["not json", "null", "[]", '{"pullRequestMergeMethod":12}'])(
  "uses empty global UI preferences for invalid optional state (%s)",
  async (raw) => {
    await using setup = await fixture();
    const result = await preparePreviewSettings(
      setup.options,
      async () => new Map([["t3code:ui-state:v1", raw]]),
    );
    const seed = JSON.parse(await NodeFSP.readFile(result.settingsPath, "utf8"));
    expect(JSON.parse(seed.localStorage["t3code:ui-state:v1"])).toEqual({});
    expect(JSON.parse(seed.localStorage["t3code:client-settings:v1"])).toEqual({});
  },
);

it("rereads a changing browser profile before publishing preview preferences", async () => {
  await using setup = await fixture();
  let attempts = 0;
  const result = await preparePreviewSettings(setup.options, async () => {
    attempts++;
    if (attempts < 3) throw new Error("database changed while reading");
    return new Map([["t3code:typography-advanced", "true"]]);
  });
  expect(attempts).toBe(3);
  const seed = JSON.parse(await NodeFSP.readFile(result.settingsPath, "utf8"));
  expect(seed.localStorage["t3code:typography-advanced"]).toBe("true");
});

it("stops after three failed profile snapshots without writing preview settings", async () => {
  await using setup = await fixture();
  let attempts = 0;
  const failure = new Error("unreadable profile");
  await expect(
    preparePreviewSettings(setup.options, async () => {
      attempts++;
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(attempts).toBe(3);
  await expect(NodeFSP.stat(setup.options.targetHome)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["client-settings.json", "settings.json", "preview-settings.json"])(
  "refuses an existing destination %s link outside the isolated home",
  async (name) => {
    await using setup = await fixture();
    const externalFile = NodePath.join(setup.root, "external-preferences.json");
    const original = '{"externalPreference":"keep"}';
    await NodeFSP.writeFile(externalFile, original);
    const stateDir = NodePath.join(setup.options.targetHome, "userdata");
    await NodeFSP.mkdir(stateDir, { recursive: true });
    await NodeFSP.symlink(externalFile, NodePath.join(stateDir, name));
    if (name === "settings.json") {
      await NodeFSP.writeFile(NodePath.join(setup.options.sourceStateDir, name), "{}");
    }
    await expect(preparePreviewSettings(setup.options, async () => new Map())).rejects.toThrow(
      "within the preview home",
    );
    expect(await NodeFSP.readFile(externalFile, "utf8")).toBe(original);
  },
);

it("refuses a dangling destination link that would create a file outside the preview home", async () => {
  await using setup = await fixture();
  const externalFile = NodePath.join(setup.root, "missing-preferences.json");
  const stateDir = NodePath.join(setup.options.targetHome, "userdata");
  await NodeFSP.mkdir(stateDir, { recursive: true });
  await NodeFSP.symlink(externalFile, NodePath.join(stateDir, "client-settings.json"));
  await expect(preparePreviewSettings(setup.options, async () => new Map())).rejects.toThrow(
    "within the preview home",
  );
  await expect(NodeFSP.stat(externalFile)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["userdata", "userdata/themes"])(
  "refuses a destination %s directory link outside the preview home before cleanup",
  async (name) => {
    await using setup = await fixture();
    const externalDir = NodePath.join(setup.root, "external-directory");
    await NodeFSP.mkdir(externalDir);
    await NodeFSP.writeFile(NodePath.join(externalDir, "keep.json"), "unchanged");
    const destination = NodePath.join(setup.options.targetHome, name);
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.symlink(externalDir, destination);
    await expect(preparePreviewSettings(setup.options, async () => new Map())).rejects.toThrow(
      "within the preview home",
    );
    expect(await NodeFSP.readdir(externalDir)).toEqual(["keep.json"]);
    expect(await NodeFSP.readFile(NodePath.join(externalDir, "keep.json"), "utf8")).toBe(
      "unchanged",
    );
  },
);

it("seeds only saved themes and client preferences, clears absent theme keys, and refreshes the seed ID", async () => {
  await using setup = await fixture();
  const settings = { unknownFuturePreference: "preserved" };
  await NodeFSP.writeFile(
    NodePath.join(setup.options.sourceStateDir, "client-settings.json"),
    JSON.stringify(settings),
  );
  const readStorage = async (directory: string, origin: string) => {
    expect(directory).toBe(
      NodePath.join(setup.options.sourceBrowserProfile, "Local Storage", "leveldb"),
    );
    expect(origin).toBe(setup.options.sourceOrigin);
    return new Map([
      ["t3code:theme", "custom-theme"],
      ["t3code:themes:v1", '{"custom-theme":{"name":"Saved"}}'],
      ["t3code:theme-future-preference", "saved"],
      ["t3code:client-settings:v1", '{"stale":true}'],
      ["t3code:auth-token", "private-auth"],
      ["t3code:session", "private-session"],
      ["t3code:runtime-override", "temporary"],
    ]);
  };
  const result = await preparePreviewSettings(setup.options, readStorage);
  const seed = JSON.parse(await NodeFSP.readFile(result.settingsPath, "utf8"));
  expect(seed.localStorage).toMatchObject({
    "t3code:theme": "custom-theme",
    "t3code:themes:v1": '{"custom-theme":{"name":"Saved"}}',
    "t3code:theme-future-preference": "saved",
    "t3code:theme-follow-system": null,
    "t3code:theme-appearance-mode": null,
    "t3code:theme-halves:v1": null,
    "t3code:client-settings:v1": JSON.stringify(settings),
  });
  expect(seed.localStorage["t3code:auth-token"]).toBeUndefined();
  expect(seed.localStorage["t3code:session"]).toBeUndefined();
  expect(seed.localStorage["t3code:runtime-override"]).toBeUndefined();
  expect(result.browserPreferenceCount).toBe(3);
  expect((await preparePreviewSettings(setup.options, readStorage)).id).not.toBe(result.id);
});

it("accepts the running app's lenient settings and carries saved preferences outside the main document", async () => {
  await using setup = await fixture();
  const raw = '{\n // Saved preferences\n "lastcodeSidebarEnabled": true,\n}';
  await NodeFSP.writeFile(NodePath.join(setup.options.sourceStateDir, "client-settings.json"), raw);
  const result = await preparePreviewSettings(
    setup.options,
    async () =>
      new Map([
        ["t3code:typography-advanced", "true"],
        ["chat_thread_sidebar_width", "320"],
        ["t3code:usage-page-preferences:v1", '{"range":"month"}'],
        [
          "t3code:ui-state:v1",
          '{"pullRequestMergeMethod":"squash","threadLastVisitedAtById":{"thread-1":"old"}}',
        ],
      ]),
  );
  const seed = JSON.parse(await NodeFSP.readFile(result.settingsPath, "utf8"));
  expect(JSON.parse(seed.localStorage["t3code:client-settings:v1"])).toEqual({
    lastcodeSidebarEnabled: true,
  });
  expect(seed.localStorage["t3code:typography-advanced"]).toBe("true");
  expect(seed.localStorage["chat_thread_sidebar_width"]).toBe("320");
  expect(seed.localStorage["t3code:usage-page-preferences:v1"]).toBe('{"range":"month"}');
  expect(seed.localStorage["t3code.renderMarkdown"]).toBeNull();
  expect(JSON.parse(seed.localStorage["t3code:ui-state:v1"])).toEqual({
    pullRequestMergeMethod: "squash",
  });
  expect(
    await NodeFSP.readFile(
      NodePath.join(setup.options.targetHome, "userdata", "client-settings.json"),
      "utf8",
    ),
  ).toBe(raw);
});

it("refuses the live home and destination directory or file links back to source", async () => {
  await using setup = await fixture();
  const { options } = setup;
  const reader = async () => new Map<string, string>();
  await expect(
    preparePreviewSettings(
      { ...options, targetHome: NodePath.dirname(options.sourceStateDir) },
      reader,
    ),
  ).rejects.toThrow("separate from the source");
  await expect(
    preparePreviewSettings({ ...options, targetHome: options.sourceStateDir }, reader),
  ).rejects.toThrow("separate from the source");
  await NodeFSP.mkdir(options.targetHome);
  await NodeFSP.symlink(options.sourceStateDir, NodePath.join(options.targetHome, "userdata"));
  await expect(preparePreviewSettings(options, reader)).rejects.toThrow("separate from the source");
  await NodeFSP.rm(NodePath.join(options.targetHome, "userdata"));
  await NodeFSP.mkdir(NodePath.join(options.targetHome, "userdata"));
  await NodeFSP.symlink(
    NodePath.join(options.sourceStateDir, "client-settings.json"),
    NodePath.join(options.targetHome, "userdata", "client-settings.json"),
  );
  await expect(preparePreviewSettings(options, reader)).rejects.toThrow("separate from the source");
  expect(
    await NodeFSP.readFile(NodePath.join(options.sourceStateDir, "client-settings.json"), "utf8"),
  ).toBe("{}");
});

it("refuses a dangling destination link into a missing source preference file", async () => {
  await using setup = await fixture();
  const { options } = setup;
  await NodeFSP.mkdir(NodePath.join(options.targetHome, "userdata"), { recursive: true });
  await NodeFSP.symlink(
    NodePath.join(options.sourceStateDir, "preview-settings.json"),
    NodePath.join(options.targetHome, "userdata", "preview-settings.json"),
  );
  await expect(preparePreviewSettings(options, async () => new Map())).rejects.toThrow(
    "separate from the source",
  );
  await expect(
    NodeFSP.readFile(NodePath.join(options.sourceStateDir, "preview-settings.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["existing", "missing"])("skips theme symlinks (%s target)", async (target) => {
  await using setup = await fixture();
  const { options } = setup;
  const sourceThemes = NodePath.join(options.sourceStateDir, "themes");
  const targetThemes = NodePath.join(options.targetHome, "userdata", "themes");
  const externalTheme = NodePath.join(setup.root, "external-theme.json");
  await NodeFSP.mkdir(sourceThemes);
  await NodeFSP.mkdir(targetThemes, { recursive: true });
  if (target === "existing") await NodeFSP.writeFile(externalTheme, '{"id":"unpublished"}');
  await NodeFSP.symlink(externalTheme, NodePath.join(sourceThemes, "linked.json"));
  await NodeFSP.writeFile(NodePath.join(sourceThemes, "regular.json"), '{"id":"published"}');
  await NodeFSP.writeFile(NodePath.join(targetThemes, "linked.json"), '{"id":"stale"}');

  const result = await preparePreviewSettings(options, async () => new Map());

  expect(result.copiedFiles).toEqual(["client-settings.json", "themes/regular.json"]);
  expect(await NodeFSP.readdir(targetThemes)).toEqual(["regular.json"]);
  expect(await NodeFSP.readFile(NodePath.join(targetThemes, "regular.json"), "utf8")).toBe(
    '{"id":"published"}',
  );
  expect((await NodeFSP.lstat(NodePath.join(sourceThemes, "linked.json"))).isSymbolicLink()).toBe(
    true,
  );
});

it("copies published JSON themes byte-for-byte from a linked source directory", async () => {
  await using setup = await fixture();
  const { options } = setup;
  const themeDir = NodePath.join(setup.root, "published-themes");
  await NodeFSP.mkdir(themeDir);
  await NodeFSP.symlink(themeDir, NodePath.join(options.sourceStateDir, "themes"));
  const bytes = '{ "id": "published-theme", "futureThemeField": { "value": 12 } }\n';
  await NodeFSP.writeFile(NodePath.join(themeDir, "published-theme.json"), bytes);
  await NodeFSP.writeFile(NodePath.join(themeDir, "unrelated.txt"), "not a theme");
  await NodeFSP.mkdir(NodePath.join(themeDir, "nested.json"));
  const result = await preparePreviewSettings(options, async () => new Map());
  expect(result.copiedFiles).toEqual(["client-settings.json", "themes/published-theme.json"]);
  expect(
    await NodeFSP.readFile(
      NodePath.join(options.targetHome, "userdata", "themes", "published-theme.json"),
      "utf8",
    ),
  ).toBe(bytes);
  expect(await NodeFSP.readFile(NodePath.join(themeDir, "published-theme.json"), "utf8")).toBe(
    bytes,
  );
  expect(await NodeFSP.readdir(NodePath.join(options.targetHome, "userdata", "themes"))).toEqual([
    "published-theme.json",
  ]);
});

it("rejects destination theme links into an external source theme directory", async () => {
  await using setup = await fixture();
  const { options } = setup;
  const sourceThemes = NodePath.join(setup.root, "published-themes");
  const targetThemes = NodePath.join(options.targetHome, "userdata", "themes");
  await NodeFSP.mkdir(sourceThemes);
  await NodeFSP.symlink(sourceThemes, NodePath.join(options.sourceStateDir, "themes"));
  const bytes = '{ "id": "published-theme" }\n';
  await NodeFSP.writeFile(NodePath.join(sourceThemes, "published-theme.json"), bytes);
  await NodeFSP.mkdir(NodePath.dirname(targetThemes), { recursive: true });
  await NodeFSP.symlink(sourceThemes, targetThemes);
  const reader = async () => new Map<string, string>();
  await expect(preparePreviewSettings(options, reader)).rejects.toThrow("separate from the source");
  await NodeFSP.rm(targetThemes);
  await NodeFSP.mkdir(targetThemes);
  await NodeFSP.symlink(
    NodePath.join(sourceThemes, "published-theme.json"),
    NodePath.join(targetThemes, "published-theme.json"),
  );
  await expect(preparePreviewSettings(options, reader)).rejects.toThrow("separate from the source");
  expect(await NodeFSP.readFile(NodePath.join(sourceThemes, "published-theme.json"), "utf8")).toBe(
    bytes,
  );
});
