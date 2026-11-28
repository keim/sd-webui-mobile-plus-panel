import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./theme.css";

const rootEl = document.querySelector<HTMLElement>("[data-generated-space-root]");
if (!rootEl) {
  throw new Error("missing generated space root element");
}

// Failure notice for mutations that have no error handler of
// their own (a behavior kept from the retired Space SDK's
// shared client): a short-lived alert at the bottom of the
// page, so a handler-less save never fails silently.
let failureNoticeTimer: ReturnType<typeof setTimeout> | undefined;
function showFailureNotice(error: unknown) {
  if (typeof document === "undefined" || document.body === null) return;
  const message =
    error instanceof Error && error.message
      ? error.message
      : "保存に失敗しました。もう一度お試しください。";
  let notice = document.getElementById("workbench-failure-notice");
  if (notice === null) {
    notice = document.createElement("div");
    notice.id = "workbench-failure-notice";
    notice.setAttribute("role", "alert");
    Object.assign(notice.style, {
      position: "fixed",
      left: "16px",
      right: "16px",
      bottom:
        "calc(16px + env(safe-area-inset-bottom, 0px))",
      width: "fit-content",
      maxWidth: "480px",
      marginInline: "auto",
      pointerEvents: "none",
      padding: "12px 16px",
      borderRadius: "12px",
      background: "rgba(20, 20, 20, 0.92)",
      color: "#fff",
      fontSize: "14px",
      zIndex: "9999",
    });
    document.body.appendChild(notice);
  }
  notice.textContent = message;
  if (failureNoticeTimer !== undefined) {
    clearTimeout(failureNoticeTimer);
  }
  failureNoticeTimer = setTimeout(() => notice.remove(), 6_000);
}

// The app's QueryClient (2026-11-27: formerly the Space SDK's
// shared spaceQueryClient). Defaults mirror the behavior the
// workbench has run with: 30s staleTime, no refetch on focus,
// and no query retries — the plain fetch client throws plain
// Errors, which the old SDK retry predicate never retried
// either (it only retried its own retry-safe action errors).
const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (
        mutation.options.onError === undefined &&
        mutation.options.onSettled === undefined
      ) {
        showFailureNotice(error);
      }
    },
  }),
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <div className="hatch-space-root" data-hatch-space-root>
        <App />
      </div>
    </QueryClientProvider>
  </StrictMode>,
);

// PWA: the workbench is installable from its /mobileplus/ scope. The
// service worker caches only the app shell (see pwa/sw.js); failures
// are non-fatal — the workbench keeps working as a plain web page.
// The manifest and touch-icon links are injected here rather than in
// index.html: the bundler would try to resolve them as bundle assets.
{
  const manifestLink = document.createElement("link");
  manifestLink.rel = "manifest";
  manifestLink.href = "./manifest.webmanifest";
  document.head.appendChild(manifestLink);
  const touchIcon = document.createElement("link");
  touchIcon.rel = "apple-touch-icon";
  touchIcon.href = "./icon-192.png";
  document.head.appendChild(touchIcon);
}
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
