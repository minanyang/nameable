import { describe, expect, it } from "vite-plus/test";
import {
  classesOf,
  entriesFrom,
  formatList,
  HEADER,
  keysOf,
  normalize,
  shardOf,
  SHARDS,
  type MarkRecord,
} from "../../../scripts/tw-trademarks.ts";
import * as channel from "../src/channels/trademark-tw.js";

const mark = (fields: MarkRecord): MarkRecord => ({
  "appl-no": "113000001",
  "appl-date": "2024/01/02",
  goodsclasses: [{ "goodsclass-code": "009" }],
  deadline: "2034/01/01",
  "del-reason": null,
  ...fields,
});

describe("scripts/tw-trademarks.ts", () => {
  it("compares names folded to lower-case letters and digits", () => {
    expect(normalize("Cover-Girl")).toBe("covergirl");
    expect(normalize("ＮＡＭＥ　ａｂｌｅ")).toBe("nameable");
    expect(normalize("旭梅 Sm")).toBe("旭梅sm");
  });

  it("finds a mark by the words in its drawing, or by its name without TIPO's suffixes", () => {
    expect(
      keysOf(mark({ "tmark-name": "旭梅Sm及圖", "tmark-draft-c": "旭梅", "tmark-draft-e": "SM" })),
    ).toEqual(["sm", "旭梅"]);
    expect(keysOf(mark({ "tmark-name": "EBARA及圖（墨色）" }))).toEqual(["ebara"]);
    expect(keysOf(mark({ "tmark-name": "LUCY BELLE 及圖形 (logo)" }))).toEqual(["lucybelle"]);
    expect(keysOf(mark({ "tmark-name": "1868及設計圖" }))).toEqual(["1868"]);
    expect(keysOf(mark({ "tmark-name": "cama cafe 立體商標" }))).toEqual(["camacafe"]);
    expect(keysOf(mark({ "tmark-name": "100% with design (in color)" }))).toEqual(["100"]);
    expect(keysOf(mark({ "tmark-name": "16-LEAF LAUREL WREATH DEVICE （墨色）" }))).toEqual([
      "16leaflaurelwreath",
    ]);
    // Only a descriptive word on its own goes, not the end of a name.
    expect(keysOf(mark({ "tmark-name": "Redesign" }))).toEqual(["redesign"]);
    expect(keysOf(mark({ "tmark-name": "地圖" }))).toEqual(["地圖"]);
    expect(keysOf(mark({ "tmark-name": "COVER GIRL", "tmark-draft-e": "Cover Girl" }))).toEqual([
      "covergirl",
    ]);
    // A drawing with no words leaves nothing to find it by.
    expect(keysOf(mark({ "tmark-name": "（墨色）" }))).toEqual([]);
  });

  it("marks the classes of the scheme used before the Nice classes", () => {
    expect(
      classesOf(
        mark({ goodsclasses: [{ "goodsclass-code": "042" }, { "goodsclass-code": "009" }] }),
      ),
    ).toBe("9,42");
    expect(
      classesOf(mark({ "appl-date": "1992/06/04", goodsclasses: [{ "goodsclass-code": "005" }] })),
    ).toBe("old:5");
    expect(
      classesOf(mark({ "appl-date": "1995/07/18", goodsclasses: [{ "goodsclass-code": "092" }] })),
    ).toBe("old:92");
    expect(classesOf(mark({ goodsclasses: null }))).toBe("");
  });

  it("keeps registrations in force or still renewable, and applications not yet registered", () => {
    const registrations = [
      mark({ "appl-no": "1", "tmark-name": "ALPHA" }),
      mark({ "appl-no": "2", "tmark-name": "BETA", "del-reason": "J" }),
      mark({ "appl-no": "3", "tmark-name": "GAMMA", deadline: "2026/01/01" }),
      mark({ "appl-no": "5", "tmark-name": "DELTA", deadline: "2026/06/01" }),
      mark({ "appl-no": "6", "tmark-name": "DELTA", deadline: "2026/06/01", "del-reason": "2" }),
    ];
    const applications = [
      mark({ "appl-no": "1", "tmark-name": "ALPHA" }),
      mark({ "appl-no": "2", "tmark-name": "BETA" }),
      mark({ "appl-no": "4", "tmark-name": "Alpha\t及圖" }),
    ];
    expect(entriesFrom(registrations, applications, "2026/11/03", "2026/05/03")).toEqual([
      { key: "alpha", name: "ALPHA", classes: "9", status: "registered", applNo: "1" },
      { key: "alpha", name: "Alpha 及圖", classes: "9", status: "applied", applNo: "4" },
      { key: "delta", name: "DELTA", classes: "9", status: "expiring", applNo: "5" },
    ]);
  });

  it("files and compares names exactly as the trademark-tw channel looks them up", () => {
    expect(SHARDS).toBe(channel.SHARDS);
    for (const name of [
      "",
      "Claude",
      "台積電",
      "ＮＡＭＥ　ａｂｌｅ",
      "cama cafe",
      "ちびしまうさ",
      "é",
    ]) {
      expect(normalize(name)).toBe(channel.normalizeMark(name));
      expect(shardOf(normalize(name))).toBe(channel.shardOf(channel.normalizeMark(name)));
    }
  });

  it("puts a name in one of 16 files, the same one every time", () => {
    // FNV-1a over UTF-8; the channel computes the same to know which file to download.
    expect(shardOf("")).toBe("05");
    expect(shardOf("claude")).toBe(shardOf("claude"));
    expect(shardOf("台積電")).toMatch(/^0[0-9a-f]$/);
    const used = new Set(Array.from({ length: 200 }, (_, i) => shardOf(`name${i}`)));
    expect(used.size).toBe(SHARDS);
  });

  it("writes a header, the source, the shard, the date and a count", () => {
    const text = formatList(
      [{ key: "alpha", name: "ALPHA", classes: "9", status: "registered", applNo: "1" }],
      "2026-11-03T00:00:00.000Z",
      "0a",
    );
    expect(text.split("\n")).toEqual([
      HEADER,
      "#source\tTaiwan Intellectual Property Office open data, under the Open Government Data License, version 1.0",
      "#shard\t0a/16",
      "#asof\t2026-11-03T00:00:00.000Z",
      "alpha\tALPHA\t9\tregistered\t1",
      "#end\t1",
      "",
    ]);
  });
});
