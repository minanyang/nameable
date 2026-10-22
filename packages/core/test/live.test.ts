import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, fileStore, selectChannels } from "../src/index.js";

// Hits the real services. Run with `pnpm test:live`; a service outage fails here on purpose.
const live = describe.runIf(process.env.NAMEABLE_LIVE === "1");

// Fresh every run, so nobody can have registered it.
const fresh = `zq${Date.now().toString(36)}x`;
// One store for the run, so the PyPI and Homebrew name lists are downloaded once, not per test.
const store = fileStore(mkdtempSync(join(tmpdir(), "nameable-live-")));
const opts = { githubToken: process.env.GITHUB_TOKEN, store };

const cases: [channel: string, taken: string][] = [
  ["npm", "react"],
  // Names the rules keep from new packages, held by packages published before them.
  ["npm", "events"],
  ["pypi", "asyncio"],
  ["pypi", "requests"],
  ["crates", "serde"],
  ["homebrew", "wget"],
  ["github", "torvalds"],
  ["cursor", "github"],
  ["mcp-registry", "remote-filesystem"],
  ["vscode", "esbenp"],
  ["open-vsx", "redhat"],
  ["jetbrains", "Rust"],
  ["gemini", "superpowers"],
  ["app-store", "Calculator"],
  ["google-play", "Slack"],
  ["rubygems", "rails"],
  ["packagist", "symfony"],
  ["pub", "http"],
  ["nuget", "Newtonsoft.Json"],
  ["docker", "bitnami"],
  ["smithery", "exa"],
  ["claude-plugins", "github"],
  ["domain:com", "google"],
  ["domain:dev", "google"],
  // No RDAP: these go through whois.
  ["domain:io", "google"],
  ["domain:sh", "google"],
  ["domain:co", "google"],
  ["domain:de", "google"],
  ["domain:jp", "google"],
  // Their whois says "Status: AVAILABLE" for a free name.
  ["domain:eu", "google"],
  ["domain:it", "google"],
  ["domain:be", "google"],
];

live("live channels", () => {
  for (const [channel, taken] of cases) {
    it(`${channel}: "${taken}" is taken and a fresh name is available`, async () => {
      const channels = selectChannels({ only: [channel] });
      const [held] = await check(taken, channels, opts);
      const [free] = await check(fresh, channels, opts);
      expect(held, JSON.stringify(held)).toMatchObject({ status: "taken" });
      expect(free, JSON.stringify(free)).toMatchObject({ status: "available" });
    }, 180_000);
  }

  // Names the registry answers 404 for, or that look valid, but that it would refuse.
  const refused: [channel: string, name: string, status: string, note: string][] = [
    ["pypi", "tomllib", "unavailable", "standard library"],
    ["pypi", "f1ask", "unavailable", "Flask"],
    ["crates", "std", "unavailable", "reserves"],
    // Reserved by crates.io admins after the migrations: only the database dump lists them.
    ["crates", "rust", "unavailable", "reserves"],
    ["crates", "nightly", "unavailable", "reserves"],
    ["homebrew", "golang", "taken", "alias of go"],
    ["homebrew", "pip", "unavailable", "does not allow"],
    ["rubygems", "rbconfig", "unavailable", "reserves"],
    ["rubygems", "Rails", "taken", "held as"],
    ["pub", "dart", "unavailable", "Dart and Flutter teams"],
    ["pub", "providers", "unavailable", "too similar"],
    ["nuget", "Coinbase.Core", "unavailable", "deleted by the NuGet team"],
    ["docker", "postgres", "taken", "official image"],
    // Every plain core module name is held on npm (mostly by placeholders), so the core-module rule is
    // covered by unit tests; this one is refused for a spelling that search does not return.
    ["npm", "worker_threads", "unavailable", '"worker-threads"'],
    ["npm", "test-unpublish", "reclaimable", "anyone can publish it again"],
    [
      "npm",
      "@babel/zq-not-a-real-pkg",
      "available",
      '@babel belongs to the npm user or organization "babel"',
    ],
  ];
  for (const [channel, name, status, note] of refused) {
    it(`${channel}: "${name}" is ${status} (${note})`, async () => {
      const [r] = await check(name, selectChannels({ only: [channel] }), opts);
      expect(r, JSON.stringify(r)).toMatchObject({ status, note: expect.stringContaining(note) });
      expect(r!.certainty).not.toBe("confirmed");
    }, 180_000);
  }

  for (const [name, clash] of [
    ["first-one", "firstone"],
    ["lodashes", "lodash-es"],
  ]) {
    it(`npm: "${name}" is unavailable because "${clash}" exists`, async () => {
      const [r] = await check(name!, selectChannels({ only: ["npm"] }));
      expect(r, JSON.stringify(r)).toMatchObject({
        status: "unavailable",
        note: `npm refuses it: the same as "${clash}" without punctuation`,
      });
    }, 30_000);
  }
});
