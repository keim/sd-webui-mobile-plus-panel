// Standalone client bundler for the workbench UI.
//
// Bun.build over the HTML entry, production NODE_ENV, hashed asset
// names, tailwind plugin.

import { basename, join } from "node:path";
import tailwindPlugin from "bun-plugin-tailwind";

// MOCK_PAGES=1 builds the temporary, fully self-contained
// preview for static hosting (e.g. GitHub Pages): the transport
// module src/backend.ts is swapped for src/backend.mock.ts, so
// the UI runs against the in-browser mock (src/mockCore.ts) and
// never touches a server. Output goes to ./dist-pages; the
// standard build is completely unaffected.
const MOCK_PAGES = process.env.MOCK_PAGES === "1";
const OUTDIR = MOCK_PAGES ? "./dist-pages" : "./dist";

const mockBackendPlugin = {
  name: "mock-backend",
  setup(build) {
    build.onResolve({ filter: /^\.\/backend$/ }, (args) => {
      if (args.importer.endsWith("api.ts")) {
        return { path: join(process.cwd(), "src", "backend.mock.ts") };
      }
      return undefined;
    });
  },
};

// Start from a clean output dir: hashed outputs from earlier
// builds would otherwise accumulate and get published alongside
// the current ones.
import { rm } from "node:fs/promises";
await rm(OUTDIR, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["./index.html"],
  outdir: OUTDIR,
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  naming: {
    asset: "assets/[name]-[hash].[ext]",
    chunk: "assets/[name]-[hash].[ext]",
    entry: "[name].[ext]",
  },
  plugins: MOCK_PAGES ? [tailwindPlugin, mockBackendPlugin] : [tailwindPlugin],
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

// PWA statics (manifest, service worker, icons) live in ./pwa and are
// copied verbatim; only the service worker's cache version is stamped
// (WB_STAMP from publish.sh, else the git stamp, else "dev").
import { copyFile, readFile, writeFile } from "node:fs/promises";
let stamp = process.env.WB_STAMP;
if (!stamp) {
  try {
    const { execSync } = await import("node:child_process");
    stamp = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    if (execSync("git status --porcelain", { encoding: "utf8" }).trim()) {
      stamp += "-dirty";
    }
  } catch {
    stamp = "dev";
  }
}
for (const name of ["manifest.webmanifest", "icon-192.png", "icon-512.png"]) {
  await copyFile(`./pwa/${name}`, `${OUTDIR}/${name}`);
}
const swSource = await readFile("./pwa/sw.js", "utf8");
await writeFile(`${OUTDIR}/sw.js`, swSource.replaceAll("__WB_VERSION__", stamp));

console.log(`built ${result.outputs.length} outputs to ${OUTDIR}`);
