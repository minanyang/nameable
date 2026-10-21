import { defineConfig } from "vite-plus";

export default defineConfig({
  // Workspace packages resolve to their TypeScript sources (the "@nameable/source" export condition) in
  // tests. The name is scoped because dependencies publish a plain "source" condition too (eventsource).
  // Vitest's node environment resolves through Vite's SSR settings, so the condition goes there.
  ssr: { resolve: { conditions: ["@nameable/source"] } },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    coverage: {
      include: ["packages/*/src/**"],
      // Process wiring and the raw socket are exercised by the dist and live tests instead.
      exclude: ["packages/nameable/src/cli.ts", "packages/core/src/tcp-whois.ts"],
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 90 },
    },
  },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
