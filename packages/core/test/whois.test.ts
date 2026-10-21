import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { readWhois } from "../src/index.js";

// Real answers recorded from each registry on 2026-10-21: `free.<tld>.txt` for an unregistered name,
// `taken.<tld>.txt` for google.<tld>. Reading recorded answers keeps the patterns honest; a hand-written
// sample only proves the pattern matches what its author imagined.
const dir = new URL("./whois-answers/", import.meta.url);
const answers = readdirSync(dir).map((file) => {
  const [kind, tld] = file.split(".") as ["free" | "taken", string];
  return { file, kind, tld, text: readFileSync(new URL(file, dir), "utf8") };
});

// whois.nic.ch refuses automated queries ("Requests of this client are not permitted").
const REFUSES_QUERIES = new Set(["ch"]);

describe("readWhois on recorded answers", () => {
  it("has a free and a taken answer for every recorded registry", () => {
    const tlds = (kind: string) =>
      answers
        .filter((a) => a.kind === kind)
        .map((a) => a.tld)
        .sort();
    expect(tlds("free")).toEqual(tlds("taken"));
    expect(tlds("free").length).toBeGreaterThanOrEqual(10);
  });

  for (const { file, kind, tld, text } of answers) {
    const expected = REFUSES_QUERIES.has(tld)
      ? "unrecognized"
      : kind === "free"
        ? "free"
        : "registered";
    it(`${file} reads as ${expected}`, () => {
      expect(readWhois(text)).toBe(expected);
    });
  }

  it("never reads a registered domain as free, whatever else the answer says", () => {
    for (const { text } of answers.filter((a) => a.kind === "taken")) {
      expect(readWhois(text), text.slice(0, 200)).not.toBe("free");
    }
  });
});
