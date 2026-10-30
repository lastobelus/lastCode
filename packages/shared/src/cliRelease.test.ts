import { describe, expect, it } from "vite-plus/test";

import {
  acceptsTrackSwitchRelease,
  cliArchiveTarCommand,
  cliReleaseChannelOf,
  crossesReleaseTrack,
  desktopUpdateChannelOf,
  newestCliReleaseVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it.each(["", ".1"])("keeps nightly revision %s on its guarded release track", (revision) => {
    const nightly = `1.2.4-nightly.20261030.3917${revision}`;
    const older = "1.2.4-nightly.20261030.3916.9";
    const preview = `1.2.4-preview.20261030.3917${revision}`;

    expect(cliReleaseChannelOf(nightly)).toBe("nightly");
    expect(desktopUpdateChannelOf(nightly)).toBe("nightly");
    expect(cliReleaseChannelOf(preview)).toBe("preview");
    expect(desktopUpdateChannelOf(preview)).toBe("latest");
    expect(crossesReleaseTrack("1.2.3", nightly)).toBe(true);
    expect(crossesReleaseTrack(nightly, "1.2.4")).toBe(true);
    expect(crossesReleaseTrack(older, nightly)).toBe(false);
    expect(crossesReleaseTrack(preview, nightly)).toBe(false);
    expect(acceptsTrackSwitchRelease(nightly, "nightly", nightly)).toBe(true);
    expect(acceptsTrackSwitchRelease(older, "nightly", nightly)).toBe(false);
    expect(acceptsTrackSwitchRelease(nightly, "latest", "1.2.3")).toBe(false);
    expect(acceptsTrackSwitchRelease("1.2.4", "nightly", nightly)).toBe(false);
    expect(acceptsTrackSwitchRelease(preview, "nightly", nightly)).toBe(false);
    expect(newestCliReleaseVersion([{ tag_name: `v${nightly}` }], "nightly")).toBe(nightly);
  });

  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });
});
