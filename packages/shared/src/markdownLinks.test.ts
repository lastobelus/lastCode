import { splitFilePathPosition } from "./fileLinks.ts";
import { parseFileUrlHref } from "./fileLinks.ts";
import { workspaceRelativeFilePath, fileBasename } from "./path.ts";
import { describe, expect, it } from "vite-plus/test";
import {
  extractMarkdownLinkHrefs,
  resolveMarkdownFileLinkTarget,
  isWindowsDrivePathHref,
} from "./markdownLinks.ts";

import {
  inlineCodeFilePathCandidate,
  isMarkdownFileLinkLabel,
  parseMarkdownFileLink,
} from "./markdownLinks.ts";

describe("isMarkdownFileLinkLabel", () => {
  it.each([
    ["validates the input", "/repo/src/example.ts:12", false],
    ["read src/example.ts", "/repo/src/example.ts:12", false],
    ["example.ts?why this matters", "/repo/src/example.ts", false],
    ["example.ts", "/repo/src/example.ts:12", true],
    ["example.ts:12", "/repo/src/example.ts:12", true],
    ["example.ts:99", "/repo/src/example.ts:12", false],
    ["example.ts:12:2", "/repo/src/example.ts:12:2", true],
    ["example.ts:12:3", "/repo/src/example.ts:12:2", false],
    ["example.ts:12", "/repo/src/example.ts", false],
    ["src/example.ts:12", "/repo/src/example.ts:12", true],
    ["./src/example.ts", "/repo/src/example.ts", true],
    ["/repo/src/example.ts", "/repo/src/example.ts", true],
    ["src/", "/home/me/project/src/", true],
    ["EXAMPLE.TS", "C:/repo/src/example.ts:12", true],
    ["file name.ts", "file:///repo/file%20name.ts", true],
    ["", "/repo/src/example.ts", true],
    ["", "https://example.com/docs", false],
    ["", "", false],
  ])("classifies %s for %s", (label, href, expected) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(expected);
  });
});

describe("inlineCodeFilePathCandidate", () => {
  it.each([
    ["src\\main.ts", "src/main.ts"],
    ["C:\\Users\\demo\\image.png", "C:\\Users\\demo\\image.png"],
    ["\\\\server\\share\\image.png", "\\\\server\\share\\image.png"],
    ["conf.d/nginx.conf", "conf.d/nginx.conf"],
    ["script.pl:10", "script.pl:10"],
    ["node.meta", null],
    ["Recorded evidence here: /tmp/image.png", null],
    ["origin/main", null],
    ["127.0.0.1:3000", null],
    ["example.com/index.html", null],
    ["example.pl/index.html", null],
    ["z-ai/glm-5.3", null],
    ["z-ai/glm-5.3:12", null],
    ["python/3.12", null],
    ["Qwen/Qwen2.5-Coder", null],
    ["meta-llama/Llama-3.1-8B", null],
    ["share/man/ls.1", "share/man/ls.1"],
    ["usr/lib/libfoo.so.1", "usr/lib/libfoo.so.1"],
    ["vendor/jquery-3.6.0.min.js", "vendor/jquery-3.6.0.min.js"],
    ["./models/glm-5.3", "./models/glm-5.3"],
  ])("distinguishes file paths from code and hostnames in %s", (source, candidate) => {
    expect(inlineCodeFilePathCandidate(source)).toBe(candidate);
  });
});

describe("parseFileUrlHref", () => {
  it.each([
    ["file:///Users/julius/project/src/main.ts#L42", "/Users/julius/project/src/main.ts", "#L42"],
    [
      "file:///D:/Programme/t3code/OpenInPicker.tsx#L69",
      "D:/Programme/t3code/OpenInPicker.tsx",
      "#L69",
    ],
    ["file://server/share/workspace-image.svg", "\\\\server\\share\\workspace-image.svg", ""],
    ["file://localhost/home/me/notes.md", "/home/me/notes.md", ""],
  ])("parses %s", (href, path, hash) => {
    expect(parseFileUrlHref(href)).toEqual({ path, hash });
  });

  it("keeps percent-encoding so the caller decodes once", () => {
    expect(parseFileUrlHref("file:///Users/julius/project/file%2520name.md")?.path).toBe(
      "/Users/julius/project/file%2520name.md",
    );
    expect(parseFileUrlHref("file:///c%3A/Users/x/shot.png")?.path).toBe("/c%3A/Users/x/shot.png");
  });

  it.each(["https://example.com/a.ts", "file://%", "/Users/julius/a.ts"])("rejects %s", (href) => {
    expect(parseFileUrlHref(href)).toBeNull();
  });
});

describe("splitFilePathPosition", () => {
  it.each([
    ["src/main.ts", "", { path: "src/main.ts" }],
    ["src/main.ts:12", "", { path: "src/main.ts", line: 12 }],
    ["src/main.ts:12:5", "", { path: "src/main.ts", line: 12, column: 5 }],
    ["src/main.ts", "#L18C2", { path: "src/main.ts", line: 18, column: 2 }],
    ["src/main.ts:3", "#L18C2", { path: "src/main.ts", line: 3 }],
    ["src/main.ts:0", "", { path: "src/main.ts" }],
    ["src/main.ts", "#section", { path: "src/main.ts" }],
  ])("splits %s%s", (path, hash, expected) => {
    expect(splitFilePathPosition(path, hash)).toEqual(expected);
  });
});

describe("parseMarkdownFileLink", () => {
  // Both clients consume this table, so a path the web app recognizes is one
  // the mobile app recognizes too.
  it.each([
    ["/Users/julius/project/AGENTS.md", "/Users/julius/project/AGENTS.md"],
    ["/home/me/notes.md", "/home/me/notes.md"],
    ["/usr/local/bin/tool", "/usr/local/bin/tool"],
    ["/workspace/Makefile", "/workspace/Makefile"],
    ["/tmp/favicons/", "/tmp/favicons/"],
    ["C:\\Users\\mike\\project\\src\\main.ts", "C:\\Users\\mike\\project\\src\\main.ts"],
    ["C:%5Crepo%5Cimage.png", "C:\\repo\\image.png"],
    ["\\\\server\\share\\image.png", "\\\\server\\share\\image.png"],
    ["/D:/Programme/t3code/OpenInPicker.tsx", "D:/Programme/t3code/OpenInPicker.tsx"],
    ["</D:/Programme/t3code/ChatMarkdown.tsx:1>", "D:/Programme/t3code/ChatMarkdown.tsx"],
    ["file:///Users/julius/project/file%2520name.md", "/Users/julius/project/file%20name.md"],
    ["file://server/share/workspace-image.svg", "\\\\server\\share\\workspace-image.svg"],
    ["file://localhost/home/me/notes.md", "/home/me/notes.md"],
    ["apps/mobile/src/index.ts:10", "apps/mobile/src/index.ts"],
    ["docs/My%20Folder/checklist.xml", "docs/My Folder/checklist.xml"],
    ["Updated%20cutover%20checklist.md", "Updated cutover checklist.md"],
    ["./scripts/deploy", "./scripts/deploy"],
    ["~/notes/today.md", "~/notes/today.md"],
    ["AGENTS.md", "AGENTS.md"],
    ["script.ts:10", "script.ts"],
    ["/tmp/clip%23one.mp4#t=2", "/tmp/clip#one.mp4"],
  ])("recognizes %s as a file", (href, path) => {
    expect(parseMarkdownFileLink(href)?.path).toBe(path);
  });

  it.each([
    "",
    "#anchor",
    "//cdn.example.com/clip.mp4",
    "https://example.com/docs",
    "mailto:someone@example.com",
    "javascript:alert(1)",
    "/chat/settings",
    "/chat/settings#L3",
    "/app#L1",
    "readme",
    "TODO:12",
  ])("does not treat %s as a file", (href) => {
    expect(parseMarkdownFileLink(href)).toBeNull();
  });

  it("accepts conventional extensionless names with or without a position", () => {
    expect(parseMarkdownFileLink("Makefile")).toEqual({ path: "Makefile" });
    expect(parseMarkdownFileLink("Dockerfile:8")).toEqual({ path: "Dockerfile", line: 8 });
    expect(parseMarkdownFileLink("/srv/app/Makefile")).toEqual({ path: "/srv/app/Makefile" });
  });

  it("reads positions from suffixes and line anchors", () => {
    expect(parseMarkdownFileLink("/Users/julius/project/src/main.ts#L42C7")).toEqual({
      path: "/Users/julius/project/src/main.ts",
      line: 42,
      column: 7,
    });
    expect(parseMarkdownFileLink("file://server/share/src/main.ts#L42C7")).toMatchObject({
      path: "\\\\server\\share\\src\\main.ts",
      line: 42,
      column: 7,
    });
  });
});

describe("fileBasename", () => {
  it.each([
    ["/tmp/favicons/", "favicons"],
    ["C:\\Users\\kelchm\\.claude\\", ".claude"],
    ["/tmp/", "tmp"],
    ["AGENTS.md", "AGENTS.md"],
    ["/", "/"],
  ])("labels %s as %s", (path, basename) => {
    expect(fileBasename(path)).toBe(basename);
  });
});

describe("workspaceRelativeFilePath", () => {
  it.each([
    ["/repo/project", "/repo/project", "."],
    ["/repo/project/", "/repo/project/", "."],
    ["/", "/", "."],
    ["C:/USERS/mike/project", "c:/users/MIKE/project", "."],
    ["C:/", "c:/", "."],
    ["/repo/project/src/main.ts", "/repo/project", "src/main.ts"],
    ["/repo/project/src/main.ts", "/repo/project/", "src/main.ts"],
    ["C:\\Users\\mike\\t3code\\apps\\web\\a.ts", "C:/Users/mike/t3code", "apps/web/a.ts"],
    ["/C:/Users/mike/t3code/apps/web/a.ts", "C:/Users/mike/t3code", "apps/web/a.ts"],
    ["/Repo/Project/src/main.ts", "/repo/project", null],
    ["/tmp/case/project/probe.txt", "/tmp/case/Project", null],
    ["//tmp/case/project/probe.txt", "//tmp/case/Project", null],
    ["/tmp/case/Project/probe.txt", "/tmp/case/Project", "probe.txt"],
    ["C:/USERS/mike/t3code/main.ts", "c:/users/MIKE/t3code", "main.ts"],
    ["/C:/USERS/mike/t3code/main.ts", "/c:/users/MIKE/t3code", "main.ts"],
    ["\\\\server\\share\\PROJECT\\main.ts", "\\\\Server\\Share\\Project", "main.ts"],
    ["/tmp/repo/file.ts", "/", "tmp/repo/file.ts"],
    ["C:/Users/MIKE/main.ts", "c:/", "Users/MIKE/main.ts"],
    ["\\\\server\\SHARE\\file.ts", "\\\\Server\\Share\\", "file.ts"],
    ["/tmp/repo/file.ts ", "/tmp/repo", "file.ts "],
    ["/tmp/report.ts", "/repo/project", null],
    ["/repo/project-two/a.ts", "/repo/project", null],
    ["/repo/project/a.ts", undefined, null],
  ])("relates %s to %s", (path, workspaceRoot, relativePath) => {
    expect(workspaceRelativeFilePath(path, workspaceRoot)).toBe(relativePath);
  });
});

describe("isWindowsDrivePathHref", () => {
  it.each([
    ["C:\\repo\\image.png", true],
    ["C:%5Crepo%5Cimage.png", true],
    ["https://example.com/image.png", false],
  ])("classifies %s as %s", (href, expected) => {
    expect(isWindowsDrivePathHref(href)).toBe(expected);
  });
});

describe("extractMarkdownLinkHrefs", () => {
  it("extracts angle-bracketed paths containing spaces", () => {
    expect(
      extractMarkdownLinkHrefs(
        "[Open the Bike Receipts folder](</Users/dara/Downloads/Lime Ride Artifacts/Bike Receipts>)",
      ),
    ).toEqual(["/Users/dara/Downloads/Lime Ride Artifacts/Bike Receipts"]);
  });

  it("preserves ordinary destinations and ignores link titles", () => {
    expect(
      extractMarkdownLinkHrefs(
        '[source](apps/web/src/markdown-links.ts "implementation") and [docs](https://example.com)',
      ),
    ).toEqual(["apps/web/src/markdown-links.ts", "https://example.com"]);
  });
});

describe("resolveMarkdownFileLinkTarget", () => {
  it("resolves absolute posix file paths", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/AGENTS.md")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("resolves relative file paths against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("src/processRunner.ts:71", "/Users/julius/project")).toBe(
      "/Users/julius/project/src/processRunner.ts:71",
    );
  });

  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  it("resolves bare file names against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("AGENTS.md", "/Users/julius/project")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("maps #L line anchors to editor line suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  it("ignores external urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
    expect(resolveMarkdownFileLinkTarget("//cdn.example.com/clip.mp4", "/workspace")).toBeNull();
  });

  it("does not double-decode file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });

  it("resolves file uri authorities as windows UNC paths", () => {
    expect(resolveMarkdownFileLinkTarget("file://server/share/workspace-image.svg")).toBe(
      "\\\\server\\share\\workspace-image.svg",
    );
  });

  it("resolves a localhost file uri as a local path", () => {
    expect(resolveMarkdownFileLinkTarget("file://localhost/home/me/notes.md")).toBe(
      "/home/me/notes.md",
    );
  });

  it("keeps an encoded final space in the absolute target", () => {
    expect(resolveMarkdownFileLinkTarget("/tmp/repo/file.ts%20", "/tmp/repo")).toBe(
      "/tmp/repo/file.ts ",
    );
  });

  it("normalizes slash-prefixed windows drive paths before resolving", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "/D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx:69");
  });

  it("resolves angle-bracketed windows drive paths", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "</D:/Programme/t3code/apps/web/src/components/ChatMarkdown.tsx:1>",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/ChatMarkdown.tsx:1");
  });

  it("does not treat app routes as file links, even with a line anchor", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
    expect(resolveMarkdownFileLinkTarget("/chat/settings#L3", "/repo")).toBeNull();
  });

  it("decodes an encoded drive colon in a file uri before dropping its slash", () => {
    expect(resolveMarkdownFileLinkTarget("file:///c%3A/Users/x/shot.png")).toBe(
      "c:/Users/x/shot.png",
    );
  });
});

describe("isMarkdownFileLinkLabel", () => {
  it.each(["README.md ", " README.md", "\nREADME.md", "README.md\u00a0"])(
    "preserves surrounding label whitespace in %j",
    (label) => expect(isMarkdownFileLinkLabel(label, "/repo/README.md")).toBe(false),
  );

  it.each([
    ["<example.ts>", "/repo/example.ts", false],
    ["<example.ts:12>", "/repo/example.ts:12", false],
    ["<example.ts>", "/tmp/%3Cexample.ts%3E", true],
    ["<example.ts>:12", "/tmp/%3Cexample.ts%3E:12", true],
  ])("preserves literal angle brackets in %s", (label, href, compact) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(compact);
  });

  it.each([
    ["README.md#L0", "/tmp/README.md%23L0", true],
    ["README.md#L0", "/tmp/README.md#L0", false],
    ["README.md#L12C0", "/tmp/README.md%23L12C0", true],
  ])("distinguishes literal zero anchors in %s", (label, href, compact) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(compact);
  });

  it.each([
    "example.ts:0",
    "example.ts:12:0",
    "example.ts#L0",
    "example.ts#L12C0",
    "example.ts:00",
  ])("preserves invalid explicit position in %s", (label) =>
    expect(isMarkdownFileLinkLabel(label, "/repo/example.ts:12")).toBe(false),
  );

  it.each([
    ["clip#one.mp4#L12", "/tmp/clip%23one.mp4#L12", true],
    ["clip?one.mp4#L12C4", "/tmp/clip%3Fone.mp4:12:4", true],
    ["clip#one.mp4#L12", "/tmp/clip%23one.mp4:99", false],
    ["clip?one.mp4#L12C4", "/tmp/clip%3Fone.mp4:12:8", false],
    ["clip#one.mp4#L12", "/tmp/clip%23one.mp4", false],
    ["CLIP#ONE.mp4#l12", "C:/clips/clip%23one.mp4:12", true],
    ["clip#one.mp4#L12", "/tmp/clip%23one.mp4%23L12", true],
    ["clip#one.mp4#details", "/tmp/clip%23one.mp4", false],
  ])("matches trailing position anchors on literal filename %s", (label, href, compact) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(compact);
  });

  it.each([
    ["clip#one.mp4:12", "/tmp/clip%23one.mp4:12", true],
    ["clip?one.mp4:12:4", "/tmp/clip%3Fone.mp4:12:4", true],
    ["clip#one.mp4:12", "/tmp/clip%23one.mp4:99", false],
    ["clip?one.mp4:12:4", "/tmp/clip%3Fone.mp4:12:8", false],
    ["clip#one.mp4:12", "/tmp/clip%23one.mp4", false],
    ["CLIP#ONE.mp4:12", "C:/clips/clip%23one.mp4:12", true],
  ])("matches positions on literal filename %s", (label, href, compact) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(compact);
  });

  it.each([
    ["clip#one.mp4", "/tmp/clip%23one.mp4#t=2"],
    ["clip?one.mp4", "/tmp/clip%3Fone.mp4"],
    ["./clips/clip#one.mp4", "/tmp/clips/clip%23one.mp4"],
    ["CLIP#ONE.mp4", "C:/clips/clip%23one.mp4"],
  ])("keeps literal filename delimiters compact in %s", (label, href) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(true);
  });

  it.each([
    ["README.md#installation", "/repo/README.md"],
    ["README.md?mode=raw", "/repo/README.md"],
    ["README.md?mode=raw#L12", "/repo/README.md:12"],
    ["file:///repo/README.md#installation", "/repo/README.md"],
    ["README.md#installation", "/repo/README.md#installation"],
    ["README.md#", "/repo/README.md"],
  ])("preserves non-position suffixes in %s", (label, href) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(false);
  });

  it.each([
    ["C:\\Repo\\src\\Example.ts", "c:\\repo\\src\\example.ts", true],
    ["SRC/Example.ts:12", "c:/repo/src/example.ts:12", true],
    ["Example.ts", "file:///C:/repo/example.ts", true],
    ["Example.ts:99", "c:/repo/example.ts:12", false],
    ["/Repo/Example.ts", "/repo/example.ts", false],
    ["Example.ts", "/repo/example.ts", false],
  ])("respects filesystem casing for %s against %s", (label, href, compact) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(compact);
  });

  it.each([
    ["example.ts:99", "/repo/example.ts:12", false],
    ["example.ts:12:8", "/repo/example.ts:12:4", false],
    ["example.ts:12", "/repo/example.ts", false],
    ["example.ts:12:4", "/repo/example.ts:12", false],
    ["file:///repo/example.ts#L99", "/repo/example.ts:12", false],
    ["file:///repo/example.ts#L12C8", "/repo/example.ts:12:4", false],
    ["example.ts", "/repo/example.ts:12:4", true],
    ["example.ts:12", "/repo/example.ts:12:4", true],
    ["example.ts:12:4", "/repo/example.ts:12:4", true],
    ["file:///repo/example.ts#L12C4", "/repo/example.ts:12:4", true],
  ])("matches explicit positions in %s against %s", (label, href, compact) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(compact);
  });

  it.each([
    "example.ts",
    "example.ts:12",
    "src/example.ts",
    "./src/example.ts:12",
    "/repo/src/example.ts",
    "file:///repo/src/example.ts#L12",
    "",
  ])("keeps destination label %s compact", (label) =>
    expect(isMarkdownFileLinkLabel(label, "/repo/src/example.ts:12")).toBe(true),
  );
  it.each(["validates the input", "the example.ts", "other.ts", "src/other.ts"])(
    "preserves authored label %s",
    (label) => expect(isMarkdownFileLinkLabel(label, "/repo/src/example.ts:12")).toBe(false),
  );
  it.each(["favicons", "favicons/", "/tmp/favicons/"])(
    "keeps directory label %s compact",
    (label) => {
      expect(isMarkdownFileLinkLabel(label, "/tmp/favicons/")).toBe(true);
    },
  );
  it("recognizes Windows paths and encoded destinations", () => {
    expect(isMarkdownFileLinkLabel("src\\example.ts:12", "C:\\repo\\src\\example.ts:12")).toBe(
      true,
    );
    expect(isMarkdownFileLinkLabel("my file.ts", "/repo/my%20file.ts#L12")).toBe(true);
  });
});
