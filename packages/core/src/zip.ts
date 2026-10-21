import { inflateRawSync } from "node:zlib";
import { get } from "./http.js";
import type { Context } from "./types.js";

const END = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ENTRY = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX32 = 0xffffffff;

/**
 * Files named `wanted` (matched on their last path segment) from a remote zip archive, read with HTTP
 * range requests, so a few small files come out of a multi-gigabyte archive without downloading it.
 * Throws when the archive cannot be read this way (no range support, zip64, a missing file).
 */
export async function remoteZipFiles(
  ctx: Context,
  url: string,
  wanted: string[],
): Promise<Map<string, Buffer>> {
  const range = async (spec: string) => {
    const res = await get(ctx, url, { headers: { range: `bytes=${spec}` }, timeoutMs: 120_000 });
    if (res.status !== 206)
      throw new Error(`${url} answered a range request with HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };

  // The end-of-central-directory record: 22 bytes plus a comment of up to 64 KB, at the very end.
  const tail = await range("-65557");
  const end = tail.lastIndexOf(END);
  if (end < 0) throw new Error(`${url} is not a zip archive`);
  const count = tail.readUInt16LE(end + 10);
  const size = tail.readUInt32LE(end + 12);
  const offset = tail.readUInt32LE(end + 16);
  if (size === MAX32 || offset === MAX32) throw new Error(`${url} is a zip64 archive`);

  const dir = await range(`${offset}-${offset + size - 1}`);
  const entries: { file: string; method: number; size: number; offset: number }[] = [];
  for (let at = 0, i = 0; i < count; i++) {
    if (dir.readUInt32LE(at) !== ENTRY) throw new Error(`${url} has a broken central directory`);
    const nameLength = dir.readUInt16LE(at + 28);
    const name = dir.toString("utf8", at + 46, at + 46 + nameLength);
    const file = wanted.find((w) => name === w || name.endsWith(`/${w}`));
    if (file) {
      entries.push({
        file,
        method: dir.readUInt16LE(at + 10),
        size: dir.readUInt32LE(at + 20),
        offset: dir.readUInt32LE(at + 42),
      });
    }
    at += 46 + nameLength + dir.readUInt16LE(at + 30) + dir.readUInt16LE(at + 32);
  }

  const files = new Map<string, Buffer>();
  for (const e of entries) {
    if (e.size === MAX32 || e.offset === MAX32) throw new Error(`${url} is a zip64 archive`);
    // The local header repeats the name and has its own extra field, so its length is read first.
    const header = await range(`${e.offset}-${e.offset + 29}`);
    if (header.readUInt32LE(0) !== LOCAL) throw new Error(`${url} has a broken local header`);
    const start = e.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const data = e.size ? await range(`${start}-${start + e.size - 1}`) : Buffer.alloc(0);
    if (e.method === 0) files.set(e.file, data);
    else if (e.method === 8) files.set(e.file, inflateRawSync(data));
    else throw new Error(`${url} uses zip compression method ${e.method}`);
  }
  const missing = wanted.filter((w) => !files.has(w));
  if (missing.length) throw new Error(`${url} has no ${missing.join(", ")}`);
  return files;
}
