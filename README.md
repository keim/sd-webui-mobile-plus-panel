# sd-webui-mobile-plus-workbench

The illu SD Workbench UI (React + TypeScript) as a standalone project.
It is served by the sd-webui-mobile-plus Forge extension under
`/mobileplus/`; this repository holds the UI **sources**, the extension
repository holds only the built output (`workbench/` folder there).

Migrated out of the Muse Space `illu-sd-wakusupesu-v2` on 2026-11-22 so
the UI can be developed and verified directly against illu, without the
Space build pipeline in between.

## Layout

- `src/App.tsx` — the whole UI (Editor / Parameter / History / Inpaint),
  carried over from the Space client unchanged except for the two imports
  noted below.
- `src/api.ts` — typed RPC client; POSTs `{action, args}` to `./actions`
  (i.e. `/mobileplus/actions` when served by the extension). The backend
  behind that endpoint is implemented in the extension (FastAPI); until
  it exists, calls fail and the UI renders with its defaults.
- `src/contract.ts` — the action contract: the Space server's zod
  request/response schemas for every client-facing action, transcribed
  verbatim. This is the reference for implementing `/mobileplus/actions`.
- `src/fields.ts` — per-action form field attributes (min/max/maxLength/
  step/required) inlined from the contract schemas. In the Space this was
  a bundle-time macro over the server sources; here it is a checked-in
  snapshot — regenerate it if contract limits change.
- `src/main.tsx`, `src/theme.css`, `src/globals.d.ts` — entry and styles,
  unchanged from the Space client.
- `vendor/space-sdk/` — the client subset of `@hatch/space-sdk` 0.15.1
  (RPC client, query client, base64 helpers, base styles), vendored so
  the project builds without the Space runtime. Wired up as a `file:`
  dependency in package.json.
- `build.mjs` — Bun.build over `index.html` (production, minified,
  hashed asset names, Tailwind plugin), mirroring the canonical Space
  client build so output stays interchangeable with it.
- `scripts/publish.sh` — build + copy `dist/` into the extension repo's
  `workbench/` folder, stamping `workbench/VERSION` with this repo's
  commit hash and build time.

## Develop

```sh
bun install
bun run build        # -> dist/
bun run typecheck    # tsc --noEmit (clean as of the migration)
```

## Publish to the extension

```sh
bun run publish:extension            # ../sd-webui-mobile-plus by default
bun run publish:extension /path/to/sd-webui-mobile-plus
```

Then deploy the extension to illu as usual (copy or pull + WebUI
restart; static file swaps under the existing `/mobileplus` mount are
picked up without a restart).
