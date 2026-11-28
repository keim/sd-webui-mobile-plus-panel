// Mock transport for the temporary Pages preview build.
// build.mjs (MOCK_PAGES=1) bundles THIS module in place of
// backend.ts: every action runs against the in-browser mock
// (mockCore.ts, a port of mock/server.mjs) and the sdapi list
// reads return the mock's fixtures in sdapi's native shapes,
// so api.ts's mapping code runs unchanged. IS_MOCK_BUILD is
// what puts the "mock environment" label on screen.

import { callMockAction, SD_MODELS, SD_SAMPLERS, SD_SCHEDULERS } from "./mockCore";

export const IS_MOCK_BUILD = true;

export const MOCK_BADGE_LABEL: string | null =
  "モック環境（UI確認用・実生成しません）";

export async function callAction(
  action: string,
  args: unknown,
): Promise<unknown> {
  return callMockAction(action, args);
}

export async function fetchJson(path: string): Promise<unknown> {
  if (path === "/sdapi/v1/sd-models") return SD_MODELS;
  if (path === "/sdapi/v1/samplers") {
    return SD_SAMPLERS.map((name) => ({ name, aliases: [], options: {} }));
  }
  if (path === "/sdapi/v1/schedulers") {
    return SD_SCHEDULERS.map((name) => ({ name, label: name, aliases: [] }));
  }
  throw new Error(`${path}: not available in the mock build`);
}
