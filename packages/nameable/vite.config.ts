import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: { entry: ["src/cli.ts"], dts: false, sourcemap: true },
});
