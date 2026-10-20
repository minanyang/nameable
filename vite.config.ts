import { defineConfig } from "vite-plus";

export default defineConfig({
  // Workspace packages resolve to their TypeScript sources (the "source" export condition) in tests.
  resolve: { conditions: ["source"] },
  test: { include: ["packages/*/test/**/*.test.ts"] },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
