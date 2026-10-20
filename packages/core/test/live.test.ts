import { describe, expect, it } from "vite-plus/test";
import { check, selectChannels } from "../src/index.js";

// Hits the real services. Run with `pnpm test:live`; a service outage fails here on purpose.
const live = describe.runIf(process.env.NAMEABLE_LIVE === "1");

// Fresh every run, so nobody can have registered it.
const fresh = `zq${Date.now().toString(36)}x`;

const cases: [channel: string, taken: string][] = [
  ["npm", "react"],
  ["pypi", "requests"],
  ["crates", "serde"],
  ["homebrew", "wget"],
  ["github", "torvalds"],
  ["domain:com", "google"],
  ["domain:dev", "google"],
];

live("live channels", () => {
  for (const [channel, taken] of cases) {
    it(`${channel}: "${taken}" is taken and a fresh name is available`, async () => {
      const channels = selectChannels({ only: [channel] });
      const [held] = await check(taken, channels, { githubToken: process.env.GITHUB_TOKEN });
      const [free] = await check(fresh, channels, { githubToken: process.env.GITHUB_TOKEN });
      expect(held, JSON.stringify(held)).toMatchObject({ status: "taken" });
      expect(free, JSON.stringify(free)).toMatchObject({ status: "available" });
    }, 30_000);
  }

  for (const [name, clash] of [
    ["first-one", "firstone"],
    ["lodashes", "lodash-es"],
  ]) {
    it(`npm: "${name}" is unavailable because "${clash}" exists`, async () => {
      const [r] = await check(name!, selectChannels({ only: ["npm"] }));
      expect(r, JSON.stringify(r)).toMatchObject({
        status: "unavailable",
        note: `npm rejects names too similar to "${clash}"`,
      });
    }, 30_000);
  }
});
