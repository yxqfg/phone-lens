import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    outDir: "lib",
    dts: { sourcemap: true },
    // intent: js sourcemaps OFF — the 335KB index.js.map was over half the
    // published tarball and nothing consumes it at runtime. tsdown 0.9.9
    // ignores `sourcemap: false` (still emits the map), so the REAL exclusion
    // lives in package.json's files array ("!lib/*.map"): maps stay available
    // locally for debugging but never ship.
    sourcemap: false,
    format: "esm",
    platform: "node",
    target: "node22",
    // lib/client.js is a hand-written browser artifact (module-loader factory
    // format); tsdown's clean step must not delete it.
    clean: false,
    external: [/^@deepseek-ai\//],
    outExtensions: () => ({ js: ".js" }),
  },
  {
    entry: ["src/dev.ts"],
    outDir: "lib",
    format: "esm",
    platform: "node",
    target: "node22",
    clean: false,
    external: [/^@deepseek-ai\//, /^node:/],
    outExtensions: () => ({ js: ".js" }),
    dts: false,
    sourcemap: false,
  },
]);
