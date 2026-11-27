// Plain fetch client for the workbench backend.
//
// (2026-11-27: the Space actions protocol was retired. Each
// action is a POST to `./api/<action>` with the args as the
// JSON body; the result is the JSON response body itself, and
// a failure is a non-2xx status with `{"error": "<message>"}`
// — surfaced here as a thrown Error with that message, exactly
// as the old client behaved. Types come straight from
// `./types` — no codegen, no runtime schema.)

import type { Actions } from "./types";

export type ApiRequest<A extends keyof Actions> = Actions[A]["request"];
export type ApiResponse<A extends keyof Actions> = Actions[A]["response"];

async function call(action: string, args: unknown): Promise<unknown> {
  const res = await fetch(`./api/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body: only the status matters below.
  }
  if (!res.ok) {
    const message =
      (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body;
}

type Api = {
  [K in keyof Actions]: (
    args: Actions[K]["request"],
  ) => Promise<Actions[K]["response"]>;
};

export const api: Api = new Proxy(
  {},
  {
    get: (_target, prop) => {
      if (typeof prop !== "string") return undefined;
      return (args: unknown) => call(prop, args);
    },
  },
) as Api;

// --- Direct sdapi reads (2026-11-27) ------------------------------
// The workbench page is served by the WebUI itself, so the
// read-only sdapi lists are fetched directly from the same
// origin instead of through the backend: the model list for
// the template pane's dropdown, and the sampler / scheduler
// name lists for the Parameter pane's selects. The mapping
// mirrors what the removed backend actions returned: name is
// the canonical model_name, stem the bare file stem that saved
// templates may still carry.

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
