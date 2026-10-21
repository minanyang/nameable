import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/cli.ts"],
    dts: false,
    sourcemap: true,
    // The CLI ships as one package: core is bundled in, so it is not published on its own yet.
    deps: { alwaysBundle: ["@nameable/core"] },
  },
});
