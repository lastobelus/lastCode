import { describe, expect, it } from "vite-plus/test";
import { collectTagPages } from "./pagination";

describe("tag discovery pagination", () => {
  it("includes later pages without retaining results from a superseded request", async () => {
    const cursors: Array<number | undefined> = [];
    const read = async (cursor: number | undefined) => {
      cursors.push(cursor);
      return cursor === undefined
        ? { items: ["first"], nextCursor: 100 }
        : { items: ["last"], nextCursor: null };
    };
    expect(await collectTagPages(read, () => true)).toEqual(["first", "last"]);
    expect(cursors).toEqual([undefined, 100]);
    expect(await collectTagPages(read, () => false)).toEqual([]);
  });
  it("rejects a nonadvancing cursor rather than repeating requests", async () => {
    await expect(
      collectTagPages(
        async () => ({ items: [], nextCursor: 100 }),
        () => true,
      ),
    ).rejects.toThrow("did not advance");
  });
});
