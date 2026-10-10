// @effect-diagnostics nodeBuiltinImport:off -- Publication fixtures use disposable directories and controlled host seams.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { acquireLocalCiAdmissionLock } from "./lastcode-ci-admission-lock.ts";
import { PortableLockContentionError } from "../lastcode-lock.mjs";

const fixture = vi.hoisted(() => ({ platform: "linux" }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));
vi.mock("node:process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:process")>();
  return {
    ...actual,
    get platform() {
      return fixture.platform;
    },
  };
});
vi.mock("./lastcode-ci-process-identity.ts", () => ({
  getCurrentProcessStartIdentity: () => "fixture-start",
  readProcessIdentities: vi.fn(() => new Map()),
  isProcessIdentityRunning: vi.fn(() => true),
}));

const directories: string[] = [];
function temporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "admission-publication-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  vi.restoreAllMocks();
  fixture.platform = "linux";
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

describe("admission publication (controlled platform fixtures, not native Windows proof)", () => {
  it("publishes a prepared owner atomically and releases it once", async () => {
    const directory = temporaryDirectory();
    const rename = vi.spyOn(NodeFS, "renameSync");
    const release = await acquireLocalCiAdmissionLock(directory, {
      forceDirectoryLock: true,
      onCandidatePrepared: async () => {
        expect(NodeFS.existsSync(NodePath.join(directory, "admission.lock.d"))).toBe(false);
        const candidate = NodeFS.readdirSync(directory)[0]!;
        const files = NodeFS.readdirSync(NodePath.join(directory, candidate));
        expect(files).toHaveLength(1);
        expect(
          JSON.parse(NodeFS.readFileSync(NodePath.join(directory, candidate, files[0]!), "utf8")),
        ).toMatchObject({ startIdentity: "fixture-start" });
      },
    });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename.mock.calls[0]![1]).toBe(NodePath.join(directory, "admission.lock.d"));
    expect(NodeFS.readdirSync(directory)).toEqual(["admission.lock.d"]);
    release();
    release();
    expect(NodeFS.readdirSync(directory)).toEqual([]);
  });

  it.each(["EEXIST", "ENOTEMPTY"])(
    "reports a controlled live owner for %s without probing existence",
    async (code) => {
      const directory = temporaryDirectory();
      const lock = NodePath.join(directory, "admission.lock.d");
      const token = "11111111-1111-1111-1111-111111111111";
      NodeFS.mkdirSync(lock);
      NodeFS.writeFileSync(
        NodePath.join(lock, `owner-${token}.json`),
        JSON.stringify({ pid: 123, startIdentity: "fixture-live", token }),
      );
      vi.spyOn(NodeFS, "renameSync").mockImplementation(() => {
        throw { code };
      });
      const exists = vi.spyOn(NodeFS, "existsSync");
      await expect(
        acquireLocalCiAdmissionLock(directory, { forceDirectoryLock: true }),
      ).rejects.toBeInstanceOf(PortableLockContentionError);
      expect(exists).not.toHaveBeenCalled();
      expect(NodeFS.readdirSync(directory)).toEqual(["admission.lock.d"]);
      expect(NodeFS.readdirSync(lock)).toEqual([`owner-${token}.json`]);
    },
  );

  it("never reclaims malformed ownership after publication contention", async () => {
    const directory = temporaryDirectory();
    const lock = NodePath.join(directory, "admission.lock.d");
    NodeFS.mkdirSync(lock);
    NodeFS.writeFileSync(NodePath.join(lock, "unrecognized"), "not an owner");
    vi.spyOn(NodeFS, "renameSync").mockImplementation(() => {
      throw { code: "EEXIST" };
    });
    await expect(
      acquireLocalCiAdmissionLock(directory, { forceDirectoryLock: true }),
    ).rejects.toThrow("Invalid local CI admission owner");
    expect(NodeFS.readdirSync(lock)).toEqual(["unrecognized"]);
    expect(NodeFS.readdirSync(directory)).toEqual(["admission.lock.d"]);
  });

  it.each([
    ["linux", "EEXIST"],
    ["linux", "ENOTEMPTY"],
    ["darwin", "EEXIST"],
    ["darwin", "ENOTEMPTY"],
    ["win32", "EEXIST"],
    ["win32", "ENOTEMPTY"],
    ["win32", "EPERM"],
  ])("retries publication after controlled %s/%s contention", async (platform, code) => {
    const directory = temporaryDirectory();
    fixture.platform = platform;
    const realRename = NodeFS.renameSync;
    const rename = vi
      .spyOn(NodeFS, "renameSync")
      .mockImplementation(realRename)
      .mockImplementationOnce(() => {
        throw { code };
      });
    const exists = vi.spyOn(NodeFS, "existsSync").mockReturnValue(true);
    const release = await acquireLocalCiAdmissionLock(directory, { forceDirectoryLock: true });
    expect(rename).toHaveBeenCalledTimes(2);
    expect(exists).toHaveBeenCalledTimes(code === "EPERM" ? 1 : 0);
    expect(NodeFS.readdirSync(directory)).toEqual(["admission.lock.d"]);
    release();
    expect(NodeFS.readdirSync(directory)).toEqual([]);
  });

  it.each([
    ["linux", "EPERM"],
    ["darwin", "EPERM"],
    ["win32", "EPERM"],
    ["win32", "EACCES"],
  ])(
    "rethrows the identical error for controlled %s/%s without an existing lock",
    async (platform, code) => {
      const directory = temporaryDirectory();
      fixture.platform = platform;
      const error = { code };
      vi.spyOn(NodeFS, "renameSync").mockImplementation(() => {
        throw error;
      });
      const exists = vi.spyOn(NodeFS, "existsSync").mockReturnValue(false);
      await expect(
        acquireLocalCiAdmissionLock(directory, { forceDirectoryLock: true }),
      ).rejects.toBe(error);
      expect(exists).toHaveBeenCalledTimes(platform === "win32" && code === "EPERM" ? 1 : 0);
      expect(NodeFS.readdirSync(directory)).toEqual([]);
    },
  );

  it("preserves an exception from the Windows existence probe", async () => {
    const directory = temporaryDirectory();
    fixture.platform = "win32";
    const existsError = new Error("controlled existence failure");
    vi.spyOn(NodeFS, "renameSync").mockImplementation(() => {
      throw { code: "EPERM" };
    });
    vi.spyOn(NodeFS, "existsSync").mockImplementation(() => {
      throw existsError;
    });
    await expect(acquireLocalCiAdmissionLock(directory, { forceDirectoryLock: true })).rejects.toBe(
      existsError,
    );
    expect(NodeFS.readdirSync(directory)).toEqual([]);
  });
});
