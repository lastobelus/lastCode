import { describe, expect, it } from "vite-plus/test";

import { assistantMarkdownFileReferences } from "./assistantMarkdownFiles.ts";

describe("assistantMarkdownFileReferences", () => {
  it.each([
    ["`./report.md`", ["./report.md"]],
    ["`report.md:12`", ["report.md"]],
    ["`report.md`", []],
    ["`origin/main`", []],
    ["[Read `./secret.md`](report.md)", ["report.md"]],
    ["![Screenshot](images/shot.png)", ["/workspace/project/images/shot.png"]],
    ["![Screenshot][shot]\n\n[shot]: images/shot.png", ["/workspace/project/images/shot.png"]],
    ["[Report](./report%2520.md)", ["./report%20.md"]],
    ["[Report](./report%23L12)", ["./report#L12"]],
    ["[Report](report.md?view=1#section)", ["report.md"]],
    [':codex-file-citation{path="tmp/report.md" line_range_start="66"}', ["tmp/report.md"]],
    ["[Report](C:\\work\\.notes\\report.md)", ["C:/work/.notes/report.md"]],
    ["![Screenshot](C:\\work\\.notes\\shot.png)", ["C:\\work\\.notes\\shot.png"]],
    ['<img src="C:\\work\\.notes\\shot.png">', ["C:/work/.notes/shot.png"]],
    ['<a href="./report%20file.md">Report</a>', ["./report file.md"]],
    ['<a href="./report&amp;notes.md">Report</a>', ["./report&notes.md"]],
    ['<img src="./shot.png">', ["/workspace/project/./shot.png"]],
    [
      '<a href="./report.md"><img src="./shot.png"></a>',
      ["./report.md", "/workspace/project/./shot.png"],
    ],
    ['<!-- <a href="./report.md">Report</a><img src="./shot.png"> -->', []],
    ['`<a href="./report.md">Report</a><img src="./shot.png">`', []],
    ['<script><a href="./report.md">Report</a><img src="./shot.png"></script>', []],
    ['<a href="javascript:./report.md">Report</a><img src="javascript:./shot.png">', []],
    ['<a href="https://example.com"><code data-inline-code="">./secret.md</code></a>', []],
    ['<a href="https://example.com">`./secret.md`</a>', []],
    ['```html\n<a href="./report.md">Report</a><img src="./shot.png">\n```', []],
    [
      '```md\n`./report.md`\n![Screenshot](shot.png)\n:codex-file-citation{path="report.md"}\n```',
      [],
    ],
  ])("matches client file presentation for %s", (markdown, expected) => {
    expect(
      assistantMarkdownFileReferences(markdown, "/workspace/project").map(
        (reference) => reference.path,
      ),
    ).toEqual(expected);
  });
});
