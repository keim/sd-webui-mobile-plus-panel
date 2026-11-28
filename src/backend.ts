// Transport seam between the workbench UI and its backend.
//
// The standard build talks to the Forge extension backend over
// fetch: actions are POSTs to `./api/<action>` and the sdapi
// lists are GETs on the same origin. The temporary Pages
// preview build (build.mjs with MOCK_PAGES=1) swaps THIS module
// for backend.mock.ts at bundle time, so the whole UI runs
// against an in-browser mock and needs no server at all. Only
// api.ts imports this module; IS_MOCK_BUILD lets the UI label
// the mock build on screen so it is never mistaken for the
// real environment.

export const IS_MOCK_BUILD = false;

// On-screen label identifying the mock build (null in the real
// build, so neither the label nor its text ships in the
// standard bundle).
export const MOCK_BADGE_LABEL: string | null = null;

export async function callAction(
  action: string,
  args: unknown,
): Promise<unknown> {
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

export async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}
