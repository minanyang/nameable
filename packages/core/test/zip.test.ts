import { describe, expect, it } from "vite-plus/test";
import type { Context } from "../src/index.js";
import { remoteZipFiles } from "../src/zip.js";
import { fakeFetch, rangeReply, zipArchive } from "./fake-fetch.js";

const URL = "https://example.com/dump.zip";

function read(archive: Buffer, wanted: string[]) {
  const fetch = fakeFetch({ [URL]: (headers) => rangeReply(archive, headers) });
  const ctx: Context = { fetch, whois: async () => "", cache: new Map(), gates: new Map() };
  return { files: remoteZipFiles(ctx, URL, wanted), requests: () => fetch.calls.length };
}

describe("remoteZipFiles", () => {
  it("reads deflated and stored files, matched on their last path segment", async () => {
    for (const method of [0, 8]) {
      const archive = zipArchive(
        { "dump/data/a.csv": "alpha", "dump/data/b.csv": "", "x.txt": "x" },
        method,
      );
      const files = await read(archive, ["a.csv", "b.csv"]).files;
      expect(files.get("a.csv")?.toString()).toBe("alpha");
      expect(files.get("b.csv")?.toString()).toBe("");
    }
  });

  it("reads only the end of the archive, its directory and the wanted file", async () => {
    const big = "x".repeat(200_000);
    const { files, requests } = read(zipArchive({ "big.bin": big, "a.csv": "alpha" }, 0), [
      "a.csv",
    ]);
    expect((await files).get("a.csv")?.toString()).toBe("alpha");
    // End record, directory, local header, data.
    expect(requests()).toBe(4);
  });

  it.each([
    ["a missing file", zipArchive({ "a.csv": "alpha" }), "has no b.csv"],
    [
      "an unsupported compression method",
      zipArchive({ "b.csv": "x" }, 12),
      "compression method 12",
    ],
    ["something that is not a zip", Buffer.from("plain text"), "not a zip archive"],
    [
      "a zip64 archive",
      (() => {
        const archive = zipArchive({ "b.csv": "x" });
        archive.writeUInt32LE(0xffffffff, archive.length - 6);
        return archive;
      })(),
      "zip64",
    ],
    [
      "a broken central directory",
      (() => {
        const archive = zipArchive({ "b.csv": "x" });
        archive.writeUInt32LE(0, archive.readUInt32LE(archive.length - 6));
        return archive;
      })(),
      "broken central directory",
    ],
  ])("throws on %s", async (_, archive, message) => {
    await expect(read(archive, ["b.csv"]).files).rejects.toThrow(message);
  });
});
