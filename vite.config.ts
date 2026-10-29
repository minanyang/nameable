import { defineConfig } from "vite-plus";

export default defineConfig({
  // Workspace packages resolve to their TypeScript sources (the "@nameable/source" export condition) in
  // tests. The name is scoped because dependencies publish a plain "source" condition too (eventsource).
  // Vitest's node environment resolves through Vite's SSR settings, so the condition goes there.
  ssr: { resolve: { conditions: ["@nameable/source"] } },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // The live tests (`pnpm test:live`) wait on real services, which at times take well over the default
    // 5 seconds to answer (the MCP Registry's updated_since query has taken 22).
    testTimeout: process.env.NAMEABLE_LIVE === "1" ? 60_000 : undefined,
    coverage: {
      include: ["packages/*/src/**"],
      // Process wiring and the raw socket are exercised by the dist and live tests instead.
      exclude: ["packages/nameable/src/cli.ts", "packages/core/src/tcp-whois.ts"],
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 90 },
    },
  },
  // The plugin's copy of the built CLI (scripts/build-plugin.sh) is generated, like dist/.
  fmt: { ignorePatterns: ["plugins/nameable/server/**"] },
  lint: {
    ignorePatterns: ["plugins/nameable/server/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
