import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/cli.ts"],
    dts: false,
    // The bundle is not minified, so stack traces read without maps, which would double the package size.
    sourcemap: false,
    // The CLI ships as one package: core is bundled in, so it is not published on its own yet.
    deps: { alwaysBundle: ["@nameable/core"] },
  },
});
