// Standalone client bundler for the workbench UI.
//
// Mirrors the canonical Space client build (Bun.build over the HTML entry,
// production NODE_ENV, hashed asset names, tailwind plugin) so the output
// is interchangeable with the Space's client/dist. The one Space-specific
// define kept is __HATCH_SPACE_PLATFORM_VERSION__: the vendored SDK client
// reads it (typeof-guarded) to enable its readable-failure messages, and
// the Space this UI was migrated from ran platformVersion 29.

import { basename } from "node:path";
import tailwindPlugin from "bun-plugin-tailwind";

const result = await Bun.build({
  entrypoints: ["./index.html"],
  outdir: "./dist",
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    __HATCH_SPACE_PLATFORM_VERSION__: JSON.stringify(29),
  },
  naming: {
    asset: "assets/[name]-[hash].[ext]",
    chunk: "assets/[name]-[hash].[ext]",
    entry: "[name].[ext]",
  },
  plugins: [tailwindPlugin],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("build failed; see logged diagnostics");
}

// Bun writes imported assets to assets/<name>-<hash>.<ext> but emits the
// JS/CSS import URL as a bare ./<name>-<hash>.<ext>. Re-prefix the bare
// imported-asset URLs to ./assets/... (same fix-up as the canonical
// build; idempotent, chunk refs already carry the prefix).
const assetFiles = result.outputs
  .filter((output) => output.kind === "asset")
  .map((output) => basename(output.path));

for (const output of result.outputs) {
  if (!/\.(js|css|html)$/.test(output.path)) continue;
  let text = await output.text();
  let changed = false;
  for (const name of assetFiles) {
    const bare = `./${name}`;
    if (text.includes(bare)) {
      text = text.split(bare).join(`./assets/${name}`);
      changed = true;
    }
  }
  if (changed) await Bun.write(output.path, text);
}

console.log(`built ${result.outputs.length} outputs to ./dist`);
