import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    outDir: "lib",
    dts: { sourcemap: true },
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
  },
]);
