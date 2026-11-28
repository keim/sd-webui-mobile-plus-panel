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
import { callAction, fetchJson } from "./backend";

export { IS_MOCK_BUILD, MOCK_BADGE_LABEL } from "./backend";

export type ApiRequest<A extends keyof Actions> = Actions[A]["request"];
export type ApiResponse<A extends keyof Actions> = Actions[A]["response"];

async function call(action: string, args: unknown): Promise<unknown> {
  return callAction(action, args);
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
  const entries = (await fetchJson("/sdapi/v1/sd-models")) as {
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
  const entries = (await fetchJson(path)) as { name?: string }[];
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

// --- Base64 helpers (formerly the Space SDK's) -------------------
// The obvious one-liner — btoa(String.fromCharCode(...bytes)) —
// passes every byte as a separate argument and throws RangeError
// on multi-megabyte payloads, the size class of every phone
// photo. Encode in bounded 32 KB chunks instead (the native
// Uint8Array.prototype.toBase64 is used when present).

export function bytesToBase64(bytes: Uint8Array): string {
  const native = bytes as Uint8Array & {
    toBase64?: () => string;
  };
  if (typeof native.toBase64 === "function") {
    return native.toBase64();
  }
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(
      null,
      chunk as unknown as number[],
    );
  }
  return btoa(binary);
}

export async function fileToBase64(
  file: File | Blob,
): Promise<{ dataBase64: string; mimeType: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    dataBase64: bytesToBase64(bytes),
    mimeType: file.type || "application/octet-stream",
  };
}
