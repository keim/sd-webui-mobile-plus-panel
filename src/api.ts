// Typed RPC client. Types come straight from `./contract` — no
// codegen. `createActionClient` returns a proxy that POSTs `{action, args}`
// to `./actions` and returns the typed response.
//
// `import type { Actions }` is type-only by design: the client bundle never
// pulls in any server runtime (bun:sqlite, file APIs, etc.). With
// `verbatimModuleSyntax: true`, dropping `type` is a compile error.

import type { Actions } from "./contract";
import { createActionClient } from "@hatch/space-sdk/client";

export const api = createActionClient<typeof Actions>();

// Re-exported for convenience so client code can do
//
//     import { api, type ApiResponse } from "./api";
//     type Article = ApiResponse<typeof api, "listArticles">["articles"][number];
//
// They are also available directly from "@hatch/space-sdk/client".
export type { ApiRequest, ApiResponse } from "@hatch/space-sdk/client";

// --- Direct sdapi reads (2026-11-27) ------------------------------
// The workbench page is served by the WebUI itself, so the
// read-only sdapi lists are fetched directly from the same
// origin instead of through the actions protocol: the model
// list for the template pane's dropdown, and the sampler /
// scheduler name lists for the Parameter pane's selects. The
// mapping mirrors what the removed backend actions returned:
// name is the canonical model_name, stem the bare file stem
// that saved templates may still carry.

export interface SdModelEntry {
  name: string;
  stem: string;
}

export async function fetchSdModels(): Promise<SdModelEntry[]> {
  const res = await fetch("/sdapi/v1/sd-models");
  if (!res.ok) throw new Error(`sd-models: HTTP ${res.status}`);
  const entries = (await res.json()) as {
    model_name?: string;
    filename?: string;
  }[];
  const models: SdModelEntry[] = [];
  for (const entry of entries) {
    const name = entry.model_name || "";
    if (!name) continue;
    let stem = "";
    const filename = entry.filename || "";
    if (filename) {
      const base = filename.replace(/\\/g, "/").split("/").pop() ?? "";
      stem = base.includes(".")
        ? base.slice(0, base.lastIndexOf("."))
        : base;
    }
    models.push({ name, stem: stem || name });
  }
  return models;
}

async function fetchSdNames(path: string): Promise<string[]> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const entries = (await res.json()) as { name?: string }[];
  return entries
    .map((e) => e.name)
    .filter((n): n is string => !!n);
}

export async function fetchSdSamplerLists(): Promise<{
  samplers: string[];
  schedulers: string[];
}> {
  const [samplers, schedulers] = await Promise.all([
    fetchSdNames("/sdapi/v1/samplers"),
    fetchSdNames("/sdapi/v1/schedulers"),
  ]);
  return { samplers, schedulers };
}
