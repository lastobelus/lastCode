import { describe, expect, it } from "vite-plus/test";

import {
  fileBasename,
  isMarkdownFileLinkLabel,
  inlineCodeFilePathCandidate,
  parseFileUrlHref,
  parseMarkdownFileLink,
  splitFilePathPosition,
  workspaceRelativeFilePath,
} from "./markdownLinks.ts";

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

describe("isMarkdownFileLinkLabel", () => {
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
