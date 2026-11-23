import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { bytesToBase64, fileToBase64 } from "@hatch/space-sdk/client";
import { api, type ApiRequest, type ApiResponse } from "./api";

import { FIELDS } from "./fields";

type Job = ApiResponse<typeof api, "listJobs">["jobs"][number];
type UploadImage = ApiResponse<typeof api, "listUploadImages">["uploads"][number];
type EditorSource = ApiResponse<typeof api, "getEditorSource">["source"];
type GenerationArgs = ApiRequest<typeof api, "createJob">;
type ModelKey = "wai" | "pornmaster" | "zimage";
type SeedMode = "random" | "fixed" | "reuse";
// Pane keys. There is no tab bar and no flick navigation: the
// Editor pane is the hub, and panes are reached only through
// in-pane controls (image tap → Inpaint, the parameter panel's
// 「その他」 column → Parameter, the history panel's History
// button → History, and the round 「<」 back buttons on the
// other panes → Editor).
// img2img resize modes (sdapi resize_mode values) as offered by
// the Editor operation panel's selector: Cover = just resize
// (stretch to cover the target size), Crop = crop and resize,
// Contain = resize and fill (whole image fits, bands filled),
// Latent = just resize in latent space.
const RESIZE_MODES = [
  { value: 0, label: "Cover" },
  { value: 1, label: "Crop" },
  { value: 2, label: "Contain" },
  { value: 3, label: "Latent" },
] as const;

type PaneKey = "editor" | "preview" | "inpaint" | "parameters" | "history";

// --- Polling self-recovery (2026-11-21) ------------------------------
// Every polling request (the jobs list fetch and each
// pollGenerationJob call) carries a hard timeout: a request that
// does not settle within POLL_REQUEST_TIMEOUT_MS is abandoned —
// the race rejects and the loop moves on to its next tick — so one
// wedged request can no longer stall polling for good. That is
// the failure mode behind the 2026-11-21 incident: the poll loop
// died seconds before a run finished on the host and the UI sat
// on 「生成中」 indefinitely. On top of the per-request timeout,
// the last successful poll time is tracked across both loops: a
// watchdog rebuilds the loops when active jobs exist but no poll
// has succeeded for POLL_STALE_MS, and returning to the
// foreground (visibilitychange) polls immediately.
const POLL_REQUEST_TIMEOUT_MS = 15000;
const POLL_STALE_MS = 20000;

function withPollTimeout<T>(request: Promise<T>): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(
      () => reject(new Error("poll-timeout")),
      POLL_REQUEST_TIMEOUT_MS,
    );
  });
  return Promise.race([request, timeout]).finally(() => {
    window.clearTimeout(timer);
  });
}

// --- Downloads (2026-11-21) ------------------------------------------
// Every download in this app (Editor image, History job PNG, saved
// image, upload) goes through DownloadButton, NOT a plain
// <a href download> anchor. A bare anchor hands the tap to the
// WebView's own download handling, and on the phone that could
// leave the page's client wedged afterwards — taps on delete and
// the other controls stopped responding until a reload (the
// 2026-11-21 report; same family as the polling stall above).
// Instead the click handler fetches the file behind the scenes,
// wraps it in an object URL, and fires a temporary anchor for
// THAT url: the page itself never navigates and never hands the
// gesture to the WebView's download path. The fetch carries a
// hard timeout so the button's busy state always clears, and
// onSettled lets the app reconcile its lists the moment a
// download finishes (plus the foreground-return reconcile in App)
// so even a wedged attempt cannot leave stale pending state
// behind. If the fetch itself fails, fall back to opening the
// original URL in a new tab — the file still reaches the user.
const DOWNLOAD_TIMEOUT_MS = 30000;

async function fetchBlobDownload(url: string, fileName: string): Promise<void> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = fileName;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on a delay: revoking synchronously can cancel the
    // download before the browser has picked the blob up.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  } catch {
    window.open(url, "_blank", "noopener");
  } finally {
    window.clearTimeout(timer);
  }
}

function DownloadButton(props: {
  url: string;
  fileName: string;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  stopPropagation?: boolean;
  onSettled?: () => void;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      aria-label={props.ariaLabel}
      aria-busy={busy}
      className={props.className}
      style={props.style}
      onClick={(e) => {
        if (props.stopPropagation) e.stopPropagation();
        if (busy) return;
        setBusy(true);
        void fetchBlobDownload(props.url, props.fileName).finally(() => {
          setBusy(false);
          props.onSettled?.();
        });
      }}
    >
      {props.children}
    </button>
  );
}

const MODELS: {
  key: ModelKey;
  label: string;
  shortLabel: string;
  checkpoint: string;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
}[] = [
  {
    key: "wai",
    label: "wai",
    shortLabel: "wai",
    checkpoint: "waiNSFWIllustrious_v140",
    steps: 20,
    cfg: 5.5,
    sampler: "DPM++ 2M",
    scheduler: "Karras",
  },
  {
    key: "pornmaster",
    label: "pornmaster",
    shortLabel: "pm",
    checkpoint: "pornmasterPro_realismILV4",
    steps: 20,
    cfg: 5.5,
    sampler: "DPM++ 2M",
    scheduler: "Karras",
  },
  {
    key: "zimage",
    label: "z-image",
    shortLabel: "zimg",
    checkpoint: "z-image-turbo-quant-bundle",
    steps: 10,
    cfg: 1,
    sampler: "Euler",
    scheduler: "Beta",
  },
];

function modelShortLabel(key: string | null): string {
  return MODELS.find((m) => m.key === key)?.shortLabel ?? key ?? "";
}

// --- Per-model positive prompt templates (2026-11-23) ---
// Each model holds a template; the final positive prompt is the
// template with its %...% tokens replaced:
//   %prompt%                  -> the prompt area's text, as-is
//   %label:min:max:step:def%  -> a numeric parameter; one slider
//                                per parameter appears in the
//                                style （調整） popup, and the
//                                token is replaced by its value
// Any other %...% token is left in the text untouched.
type TemplateParam = {
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
};

const TEMPLATE_PARAM_RE =
  /^([^:]+):(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/;

function parseTemplateParamToken(token: string): TemplateParam | null {
  const m = TEMPLATE_PARAM_RE.exec(token);
  if (!m) return null;
  const label = m[1]!.trim();
  const min = Number(m[2]);
  const max = Number(m[3]);
  const step = Number(m[4]);
  const def = Number(m[5]);
  if (!label || !(min < max) || !(step > 0)) return null;
  return { label, min, max, step, def: Math.min(max, Math.max(min, def)) };
}

// The template's numeric parameters, in order of first
// appearance, deduplicated by label.
function parseTemplateParams(template: string): TemplateParam[] {
  const out: TemplateParam[] = [];
  const seen = new Set<string>();
  for (const match of template.matchAll(/%([^%]+)%/g)) {
    const p = parseTemplateParamToken(match[1]!);
    if (p && !seen.has(p.label)) {
      seen.add(p.label);
      out.push(p);
    }
  }
  return out;
}

// The default value of every numeric parameter in a template
// (its def, from the token syntax).
function templateParamDefaults(
  template: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of parseTemplateParams(template)) out[p.label] = p.def;
  return out;
}

// Value formatting for substitution and slider displays: rounded
// to the step's decimal places, shortest form (1.20 -> "1.2",
// 1 -> "1").
function formatTemplateValue(v: number, step: number): string {
  const stepText = String(step);
  const decimals = stepText.includes(".")
    ? stepText.split(".")[1]!.length
    : 0;
  return String(parseFloat(v.toFixed(Math.min(decimals, 10))));
}

function applyPromptTemplate(
  template: string,
  content: string,
  values: Record<string, number>,
): string {
  return template.replace(/%([^%]+)%/g, (whole, token: string) => {
    if (token === "prompt") return content;
    const p = parseTemplateParamToken(token);
    if (!p) return whole;
    const v = values[p.label] ?? p.def;
    const clamped = Math.min(p.max, Math.max(p.min, v));
    return formatTemplateValue(clamped, p.step);
  });
}

// The models' built-in templates. wai's reproduces the former
// fixed style base (photorealistic + comiclo LoRA ahead of the
// prompt); the other models send the prompt as-is.
const DEFAULT_TEMPLATES: Record<ModelKey, string> = {
  wai: "(photorealistic: %写実的:0:2:0.1:1.2%), <lora:comiclo-xl-pony:%コミック調:0:1:0.05:0.7%>, %prompt%",
  pornmaster: "%prompt%",
  zimage: "%prompt%",
};

// Fetch an image URL (the workbench's own /files/ route) and
// return its raw base64 — the client now carries the img2img init
// image inside the payload it composes.
async function fetchImageAsBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
  const blob = await res.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("image read failed"));
    reader.readAsDataURL(blob);
  });
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : "";
}

// A labelled segmented choice in the Parameter pane's style (the
// seed-mode selector's shape): one row of options, the active one
// filled with the accent color.
function SegmentedSetting(props: {
  label: string;
  options: { key: string; label: string }[];
  value: string;
  onPick: (key: string) => void;
}) {
  return (
    <div>
      <span className="block text-xs text-[var(--dim)] mb-1">{props.label}</span>
      <div
        className="flex border border-[var(--border)]"
        role="group"
        aria-label={props.label}
      >
        {props.options.map((o, i) => (
          <button
            key={o.key}
            type="button"
            aria-pressed={props.value === o.key}
            onClick={() => props.onPick(o.key)}
            className={`flex-1 px-2 py-2 text-sm ${
              props.value === o.key ? "" : "bg-[var(--surface)]"
            }`}
            style={{
              borderLeft: i > 0 ? "1px solid var(--border)" : undefined,
              ...(props.value === o.key
                ? { backgroundColor: "var(--accent)", color: "var(--accent-text)" }
                : {}),
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// Base display for history: each tag appears only when its weight
// is non-zero (baseEnabled abolished in the 2026-11-19 overhaul).
// Legacy jobs recorded with baseEnabled false and non-zero weights
// still read as "付けない" out of respect for what was sent.
function baseStringOf(job: Job): string | null {
  if (job.baseEnabled === false && job.negativePrompt == null) return null;
  const parts: string[] = [];
  const pw = job.photorealisticWeight;
  const cw = job.comicloWeight;
  if (pw != null && pw !== 0) parts.push(`(photorealistic: ${pw})`);
  if (cw != null && cw !== 0) parts.push(`<lora:comiclo-xl-pony:${cw}>`);
  return parts.length > 0 ? parts.join(", ") : null;
}

const SIZE_PRESETS: { key: string; label: string; w: number; h: number }[] = [
  { key: "9:21", label: "9:21", w: 832, h: 1984 },
  { key: "9:16", label: "9:16", w: 960, h: 1728 },
  { key: "2:3", label: "2:3", w: 1024, h: 1536 },
  { key: "3:4", label: "3:4", w: 1088, h: 1472 },
  { key: "4:5", label: "4:5", w: 1152, h: 1408 },
  { key: "1:1", label: "1:1", w: 1280, h: 1280 },
  { key: "5:4", label: "5:4", w: 1408, h: 1152 },
  { key: "4:3", label: "4:3", w: 1472, h: 1088 },
  { key: "3:2", label: "3:2", w: 1536, h: 1024 },
  { key: "16:9", label: "16:9", w: 1728, h: 960 },
  { key: "21:9", label: "21:9", w: 1984, h: 832 },
];

// Button layout for the size selector, ported from SD WebUI Mobile
// Plus (scripts/panel.html #sspp-size-selector, style.css
// .sspp-size-aspect-grid): a 6-column grid whose top row holds the
// landscape ratios and whose left column holds the portrait ratios;
// the remaining wide area (columns 2–6, rows 2–6) is the ratio
// preview canvas. The grid has 6 rows — there is no FREE/custom
// button or placeholder cell: hand-editing the width/height inputs
// simply clears both the aspect-ratio and the pixel-count
// selections. The `sub` values are the original's second label
// lines.
const SIZE_LANDSCAPE_ROW: { key: string; sub?: string }[] = [
  { key: "1:1" },
  { key: "5:4" },
  { key: "4:3", sub: "Standard" },
  { key: "3:2", sub: "Film" },
  { key: "16:9", sub: "Full HD" },
  { key: "21:9", sub: "Cinema" },
];
const SIZE_PORTRAIT_COL: { key: string; sub?: string }[] = [
  { key: "4:5", sub: "Instagram" },
  { key: "3:4" },
  { key: "2:3" },
  { key: "9:16" },
  { key: "9:21", sub: "SmartPhone" },
];

// Pixel-count options for the size selector (the squareWidth of the
// original SizeSelector calculation). Defaults: 1280p, block size 64 —
// at those values the calculation reproduces the SIZE_PRESETS dimensions.
const PIXEL_SIZES: number[] = [1024, 1280, 1440];
const DEFAULT_PIXEL_SIZE = 1280;
const DEFAULT_BLOCK_SIZE = "64";

// Port of SizeSelector._calculateAspectSize (SD WebUI Mobile Plus
// size_selector.js): given the pixel count (squareWidth), the block
// size, and the aspect ratio key ("W:H"), compute the dimensions.
// Returns null when the block size is empty, non-numeric, or <= 0 —
// the original's guard in _applyAspectSelection, in which case the
// caller must not recalculate.
function calculateAspectSize(
  sizeKey: string,
  pixelSize: number,
  blockSizeText: string,
): { w: number; h: number } | null {
  const blockSize = Number.parseInt(blockSizeText, 10);
  if (!Number.isFinite(blockSize) || blockSize <= 0) return null;
  if (!Number.isFinite(pixelSize) || pixelSize <= 0) return null;
  const parts = sizeKey.split(":");
  const widthRatio = Number(parts[0]);
  const heightRatio = Number(parts[1]);
  if (!Number.isFinite(widthRatio) || !Number.isFinite(heightRatio) || heightRatio === 0) {
    return null;
  }
  const area = pixelSize * pixelSize;
  const aspectRatio = widthRatio / heightRatio;
  const w = Math.max(blockSize, Math.round(Math.sqrt(area * aspectRatio) / blockSize) * blockSize);
  const h = Math.max(blockSize, Math.round(Math.sqrt(area / aspectRatio) / blockSize) * blockSize);
  return { w, h };
}

// Port of SizeSelector._renderAspectPreview (SD WebUI Mobile Plus
// size_selector.js), recoloured to this workspace's theme (base
// #F9F8FF, main #26183A, secondary #F96A6A): fills the background,
// draws the quarter guide lines, centres a rectangle of the given
// ratio, and writes the ratio label and the computed dimensions
// inside it. The caller passes ratioW/ratioH as NaN when there is
// nothing valid to preview (no selection, unparseable dimensions),
// in which case only the background and guides are drawn.
function drawAspectPreview(
  canvas: HTMLCanvasElement,
  ratioW: number,
  ratioH: number,
  ratioLabel: string,
  dimW: number | null,
  dimH: number | null,
): void {
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW <= 0 || cssH <= 0) return;
  const scale = 2;
  canvas.width = Math.round(cssW * scale);
  canvas.height = Math.round(cssH * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(scale, scale);
  const W = cssW;
  const H = cssH;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#f9f8ff";
  ctx.fillRect(0, 0, W, H);
  const padding = Math.min(W, H) * 0.0625;
  const availW = W - padding * 2;
  const availH = H - padding * 2;
  ctx.strokeStyle = "#dcd6ec";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const gx = padding + (availW / 4) * i;
    const gy = padding + (availH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(gx, padding);
    ctx.lineTo(gx, H - padding);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(padding, gy);
    ctx.lineTo(W - padding, gy);
    ctx.stroke();
  }
  if (!Number.isFinite(ratioW) || !Number.isFinite(ratioH) || ratioW <= 0 || ratioH <= 0) {
    return;
  }
  const ratio = ratioW / ratioH;
  let rectW = availW;
  let rectH = rectW / ratio;
  if (rectH > availH) {
    rectH = availH;
    rectW = rectH * ratio;
  }
  const x = (W - rectW) / 2;
  const y = (H - rectH) / 2;
  ctx.fillStyle = "#fde3e3";
  ctx.fillRect(x, y, rectW, rectH);
  ctx.strokeStyle = "#f96a6a";
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, rectW, rectH);
  const unit = Math.min(W, H) / 512;
  ctx.fillStyle = "#26183a";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${Math.max(12, 28 * unit)}px sans-serif`;
  ctx.fillText(ratioLabel, W / 2, H / 2 - 18 * unit);
  if (dimW != null && dimH != null) {
    ctx.font = `${Math.max(11, 24 * unit)}px sans-serif`;
    ctx.fillText(`${dimW} x ${dimH}`, W / 2, H / 2 + 22 * unit);
  }
}

const SAMPLERS = [
  "DPM++ 2M",
  "DPM++ 2M SDE",
  "DPM++ SDE",
  "DPM2",
  "DPM++ 2S a",
  "Euler",
  "Euler a",
  "DDIM",
  "LMS",
  "Heun",
  "UniPC",
  "Restart",
];

const SCHEDULERS = [
  "Karras",
  "Exponential",
  "Normal",
  "Simple",
  "Beta",
  "DDIM Uniform",
  "SGM Uniform",
  "Align Your Steps",
];

const MONO = "font-mono tabular-nums";

function isActive(job: Job): boolean {
  return job.status === "queued" || job.status === "running";
}

const PHASE_LABELS: Record<string, string> = {
  agent_starting: "エージェント起動中",
  connecting: "接続中",
  preparing: "準備中",
  generating: "画像生成中",
  saving: "保存中",
};

function phaseLabel(job: Job): string | null {
  if (job.phase == null) return null;
  return PHASE_LABELS[job.phase] ?? null;
}

function phaseSince(job: Job): string {
  return job.phaseUpdatedAt ?? job.createdAt;
}

function statusLabel(job: Job): string {
  switch (job.status) {
    case "queued":
      return "キュー待ち";
    case "running":
      return "生成中";
    case "completed":
      return "完了";
    case "failed": {
      const p = phaseLabel(job);
      return p ? `失敗（${p}）` : "失敗";
    }
  }
}

// Short phase names for the generate button's status label (the
// history rows keep the long PHASE_LABELS wording).
const PHASE_SHORT: Record<string, string> = {
  agent_starting: "起動",
  connecting: "接続",
  preparing: "準備",
  generating: "生成",
  saving: "保存",
};

function fmtElapsed(fromIso: string, now: number): string {
  const sec = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Display JPEG for an upload-library record (max 1280px on the
// long edge, the same scale as a generation job's display JPEG),
// generated client-side at upload time and stored beside the
// original in blob storage so the upload lists and the Editor's
// side preview column can thumbnail from a small file. Returns
// the JPEG bytes as base64, or null when the image cannot be
// decoded / encoded here — the upload then simply stores no
// display version and thumbnails from the original.
async function fileToDisplayJpegBase64(file: File): Promise<string | null> {
  try {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolveImg, rejectImg) => {
        const el = new Image();
        el.onload = () => resolveImg(el);
        el.onerror = () => rejectImg(new Error("image decode failed"));
        el.src = url;
      });
      const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
      if (longEdge === 0) return null;
      const scale = Math.min(1, 1280 / longEdge);
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const cx = canvas.getContext("2d");
      if (!cx) return null;
      cx.drawImage(img, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((resolveBlob) =>
        canvas.toBlob(resolveBlob, "image/jpeg", 0.85),
      );
      if (!blob) return null;
      const buf = await blob.arrayBuffer();
      return bytesToBase64(new Uint8Array(buf));
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}

function modelLabel(key: string | null): string {
  return MODELS.find((m) => m.key === key)?.label ?? key ?? "";
}

// --- Word prediction (port of SD WebUI Mobile Plus CandidateOperations) ---
// dictionary[word][contextWord] = score (symmetric co-occurrence), plus
// the special "__first__" key holding scores for prompt-leading words.
type WordDictionary = Record<string, Record<string, number>>;
type Candidate = { word: string; score: number };

// Port of UIController._matchWordAtPosition: finds the word token at
// `position` in `text`; directionFlag -1 searches backwards (the token
// ending at or before the position).
function matchWordAtPosition(
  text: string,
  position: number,
  directionFlag = 0,
): { start: number; end: number } | null {
  const re = /[^\s,():]+|:\s*[\d.]+/g;
  let prevStart = 0;
  let prevEnd = 0;
  const pos = Math.max(0, Math.min(position + directionFlag, text.length));
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (pos <= end) {
      if (start <= pos) return { start, end };
      if (directionFlag < 0) return { start: prevStart, end: prevEnd };
      if (directionFlag > 0) return { start, end };
      return null;
    }
    prevStart = start;
    prevEnd = end;
  }
  return directionFlag < 0 ? { start: prevStart, end: prevEnd } : null;
}

// --- Text snippets (port of SD WebUI Mobile Plus TextSelector) ---
// Flexible prompt matching: separator spelling (commas / whitespace)
// is normalized away, and a ":n" emphasis weight inside the snippet
// matches whether the prompt carries it or not. Ports of
// TextSelector._escapeRegExp / _buildFlexibleSearchPattern /
// _buildPromptTextRegex / _findPromptTextMatch.
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFlexibleSearchPattern(text: string): string {
  return text
    .split(/(__SSPP_OPTIONAL_EMPHASIS__|[,\s]+)/)
    .filter((part) => part !== "")
    .map((part) => {
      if (part === "__SSPP_OPTIONAL_EMPHASIS__") return "(?:\\s*:\\s*[\\d.]+)?";
      return /[ ,\s]+/.test(part) ? "[,\\s]+" : escapeRegExp(part);
    })
    .join("");
}

function buildPromptTextRegex(text: string): RegExp | null {
  const trimmedText = (text || "").trim();
  if (trimmedText === "") return null;
  const pattern = buildFlexibleSearchPattern(
    trimmedText.replace(/:\s*[\d.]+(?=\s*[)>])/g, "__SSPP_OPTIONAL_EMPHASIS__"),
  );
  return new RegExp(pattern);
}

function findPromptTextMatch(
  promptValue: string,
  text: string,
): RegExpExecArray | null {
  const searchPattern = buildPromptTextRegex(text);
  if (!searchPattern) return null;
  return searchPattern.exec(promptValue);
}

// --- Workspace state backup / restore ---
// The form's current values are backed up to the DB as two JSON
// payloads in one record: a settings bundle and a prompt snapshot
// (prompt text + extra negative). The settings bundle remembers
// the parameters PER MODEL (2026-11-23): { model, models: { wai:
// record, pornmaster: record, zimage: record } }, where a record
// is one model's SettingsSnapshot. Switching models restores that
// model's last-used record (its defaults on first use). At startup
// the saved values, when present and valid, override the defaults
// field by field. Legacy saves (a flat snapshot with a model
// field) are read as the record of their model.
type SettingsSnapshot = {
  promptTemplate: string;
  templateValues: Record<string, number>;
  sizeKey: string | null;
  width: string;
  height: string;
  pixelSize: number | null;
  blockSize: string;
  seedMode: SeedMode;
  seedText: string;
  steps: string;
  cfg: string;
  sampler: string;
  scheduler: string;
  img2imgChecked: boolean;
  denoisingStrength: string;
  resizeMode: number;
  maskMode: string;
  maskBlur: string;
  brushSize: string;
  penTool: string;
  // The payload's formerly fixed values, now specifiable from
  // the Parameter pane's 詳細設定 (payload-passthrough follow-up):
  // override_settings_restore_afterwards (default false) and the
  // inpaint trio (fill / full-res / full-res padding).
  // include_init_images stays a fixed false in the composition —
  // keim asked for no control for it (2026-11-23).
  restoreAfterwards: boolean;
  inpaintingFill: number;
  inpaintFullRes: boolean;
  inpaintFullResPadding: string;
};

type PromptSnapshot = {
  prompt: string;
  negativePrompt: string;
};

// Canonical snapshot constructor: fixes the key order so the JSON of
// a restored snapshot string-matches the JSON of the live form state
// built the same way (the dirty checks compare serialized strings).
function settingsSnapshotOf(v: SettingsSnapshot): SettingsSnapshot {
  return {
    promptTemplate: v.promptTemplate,
    templateValues: Object.fromEntries(
      Object.entries(v.templateValues).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    ),
    sizeKey: v.sizeKey,
    width: v.width,
    height: v.height,
    pixelSize: v.pixelSize,
    blockSize: v.blockSize,
    seedMode: v.seedMode,
    seedText: v.seedText,
    steps: v.steps,
    cfg: v.cfg,
    sampler: v.sampler,
    scheduler: v.scheduler,
    img2imgChecked: v.img2imgChecked,
    denoisingStrength: v.denoisingStrength,
    resizeMode: v.resizeMode,
    maskMode: v.maskMode,
    maskBlur: v.maskBlur,
    brushSize: v.brushSize,
    penTool: v.penTool,
    restoreAfterwards: v.restoreAfterwards,
    inpaintingFill: v.inpaintingFill,
    inpaintFullRes: v.inpaintFullRes,
    inpaintFullResPadding: v.inpaintFullResPadding,
  };
}

function parseJsonRecord(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to empty record
  }
  return {};
}

function savedString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

// Merges a saved settings record over the current values: each field
// is taken from the save only when present and valid, otherwise the
// current value (the form default at startup) is kept.
function restoredRecord(
  saved: Record<string, unknown>,
  base: SettingsSnapshot,
): SettingsSnapshot {
  const next = { ...base };
  if (typeof saved.promptTemplate === "string") {
    next.promptTemplate = saved.promptTemplate;
  }
  if (
    saved.templateValues &&
    typeof saved.templateValues === "object" &&
    !Array.isArray(saved.templateValues)
  ) {
    const tv: Record<string, number> = {};
    for (const [k, val] of Object.entries(
      saved.templateValues as Record<string, unknown>,
    )) {
      if (typeof val === "number" && Number.isFinite(val)) tv[k] = val;
    }
    next.templateValues = tv;
  }
  if (
    typeof saved.sizeKey === "string" &&
    SIZE_PRESETS.some((p) => p.key === saved.sizeKey)
  ) {
    next.sizeKey = saved.sizeKey;
  } else if (saved.sizeKey === null || saved.sizeKey === "custom") {
    // No aspect selection. ("custom" is what older saves stored for
    // hand-edited dimensions, back when they were a FREE selection.)
    next.sizeKey = null;
  }
  const w = savedString(saved.width);
  if (w != null) next.width = w;
  const h = savedString(saved.height);
  if (h != null) next.height = h;
  if (
    typeof saved.pixelSize === "number" &&
    PIXEL_SIZES.includes(saved.pixelSize)
  ) {
    next.pixelSize = saved.pixelSize;
  } else if (
    typeof saved.pixelSize === "string" &&
    PIXEL_SIZES.includes(Number(saved.pixelSize))
  ) {
    next.pixelSize = Number(saved.pixelSize);
  } else if (saved.pixelSize === null) {
    // No pixel-count selection (dimensions were hand-edited).
    next.pixelSize = null;
  }
  const bs = savedString(saved.blockSize);
  if (bs != null) next.blockSize = bs;
  if (
    saved.seedMode === "random" ||
    saved.seedMode === "fixed" ||
    saved.seedMode === "reuse"
  ) {
    next.seedMode = saved.seedMode;
  }
  const seedText = savedString(saved.seedText);
  if (seedText != null) next.seedText = seedText;
  const steps = savedString(saved.steps);
  if (steps != null) next.steps = steps;
  const cfg = savedString(saved.cfg);
  if (cfg != null) next.cfg = cfg;
  if (typeof saved.sampler === "string" && SAMPLERS.includes(saved.sampler)) {
    next.sampler = saved.sampler;
  }
  if (
    typeof saved.scheduler === "string" &&
    SCHEDULERS.includes(saved.scheduler)
  ) {
    next.scheduler = saved.scheduler;
  }
  if (typeof saved.img2imgChecked === "boolean") {
    next.img2imgChecked = saved.img2imgChecked;
  }
  const dn = savedString(saved.denoisingStrength);
  if (dn != null) next.denoisingStrength = dn;
  if (
    saved.resizeMode === 0 || saved.resizeMode === 1 ||
    saved.resizeMode === 2 || saved.resizeMode === 3
  ) {
    next.resizeMode = saved.resizeMode;
  }
  // Legacy saves stored the denoise under editorDenoise.
  if (dn == null) {
    const legacyDn = savedString(saved.editorDenoise);
    if (legacyDn != null) next.denoisingStrength = legacyDn;
  }
  if (saved.maskMode === "masked" || saved.maskMode === "not masked") {
    next.maskMode = saved.maskMode;
  }
  const mb = savedString(saved.maskBlur);
  if (mb != null) next.maskBlur = mb;
  const brushSaved = savedString(saved.brushSize);
  if (brushSaved != null) {
    const n = Number(brushSaved);
    if (Number.isFinite(n) && n >= 4 && n <= 200) next.brushSize = brushSaved;
  }
  if (saved.penTool === "pen" || saved.penTool === "eraser") {
    next.penTool = saved.penTool;
  }
  if (typeof saved.restoreAfterwards === "boolean") {
    next.restoreAfterwards = saved.restoreAfterwards;
  }
  if (
    saved.inpaintingFill === 0 || saved.inpaintingFill === 1 ||
    saved.inpaintingFill === 2 || saved.inpaintingFill === 3
  ) {
    next.inpaintingFill = saved.inpaintingFill;
  }
  if (typeof saved.inpaintFullRes === "boolean") {
    next.inpaintFullRes = saved.inpaintFullRes;
  }
  const frp = savedString(saved.inpaintFullResPadding);
  if (frp != null) {
    const n = Number(frp);
    if (Number.isInteger(n) && n >= 0 && n <= 256) {
      next.inpaintFullResPadding = frp;
    }
  }
  return settingsSnapshotOf(next);
}

// One model's factory defaults: the app-wide initial values, with
// steps / cfg / sampler / scheduler from the model's recipe and
// the model-linked style / denoise presets (wai gets the standard
// base — photorealistic 1.2 / comiclo 0.7, denoise 0.35; the other
// models get a neutral style and denoise 0.5). Used on a model's
// first use and by the Parameter pane's reset button.
function defaultSettingsFor(key: ModelKey): SettingsSnapshot {
  const recipe = MODELS.find((m) => m.key === key) ?? MODELS[0]!;
  return settingsSnapshotOf({
    promptTemplate: DEFAULT_TEMPLATES[key],
    templateValues: templateParamDefaults(DEFAULT_TEMPLATES[key]),
    sizeKey: "3:4",
    width: "1088",
    height: "1472",
    pixelSize: DEFAULT_PIXEL_SIZE,
    blockSize: DEFAULT_BLOCK_SIZE,
    seedMode: "random",
    seedText: "",
    steps: String(recipe.steps),
    cfg: String(recipe.cfg),
    sampler: recipe.sampler,
    scheduler: recipe.scheduler,
    img2imgChecked: false,
    denoisingStrength: key === "wai" ? "0.35" : "0.5",
    resizeMode: 0,
    maskMode: "masked",
    maskBlur: "0",
    brushSize: "100",
    penTool: "pen",
    restoreAfterwards: false,
    inpaintingFill: 1,
    inpaintFullRes: false,
    inpaintFullResPadding: "32",
  });
}

// Parses a saved settings JSON into the per-model bundle. The
// current format is { model, models: { <key>: record } }; legacy
// flat snapshots (a record with a model field) are read as the
// record of their model, merged over that model's defaults.
function parseSettingsBundle(saved: Record<string, unknown>): {
  model: ModelKey;
  records: Partial<Record<ModelKey, SettingsSnapshot>>;
} | null {
  if (Object.keys(saved).length === 0) return null;
  const records: Partial<Record<ModelKey, SettingsSnapshot>> = {};
  let model: ModelKey = "wai";
  if (
    typeof saved.model === "string" &&
    MODELS.some((m) => m.key === saved.model)
  ) {
    model = saved.model as ModelKey;
  }
  const models = saved.models;
  if (models && typeof models === "object" && !Array.isArray(models)) {
    for (const m of MODELS) {
      const rec = (models as Record<string, unknown>)[m.key];
      if (rec && typeof rec === "object" && !Array.isArray(rec)) {
        records[m.key] = restoredRecord(
          rec as Record<string, unknown>,
          defaultSettingsFor(m.key),
        );
      }
    }
  } else if (Object.keys(saved).length > 0) {
    const rec = restoredRecord(saved, defaultSettingsFor(model));
    // Legacy saves predate templates: their photorealistic /
    // comiclo weights become the values of the default template's
    // parameters, so a tuned weight survives the migration
    // instead of snapping back to the defaults.
    if (rec.promptTemplate === DEFAULT_TEMPLATES[model]) {
      const labels = new Set(
        parseTemplateParams(rec.promptTemplate).map((p) => p.label),
      );
      const tv = { ...rec.templateValues };
      const pw = savedString(saved.photorealisticWeight);
      if (pw != null && labels.has("写実的")) {
        const n = Number(pw);
        if (Number.isFinite(n)) tv["写実的"] = n;
      }
      const cw = savedString(saved.comicloWeight);
      if (cw != null && labels.has("コミック調")) {
        const n = Number(cw);
        if (Number.isFinite(n)) tv["コミック調"] = n;
      }
      rec.templateValues = tv;
    }
    records[model] = rec;
  }
  return { model, records };
}

// The canonical settings-bundle JSON for a model + records map:
// fixed key order (model, then models in MODELS order) so the
// dirty checks compare stable strings.
function settingsBundleJson(
  model: ModelKey,
  records: Partial<Record<ModelKey, SettingsSnapshot>>,
): string {
  const models: Partial<Record<ModelKey, SettingsSnapshot>> = {};
  for (const m of MODELS) {
    const rec = records[m.key];
    if (rec) models[m.key] = rec;
  }
  return JSON.stringify({ model, models });
}

function restoredPrompt(
  saved: Record<string, unknown>,
  current: PromptSnapshot,
): PromptSnapshot {
  return {
    prompt: typeof saved.prompt === "string" ? saved.prompt : current.prompt,
    negativePrompt:
      typeof saved.negativePrompt === "string"
        ? saved.negativePrompt
        : current.negativePrompt,
  };
}

export function App() {
  const queryClient = useQueryClient();
  const jobsQuery = useQuery({
    queryKey: ["jobs"],
    queryFn: () => withPollTimeout(api.listJobs({ limit: 50 })),
  });
  // Saved images (the History pane's 「保存」 tab): copies of
  // generation results stored under "{counter}-{seed}" names,
  // independent of the jobs list above.
  const savedQuery = useQuery({
    queryKey: ["savedImages"],
    queryFn: () => api.listSavedImages({}),
  });
  const savedImages = useMemo(
    () => savedQuery.data?.saved ?? [],
    [savedQuery.data],
  );
  // Upload library (the History pane's 「アップロード」 tab, and
  // half of the Editor side preview column's merged list): one
  // record per uploaded image, accumulated server-side.
  const uploadsQuery = useQuery({
    queryKey: ["uploadImages"],
    queryFn: () => api.listUploadImages({}),
  });
  const uploadImages = useMemo(
    () => uploadsQuery.data?.uploads ?? [],
    [uploadsQuery.data],
  );
  const jobs = useMemo(() => jobsQuery.data?.jobs ?? [], [jobsQuery.data]);
  const hasActive = jobs.some(isActive);

  // Polling self-recovery state (see the POLL_* constants above):
  // pollEpoch is the watchdog's restart lever — bumping it tears
  // both polling loops down and rebuilds them; lastPollSuccessRef
  // is stamped by every successful jobs fetch and every successful
  // pollGenerationJob response; pollNowRef exposes the current
  // pollGenerationJob sweep to the visibility handler;
  // hasActiveRef mirrors hasActive for that handler.
  const [pollEpoch, setPollEpoch] = useState(0);
  const lastPollSuccessRef = useRef(Date.now());
  const pollNowRef = useRef<(() => void) | null>(null);
  const hasActiveRef = useRef(false);
  useEffect(() => {
    hasActiveRef.current = hasActive;
    // A job becoming active starts a fresh staleness window, so
    // the watchdog never fires on a job that just started.
    if (hasActive) lastPollSuccessRef.current = Date.now();
  }, [hasActive]);
  useEffect(() => {
    if (jobsQuery.dataUpdatedAt > 0) {
      lastPollSuccessRef.current = Date.now();
    }
  }, [jobsQuery.dataUpdatedAt]);

  // Poll while any job is in flight.
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    }, 3000);
    return () => clearInterval(t);
  }, [hasActive, queryClient, pollEpoch]);

  // Watchdog: while jobs are active, if no poll has succeeded for
  // POLL_STALE_MS the loops are assumed wedged (a hung request, a
  // background-frozen timer) and are rebuilt — bumping pollEpoch
  // recreates both intervals, the poll effect polls immediately on
  // rebuild, and the list is refetched at once.
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(() => {
      if (Date.now() - lastPollSuccessRef.current > POLL_STALE_MS) {
        lastPollSuccessRef.current = Date.now();
        setPollEpoch((e) => e + 1);
        void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      }
    }, 5000);
    return () => clearInterval(t);
  }, [hasActive, queryClient]);

  // Returning to the foreground reconciles at once instead of
  // waiting for the next tick: a backgrounded WebView throttles or
  // freezes its timers, so the first poll after a return is the
  // one that recovers a job that finished while the app was away.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (!hasActiveRef.current) return;
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      pollNowRef.current?.();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () =>
      document.removeEventListener("visibilitychange", onVisibility);
  }, [queryClient]);

  // Download recovery (2026-11-21): after a download the phone's
  // WebView may hand focus to a system download UI and back; if
  // anything in the client wedged in between, the lists must not
  // stay stale. Every download settles through reconcileAfterDownload
  // (DownloadButton's onSettled), and returning to the foreground
  // or regaining window focus reconciles the same way — refetching
  // the image lists is cheap and idempotent, so a download can
  // never leave the UI needing a reload to operate again.
  const reconcileAfterDownload = () => {
    void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    void queryClient.invalidateQueries({ queryKey: ["savedImages"] });
    void queryClient.invalidateQueries({ queryKey: ["uploadImages"] });
    void queryClient.invalidateQueries({ queryKey: ["editorSource"] });
  };
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== "visible") return;
      reconcileAfterDownload();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
    // reconcileAfterDownload only touches queryClient (stable);
    // the first-render closure stays valid for the component's
    // lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1-second ticker for elapsed-time readouts.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasActive) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasActive]);

  // Only generation jobs are surfaced anywhere in the UI now; check jobs
  // are no longer created from this screen and never shown.
  const genJobs = useMemo(() => jobs.filter((j) => j.kind === "generate"), [jobs]);

  const lastSeed = useMemo(() => {
    const done = genJobs.find(
      (j) => j.status === "completed" && j.resultSeed != null,
    );
    return done?.resultSeed ?? null;
  }, [genJobs]);

  const activeJobs = useMemo(() => genJobs.filter(isActive), [genJobs]);
  const latestGen = useMemo(() => genJobs[0] ?? null, [genJobs]);
  const history = genJobs;

  // Merged preview list for the Editor's side column: generation
  // outputs (completed jobs with a display image) and upload
  // library records, interleaved by time, newest first. Saved
  // images are NOT part of this list (they are copies of outputs).
  // Tapping either kind sets it as the Editor's current image —
  // a user selection, which also switches the generation mode
  // to the i2i/inpaint side. This merged order is also the basis
  // for the Editor image-area delete's "load the next image"
  // behaviour (§12.18, extended to the merged list) — that
  // automatic load, unlike a tap, does not switch the mode.
  type MergedPreviewItem =
    | { kind: "job"; job: Job; time: number }
    | { kind: "upload"; upload: UploadImage; time: number };
  const mergedPreview = useMemo<MergedPreviewItem[]>(() => {
    const items: MergedPreviewItem[] = [];
    for (const j of history) {
      if (j.status === "completed" && j.displayUrl) {
        items.push({ kind: "job", job: j, time: new Date(j.createdAt).getTime() });
      }
    }
    for (const u of uploadImages) {
      if (u.displayUrl ?? u.imageUrl) {
        items.push({ kind: "upload", upload: u, time: new Date(u.createdAt).getTime() });
      }
    }
    items.sort((a, b) => b.time - a.time);
    return items;
  }, [history, uploadImages]);

  // Baseline for the completion watcher further below: the first
  // jobs payload only RECORDS the newest completed job's id, so a
  // completion that predates this session (e.g. the page was
  // reloaded after it finished) is not mistaken for a fresh
  // in-session completion. Declared before the watcher so it runs
  // first within the same commit.
  const latestCompletedIdRef = useRef<number | null>(null);
  const completionBaselineRef = useRef(false);
  useEffect(() => {
    if (completionBaselineRef.current) return;
    if (!jobsQuery.data) return;
    completionBaselineRef.current = true;
    const latest = genJobs[0];
    if (latest && latest.status === "completed") {
      latestCompletedIdRef.current = latest.id;
    }
  }, [jobsQuery.data, genJobs]);

  // Generation jobs run detached on the host with no worker to write
  // their result back: the client polls pollGenerationJob, which
  // checks the run on the host, advances the display phase, and
  // completes/fails the job server-side.
  const activeDirectIds = useMemo(
    () => genJobs.filter((j) => j.direct && isActive(j)).map((j) => j.id),
    [genJobs],
  );
  const activeDirectKey = activeDirectIds.join(",");
  // Live sampling progress piggybacked on the poll response
  // (display-only, never persisted), as a per-job display state
  // machine. illu's raw counters cannot be shown as-is: during
  // preparation (model load, init-image encode) sampling_step sits
  // at 0 while sampling_steps still holds the payload steps, an
  // img2img total then switches mid-run to the denoise-adjusted
  // real count, and once sampling finishes illu falls back to idle
  // and the readings stop. So:
  // - `started` flips only when sampling is observably under way
  //   (a poll returns step >= 1 or fraction > 0); before that the
  //   label shows no step counts at all.
  // - `total` is fixed from the sampling_steps of that first
  //   started reading and never changes afterwards (null when that
  //   reading carried no usable total — the label then falls back
  //   to the job's own steps setting).
  // - `done` flips when, after the start, a poll brings back no
  //   progress (idle state or a failed read): sampling is treated
  //   as complete and the label shows (total/total) instead of
  //   freezing at an intermediate count. A later live reading
  //   clears it again — fresh counters win over the inference.
  const [liveProgress, setLiveProgress] = useState<
    Record<
      number,
      { started: boolean; total: number | null; step: number; done: boolean }
    >
  >({});
  useEffect(() => {
    if (activeDirectKey === "") return;
    const ids = activeDirectKey.split(",").map((s) => Number(s));
    const poll = () => {
      for (const id of ids) {
        void withPollTimeout(api.pollGenerationJob({ jobId: id }))
          .then((res) => {
            lastPollSuccessRef.current = Date.now();
            const progress = res.progress;
            setLiveProgress((prev) => {
              const cur = prev[id] ?? {
                started: false,
                total: null,
                step: 0,
                done: false,
              };
              if (progress) {
                const samplingNow =
                  progress.step >= 1 ||
                  (progress.fraction != null && progress.fraction > 0);
                if (!samplingNow) {
                  // Pre-sampling reading (or a stale zeroed one
                  // after the start): nothing displayable changes.
                  return prev;
                }
                const total = cur.started
                  ? cur.total
                  : progress.steps != null && progress.steps > 0
                    ? progress.steps
                    : null;
                if (
                  cur.started &&
                  !cur.done &&
                  cur.total === total &&
                  cur.step === progress.step
                ) {
                  return prev;
                }
                return {
                  ...prev,
                  [id]: {
                    started: true,
                    total,
                    step: progress.step,
                    done: false,
                  },
                };
              }
              // No progress on this poll: after sampling has
              // started that means it has finished (illu went
              // idle) or the read failed — either way the display
              // completes the count instead of freezing mid-way.
              // Before the start it means nothing yet.
              if (cur.started && !cur.done) {
                return { ...prev, [id]: { ...cur, done: true } };
              }
              return prev;
            });
            void queryClient.invalidateQueries({ queryKey: ["jobs"] });
          })
          .catch(() => {
            // A failed (or timed-out) poll is retried on the next
            // interval tick; if failures persist, the watchdog
            // above rebuilds this loop.
          });
      }
    };
    pollNowRef.current = poll;
    poll();
    const t = setInterval(poll, 4000);
    return () => {
      clearInterval(t);
      if (pollNowRef.current === poll) pollNowRef.current = null;
    };
  }, [activeDirectKey, queryClient, pollEpoch]);

  // --- word prediction dictionary (loaded once at startup, kept in memory) ---
  const dictQuery = useQuery({
    queryKey: ["wordDictionary"],
    queryFn: () => api.getWordDictionary({}),
  });
  const dictionary = useMemo<WordDictionary>(() => {
    if (!dictQuery.data) return {};
    try {
      const parsed: unknown = JSON.parse(dictQuery.data.dictionary);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as WordDictionary;
      }
    } catch {
      // fall through to empty dictionary
    }
    return {};
  }, [dictQuery.data]);

  // --- text snippets (loaded at startup from the DB, kept via query) ---
  const snippetsQuery = useQuery({
    queryKey: ["textSnippets"],
    queryFn: () => api.getTextSnippets({}),
  });
  const snippets = useMemo<string[]>(() => {
    if (!snippetsQuery.data) return [];
    try {
      const parsed: unknown = JSON.parse(snippetsQuery.data.snippets);
      if (Array.isArray(parsed)) {
        return parsed.filter((s): s is string => typeof s === "string");
      }
    } catch {
      // fall through to empty list
    }
    return [];
  }, [snippetsQuery.data]);

  // Inline snippet editor: null = closed; index null = adding a new
  // snippet, otherwise editing snippets[index].
  const [snippetEdit, setSnippetEdit] = useState<{
    index: number | null;
    value: string;
  } | null>(null);
  const [snippetEditError, setSnippetEditError] = useState<string | null>(null);
  const [snippetPopupOpen, setSnippetPopupOpen] = useState(false);
  const [sizePopupOpen, setSizePopupOpen] = useState(false);
  const sizePopupRef = useRef<HTMLDivElement | null>(null);
  const sizeToggleRef = useRef<HTMLButtonElement | null>(null);

  // Size popup dismissal: a pointer-down anywhere outside the popup
  // panel closes it — not only taps on the size toggle button. The
  // toggle itself is excluded so its own click handler can toggle,
  // and the panel is excluded so interacting with the size controls
  // never closes it.
  useEffect(() => {
    if (!sizePopupOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (sizePopupRef.current?.contains(target)) return;
      if (sizeToggleRef.current?.contains(target)) return;
      setSizePopupOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [sizePopupOpen]);

  function closeSnippetPopup() {
    setSnippetPopupOpen(false);
    setSnippetEdit(null);
    setSnippetEditError(null);
    // Return focus to the prompt textarea: closing the popup (× or
    // backdrop tap) must land the user back in the prompt with the
    // focused layout (auxiliary panel) intact, exactly as if the
    // popup had never taken focus. focusPrompt re-focuses the
    // textarea (its onFocus restores promptFocused) and restores
    // the selection the panel operations last left behind.
    focusPrompt(selStart, selEnd);
  }

  const saveSnippets = useMutation({
    mutationFn: (list: string[]) => api.saveTextSnippets({ snippets: list }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["textSnippets"] });
    },
  });

  // Persists a new snippet list: update the query cache immediately so
  // the chips reflect the change, then save the whole list to the DB.
  function persistSnippets(list: string[]) {
    queryClient.setQueryData(["textSnippets"], {
      snippets: JSON.stringify(list),
    });
    saveSnippets.mutate(list);
  }

  // Port of TextSelector.addText: trims, ignores empty input and exact
  // duplicates, otherwise appends to the list.
  function addSnippet(text: string) {
    const trimmed = (text || "").trim();
    if (trimmed === "") return;
    if (snippets.includes(trimmed)) return;
    persistSnippets([...snippets, trimmed]);
  }

  // Port of TextSelector.updateTextAt: trims; empty input deletes the
  // snippet at index, otherwise replaces it.
  function updateSnippetAt(index: number, text: string) {
    if (index < 0 || index >= snippets.length) return;
    const trimmed = (text || "").trim();
    const next = [...snippets];
    if (trimmed === "") {
      next.splice(index, 1);
    } else {
      next[index] = trimmed;
    }
    persistSnippets(next);
  }

  function saveSnippetEdit() {
    if (!snippetEdit) return;
    if (snippetEdit.index == null && snippetEdit.value.trim() === "") {
      setSnippetEditError("定型文を入力してください。");
      return;
    }
    setSnippetEditError(null);
    if (snippetEdit.index == null) {
      addSnippet(snippetEdit.value);
    } else {
      updateSnippetAt(snippetEdit.index, snippetEdit.value);
    }
    setSnippetEdit(null);
  }

  // Port of TextSelector._onSelectText (toggle): when the snippet is
  // already in the prompt (flexible match), remove that part; when it
  // is not, insert it at the cursor, adding a leading space unless the
  // preceding character is already a space. Main prompt textarea only.
  function onToggleSnippet(text: string) {
    if (text === "") return;
    const matched = findPromptTextMatch(prompt, text);
    if (matched) {
      const matchStart = matched.index;
      const matchEnd = matchStart + (matched[0]?.length ?? 0);
      const next = prompt.slice(0, matchStart) + prompt.slice(matchEnd);
      setPrompt(next);
      recordHistory(next);
      focusPrompt(matchStart, matchStart);
      return;
    }
    const start = selStart;
    const end = selEnd;
    const needsLeadingSpace = start > 0 && prompt[start - 1] !== " ";
    const insertText = `${needsLeadingSpace ? " " : ""}${text}`;
    const next = prompt.slice(0, start) + insertText + prompt.slice(end);
    setPrompt(next);
    recordHistory(next);
    const caret = start + insertText.length;
    focusPrompt(caret, caret);
  }

  // --- pane state ---
  const [tab, setTab] = useState<PaneKey>("editor");
  const [promptFocused, setPromptFocused] = useState(false);
  const [editorPopup, setEditorPopup] = useState<
    "model" | "style" | "denoise" | "blur" | "brush" | "resize" | null
  >(null);

  // Editor / Inpaint popup dismissal (same general rule as the
  // size popup): a pointer-down outside the parameter panel area
  // (panel + its upward popup) closes the open popup; taps on the
  // panel's own toggle buttons are inside the area, so their click
  // handlers toggle normally.
  useEffect(() => {
    if (editorPopup == null) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-popup-area="true"]')) return;
      setEditorPopup(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [editorPopup]);

  // Standard negative (initial value for the Parameter pane's
  // editable negative editor, before any saved state exists).
  const standardNegativeQuery = useQuery({
    queryKey: ["standardNegative"],
    queryFn: () => api.getStandardNegative({}),
  });
  const standardNegative = standardNegativeQuery.data?.standardNegative ?? "";

  // --- Editor / Inpaint image slot state ---
  // The current image lives in ONE server-side slot
  // (getEditorSource): either a history job transferred via
  // 「Editorへ転送」 (kind "job"), a local file uploaded from the
  // Editor pane (kind "upload", stored server-side as a blob and
  // restored on reload), or the latest completed generation (the
  // server points the slot at it on completion). Whichever was set
  // last replaces the other; the preview always uses the slot's
  // displayUrl (blob URL route, same as history images). Only
  // identifiers travel at generation time — the server resolves
  // the init image's host path itself. The Editor and Inpaint
  // panes both display this same slot.
  const editorSourceQuery = useQuery({
    queryKey: ["editorSource"],
    queryFn: () => api.getEditorSource({}),
  });
  const sourceImageQuery = useQuery({
    queryKey: ["sourceImage"],
    queryFn: () => api.getSourceImage({}),
  });
  // The img2img source slot, independent of the Editor slot:
  // the image in the prompt row's source image area, the
  // Inpaint pane's target, and the init image of img2img /
  // inpaint generation. It changes only through the source
  // area (upload / detach) and the image area's adopt button.
  const sourceImage: EditorSource =
    sourceImageQuery.data?.source ?? {
      kind: "none",
      jobId: null,
      uploadId: null,
      resultSeed: null,
      displayUrl: null,
      imageUrl: null,
      mimeType: null,
      byteSize: null,
      fileName: null,
    };
  const editorSource: EditorSource =
    editorSourceQuery.data?.source ?? {
      kind: "none",
      jobId: null,
      uploadId: null,
      resultSeed: null,
      displayUrl: null,
      imageUrl: null,
      mimeType: null,
      byteSize: null,
      fileName: null,
    };
  const [editorDenoise, setEditorDenoise] = useState("0.5");
  // Mode toggle state (the operation panel's mode cell): true =
  // the img2img(inpaint) side is selected, false = the txt2img
  // side. It only has an effect while a SOURCE image is set —
  // with no source image the generation is txt2img regardless.
  // NOTHING changes this state automatically: uploads, image
  // selections, generation completions, deletions and detaches
  // all leave it exactly as the user left it. The single
  // exception is the image area's adopt button (元画像に採用),
  // whose very action is "make this the source and switch to
  // img2img". Manual toggling is always available, with or
  // without any image.
  // Persisted in the settings backup under its historical key name.
  const [img2imgChecked, setImg2imgChecked] = useState(false);
  // img2img resize mode for the operation panel's Cover / Crop
  // / Contain / Latent selector: 0 = Cover (just resize),
  // 1 = Crop (crop and resize), 2 = Contain (resize and fill),
  // 3 = Latent (just resize in latent space).
  const [resizeMode, setResizeMode] = useState(0);
  const [maskMode, setMaskMode] = useState("masked");
  const [maskBlur, setMaskBlur] = useState("0");
  // The payload's formerly fixed values, edited in the Parameter
  // pane's 詳細設定 and backed up in the settings snapshot.
  const [restoreAfterwards, setRestoreAfterwards] = useState(false);
  const [inpaintingFill, setInpaintingFill] = useState(1);
  const [inpaintFullRes, setInpaintFullRes] = useState(false);
  const [inpaintFullResPadding, setInpaintFullResPadding] = useState("32");
  // Inpaint brush: diameter in DISPLAY pixels (4..200 step 4) and
  // the current tool. Both are backed up in the settings snapshot;
  // the painted mask itself is not (it lives in the mask canvas
  // below, in memory only).
  const [brushSize, setBrushSize] = useState("100");
  const [penTool, setPenTool] = useState<"pen" | "eraser">("pen");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const editorFileInputRef = useRef<HTMLInputElement | null>(null);

  // Switch the mode toggle to the img2img(inpaint) side, saving
  // the settings snapshot immediately (the same discipline as
  // the manual toggle). Used ONLY by the adopt button — the one
  // place whose action includes the mode switch. img2img vs
  // inpaint is not decided here: the
  // mask's paint splits the two at generation time.
  function switchToI2iSide() {
    markSettingsImmediate();
    setImg2imgChecked(true);
  }

  const uploadImage = useMutation({
    mutationFn: api.uploadEditorImage,
    onSuccess: (res) => {
      // Uploads land in the SOURCE slot (the source image area
      // is the only upload entry point). The mode toggle is
      // NOT switched — mode changes are the user's alone (and
      // the adopt button's).
      void queryClient.invalidateQueries({ queryKey: ["sourceImage"] });
      void queryClient.invalidateQueries({ queryKey: ["uploadImages"] });
      if (!res.ok) {
        setUploadError(res.error ?? "アップロードできませんでした。");
      }
    },
    onError: () =>
      setUploadError(
        "アップロードできませんでした（サイズが大きすぎる可能性があります）。通信状態を確認してください。",
      ),
  });

  // The two Editor-slot-setting mutations never touch the mode
  // toggle: an image selection changes which image the image
  // area shows, nothing else. (The img2img source slot has its
  // own mutations below.)
  const setSourceFromJob = useMutation({
    mutationFn: api.setEditorSourceFromJob,
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["editorSource"] });
      if (!res.ok) {
        setUploadError(res.error ?? "Editor へ転送できませんでした。");
      }
    },
    onError: () => setUploadError("Editor へ転送できませんでした。通信状態を確認してください。"),
  });

  const setSourceFromUpload = useMutation({
    mutationFn: api.setEditorSourceFromUpload,
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["editorSource"] });
      if (!res.ok) {
        setUploadError(res.error ?? "Editor へセットできませんでした。");
      }
    },
    onError: () => setUploadError("Editor へセットできませんでした。通信状態を確認してください。"),
  });

  // Detach the img2img source image (the source area's ×).
  // The mode toggle is NOT reset: the area stays on whichever
  // side the user selected, empty, as the upload target.
  const clearSourceImage = useMutation({
    mutationFn: () => api.clearSourceImage({}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sourceImage"] });
    },
    onError: () => setUploadError("元画像を外せませんでした。通信状態を確認してください。"),
  });

  // 元画像に採用 (the image area's adopt button): copy the image
  // area's current image into the source slot AND switch the
  // mode toggle to the img2img side — the one automatic mode
  // switch in the app, because it is the button's own action.
  const adoptSource = useMutation({
    mutationFn: () => api.adoptEditorSource({}),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["sourceImage"] });
      if (!res.ok) {
        setUploadError(res.error ?? "元画像に採用できませんでした。");
      } else {
        switchToI2iSide();
      }
    },
    onError: () => setUploadError("元画像に採用できませんでした。通信状態を確認してください。"),
  });

  // 「Editorへ転送」 (history detail): make the job's generated image
  // the Editor's current image (server-side slot) and switch to
  // the Editor pane. As a user image-list selection, a successful
  // transfer changes the image area's image only — the mode
  // toggle and the img2img source slot are untouched.
  function transferToEditor(job: Job) {
    setUploadError(null);
    setSourceFromJob.mutate({ jobId: job.id });
    switchTab("editor");
  }

  // History-panel preview tap (Editor pane): the same editor_source
  // setting as 「Editorへ転送」 — the tapped image becomes the
  // Editor's current image — but WITHOUT moving panes: the user
  // stays in the Editor, and tapping the image body itself
  // remains the route into the Preview pane. Neither the mode
  // toggle nor the img2img source slot changes.
  function setSourceFromPreview(job: Job) {
    setUploadError(null);
    setSourceFromJob.mutate({ jobId: job.id });
  }

  // Upload-library selection (History 「アップロード」 tab detail
  // and the Editor side preview column): the same editor_source
  // setting as the history transfer — the tapped upload becomes
  // the Editor's current image. The mode toggle and the img2img
  // source slot are untouched.
  function setSourceFromUploadPreview(upload: UploadImage) {
    setUploadError(null);
    setSourceFromUpload.mutate({ uploadId: upload.id });
  }

  function transferUploadToEditor(upload: UploadImage) {
    setUploadError(null);
    setSourceFromUpload.mutate({ uploadId: upload.id });
    switchTab("editor");
  }

  // File picked in the Editor: validate format/size client-side for
  // immediate feedback (the server re-validates), base64-encode,
  // and upload. On success the uploaded image becomes the slot's
  // source image (replacing any transferred history image).
  async function onEditorImageChange(file: File | null) {
    if (!file) return;
    setUploadError(null);
    if (file.type !== "image/png" && file.type !== "image/jpeg") {
      setUploadError("対応形式は PNG / JPEG のみです。");
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setUploadError("画像サイズは 25MB 以下にしてください。");
      return;
    }
    try {
      const { dataBase64, mimeType } = await fileToBase64(file);
      // The library's display JPEG (max 1280px) is generated here
      // alongside the original; when it cannot be made, the
      // upload proceeds without one.
      const displayDataBase64 = await fileToDisplayJpegBase64(file);
      uploadImage.mutate({
        dataBase64,
        mimeType,
        fileName: file.name,
        ...(displayDataBase64 != null ? { displayDataBase64 } : {}),
      });
    } catch {
      setUploadError("画像ファイルを読み取れませんでした。");
    }
  }

  // --- form state ---
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<ModelKey>("wai");
  // Per-model parameter records for the models that are NOT
  // current (the live form state is the current model's record).
  const [byModel, setByModel] = useState<
    Partial<Record<ModelKey, SettingsSnapshot>>
  >({});
  const [sizeKey, setSizeKey] = useState<string | null>("3:4");
  const [width, setWidth] = useState("1088");
  const [height, setHeight] = useState("1472");
  const [pixelSize, setPixelSize] = useState<number | null>(DEFAULT_PIXEL_SIZE);
  const [blockSize, setBlockSize] = useState<string>(DEFAULT_BLOCK_SIZE);
  const [seedMode, setSeedMode] = useState<SeedMode>("random");
  const [seedText, setSeedText] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [steps, setSteps] = useState("20");
  const [cfg, setCfg] = useState("5.5");
  const [sampler, setSampler] = useState("DPM++ 2M");
  const [scheduler, setScheduler] = useState("Karras");
  const [promptTemplate, setPromptTemplate] = useState(
    DEFAULT_TEMPLATES.wai,
  );
  const [templateValues, setTemplateValues] = useState<
    Record<string, number>
  >(() => templateParamDefaults(DEFAULT_TEMPLATES.wai));
  // The Parameter pane's template editor works on a draft; the
  // committed template above (and the numeric values' reset) only
  // change when its テンプレート保存 button is pressed.
  const [templateDraft, setTemplateDraft] = useState(
    DEFAULT_TEMPLATES.wai,
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [checkedIds, setCheckedIds] = useState<number[]>([]);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Editor image-area delete: confirmation dialog for deleting the
  // image currently shown in the Editor (the trash button at the
  // image's bottom-right) — a generated job (via deleteJobs) or an
  // upload record (via deleteUploadImage). Separate from the
  // history multi-select delete above.
  const [showEditorDeleteConfirm, setShowEditorDeleteConfirm] = useState(false);
  // --- History pane tabs + saved images ---
  // The History pane's top tabs switch its list between the normal
  // output history ("output") and the saved-image list ("saved").
  // Pane-local state only — not part of the hub navigation.
  const [historyTab, setHistoryTab] = useState<"output" | "saved" | "uploads">("output");
  const [selectedUploadId, setSelectedUploadId] = useState<number | null>(null);
  const [showUploadDeleteConfirm, setShowUploadDeleteConfirm] = useState(false);
  const [uploadDeleteError, setUploadDeleteError] = useState<string | null>(null);
  const [checkedUploadIds, setCheckedUploadIds] = useState<number[]>([]);
  const [showUploadBulkDeleteConfirm, setShowUploadBulkDeleteConfirm] = useState(false);
  const [selectedSavedId, setSelectedSavedId] = useState<number | null>(null);
  const [checkedSavedIds, setCheckedSavedIds] = useState<number[]>([]);
  const [showSavedDeleteConfirm, setShowSavedDeleteConfirm] = useState(false);
  const [savedDeleteError, setSavedDeleteError] = useState<string | null>(null);
  // Save feedback: after a successful save, the assigned
  // "{counter}-{seed}" name is shown briefly (auto-dismissed);
  // a failure keeps its message until the next save attempt.
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    if (saveNotice == null) return;
    const t = setTimeout(() => setSaveNotice(null), 4000);
    return () => clearTimeout(t);
  }, [saveNotice]);

  // --- prompt undo / redo history (session-only, never persisted) ---
  // Recorded snapshots of the main prompt text, oldest first, capped
  // at 10 entries; `index` points at the entry the current text was
  // last recorded as / restored from (-1 while nothing is recorded).
  // Recording happens only at the defined checkpoints: candidate
  // insertion, snippet toggles, space / newline keystrokes, pastes,
  // and the (...) / rate word operations. Plain typing between
  // checkpoints stays unrecorded until the next checkpoint — or until
  // an Undo press, which records the current value first (see
  // onUndo). Independent of the prompt backup/restore mechanism.
  const [undoState, setUndoState] = useState<{ entries: string[]; index: number }>({
    entries: [],
    index: -1,
  });

  // Records a post-operation prompt value: a no-op when it matches
  // the entry at the current position; otherwise drops any redo
  // entries ahead of the position, appends the value, and evicts the
  // oldest entries beyond the 10-entry cap.
  function recordHistory(value: string) {
    setUndoState((prev) => {
      if (prev.index >= 0 && prev.entries[prev.index] === value) return prev;
      const entries = prev.entries.slice(0, prev.index + 1);
      entries.push(value);
      while (entries.length > 10) entries.shift();
      return { entries, index: entries.length - 1 };
    });
  }

  // --- workspace state backup / restore ---
  // Startup: getWorkspaceState loads the saved settings + prompt; the
  // restore effect below applies them once over the defaults and seeds
  // the dirty-check baselines, so the restore itself never triggers a
  // save. Until the restore has run (or the load failed), no saves
  // happen at all.
  const workspaceQuery = useQuery({
    queryKey: ["workspaceState"],
    queryFn: () => api.getWorkspaceState({}),
  });

  const liveSnapshot = settingsSnapshotOf({
    promptTemplate,
    templateValues,
    sizeKey,
    width,
    height,
    pixelSize,
    blockSize,
    seedMode,
    seedText,
    steps,
    cfg,
    sampler,
    scheduler,
    img2imgChecked,
    denoisingStrength: editorDenoise,
    resizeMode,
    maskMode,
    maskBlur,
    brushSize,
    penTool,
    restoreAfterwards,
    inpaintingFill,
    inpaintFullRes,
    inpaintFullResPadding,
  });
  // The saved settings are the per-model bundle: the live form is
  // the current model's record; the other models' records are
  // held in byModel (written when switching away from them, or at
  // startup restore).
  const settingsJson = settingsBundleJson(model, {
    ...byModel,
    [model]: liveSnapshot,
  });
  // The style popup's sliders are driven by the committed
  // template's numeric parameters.
  const styleParams = parseTemplateParams(promptTemplate);
  const promptSnapshot: PromptSnapshot = { prompt, negativePrompt };
  const promptJson = JSON.stringify(promptSnapshot);

  const restoredRef = useRef(false);
  const lastSavedSettingsRef = useRef<string | null>(null);
  const lastSavedPromptRef = useRef<string | null>(null);
  const settingsJsonRef = useRef(settingsJson);
  settingsJsonRef.current = settingsJson;
  const promptJsonRef = useRef(promptJson);
  promptJsonRef.current = promptJson;
  const settingsTimerRef = useRef<number | null>(null);
  const promptTimerRef = useRef<number | null>(null);
  // Set by discrete controls (buttons / selects / checkbox) just
  // before they change state: the settings effect then saves
  // immediately instead of after the numeric-input debounce.
  const settingsImmediateRef = useRef(false);

  function markSettingsImmediate() {
    settingsImmediateRef.current = true;
  }

  function doSaveSettings(json: string) {
    if (json === lastSavedSettingsRef.current) return;
    lastSavedSettingsRef.current = json;
    void api.saveSettings({ settings: json }).catch(() => {
      // Best-effort backup: a failed save is retried implicitly by
      // the next change, which re-sends the whole snapshot.
    });
  }

  function doSavePrompt(json: string) {
    if (json === lastSavedPromptRef.current) return;
    lastSavedPromptRef.current = json;
    void api.savePrompt({ prompt: json }).catch(() => {
      // Best-effort backup, same reasoning as doSaveSettings.
    });
  }

  // Flush a pending debounced settings save right away (numeric
  // inputs call this on blur).
  function flushSettingsSave() {
    if (!restoredRef.current) return;
    if (settingsTimerRef.current != null) {
      window.clearTimeout(settingsTimerRef.current);
      settingsTimerRef.current = null;
    }
    doSaveSettings(settingsJsonRef.current);
  }

  // Flush a pending debounced prompt save right away (Generate,
  // switching panes, app going to background).
  function flushPromptSave() {
    if (!restoredRef.current) return;
    if (promptTimerRef.current != null) {
      window.clearTimeout(promptTimerRef.current);
      promptTimerRef.current = null;
    }
    doSavePrompt(promptJsonRef.current);
  }

  // One-time restore at startup. Runs when the saved state AND the
  // standard negative have arrived (the negative editor's default
  // is the standard negative verbatim when nothing was saved), or
  // when either load failed, in which case the defaults stay and
  // saving is enabled with the current values as the baseline.
  const negativeSeededRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    if (workspaceQuery.isError || standardNegativeQuery.isError) {
      restoredRef.current = true;
      if (standardNegative && !negativeSeededRef.current) {
        negativeSeededRef.current = true;
        setNegativePrompt(standardNegative);
        lastSavedPromptRef.current = JSON.stringify({
          prompt,
          negativePrompt: standardNegative,
        } satisfies PromptSnapshot);
      } else {
        lastSavedPromptRef.current = promptJsonRef.current;
      }
      lastSavedSettingsRef.current = settingsJsonRef.current;
      return;
    }
    const data = workspaceQuery.data;
    if (!data) return;
    if (standardNegativeQuery.data == null) return;
    restoredRef.current = true;
    const bundle = parseSettingsBundle(parseJsonRecord(data.settings));
    if (bundle) {
      const currentRecord =
        bundle.records[bundle.model] ?? defaultSettingsFor(bundle.model);
      setByModel(bundle.records);
      setModel(bundle.model);
      applySettingsRecord(currentRecord);
      lastSavedSettingsRef.current = settingsBundleJson(bundle.model, {
        ...bundle.records,
        [bundle.model]: currentRecord,
      });
    } else {
      // No saved settings at all: keep the form's initial values
      // as-is (they are NOT any model's defaults — e.g. the wai
      // weights start at 1 / 0.7, not the 1.2 / 0.7 preset).
      lastSavedSettingsRef.current = settingsJsonRef.current;
    }
    const savedPromptRecord = parseJsonRecord(data.prompt);
    const hadSavedNegative = typeof savedPromptRecord.negativePrompt === "string";
    const nextPrompt = restoredPrompt(savedPromptRecord, {
      prompt,
      negativePrompt: standardNegative,
    });
    negativeSeededRef.current = true;
    setPrompt(nextPrompt.prompt);
    setNegativePrompt(nextPrompt.negativePrompt);
    // When no negative was ever saved, the seeded standard text is
    // the baseline (not a change to persist); when one was saved,
    // the restored value is the baseline either way.
    void hadSavedNegative;
    lastSavedPromptRef.current = JSON.stringify(nextPrompt);
    // The restore effect re-runs only when the queries settle; the
    // state values it merges over are the startup defaults.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workspaceQuery.data,
    workspaceQuery.isError,
    standardNegativeQuery.data,
    standardNegativeQuery.isError,
  ]);

  // Settings saving: discrete changes (flagged via
  // markSettingsImmediate) save at once; everything else — the
  // numeric text inputs — saves after a 0.8s debounce (or on blur via
  // flushSettingsSave). Unchanged snapshots are never written.
  useEffect(() => {
    if (!restoredRef.current) return;
    if (settingsJson === lastSavedSettingsRef.current) return;
    if (settingsTimerRef.current != null) {
      window.clearTimeout(settingsTimerRef.current);
      settingsTimerRef.current = null;
    }
    const immediate = settingsImmediateRef.current;
    settingsImmediateRef.current = false;
    if (immediate) {
      doSaveSettings(settingsJson);
      return;
    }
    settingsTimerRef.current = window.setTimeout(() => {
      settingsTimerRef.current = null;
      doSaveSettings(settingsJsonRef.current);
    }, 800);
  }, [settingsJson]);

  // Prompt saving: 5s debounce after the last change (typing,
  // candidate insertion, word operations, snippet toggles all flow
  // through the same prompt state), with immediate flushes at the
  // key moments handled by flushPromptSave callers. Unchanged
  // snapshots are never written.
  useEffect(() => {
    if (!restoredRef.current) return;
    if (promptJson === lastSavedPromptRef.current) return;
    if (promptTimerRef.current != null) {
      window.clearTimeout(promptTimerRef.current);
    }
    promptTimerRef.current = window.setTimeout(() => {
      promptTimerRef.current = null;
      doSavePrompt(promptJsonRef.current);
    }, 5000);
  }, [promptJson]);

  // Flush the prompt backup when the app goes to the background.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushPromptSave();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
    // flushPromptSave works purely through refs; the first-render
    // closure stays valid for the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drop pending save timers on unmount.
  useEffect(() => {
    return () => {
      if (settingsTimerRef.current != null) {
        window.clearTimeout(settingsTimerRef.current);
      }
      if (promptTimerRef.current != null) {
        window.clearTimeout(promptTimerRef.current);
      }
    };
  }, []);

  // When the newest generation completes, the server points the
  // Editor source slot at it; refresh the slot so the Editor /
  // Inpaint image areas show the result. (latestCompletedIdRef is
  // declared with the baseline effect near the jobs memos; the
  // baseline keeps completions from before this session from
  // re-firing this.) The auto-set image does NOT change the
  // generation mode — only an upload and a user image-list
  // selection do that; a result simply appearing stays neutral.
  useEffect(() => {
    const latest = genJobs[0];
    if (!latest || latest.status !== "completed") return;
    if (latestCompletedIdRef.current === latest.id) return;
    latestCompletedIdRef.current = latest.id;
    void queryClient.invalidateQueries({ queryKey: ["editorSource"] });
  }, [genJobs, queryClient]);

  // --- Inpaint mask (App-level: survives pane switches) ---
  // The mask lives in an offscreen canvas at the source image's
  // NATURAL pixel size (never the display size); the Inpaint pane's
  // visible canvas mirrors it, laid exactly over the image's drawn
  // (object-contain) rectangle. Painted pixels are stored as opaque
  // white and the mirror renders at 50% opacity, so on screen the
  // mask is exactly two values — transparent or 50% white — with no
  // build-up where strokes overlap. When the editor_source slot is
  // replaced (upload / history transfer / image-list selection / a
  // completed generation's auto-set), the mask resets to fully
  // transparent ONLY when the new image's pixel size differs from
  // the current mask's; a same-size replacement keeps the painted
  // mask exactly as it is (the mask is a pixel grid, so it maps
  // onto the new image unchanged).
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskDisplayRef = useRef<HTMLCanvasElement | null>(null);
  const maskDrawingRef = useRef(false);
  const maskLastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [maskNatural, setMaskNatural] = useState<{ w: number; h: number } | null>(null);
  const [, setMaskVersion] = useState(0);
  // Reactive mirror of "the mask has at least one painted pixel":
  // drives the Editor mode toggle's i2i-side label ("inpaint"
  // while painted, "img2img" otherwise). Kept in step with the
  // offscreen mask canvas — set true as soon as a pen stroke
  // lands, recomputed exactly on pointer-up (an eraser pass can
  // unpaint the last pixel) and cleared whenever the mask resets
  // with the source image. Generation itself always re-checks
  // maskHasPaint() against the canvas, never this flag.
  const [maskPainted, setMaskPainted] = useState(false);
  const [inpaintBox, setInpaintBox] = useState<{ w: number; h: number } | null>(null);
  const inpaintBoxRef = useRef<HTMLDivElement | null>(null);
  // Editor image area measurement + its display-only mask mirror
  // canvas (the Editor shows the mask composited over the image;
  // painting stays Inpaint-only).
  const [editorBox, setEditorBox] = useState<{ w: number; h: number } | null>(null);
  const editorBoxRef = useRef<HTMLDivElement | null>(null);
  const editorMaskDisplayRef = useRef<HTMLCanvasElement | null>(null);
  // The same mask mirror for the prompt row's source image area
  // (drawn by the same effect as the Editor image area's).
  const sourceMaskDisplayRef = useRef<HTMLCanvasElement | null>(null);

  const editorSourceIdentity =
    editorSource.kind === "job"
      ? `job:${editorSource.jobId}`
      : editorSource.kind === "upload"
        ? `upload:${editorSource.uploadId ?? editorSource.fileName ?? ""}:${editorSource.byteSize ?? ""}`
        : "none";
  // The EDITOR image's own natural size, measured from its
  // original file (displayUrl can be the resized display JPEG).
  // The name plate describes the DISPLAYED image, so it uses
  // this — NOT maskNatural, which is the img2img SOURCE's size
  // (the two slots are independent; using the source's size for
  // the plate showed the wrong dimensions whenever the
  // displayed image differed from the source, and no size at
  // all while no source was set — keim's report, 2026-11-23).
  // The size-mismatch dot and 「画像サイズをあわせる」 are the
  // opposite: they follow the SOURCE's size (maskNatural).
  const [editorNatural, setEditorNatural] = useState<{
    w: number;
    h: number;
  } | null>(null);
  const editorNaturalIdentityRef = useRef<string | null>(null);
  useEffect(() => {
    if (editorNaturalIdentityRef.current === editorSourceIdentity) return;
    editorNaturalIdentityRef.current = editorSourceIdentity;
    const url = editorSource.imageUrl ?? editorSource.displayUrl;
    if (editorSource.kind === "none" || !url) {
      setEditorNatural(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        setEditorNatural({ w: img.naturalWidth, h: img.naturalHeight });
      }
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [editorSourceIdentity, editorSource]);
  const sourceIdentity =
    sourceImage.kind === "job"
      ? `job:${sourceImage.jobId}`
      : sourceImage.kind === "upload"
        ? `upload:${sourceImage.uploadId ?? sourceImage.fileName ?? ""}:${sourceImage.byteSize ?? ""}`
        : "none";
  const maskSourceRef = useRef<string | null>(null);
  useEffect(() => {
    if (maskSourceRef.current === sourceIdentity) return;
    maskSourceRef.current = sourceIdentity;
    maskDrawingRef.current = false;
    maskLastPointRef.current = null;
    // Size the mask from the ORIGINAL-resolution image: displayUrl
    // can be the resized display JPEG (max 1280px), whose pixel
    // size is NOT the init image's — the mask must match the init
    // image's real dimensions exactly.
    const sizingUrl = sourceImage.imageUrl ?? sourceImage.displayUrl;
    if (sourceImage.kind === "none" || !sizingUrl) {
      maskCanvasRef.current = null;
      setMaskNatural(null);
      setMaskPainted(false);
      setMaskVersion((v) => v + 1);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w <= 0 || h <= 0) return;
      const existing = maskCanvasRef.current;
      if (existing && existing.width === w && existing.height === h) {
        // Same pixel size as the image being replaced: keep the
        // painted mask (and its maskPainted mirror) untouched —
        // only the natural-size record is refreshed so the pane
        // mirrors redraw from the preserved canvas.
        setMaskNatural({ w, h });
        setMaskVersion((v) => v + 1);
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      maskCanvasRef.current = canvas;
      setMaskNatural({ w, h });
      setMaskPainted(false);
      setMaskVersion((v) => v + 1);
    };
    img.src = sizingUrl;
    return () => {
      cancelled = true;
    };
  }, [sourceIdentity, sourceImage.kind, sourceImage.imageUrl, sourceImage.displayUrl]);

  // Measure the Inpaint image area so the mask canvas can be laid
  // exactly over the image's drawn rectangle (letterboxing
  // included).
  useEffect(() => {
    if (tab !== "inpaint") return;
    const el = inpaintBoxRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setInpaintBox({ w: r.width, h: r.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [tab]);

  // Mirror the offscreen mask onto the visible canvas whenever the
  // Inpaint pane (re)mounts or the mask is (re)created.
  useEffect(() => {
    if (tab !== "inpaint") return;
    const disp = maskDisplayRef.current;
    const src = maskCanvasRef.current;
    if (!disp || !src) return;
    if (disp.width !== src.width) disp.width = src.width;
    if (disp.height !== src.height) disp.height = src.height;
    const ctx = disp.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, disp.width, disp.height);
    ctx.drawImage(src, 0, 0);
  }, [tab, maskNatural, inpaintBox]);

  // Measure the Editor image area (same letterbox math as the
  // Inpaint pane) so its display-only mask mirror can be laid
  // exactly over the image's drawn rectangle.
  useEffect(() => {
    if (tab !== "editor") return;
    const el = editorBoxRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setEditorBox({ w: r.width, h: r.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [tab]);

  // Mirror the offscreen mask onto the Editor pane's display-only
  // canvases (the image area's and the source image area's)
  // whenever the Editor (re)mounts, the mask is (re)created,
  // or the painted state flips (painting itself happens only in
  // the Inpaint pane, so returning here is what refreshes it).
  useEffect(() => {
    if (tab !== "editor") return;
    const src = maskCanvasRef.current;
    if (!src) return;
    for (const disp of [editorMaskDisplayRef.current, sourceMaskDisplayRef.current]) {
      if (!disp) continue;
      if (disp.width !== src.width) disp.width = src.width;
      if (disp.height !== src.height) disp.height = src.height;
      const ctx = disp.getContext("2d");
      if (!ctx) continue;
      ctx.clearRect(0, 0, disp.width, disp.height);
      ctx.drawImage(src, 0, 0);
    }
  }, [tab, maskNatural, editorBox, maskPainted, img2imgChecked]);

  function syncMaskDisplay() {
    const disp = maskDisplayRef.current;
    const src = maskCanvasRef.current;
    if (!disp || !src) return;
    const ctx = disp.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, disp.width, disp.height);
    ctx.drawImage(src, 0, 0);
  }

  // Pointer position on the display canvas, converted to mask
  // (natural-pixel) coordinates; `scale` is natural width / display
  // width — the brush diameter is specified in display pixels and
  // converted with this factor when drawn onto the natural-size
  // mask.
  function maskPointFromEvent(
    e: ReactPointerEvent<HTMLCanvasElement>,
  ): { x: number; y: number; scale: number } | null {
    const disp = maskDisplayRef.current;
    if (!disp) return null;
    const rect = disp.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: ((e.clientX - rect.left) / rect.width) * disp.width,
      y: ((e.clientY - rect.top) / rect.height) * disp.height,
      scale: disp.width / rect.width,
    };
  }

  function drawMaskStroke(
    from: { x: number; y: number },
    to: { x: number; y: number },
    scale: number,
  ) {
    const canvas = maskCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.lineWidth = (Number(brushSize) || 100) * scale;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (penTool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0, 0, 0, 1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "rgba(255, 255, 255, 1)";
    }
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
    // A pen stroke always leaves paint behind; the eraser case is
    // settled exactly on pointer-up (see onMaskPointerEnd).
    if (penTool !== "eraser") setMaskPainted(true);
    syncMaskDisplay();
  }

  function onMaskPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    const point = maskPointFromEvent(e);
    if (!point) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    maskDrawingRef.current = true;
    maskLastPointRef.current = point;
    // A line from the point to itself, with a round cap, paints
    // the brush circle centred on the pointer.
    drawMaskStroke(point, point, point.scale);
  }

  function onMaskPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!maskDrawingRef.current) return;
    const point = maskPointFromEvent(e);
    if (!point) return;
    const last = maskLastPointRef.current ?? point;
    // Interpolate from the previous position so a fast drag leaves
    // no gaps.
    drawMaskStroke(last, point, point.scale);
    maskLastPointRef.current = point;
  }

  function onMaskPointerEnd(e: ReactPointerEvent<HTMLCanvasElement>) {
    maskDrawingRef.current = false;
    maskLastPointRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // Exact re-check at stroke end: an eraser pass may have
    // removed the last painted pixel.
    setMaskPainted(maskHasPaint());
  }

  // Clear the whole mask back to fully transparent (the Inpaint
  // pane's round trash button): the offscreen canvas is wiped,
  // the visible mirror is re-synced, and the painted flag drops —
  // so the effective mode falls back from inpaint to img2img,
  // exactly as an eraser pass over the last pixel would leave it.
  // No confirmation: the button is the whole gesture.
  function clearMask() {
    const canvas = maskCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    maskDrawingRef.current = false;
    maskLastPointRef.current = null;
    syncMaskDisplay();
    setMaskPainted(false);
    setMaskVersion((v) => v + 1);
  }

  // True when at least one mask pixel is painted (alpha > 0).
  function maskHasPaint(): boolean {
    const canvas = maskCanvasRef.current;
    if (!canvas) return false;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) {
      if ((data[i] ?? 0) > 0) return true;
    }
    return false;
  }

  // Exports the mask as a base64 opaque binary PNG at natural size:
  // painted pixels (alpha > 0) become white (255), everything else
  // black (0) — the display's 50% white is never sent as grey.
  function exportMaskBase64(): string | null {
    const canvas = maskCanvasRef.current;
    if (!canvas) return null;
    const sctx = canvas.getContext("2d");
    if (!sctx) return null;
    const src = sctx.getImageData(0, 0, canvas.width, canvas.height);
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    const octx = out.getContext("2d");
    if (!octx) return null;
    const dst = octx.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < src.data.length; i += 4) {
      const v = (src.data[i + 3] ?? 0) > 0 ? 255 : 0;
      dst.data[i] = v;
      dst.data[i + 1] = v;
      dst.data[i + 2] = v;
      dst.data[i + 3] = 255;
    }
    octx.putImageData(dst, 0, 0);
    const url = out.toDataURL("image/png");
    return url.split(",")[1] ?? null;
  }

  // Pane switching with the prompt-flush rule: switching panes from
  // any pane saves any pending prompt change immediately (the
  // negative prompt now lives in the Parameter pane but still
  // belongs to the prompt snapshot).
  function switchTab(key: PaneKey) {
    if (key !== tab) flushPromptSave();
    // The size popup is anchored to the footer generate row, which
    // the History pane hides; never carry it across panes.
    setSizePopupOpen(false);
    setEditorPopup(null);
    // Opening the Inpaint pane always resets the drawing tool to
    // the pen (the eraser never carries over into a fresh Inpaint
    // visit). Only the tool resets — 変更範囲 / ブラー / 線幅 and
    // the painted mask itself are left exactly as they were.
    if (key === "inpaint" && key !== tab) {
      markSettingsImmediate();
      setPenTool("pen");
    }
    setTab(key);
  }

  // --- word prediction candidates for the prompt textarea ---
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const aspectCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // --- software-keyboard close detection for the prompt textarea ---
  // Closing the software keyboard does NOT blur the textarea, so the
  // blur-driven return to the default (image area) layout never
  // fires on its own. While the prompt is focused, watch the
  // viewport height instead: a large shrink marks the keyboard as
  // open, and a return to near full height while the textarea still
  // holds focus means the keyboard was closed — then do exactly
  // what a blur does (leave the prompt-focused layout AND blur the
  // textarea programmatically), so focus and layout never disagree
  // and a later tap on the textarea re-fires focus and restores the
  // focused layout. Opening the keyboard adds no switch of its own:
  // the existing focus behaviour is unchanged. Only the main prompt
  // textarea is in scope; other inputs are never watched.
  //
  // Height signal: the effective height is the smaller of
  // visualViewport.height (primary signal — it shrinks under an
  // overlay keyboard while innerHeight stays put) and
  // window.innerHeight (the one that moves in resizes-content
  // environments, and the fallback when visualViewport is absent).
  // Both resize events are listened to and feed the same check.
  const promptFullHeightRef = useRef(0);
  const promptKeyboardOpenRef = useRef(false);
  // Rotation handling: a rotation changes what "full height" is,
  // so the baseline is dropped and the watcher re-baselines in the
  // new orientation. The keyboard-open flag is PRESERVED across
  // the rotation, and the min/max heights seen since the rotation
  // let the focused check derive the new full height without ever
  // seeding it from a possibly keyboard-shrunk height.
  const promptRebaselineRef = useRef(false);
  const promptRebaseMinRef = useRef(Number.POSITIVE_INFINITY);
  const promptRebaseMaxRef = useRef(0);

  // Track the tallest viewport height seen while the prompt is NOT
  // the active element: that is the keyboard-closed full height the
  // recovery check compares against. Capturing it before focus
  // means a focus landing mid keyboard-animation cannot shrink the
  // baseline.
  useEffect(() => {
    const readHeight = () => {
      const vv = window.visualViewport?.height;
      const ih = window.innerHeight;
      return vv != null ? Math.min(vv, ih) : ih;
    };
    const track = () => {
      if (document.activeElement === promptRef.current) return;
      const h = readHeight();
      if (h > promptFullHeightRef.current) promptFullHeightRef.current = h;
    };
    track();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", track);
    window.addEventListener("resize", track);
    // A rotation changes what "full height" is: drop the baseline
    // from the old orientation and start re-baselining (the
    // keyboard-open flag is preserved — see the refs above). When
    // the prompt is not focused, re-track once the new size has
    // settled and finish the re-baseline right away; when it is
    // focused, the focused check below owns the re-baseline.
    const onOrientationChange = () => {
      promptFullHeightRef.current = 0;
      promptRebaselineRef.current = true;
      promptRebaseMinRef.current = Number.POSITIVE_INFINITY;
      promptRebaseMaxRef.current = 0;
      window.setTimeout(() => {
        track();
        if (document.activeElement !== promptRef.current) {
          promptRebaselineRef.current = false;
        }
      }, 350);
    };
    window.addEventListener("orientationchange", onOrientationChange);
    return () => {
      vv?.removeEventListener("resize", track);
      window.removeEventListener("resize", track);
      window.removeEventListener("orientationchange", onOrientationChange);
    };
  }, []);

  useEffect(() => {
    if (!promptFocused) {
      promptKeyboardOpenRef.current = false;
      return;
    }
    const readHeight = () => {
      const vv = window.visualViewport?.height;
      const ih = window.innerHeight;
      return vv != null ? Math.min(vv, ih) : ih;
    };
    // Focus fires before the keyboard opens, so the height at
    // effect time is still near full: raise (never lower) the
    // baseline from it as a fallback for a missing tracked value.
    // Skipped while re-baselining after a rotation, where the
    // current height may be a keyboard-shrunk one.
    const initial = readHeight();
    if (
      !promptRebaselineRef.current &&
      initial > promptFullHeightRef.current
    ) {
      promptFullHeightRef.current = initial;
    }
    const check = () => {
      // Only while the main prompt textarea itself holds focus
      // (focus parked in the auxiliary panel is out of scope).
      if (document.activeElement !== promptRef.current) return;
      if (promptRebaselineRef.current) {
        // Re-baselining after a rotation: collect the heights of
        // the new orientation without seeding the baseline from
        // any single one of them.
        const h = readHeight();
        if (h < promptRebaseMinRef.current) promptRebaseMinRef.current = h;
        if (h > promptRebaseMaxRef.current) promptRebaseMaxRef.current = h;
        if (promptKeyboardOpenRef.current) {
          // The keyboard was open across the rotation: a large
          // rise from the post-rotation minimum is the keyboard
          // closing in the new orientation — adopt the risen
          // height as the new full height and run the usual
          // switch + blur.
          const rise = h - promptRebaseMinRef.current;
          if (
            rise >= 120 &&
            promptRebaseMaxRef.current > 0 &&
            rise >= promptRebaseMaxRef.current * 0.15
          ) {
            promptFullHeightRef.current = h;
            promptRebaselineRef.current = false;
            promptKeyboardOpenRef.current = false;
            setPromptFocused(false);
            promptRef.current?.blur();
          }
          return;
        }
        // The keyboard was not open at rotation: the tallest
        // height seen since is the new full height.
        promptFullHeightRef.current = promptRebaseMaxRef.current;
        promptRebaselineRef.current = false;
        return;
      }
      const full = promptFullHeightRef.current;
      if (full <= 0) return;
      const shrink = full - readHeight();
      if (!promptKeyboardOpenRef.current) {
        // Keyboard open: the height shrank well beyond
        // address-bar-scale wobble — require both an absolute and
        // a relative shrink so small chrome height changes can
        // never mark the keyboard as open.
        if (shrink >= 120 && shrink >= full * 0.15) {
          promptKeyboardOpenRef.current = true;
        }
        return;
      }
      // Keyboard closed: the height recovered to near full (a
      // small tolerance covers address-bar / chrome differences
      // between the open and closed states).
      const tolerance = Math.max(48, full * 0.06);
      if (shrink <= tolerance) {
        promptKeyboardOpenRef.current = false;
        setPromptFocused(false);
        promptRef.current?.blur();
      }
    };
    const vv = window.visualViewport;
    vv?.addEventListener("resize", check);
    window.addEventListener("resize", check);
    // Run once in case the keyboard is already open by the time
    // this effect lands, so the open state is marked immediately.
    check();
    return () => {
      vv?.removeEventListener("resize", check);
      window.removeEventListener("resize", check);
    };
  }, [promptFocused]);

  // Aspect preview canvas (size popup): redrawn whenever the popup
  // is open and the selection or the dimensions change — aspect,
  // pixel-count and block-size changes all funnel into the
  // sizeKey / width / height state, mirroring the original's
  // _renderAspectPreview call sites. With no aspect selection the
  // ratio comes from the hand-entered width/height and no ratio
  // label is drawn.
  useEffect(() => {
    if (!sizePopupOpen) return;
    const canvas = aspectCanvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const w = Number(width);
      const h = Number(height);
      const dimsValid =
        Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
      if (sizeKey == null) {
        drawAspectPreview(
          canvas,
          dimsValid ? w : Number.NaN,
          dimsValid ? h : Number.NaN,
          "",
          dimsValid ? w : null,
          dimsValid ? h : null,
        );
        return;
      }
      const parts = sizeKey.split(":");
      drawAspectPreview(
        canvas,
        Number(parts[0]),
        Number(parts[1]),
        sizeKey,
        dimsValid ? w : null,
        dimsValid ? h : null,
      );
    };
    draw();
    // The popup can be opened while the software keyboard is up
    // (from the prompt-focused layout); when the keyboard then
    // closes, the viewport height — and with it the dvh-based grid
    // width and this canvas's CSS size — changes AFTER the first
    // draw, leaving the bitmap sized for the old box and the
    // preview stretched / misplaced. Redraw whenever the canvas's
    // laid-out size changes so the preview follows the viewport
    // before and after the keyboard transition. (Setting the
    // bitmap size inside drawAspectPreview does not change the
    // CSS size, so this cannot loop.)
    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [sizePopupOpen, sizeKey, width, height]);
  const [cursorPos, setCursorPos] = useState(0);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  // Port of CandidateOperations._candidateList / _currentWord: the
  // sorted candidate pool of the last context word that was found in
  // the dictionary, kept so a partially typed word can filter it by
  // prefix. The cache is dropped whenever the dictionary is reloaded.
  const candidateCacheRef = useRef<Record<string, Candidate[] | null>>({});
  const currentContextRef = useRef<string>("__first__");
  useEffect(() => {
    candidateCacheRef.current = {};
    currentContextRef.current = "__first__";
  }, [dictionary]);

  // Port of CandidateOperations.getCandidates.
  function getCandidates(targetText: string): Candidate[] {
    const scores = dictionary[targetText];
    if (!scores) {
      // Not in the dictionary (word being typed): filter the retained
      // current list by prefix.
      const current = currentContextRef.current;
      let list = candidateCacheRef.current[current];
      if (list == null) {
        const currentScores = dictionary[current];
        if (!currentScores) return [];
        list = Object.keys(currentScores)
          .map((word) => ({ word, score: currentScores[word] ?? 0 }))
          .sort((a, b) => b.score - a.score);
        candidateCacheRef.current[current] = list;
      }
      return list.filter((item) => item.word.startsWith(targetText));
    }
    currentContextRef.current = targetText;
    if (!candidateCacheRef.current[targetText]) {
      candidateCacheRef.current[targetText] = Object.keys(scores)
        .map((word) => ({ word, score: scores[word] ?? 0 }))
        .sort((a, b) => b.score - a.score);
    }
    return candidateCacheRef.current[targetText] ?? [];
  }

  // Port of CandidateOperations.show: derive the current word from the
  // cursor position and refresh the candidate buttons.
  useEffect(() => {
    const cursor = matchWordAtPosition(prompt, cursorPos, -1);
    if (!cursor) {
      setCandidates([]);
      return;
    }
    let targetText = prompt.substring(cursor.start, cursor.end).trim().toLowerCase();
    if (targetText === "") targetText = "__first__";
    setCandidates(getCandidates(targetText).slice(0, 6));
    // getCandidates reads refs + dictionary; prompt/cursorPos drive it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt, cursorPos, dictionary]);

  // --- word operations (port of SD WebUI Mobile Plus WordOperations,
  // wired like responsive_design.js's sspp-prevword / sspp-currword /
  // sspp-nextword / sspp-parentheses / sspp-ratedown / sspp-rateup) ---
  // Selection of the prompt textarea, mirrored in state because the
  // toolbar buttons take focus on click. wordSelectMode is the panel's
  // "word-select" class: while ON, prev/next extend the selection
  // instead of moving it.
  const [selStart, setSelStart] = useState(0);
  const [selEnd, setSelEnd] = useState(0);
  const [wordSelectMode, setWordSelectMode] = useState(false);

  // Sets the textarea selection (after any pending re-render), keeps
  // focus in the textarea like the original's textArea.focus() calls,
  // and points cursorPos at the selection start so the candidate row
  // refreshes for the new context (the original's candOps.show()).
  function focusPrompt(start: number, end: number) {
    setSelStart(start);
    setSelEnd(end);
    setCursorPos(start);
    requestAnimationFrame(() => {
      const el = promptRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(start, end);
      }
    });
  }

  // Undo: when the current text carries unrecorded changes, record
  // the current value first so Redo can return to it, then step one
  // entry back. Redo steps one entry forward. Restoring goes through
  // focusPrompt, so the selection / cursorPos state (and with it the
  // candidate row) follows the restored text; the caret lands at the
  // end of the restored text.
  function onUndo() {
    let { entries, index } = undoState;
    if (index >= 0 && prompt !== entries[index]) {
      entries = [...entries.slice(0, index + 1), prompt];
      while (entries.length > 10) entries.shift();
      index = entries.length - 1;
    }
    if (index <= 0) return;
    index -= 1;
    const value = entries[index] ?? "";
    setUndoState({ entries, index });
    setPrompt(value);
    focusPrompt(value.length, value.length);
  }

  function onRedo() {
    const { entries, index } = undoState;
    if (index >= entries.length - 1) return;
    const value = entries[index + 1] ?? "";
    setUndoState({ entries, index: index + 1 });
    setPrompt(value);
    focusPrompt(value.length, value.length);
  }

  const canUndo =
    undoState.index > 0 ||
    (undoState.index >= 0 && prompt !== undoState.entries[undoState.index]);
  const canRedo = undoState.index < undoState.entries.length - 1;

  // Port of WordOperations._selectCurrentWord.
  function selectCurrentWordRange(): { start: number; end: number } {
    const cursor = matchWordAtPosition(prompt, selStart);
    return cursor ?? { start: selStart, end: selEnd };
  }

  // sspp-currword: selectWord(panel has "word-select"), then toggle the
  // class. OFF→ON selects the word at the cursor; ON→OFF collapses the
  // selection to its start (WordOperations._unselectWord).
  function onToggleSelectWord() {
    if (wordSelectMode) {
      focusPrompt(selStart, selStart);
    } else {
      const range = selectCurrentWordRange();
      focusPrompt(range.start, range.end);
    }
    setWordSelectMode(!wordSelectMode);
  }

  // sspp-prevword: selectPrevWord(hold) — hold extends the selection
  // start to the previous word's start; otherwise the selection moves
  // to the previous word.
  function onSelectPrevWord() {
    const cursor = matchWordAtPosition(prompt, selStart, -1);
    if (cursor) {
      focusPrompt(cursor.start, wordSelectMode ? selEnd : cursor.end);
    } else {
      focusPrompt(selStart, selEnd);
    }
  }

  // sspp-nextword: selectNextWord(hold) — hold extends the selection
  // end to the next word's end; otherwise the selection moves to the
  // next word.
  function onSelectNextWord() {
    const cursor = matchWordAtPosition(prompt, selEnd, 1);
    if (cursor) {
      focusPrompt(wordSelectMode ? selStart : cursor.start, cursor.end);
    } else {
      focusPrompt(selStart, selEnd);
    }
  }

  // sspp-parentheses: WordOperations.emphasize — toggles () around the
  // selection (selecting the current word first when nothing is
  // selected), stripping existing emphasis marks inside and cleaning
  // up parenthesis fragments around it with the original regexes.
  function onEmphasize() {
    let s = selStart;
    let e = selEnd;
    if (s === e) {
      const range = selectCurrentWordRange();
      s = range.start;
      e = range.end;
    }
    const before = prompt.substring(0, s);
    const content = prompt.substring(s, e);
    const after = prompt.substring(e);
    const contentR = content.replace(/[<>()]|:\s*[\d.]+/g, "");
    const newBefore = before.replace(/^(.*)\((?!.*[)>])([^(]*)$/s, "$1$2");
    const newContent = /^\([^<>()]*\)$/s.test(content) ? contentR : `(${contentR})`;
    const newAfter = after.replace(/^([^<(]*?)[:.\d\s]*\)(.*)$/s, "$1$2");
    const next = newBefore + newContent + newAfter;
    setPrompt(next);
    recordHistory(next);
    focusPrompt(newBefore.length, newBefore.length + newContent.length);
  }

  // sspp-ratedown / sspp-rateup: WordOperations.changeRate — selects
  // the current word, then adjusts the number of the first ":n)" match
  // after the selection start by ±0.1 (floor 0, one decimal; a missing
  // number counts as 1.1 before the gain). The rewritten ":n" part
  // ends up selected.
  function onChangeRate(rateGain: number) {
    const range = selectCurrentWordRange();
    const before = prompt.substring(0, range.start);
    const after = prompt.substring(range.start);
    const match = after.match(/:?(\s*)([\d.]+)?(\s*\))/);
    if (!match) {
      // No ":n)" ahead: nothing changes, but the original's
      // _selectCurrentWord has already applied, so keep that selection.
      focusPrompt(range.start, range.end);
      return;
    }
    const idx = match.index ?? 0;
    const numPart = match[2];
    const rate = (numPart ? parseFloat(numPart) || 0 : 1.1) + rateGain;
    const rateText = `:${match[1] ?? ""}${rate < 0 ? 0 : rate.toFixed(1)}`;
    const newAfter =
      after.slice(0, idx) +
      rateText +
      (match[3] ?? "") +
      after.slice(idx + (match[0]?.length ?? 0));
    const next = before + newAfter;
    setPrompt(next);
    recordHistory(next);
    const start = before.length + idx;
    focusPrompt(start, start + rateText.length);
  }

  // Port of CandidateOperations.onClickCandidate.
  function onClickCandidate(word: string) {
    const textArea = promptRef.current;
    if (!textArea) return;
    const selEnd = textArea.selectionEnd ?? cursorPos;
    const cursor = matchWordAtPosition(prompt, selEnd, -1) ?? {
      start: selEnd,
      end: selEnd,
    };
    const targetText = prompt.substring(cursor.start, cursor.end).trim().toLowerCase();
    const before = prompt.substring(
      0,
      cursor.end - (word.startsWith(targetText) ? targetText.length : 0),
    );
    const after = prompt.substring(cursor.end);
    let insertWord = word;
    if (before && !/\s$/.test(before)) insertWord = ` ${insertWord}`;
    if (after && !/^\s/.test(after)) insertWord = `${insertWord} `;
    const pos = before.length + insertWord.length;
    const next = before + insertWord + after;
    setPrompt(next);
    recordHistory(next);
    setCursorPos(pos);
    setSelStart(pos);
    setSelEnd(pos);
    requestAnimationFrame(() => {
      const el = promptRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
      }
    });
  }

  const selected = useMemo(
    () => genJobs.find((j) => j.id === selectedId) ?? null,
    [genJobs, selectedId],
  );

  const isDeletable = (j: Job) => j.status === "completed" || j.status === "failed";
  const deletableJobs = useMemo(() => history.filter(isDeletable), [history]);
  const allDeletableSelected =
    deletableJobs.length > 0 && deletableJobs.every((j) => checkedIds.includes(j.id));

  // Prune selections that are no longer present or no longer deletable.
  useEffect(() => {
    setCheckedIds((prev) => {
      const allowed = new Set(deletableJobs.map((j) => j.id));
      const next = prev.filter((id) => allowed.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [deletableJobs]);

  function toggleChecked(id: number, checked: boolean) {
    setCheckedIds((prev) =>
      checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id),
    );
  }

  function toggleSelectAll() {
    if (allDeletableSelected) {
      setCheckedIds([]);
    } else {
      setCheckedIds(deletableJobs.map((j) => j.id));
    }
  }

  // Applies one model's parameter record to the live form (the
  // startup restore, model switching, and the reset button all
  // go through here).
  function applySettingsRecord(nextSettings: SettingsSnapshot) {
    setPromptTemplate(nextSettings.promptTemplate);
    setTemplateDraft(nextSettings.promptTemplate);
    setTemplateValues(nextSettings.templateValues);
    setSizeKey(nextSettings.sizeKey);
    setWidth(nextSettings.width);
    setHeight(nextSettings.height);
    setPixelSize(nextSettings.pixelSize);
    setBlockSize(nextSettings.blockSize);
    setSeedMode(nextSettings.seedMode);
    setSeedText(nextSettings.seedText);
    setSteps(nextSettings.steps);
    setCfg(nextSettings.cfg);
    setSampler(nextSettings.sampler);
    setScheduler(nextSettings.scheduler);
    setImg2imgChecked(nextSettings.img2imgChecked);
    setEditorDenoise(nextSettings.denoisingStrength);
    setResizeMode(nextSettings.resizeMode);
    setMaskMode(nextSettings.maskMode);
    setMaskBlur(nextSettings.maskBlur);
    setBrushSize(nextSettings.brushSize);
    setPenTool(nextSettings.penTool === "eraser" ? "eraser" : "pen");
    setRestoreAfterwards(nextSettings.restoreAfterwards);
    setInpaintingFill(nextSettings.inpaintingFill);
    setInpaintFullRes(nextSettings.inpaintFullRes);
    setInpaintFullResPadding(nextSettings.inpaintFullResPadding);
  }

  function applyModel(key: ModelKey) {
    markSettingsImmediate();
    if (key === model) return;
    // Parameters are remembered per model (2026-11-23): stash the
    // live form as the outgoing model's record, then restore the
    // incoming model's last-used record — its defaults on first
    // use. (This replaces the old behavior of reseeding the
    // recipe + style presets on every selection; those presets
    // now live in defaultSettingsFor.)
    setByModel((prev) => ({ ...prev, [model]: liveSnapshot }));
    setModel(key);
    applySettingsRecord(byModel[key] ?? defaultSettingsFor(key));
  }

  // The Parameter pane's reset button: the selected model's
  // parameters back to its defaults. Other models' records are
  // untouched.
  function resetModelSettings() {
    markSettingsImmediate();
    applySettingsRecord(defaultSettingsFor(model));
  }

  // The template editor's save button: commit the draft as the
  // model's template. A changed template redefines the numeric
  // parameters, so their values reset to the new template's
  // defaults (keim's rule, 2026-11-23); every other parameter is
  // untouched.
  function savePromptTemplate() {
    if (templateDraft === promptTemplate) {
      flushSettingsSave();
      return;
    }
    markSettingsImmediate();
    setPromptTemplate(templateDraft);
    setTemplateValues(templateParamDefaults(templateDraft));
  }

  // Recalculates width/height from (aspect ratio × pixel size ×
  // block size) for a preset size key, using the current pixel/block
  // values unless overridden. An invalid block size leaves the
  // dimensions untouched (the original's guard).
  function recalcSize(
    key: string,
    pixel: number = pixelSize ?? DEFAULT_PIXEL_SIZE,
    block: string = blockSize,
  ) {
    const result = calculateAspectSize(key, pixel, block);
    if (!result) return;
    setWidth(String(result.w));
    setHeight(String(result.h));
  }

  function applySize(key: string) {
    markSettingsImmediate();
    setSizeKey(key);
    // When both selections were cleared by a hand edit, an aspect
    // click also selects the default pixel count (1280p) so the
    // dimensions can be recalculated.
    const pixel = pixelSize ?? DEFAULT_PIXEL_SIZE;
    if (pixelSize == null) setPixelSize(pixel);
    recalcSize(key, pixel, blockSize);
  }

  function applyPixelSize(pixel: number) {
    markSettingsImmediate();
    setPixelSize(pixel);
    // When both selections were cleared by a hand edit, a
    // pixel-count click also selects 1:1 so the dimensions can be
    // recalculated.
    const key = sizeKey ?? "1:1";
    if (sizeKey == null) setSizeKey(key);
    recalcSize(key, pixel, blockSize);
  }

  // 「画像サイズをあわせる」 (bottom row of the size popup): sets
  // the form's width/height to the SOURCE image's own pixel
  // size (maskNatural), verbatim — the size an img2img run
  // starts from. Like a hand edit of the dimension inputs, both
  // the aspect-ratio and pixel-count selections are cleared.
  // The button is enabled only while sizeMismatch holds, so
  // maskNatural is always set here.
  function applyImageSize() {
    if (maskNatural == null) return;
    markSettingsImmediate();
    setWidth(String(maskNatural.w));
    setHeight(String(maskNatural.h));
    setSizeKey(null);
    setPixelSize(null);
  }

  // Block size edits only update the text while typing; the
  // width/height recalculation happens when the value is committed
  // (the input loses focus), not on every keystroke.
  function onBlockSizeChange(value: string) {
    setBlockSize(value);
  }

  function onBlockSizeBlur() {
    flushSettingsSave();
    if (sizeKey != null && pixelSize != null) {
      recalcSize(sizeKey, pixelSize, blockSize);
    }
  }

  const createJob = useMutation({
    // Hard response timeout, same discipline as deleteJobs: if the
    // create request never settles (lost response / wedged
    // connection), the mutation must still settle as an error.
    // Without this the Generate button — disabled purely by
    // isPending — stayed disabled forever with the idle 「生成」
    // label (the label only reflects jobs in the list), so a lost
    // request looked exactly like "generation never started".
    // The limit is per path: 30s for the normal path (far beyond
    // its ~1s round trip: insert + the detached startSdJob spawn),
    // and 90s for inpaint, whose legitimate server-side work is
    // the mask upload plus the privileged writeMaskImage call
    // (60s contract) before the job can start. A job that actually
    // landed server-side despite the lost response is reconciled
    // by the onSettled list refetches: it appears as an active job
    // and the label switches to 「生成中...」 on its own.
    mutationFn: async (args: GenerationArgs) => {
      const isInpaint =
        typeof args.payload.mask === "string" && args.payload.mask !== "";
      let timer: number | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(
          () => reject(new Error("create-timeout")),
          isInpaint ? 90000 : 30000,
        );
      });
      try {
        return await Promise.race([api.createJob(args), timeout]);
      } finally {
        window.clearTimeout(timer);
      }
    },
    onSuccess: (res) => {
      // The server learned this prompt into the dictionary; reload it so
      // the new scores are reflected in the candidates.
      void queryClient.invalidateQueries({ queryKey: ["wordDictionary"] });
      if (!res.ok) {
        setFormError(res.error ?? "ジョブを開始できませんでした。");
      }
    },
    onError: (error) => {
      setFormError(
        error instanceof Error && error.message === "create-timeout"
          ? "生成開始の応答がタイムアウトしました。開始されている場合は、表示が「生成中...」に変わります。"
          : "ジョブを開始できませんでした。通信状態を確認してください。",
      );
    },
    // Success, failure, or timeout: always refetch the job list, so
    // a job whose response was lost still shows up (and takes over
    // the button label) instead of leaving the screen wedged. On a
    // timeout, refetch again at 15s, 30s and 60s: an inpaint
    // request still uploading its mask (or waiting on the mask
    // write) when the timer fired lands on the server afterwards,
    // and the immediate refetch alone would miss it (no active job
    // in the list means no polling loop runs). As soon as one of
    // these refetches lists the job as active (queued/running),
    // the normal polling takes over on its own — the list poll and
    // pollGenerationJob both key off the active jobs in the list —
    // so the run is followed through 生成中表示 to completion.
    onSettled: (_data, error) => {
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      if (error instanceof Error && error.message === "create-timeout") {
        for (const delay of [15000, 30000, 60000]) {
          window.setTimeout(() => {
            void queryClient.invalidateQueries({ queryKey: ["jobs"] });
          }, delay);
        }
      }
    },
  });

  const deleteJobs = useMutation({
    // Hard response timeout: if the delete request never settles
    // (wedged connection / server), the mutation must still settle
    // as an error so the confirmation dialog closes and the user
    // returns to the list instead of being stuck on 「削除中…」
    // forever. A delete that actually landed server-side despite
    // the timeout is reconciled by the onSettled list refetch.
    mutationFn: async (jobIds: number[]) => {
      let timer: number | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(
          () => reject(new Error("delete-timeout")),
          20000,
        );
      });
      try {
        return await Promise.race([api.deleteJobs({ jobIds }), timeout]);
      } finally {
        window.clearTimeout(timer);
      }
    },
    onSuccess: (res, variables) => {
      setDeleteError(null);
      setCheckedIds([]);
      if (selectedId != null && variables.includes(selectedId)) {
        setSelectedId(null);
      }
      if (
        res.ok &&
        editorSource.kind === "job" &&
        editorSource.jobId != null &&
        variables.includes(editorSource.jobId)
      ) {
        // The job the Editor was showing is gone: the image is
        // unset. The mode toggle is left as the user set it.
      }
      if (!res.ok) {
        setDeleteError("削除できませんでした。");
      }
    },
    onError: (error) => {
      setDeleteError(
        error instanceof Error && error.message === "delete-timeout"
          ? "削除の応答がタイムアウトしました。一覧を再読み込みして、削除されたか確認してください。"
          : "削除できませんでした。通信状態を確認してください。",
      );
    },
    // Success, failure, or timeout: the dialog ALWAYS closes and
    // the list ALWAYS refetches, so the UI can never wedge on the
    // confirmation popup.
    onSettled: () => {
      setShowDeleteConfirm(false);
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      // If the deleted set included the job the Editor is
      // showing, the slot must re-read as unset.
      void queryClient.invalidateQueries({ queryKey: ["editorSource"] });
    },
  });

  // Editor image-area delete: deletes the ONE generated job whose
  // image the Editor currently shows, through the same deleteJobs
  // action (and the same 20s response-timeout discipline) as the
  // history selection delete — job row + image blobs are removed
  // server-side, generation_stats rows are kept. Afterwards the
  // Editor loads the NEXT image from the MERGED preview list
  // (outputs + uploads interleaved by time, newest first — the
  // list the Editor's side column shows): the image that slid
  // into the deleted job's position — the one immediately after
  // it in the merged list — or, when the deleted job was the
  // list's last image, the new last one (the one immediately
  // before it). The next image may be an upload; it is set
  // through the upload route just the same. Loading it goes
  // through the same source-setting routes (setEditorSourceFromJob /
  // setEditorSourceFromUpload) but WITHOUT the user-selection
  // mode switch: it is an automatic load, not an image-list tap,
  // so the generation mode is NOT changed and the usual
  // source-replacement side effects (mask reset on a size
  // change; a same-size replacement keeps the mask) apply. Only
  // when no image remains does
  // the Editor return to the unset state and the mode toggle to
  // the txt2img side. Any history selection pointing at the
  // deleted job is dropped either way.
  // (The × clear button and the History pane's selection delete
  // do NOT load a next image: they leave the Editor unset.)
  // The next image is resolved from the merged list as it stands
  // BEFORE the delete: the first loadable image after the given
  // job — it slides into the deleted job's position — else the
  // nearest loadable one before it (the new last image when the
  // deleted job was the list's last). Jobs that cannot be set as
  // the Editor image at all (canSendToEditor false) are skipped;
  // uploads are always settable; null when no image remains.
  type NextEditorImage =
    | { kind: "job"; jobId: number }
    | { kind: "upload"; uploadId: number }
    | null;

  function nextEditorImage(jobId: number): NextEditorImage {
    const idx = mergedPreview.findIndex(
      (item) => item.kind === "job" && item.job.id === jobId,
    );
    if (idx < 0) return null;
    const candidates = [
      ...mergedPreview.slice(idx + 1),
      ...mergedPreview.slice(0, idx).reverse(),
    ];
    for (const item of candidates) {
      if (item.kind === "upload") {
        return { kind: "upload", uploadId: item.upload.id };
      }
      if (item.job.canSendToEditor) {
        return { kind: "job", jobId: item.job.id };
      }
    }
    return null;
  }

  // The same next-image resolution for the Editor image-area
  // delete of an UPLOAD: the deleted upload's position in the
  // merged list is the anchor, and the next image may be a job
  // just as well as another upload.
  function nextEditorImageForUpload(uploadId: number): NextEditorImage {
    const idx = mergedPreview.findIndex(
      (item) => item.kind === "upload" && item.upload.id === uploadId,
    );
    if (idx < 0) return null;
    const candidates = [
      ...mergedPreview.slice(idx + 1),
      ...mergedPreview.slice(0, idx).reverse(),
    ];
    for (const item of candidates) {
      if (item.kind === "upload") {
        return { kind: "upload", uploadId: item.upload.id };
      }
      if (item.job.canSendToEditor) {
        return { kind: "job", jobId: item.job.id };
      }
    }
    return null;
  }

  const deleteEditorJob = useMutation({
    mutationFn: async (vars: { jobId: number; next: NextEditorImage }) => {
      let timer: number | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(
          () => reject(new Error("delete-timeout")),
          20000,
        );
      });
      try {
        return await Promise.race([api.deleteJobs({ jobIds: [vars.jobId] }), timeout]);
      } finally {
        window.clearTimeout(timer);
      }
    },
    onSuccess: (res, vars) => {
      const jobId = vars.jobId;
      if (!res.ok || res.deleted === 0) {
        setUploadError("削除できませんでした。");
        return;
      }
      setUploadError(null);
      setCheckedIds((prev) => prev.filter((id) => id !== jobId));
      if (selectedId === jobId) {
        setSelectedId(null);
      }
      if (vars.next != null) {
        // Automatic load: the mode toggle keeps its side, as
        // always. The next image in the merged list may be an
        // upload — it is set through the upload route just the
        // same.
        if (vars.next.kind === "job") {
          setSourceFromJob.mutate({ jobId: vars.next.jobId });
        } else {
          setSourceFromUpload.mutate({ uploadId: vars.next.uploadId });
        }
      }
      // No image remains: the Editor simply shows nothing; the
      // mode toggle is left as the user set it.
    },
    onError: (error) => {
      setUploadError(
        error instanceof Error && error.message === "delete-timeout"
          ? "削除の応答がタイムアウトしました。履歴を再読み込みして、削除されたか確認してください。"
          : "削除できませんでした。通信状態を確認してください。",
      );
    },
    onSettled: () => {
      setShowEditorDeleteConfirm(false);
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["editorSource"] });
    },
  });

  // Editor image-area delete of an UPLOAD image: the upload
  // record is removed as a set (record + blobs + host file) via
  // deleteUploadImage — the server also clears the Editor slot,
  // which points at it — and afterwards the Editor loads the
  // NEXT image from the merged preview list, exactly like the
  // job delete above (an automatic load: the generation mode is
  // NOT changed; only when no image remains does the mode
  // toggle return to the txt2img side). This differs from the
  // History pane's upload delete, which simply unsets the
  // Editor. Same 20s response-timeout discipline.
  const deleteEditorUpload = useMutation({
    mutationFn: async (vars: { uploadId: number; next: NextEditorImage }) => {
      let timer: number | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(
          () => reject(new Error("delete-timeout")),
          20000,
        );
      });
      try {
        return await Promise.race([
          api.deleteUploadImage({ uploadId: vars.uploadId }),
          timeout,
        ]);
      } finally {
        window.clearTimeout(timer);
      }
    },
    onSuccess: (res, vars) => {
      if (!res.ok || res.deleted === 0) {
        setUploadError("削除できませんでした。");
        return;
      }
      setUploadError(null);
      if (selectedUploadId === vars.uploadId) {
        setSelectedUploadId(null);
      }
      if (vars.next != null) {
        // Automatic load (no mode switch), same as the job
        // delete: the next image in the merged list may be a
        // job — it is set through the job route just the same.
        if (vars.next.kind === "job") {
          setSourceFromJob.mutate({ jobId: vars.next.jobId });
        } else {
          setSourceFromUpload.mutate({ uploadId: vars.next.uploadId });
        }
      }
      // No image remains: the Editor simply shows nothing; the
      // mode toggle is left as the user set it.
    },
    onError: (error) => {
      setUploadError(
        error instanceof Error && error.message === "delete-timeout"
          ? "削除の応答がタイムアウトしました。履歴を再読み込みして、削除されたか確認してください。"
          : "削除できませんでした。通信状態を確認してください。",
      );
    },
    onSettled: () => {
      setShowEditorDeleteConfirm(false);
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["uploadImages"] });
      void queryClient.invalidateQueries({ queryKey: ["editorSource"] });
    },
  });

  // Save a generation job's image into the saved-image area
  // (saveJobImage): the server claims the next save-counter value,
  // copies the original PNG into a dedicated blob, and records it
  // under "{counter}-{seed}". Used by both save buttons — the
  // Editor image area's bottom-right button and the History
  // detail's button next to the PNG download. Same response-timeout
  // discipline as the deletes (the server re-reads a multi-megabyte
  // PNG from the host, so the budget is longer: 60s); a save that
  // landed despite a timeout shows up in the saved list on the
  // onSettled refetch.
  const saveImage = useMutation({
    mutationFn: async (jobId: number) => {
      let timer: number | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(
          () => reject(new Error("save-timeout")),
          60000,
        );
      });
      try {
        return await Promise.race([api.saveJobImage({ jobId }), timeout]);
      } finally {
        window.clearTimeout(timer);
      }
    },
    onSuccess: (res) => {
      if (res.ok && res.name != null) {
        setSaveError(null);
        setSaveNotice(`保存しました：${res.name}`);
      } else {
        setSaveNotice(null);
        setSaveError(res.error ?? "保存できませんでした。");
      }
    },
    onError: (error) => {
      setSaveNotice(null);
      setSaveError(
        error instanceof Error && error.message === "save-timeout"
          ? "保存の応答がタイムアウトしました。保存タブの一覧を再読み込みして、保存されたか確認してください。"
          : "保存できませんでした。通信状態を確認してください。",
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["savedImages"] });
    },
  });

  // Saved-image selection delete: the same shape as deleteJobs
  // (20s response timeout, dialog always closes, list always
  // refetches) against deleteSavedImages. Only the saved copies
  // are removed; the source jobs are never touched.
  const deleteSaved = useMutation({
    mutationFn: async (ids: number[]) => {
      let timer: number | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(
          () => reject(new Error("delete-timeout")),
          20000,
        );
      });
      try {
        return await Promise.race([api.deleteSavedImages({ ids }), timeout]);
      } finally {
        window.clearTimeout(timer);
      }
    },
    onSuccess: (res, variables) => {
      setSavedDeleteError(null);
      setCheckedSavedIds([]);
      if (selectedSavedId != null && variables.includes(selectedSavedId)) {
        setSelectedSavedId(null);
      }
      if (!res.ok) {
        setSavedDeleteError("削除できませんでした。");
      }
    },
    onError: (error) => {
      setSavedDeleteError(
        error instanceof Error && error.message === "delete-timeout"
          ? "削除の応答がタイムアウトしました。一覧を再読み込みして、削除されたか確認してください。"
          : "削除できませんでした。通信状態を確認してください。",
      );
    },
    onSettled: () => {
      setShowSavedDeleteConfirm(false);
      void queryClient.invalidateQueries({ queryKey: ["savedImages"] });
    },
  });

  // Save an upload-library image into the saved-image area
  // (saveUploadImage): the same counter mechanism as saveJobImage,
  // with the seed fixed at 0 — the assigned name is
  // "{counter}-0". Shares the save feedback state with saveImage.
  const saveUpload = useMutation({
    mutationFn: async (uploadId: number) => {
      let timer: number | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(
          () => reject(new Error("save-timeout")),
          60000,
        );
      });
      try {
        return await Promise.race([api.saveUploadImage({ uploadId }), timeout]);
      } finally {
        window.clearTimeout(timer);
      }
    },
    onSuccess: (res) => {
      if (res.ok && res.name != null) {
        setSaveError(null);
        setSaveNotice(`保存しました：${res.name}`);
      } else {
        setSaveNotice(null);
        setSaveError(res.error ?? "保存できませんでした。");
      }
    },
    onError: (error) => {
      setSaveNotice(null);
      setSaveError(
        error instanceof Error && error.message === "save-timeout"
          ? "保存の応答がタイムアウトしました。保存タブの一覧を再読み込みして、保存されたか確認してください。"
          : "保存できませんでした。通信状態を確認してください。",
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["savedImages"] });
    },
  });

  // Upload-library delete (History 「アップロード」 tab detail):
  // one action removes the record, its blobs and its host file
  // server-side, and clears the Editor slot when the deleted
  // upload was the current source. Same 20s response-timeout
  // discipline as the other deletes; the dialog always closes
  // and the lists always refetch on settle.
  const deleteUpload = useMutation({
    mutationFn: async (uploadId: number) => {
      let timer: number | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(
          () => reject(new Error("delete-timeout")),
          20000,
        );
      });
      try {
        return await Promise.race([api.deleteUploadImage({ uploadId }), timeout]);
      } finally {
        window.clearTimeout(timer);
      }
    },
    onSuccess: (res, variables) => {
      if (!res.ok || res.deleted === 0) {
        setUploadDeleteError("削除できませんでした。");
        return;
      }
      setUploadDeleteError(null);
      if (selectedUploadId === variables) {
        setSelectedUploadId(null);
      }
      if (
        editorSource.kind === "upload" &&
        editorSource.uploadId === variables
      ) {
        // The Editor's current image is gone (the server
        // cleared the slot as well). The mode toggle is left
        // as the user set it.
      }
    },
    onError: (error) => {
      setUploadDeleteError(
        error instanceof Error && error.message === "delete-timeout"
          ? "削除の応答がタイムアウトしました。一覧を再読み込みして、削除されたか確認してください。"
          : "削除できませんでした。通信状態を確認してください。",
      );
    },
    onSettled: () => {
      setShowUploadDeleteConfirm(false);
      void queryClient.invalidateQueries({ queryKey: ["uploadImages"] });
      void queryClient.invalidateQueries({ queryKey: ["editorSource"] });
    },
  });

  // Upload-library bulk delete (History 「アップロード」 tab):
  // deleteUploadImage is a single-record action, so the bulk
  // delete calls it once per checked record, sequentially; the
  // server removes each record + blobs + host file and clears
  // any slot pointing at it. Same timeout discipline as the
  // other deletes (one 60s budget for the whole batch); the
  // dialog always closes and the lists always refetch on settle.
  const deleteUploads = useMutation({
    mutationFn: async (ids: number[]) => {
      let timer: number | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(
          () => reject(new Error("delete-timeout")),
          60000,
        );
      });
      const run = (async () => {
        let failed = 0;
        for (const uploadId of ids) {
          try {
            const res = await api.deleteUploadImage({ uploadId });
            if (!res.ok || res.deleted === 0) failed++;
          } catch {
            failed++;
          }
        }
        return { failed };
      })();
      try {
        return await Promise.race([run, timeout]);
      } finally {
        window.clearTimeout(timer);
      }
    },
    onSuccess: (res, variables) => {
      setCheckedUploadIds([]);
      if (selectedUploadId != null && variables.includes(selectedUploadId)) {
        setSelectedUploadId(null);
      }
      setUploadDeleteError(
        res.failed > 0
          ? `一部の画像（${res.failed}件）を削除できませんでした。`
          : null,
      );
    },
    onError: (error) => {
      setUploadDeleteError(
        error instanceof Error && error.message === "delete-timeout"
          ? "削除の応答がタイムアウトしました。一覧を再読み込みして、削除されたか確認してください。"
          : "削除できませんでした。通信状態を確認してください。",
      );
    },
    onSettled: () => {
      setShowUploadBulkDeleteConfirm(false);
      void queryClient.invalidateQueries({ queryKey: ["uploadImages"] });
      void queryClient.invalidateQueries({ queryKey: ["editorSource"] });
      void queryClient.invalidateQueries({ queryKey: ["sourceImage"] });
    },
  });

  const selectedUpload = useMemo(
    () => uploadImages.find((u) => u.id === selectedUploadId) ?? null,
    [uploadImages, selectedUploadId],
  );

  const selectedSaved = useMemo(
    () => savedImages.find((s) => s.id === selectedSavedId) ?? null,
    [savedImages, selectedSavedId],
  );
  const allSavedSelected =
    savedImages.length > 0 &&
    savedImages.every((s) => checkedSavedIds.includes(s.id));
  function toggleCheckedSaved(id: number, checked: boolean) {
    setCheckedSavedIds((prev) =>
      checked ? [...prev, id] : prev.filter((x) => x !== id),
    );
  }
  function toggleSelectAllSaved() {
    setCheckedSavedIds(allSavedSelected ? [] : savedImages.map((s) => s.id));
  }

  const allUploadsSelected =
    uploadImages.length > 0 &&
    uploadImages.every((u) => checkedUploadIds.includes(u.id));
  function toggleCheckedUpload(id: number, checked: boolean) {
    setCheckedUploadIds((prev) =>
      checked ? [...prev, id] : prev.filter((x) => x !== id),
    );
  }
  function toggleSelectAllUploads() {
    setCheckedUploadIds(
      allUploadsSelected ? [] : uploadImages.map((u) => u.id),
    );
  }

  // Validates the form and builds the generation arguments for
  // createJob. Returns null after setting the form error when
  // validation fails.
  async function buildJobArgs(): Promise<GenerationArgs | null> {
    // Generate is a prompt-save flush point: back up the current
    // prompt (and extra negative) before the job is created.
    flushPromptSave();
    setFormError(null);
    const w = Number(width);
    const h = Number(height);
    if (!Number.isInteger(w) || w < 64 || w > 4096 || !Number.isInteger(h) || h < 64 || h > 4096) {
      setFormError("幅と高さは 64〜4096 の整数で入力してください。");
      return null;
    }
    const st = Number(steps);
    if (!Number.isInteger(st) || st < 1 || st > 150) {
      setFormError("Steps は 1〜150 の整数で入力してください。");
      return null;
    }
    const cf = Number(cfg);
    if (!Number.isFinite(cf) || cf < 0 || cf > 30) {
      setFormError("CFG は 0〜30 の数値で入力してください。");
      return null;
    }
    // The job record still carries the two canonical style
    // weights (the history's base display reads them): they are
    // the template values of the 写実的 / コミック調 parameters
    // when the model's template defines them, else 0. The full
    // provenance is the payload itself (usedParams).
    const pw = Math.min(
      2,
      Math.max(-1, templateValues["写実的"] ?? 0),
    );
    const cw = Math.min(
      1,
      Math.max(0, templateValues["コミック調"] ?? 0),
    );
    let seedArg: { seedMode: "random" | "fixed"; seed: number | null };
    if (seedMode === "random") {
      seedArg = { seedMode: "random", seed: null };
    } else if (seedMode === "fixed") {
      const s = Number(seedText);
      if (!Number.isInteger(s) || s < 0 || s > 4294967295) {
        setFormError("seed は 0〜4294967295 の整数で入力してください。");
        return null;
      }
      seedArg = { seedMode: "fixed", seed: s };
    } else {
      if (lastSeed == null) {
        setFormError("再利用できる前回の seed がまだありません。");
        return null;
      }
      seedArg = { seedMode: "fixed", seed: lastSeed };
    }
    // Generation mode is decided by the mode toggle
    // (img2imgChecked), the source image, and the mask:
    // - no source image → txt2img only (the toggle has no
    //   i2i/inpaint side). From the Inpaint pane there is nothing
    //   to paint on, so it stays a form error.
    // - source image + toggle on the txt2img side → txt2img,
    //   even though an image is set (Editor). The Inpaint pane is
    //   the exception: it keeps its "generate with the target
    //   image" context and always uses the image (below).
    // - source image + toggle on the i2i/inpaint side (or any
    //   generation from the Inpaint pane): the mask alone splits
    //   the two — at least one painted mask pixel → inpaint
    //   (mode "img2img" + the exported mask and the fixed inpaint
    //   parameters); no mask paint → plain img2img. Generating
    //   from the Inpaint pane with an unpainted mask is img2img,
    //   NOT an error (the old "マスクが塗られていません" error
    //   stays abolished).
    // The init image is whatever the SOURCE slot holds — a job
    // image adopted from the image area (id only) or an image
    // uploaded into the source area (initSource "upload"). The
    // Editor slot's image plays no part here.
    let i2i: {
      mode: "txt2img" | "img2img";
      sourceJobId: number | null;
      initSource: "job" | "upload" | null;
      denoisingStrength: number | null;
      resizeMode: number | null;
    } = { mode: "txt2img", sourceJobId: null, initSource: null, denoisingStrength: null, resizeMode: null };
    // The painted mask, when this run is an inpaint: carried into
    // the payload below, no longer a record field of its own.
    let mask: { data: string; blur: number; invert: number } | null = null;
    // Whether this run uses the source image at all. The Inpaint
    // pane always does (its whole context is the target image);
    // the Editor follows the toggle.
    const useSourceImage =
      sourceImage.kind !== "none" && (img2imgChecked || tab === "inpaint");
    if (sourceImage.kind === "none") {
      if (tab === "inpaint") {
        setFormError(
          "元画像がセットされていません。元画像エリアで画像をアップロードするか、画像エリアの「元画像に採用」で表示中の画像を元画像にしてください。",
        );
        return null;
      }
      // No source image: txt2img — i2i stays the default above.
    } else if (!useSourceImage) {
      // Image set but the toggle is on the txt2img side (Editor):
      // txt2img — i2i stays the default above, and the denoise
      // value is not consulted.
    } else {
      const dn = Number(editorDenoise);
      if (
        editorDenoise.trim() === "" ||
        !Number.isFinite(dn) ||
        dn < 0 ||
        dn > 1
      ) {
        setFormError("denoise は 0〜1 の数値で入力してください。");
        return null;
      }
      i2i = {
        mode: "img2img",
        sourceJobId: sourceImage.kind === "job" ? sourceImage.jobId : null,
        initSource: sourceImage.kind === "job" ? "job" : "upload",
        denoisingStrength: dn,
        resizeMode,
      };
      if (maskHasPaint()) {
        const maskDataBase64 = exportMaskBase64();
        if (!maskDataBase64) {
          setFormError("マスクを書き出せませんでした。");
          return null;
        }
        const blurRaw = Number(maskBlur);
        const blur =
          Number.isInteger(blurRaw) && blurRaw >= 0 && blurRaw <= 16 ? blurRaw : 0;
        mask = {
          data: maskDataBase64,
          blur,
          // inside (塗った範囲を変更, the former "masked") → 0,
          // outside (the former "not masked") → 1.
          invert: maskMode === "not masked" ? 1 : 0,
        };
        // The record mirrors the payload: inpaint's resize is
        // Crop regardless of the panel selection.
        if (i2i) i2i.resizeMode = 1;
      }
    }
    // Compose the complete sdapi payload here in the client (the
    // payload-passthrough rework): the worker manages no
    // parameters at all and hands this object to the WebUI API
    // verbatim. The positive prompt is the model's template with
    // %prompt% and its numeric parameters replaced by their
    // values, the negative is the form's text (empty for
    // zimage), steps / cfg / sampler / scheduler are the form's
    // values, and the checkpoint comes from the model's recipe
    // entry in MODELS.
    const recipe = MODELS.find((m) => m.key === model) ?? MODELS[0]!;
    const content = prompt.trim();
    const fullPrompt = applyPromptTemplate(
      promptTemplate,
      content,
      templateValues,
    );
    const payload: Record<string, unknown> = {
      prompt: fullPrompt,
      negative_prompt: model === "zimage" ? "" : negativePrompt,
      width: w,
      height: h,
      steps: st,
      cfg_scale: cf,
      sampler_name: sampler,
      scheduler,
      seed: seedArg.seed ?? -1,
      override_settings: { sd_model_checkpoint: recipe.checkpoint },
      override_settings_restore_afterwards: restoreAfterwards,
    };
    if (i2i.mode === "img2img") {
      const srcUrl = sourceImage.imageUrl ?? sourceImage.displayUrl;
      if (!srcUrl) {
        setFormError("元画像を読み込めませんでした。");
        return null;
      }
      let initB64: string;
      try {
        initB64 = await fetchImageAsBase64(srcUrl);
      } catch {
        setFormError("元画像を読み込めませんでした。通信状態を確認してください。");
        return null;
      }
      payload.init_images = [initB64];
      payload.denoising_strength = i2i.denoisingStrength;
      // Inpaint always resizes with Crop (resize_mode 1) — the
      // panel's resize cell shows Crop and is disabled while the
      // mode is inpaint (keim, 2026-11-23). Plain img2img uses
      // the panel's selection.
      payload.resize_mode = mask ? 1 : resizeMode;
      payload.include_init_images = false;
      if (mask) {
        payload.mask = mask.data;
        payload.mask_blur = mask.blur;
        payload.inpainting_mask_invert = mask.invert;
        // The inpaint trio comes from the 詳細設定 values.
        payload.inpainting_fill = inpaintingFill;
        payload.inpaint_full_res = inpaintFullRes;
        const frp = Number(inpaintFullResPadding);
        payload.inpaint_full_res_padding =
          Number.isInteger(frp) && frp >= 0 && frp <= 256 ? frp : 32;
      }
    }
    return {
      prompt: prompt.trim(),
      model,
      extraNegative: "",
      negativePrompt,
      width: w,
      height: h,
      steps: st,
      cfg: cf,
      sampler,
      scheduler,
      baseEnabled: false,
      photorealisticWeight: pw,
      comicloWeight: cw,
      ...seedArg,
      ...i2i,
      payload,
    };
  }

  async function submit() {
    const args = await buildJobArgs();
    if (args) createJob.mutate(args);
  }

  const inputCls =
    "w-full border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)] rounded-[var(--radius)]";
  const labelCls = "block text-sm font-medium text-[var(--text)] mb-1";

  const snippetEditor = snippetEdit ? (
    <div aria-label="スニペット編集">
    <div className="flex items-center gap-1.5">
      <input
        {...FIELDS.saveTextSnippets.snippets}
        aria-label="スニペットのテキスト"
        value={snippetEdit.value}
        onChange={(e) => {
          setSnippetEdit({ ...snippetEdit, value: e.target.value });
          setSnippetEditError(null);
        }}
        placeholder="定型文を入力"
        className={`${inputCls} min-w-0 flex-1`}
        autoFocus
      />
      <button
        type="button"
        onClick={saveSnippetEdit}
        className="shrink-0 border border-transparent px-3 py-1.5 text-sm font-medium rounded-[var(--radius)]"
        style={{ backgroundColor: "var(--accent)", color: "var(--accent-text)", minHeight: "2rem" }}
      >
        保存
      </button>
    </div>
    {snippetEditError && (
      <p className="mt-1 text-sm" style={{ color: "var(--err)" }} role="alert">{snippetEditError}</p>
    )}
    </div>
  ) : null;

  // One aspect-ratio button of the size grid (Mobile Plus layout):
  // a square cell holding the ratio label and, where the original
  // has one, a smaller sub-caption line (Standard / Film / Full HD /
  // Cinema / Instagram / SmartPhone).
  const aspectButton = (
    item: { key: string; sub?: string },
    col: number,
    row: number,
  ) => {
    const selected = sizeKey === item.key;
    return (
      <button
        key={item.key}
        type="button"
        aria-pressed={selected}
        onClick={() => applySize(item.key)}
        className={`flex aspect-square flex-col items-center justify-center overflow-hidden px-0.5 py-1 text-center ${
          selected ? "" : "bg-[var(--surface)]"
        }`}
        style={{
          gridColumn: col,
          gridRow: row,
          // Seamless grid: cells share edges — separation comes only
          // from each cell's right / bottom border, never a gap.
          borderRight: col < 6 ? "1px solid var(--border)" : undefined,
          borderBottom: "1px solid var(--border)",
          ...(selected
            ? { backgroundColor: "var(--accent)", color: "var(--accent-text)" }
            : {}),
        }}
      >
        <span className={`text-sm font-semibold leading-tight ${MONO}`}>{item.key}</span>
        {item.sub && (
          <span className="text-[10px] leading-tight opacity-80">{item.sub}</span>
        )}
      </button>
    );
  };

  // Step for the width/height inputs: aligned with the block size,
  // so the number-input steppers move in block units.
  const blockStepValue = Number.parseInt(blockSize, 10);
  const dimensionStep =
    Number.isFinite(blockStepValue) && blockStepValue > 0 ? blockStepValue : 1;

  // Size settings (aspect-ratio grid with preview canvas /
  // pixel-count row / width-height inputs), rendered inside the size
  // popup launched from the Prompt pane's bottom row. The grid
  // layout and the canvas preview follow SD WebUI Mobile Plus's
  // size selector; all state, calculation and settings-backup
  // behaviour is unchanged from when this lived in the Parameters
  // pane.
  const sizeSettings = (
    <div>
      <div
        className="grid border border-[var(--border)]"
        style={{
          gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
          // The cells are square and the grid is 6 rows tall, so
          // its height equals its width. Cap the width at the
          // viewport height − 22.7rem of shell header / footer
          // generate row (3.2rem) + popup header / pixel row /
          // dimension inputs / panel padding / safe-area — the
          // figure still includes the removed tab bar's 2rem as
          // slack — written as 100dvh − 22.7rem — so on shorter
          // screens the grid itself shrinks and the whole popup
          // fits without vertical scrolling; on tall screens the
          // panel width is the binding constraint, as before.
          width: "min(100%, calc(100dvh - 22.7rem))",
          marginInline: "auto",
        }}
        role="group"
        aria-label="サイズプリセット"
      >
        {SIZE_LANDSCAPE_ROW.map((item, i) => aspectButton(item, i + 1, 1))}
        {SIZE_PORTRAIT_COL.map((item, i) => aspectButton(item, 1, i + 2))}
        <div
          className="relative min-h-0 min-w-0 overflow-hidden"
          style={{ gridColumn: "2 / 7", gridRow: "2 / 7" }}
        >
          <canvas
            ref={aspectCanvasRef}
            aria-label="選択中の比率プレビュー"
            className="absolute inset-0 block h-full w-full"
          />
        </div>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <div className="flex flex-1 border border-[var(--border)]" role="group" aria-label="画素数選択">
          {PIXEL_SIZES.map((pixel, i) => {
            const selected = pixelSize === pixel;
            return (
              <button
                key={pixel}
                type="button"
                aria-pressed={selected}
                onClick={() => applyPixelSize(pixel)}
                className={`flex-1 px-1 py-2 text-center text-sm ${MONO} ${
                  selected ? "" : "bg-[var(--surface)]"
                }`}
                style={{
                  borderLeft: i > 0 ? "1px solid var(--border)" : undefined,
                  ...(selected
                    ? { backgroundColor: "var(--accent)", color: "var(--accent-text)" }
                    : {}),
                }}
              >
                {pixel}p
              </button>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <label htmlFor="block-size" className="whitespace-nowrap text-xs text-[var(--dim)]">ブロック</label>
          <input
            id="block-size"
            aria-label="ブロックサイズ"
            inputMode="numeric"
            value={blockSize}
            onChange={(e) => onBlockSizeChange(e.target.value)}
            onBlur={onBlockSizeBlur}
            className={`${MONO} w-16 shrink-0 border border-[var(--border)] bg-[var(--surface)] px-1 py-2 text-center text-base text-[var(--text)] rounded-[var(--radius)]`}
          />
        </div>
      </div>
      <div className="mt-1 flex items-end gap-1.5">
        <div className="flex-1">
          <label htmlFor="width" className="block text-xs text-[var(--dim)] mb-1">幅</label>
          <input
            {...FIELDS.createJob.width}
            id="width"
            inputMode="numeric"
            value={width}
            step={dimensionStep}
            onChange={(e) => { setWidth(e.target.value); setSizeKey(null); setPixelSize(null); }}
            onBlur={flushSettingsSave}
            className={`${inputCls} ${MONO}`}
          />
        </div>
        <span className="pb-2 text-[var(--dim)]">×</span>
        <div className="flex-1">
          <label htmlFor="height" className="block text-xs text-[var(--dim)] mb-1">高さ</label>
          <input
            {...FIELDS.createJob.height}
            id="height"
            inputMode="numeric"
            value={height}
            step={dimensionStep}
            onChange={(e) => { setHeight(e.target.value); setSizeKey(null); setPixelSize(null); }}
            onBlur={flushSettingsSave}
            className={`${inputCls} ${MONO}`}
          />
        </div>
      </div>
    </div>
  );

  // Generate button label = job status display (the old progress
  // banner is gone), laid out in the fixed 3.2rem row. Idle:
  // 「生成」. Running: two lines — 「生成中...」 at the button's
  // normal font size, and underneath in xxs the current phase name
  // and the total elapsed time, ticking every second via `now`.
  // During the generating phase, once the live-progress state
  // machine has observed sampling start, the phase name carries
  // the counts as 「画像生成中(step/total)」 — step counts only,
  // no percentage or ETA. The total is the one fixed at sampling
  // start (falling back to the job's own steps setting when no
  // total was captured), and once sampling is treated as complete
  // the count reads (total/total). Until sampling starts (model
  // loading, init-image encoding) the plain phase name shows.
  // Completed: back to 「生成」. Failed: 「失敗：フェーズ名」
  // naming the phase the job died in, until the next generation
  // starts.
  const activeJob = activeJobs[0] ?? null;
  let generateLabel = "生成";
  let generateSubLabel: string | null = null;
  if (activeJob) {
    generateLabel = "生成中...";
    let phaseName = phaseLabel(activeJob) ?? statusLabel(activeJob);
    const live = liveProgress[activeJob.id];
    if (activeJob.phase === "generating" && live?.started) {
      const total = live.total ?? activeJob.steps ?? 0;
      if (total > 0) {
        const step = live.done
          ? total
          : Math.min(Math.max(live.step, 0), total);
        phaseName = `画像生成中(${step}/${total})`;
      }
    }
    generateSubLabel = `${phaseName} ・ 全体 ${fmtElapsed(activeJob.createdAt, now)}`;
  } else if (latestGen?.status === "failed") {
    const short = latestGen.phase ? PHASE_SHORT[latestGen.phase] : undefined;
    generateLabel = short ? `失敗：${short}` : "失敗";
  }

  // Round 「<」 back button: the return route to the Editor hub,
  // placed at the top-left of the Inpaint image area and at the
  // top-left of the Parameter / History panes' first row. The
  // Inpaint instance is rendered at 1.5× the standard size (both
  // the button disc and its glyph); the Parameter / History
  // instances keep the standard size.
  const renderBackToEditorButton = (scale: number) => {
    const size = `${2.25 * scale}rem`;
    const glyph = 18 * scale;
    return (
      <button
        type="button"
        aria-label="Editorに戻る"
        onClick={() => switchTab("editor")}
        className="flex shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
        style={{ width: size, height: size, minHeight: size }}
      >
        <svg
          width={glyph}
          height={glyph}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M15 5l-7 7 7 7" />
        </svg>
      </button>
    );
  };
  const backToEditorButton = renderBackToEditorButton(1);
  const inpaintBackToEditorButton = renderBackToEditorButton(1.5);

  // --- Editor image display ---
  // The Editor pane's image area IS the control surface for the
  // editor_source slot image:
  // - no image set: tapping the area (placeholder included) opens
  //   the file picker (the hidden file input beside this display);
  // - image set: tapping the image body switches to the Inpaint
  //   pane. The mask layer is composited over the image here too
  //   (display only — painting stays in the Inpaint pane), laid
  //   over the image's drawn rectangle exactly like Inpaint's.
  //   While the mode toggle is on the i2i/inpaint side and an
  //   image is set, the whole area is framed with a thick
  //   border (the img2img-family active signal); on the txt2img
  //   side — even with an image set — there is no frame. The
  //   area carries NO clear (×) button and NO upload tap:
  //   detaching and uploading live on the prompt row's source
  //   image area. A tap here only opens the Preview pane.
  // - the image's name plate sits FLUSH against the area's
  //   TOP-LEFT corner (no gap), on a 70%-white translucent
  //   background, in an xxs font, on TWO lines: line 1 is the
  //   file name — "{jobId}-{resultSeed}" (index - seed) for a
  //   generated job image, the original file name for an
  //   upload — and line 2 is the displayed image's own pixel
  //   dimensions as "（{width} x {height}）" — full-width
  //   parentheses, width × height order, half-width spaces
  //   around the x (editorNatural: the displayed image's own
  //   measured size, independent of the img2img source slot).
  //   Display only (pointer-events none), so it never
  //   blocks the area tap.
  // - while an image is shown — a generated job's OR an
  //   upload's — three bordered, rounded square buttons overlap
  //   the image's BOTTOM-RIGHT corner (with gaps between them —
  //   an explicit exception to the seamless-grid look):
  //   download (a DownloadButton fetching the original image
  //   behind the scenes — see the Downloads note at the top of
  //   this file; for a job the original PNG under
  //   "{jobId}-{resultSeed}.png", for an upload the original
  //   blob under its original file name), save (copies the
  //   image into the saved-image area:
  //   via saveJobImage under a "{counter}-{seed}" name for a
  //   job, via saveUploadImage under "{counter}-0" for an
  //   upload; the assigned name is shown briefly as save
  //   feedback overlaid at the area's bottom-left), and delete
  //   (opens the editor-delete confirmation; a job is deleted
  //   via deleteJobs, an upload record is removed as a set —
  //   record + blobs + host file — via deleteUploadImage, and
  //   either way the next merged-list image loads afterwards).
  //   All stop propagation so their taps never fall through to
  //   the Preview route. (A legacy single-slot upload with no
  //   library record gets the download button only — it has no
  //   record to save from or delete.)
  const editorHasImage = editorSource.kind !== "none" && !!editorSource.displayUrl;
  // The upload-library record behind an upload source, when the
  // slot points at one: the plate / download fall back to its
  // stored name when the view carries no original file name.
  const editorUploadRecord =
    editorSource.kind === "upload" && editorSource.uploadId != null
      ? (uploadImages.find((u) => u.id === editorSource.uploadId) ?? null)
      : null;
  // Line 1 of the name plate (and the upload download's file
  // name): "{jobId}-{resultSeed}" for a job image, the original
  // file name for an upload.
  const editorImageName =
    editorSource.kind === "job"
      ? `${editorSource.jobId}-${editorSource.resultSeed ?? "x"}`
      : editorSource.kind === "upload"
        ? (editorSource.fileName ??
          editorUploadRecord?.fileName ??
          editorUploadRecord?.storedName ??
          "アップロード画像")
        : "";
  // Size-mismatch dot for the footer size button: the form's
  // selected generation size (width × height) differs from the
  // SOURCE image's own pixel size (maskNatural — the img2img
  // init image sitting in the source area). The generation size
  // matters against the source, so the dot and
  // 「画像サイズをあわせる」 follow the source — NOT the
  // displayed Editor image, whose own size is what the name
  // plate shows (keim, 2026-11-23). No source image (or its
  // size not measured yet) — no dot.
  const sizeMismatch =
    sourceImage.kind !== "none" &&
    maskNatural != null &&
    (Number(width) !== maskNatural.w || Number(height) !== maskNatural.h);
  // The two-line name plate (file name on line 1, the image's
  // own "（{width} x {height}）" pixel size on line 2). Shown by
  // the Editor image display only, flush in its top-left corner —
  // the Inpaint pane shows NO name plate (neither the file name
  // nor the size), so its painting surface stays unobstructed.
  const imageNamePlate = (positionCls: string) => (
    <div
      className={`pointer-events-none absolute top-0 max-w-[70%] px-1.5 py-1 ${positionCls}`}
      style={{ backgroundColor: "rgba(255, 255, 255, 0.7)" }}
    >
      <span className="block truncate text-[10px] leading-tight">
        {editorImageName}
      </span>
      {editorNatural && (
        <span className={`block truncate text-[10px] leading-tight ${MONO}`}>
          {`（${editorNatural.w} x ${editorNatural.h}）`}
        </span>
      )}
    </div>
  );
  // The Editor mask mirror's drawn rectangle (object-contain
  // letterbox of the mask's natural size inside the measured
  // Editor image area) — same math as the Inpaint pane's maskRect.
  let editorMaskRect: { left: number; top: number; w: number; h: number } | null = null;
  if (editorBox && maskNatural && editorBox.w > 0 && editorBox.h > 0) {
    const aspect = maskNatural.w / maskNatural.h;
    let w = editorBox.w;
    let h = w / aspect;
    if (h > editorBox.h) {
      h = editorBox.h;
      w = h * aspect;
    }
    editorMaskRect = {
      left: (editorBox.w - w) / 2,
      top: (editorBox.h - h) / 2,
      w,
      h,
    };
  }
  // The area tap target: a transparent full-area button under the
  // overlay buttons. A tap while a parameter popup is open only
  // dismisses it (the general outside-tap rule), never navigates /
  // opens the picker underneath it.
  const onEditorAreaTap = () => {
    if (editorPopup != null) {
      setEditorPopup(null);
      return;
    }
    if (editorHasImage) {
      switchTab("preview");
    }
  };
  // 元画像に採用 (adopt as the img2img source): copies the image
  // area's current image into the source slot and switches the
  // mode to img2img (the adopt mutation does both). Shown only
  // in the Editor image area, left of the download button.
  const adoptSourceButton = (
    <button
      type="button"
      aria-label="元画像に採用"
      disabled={adoptSource.isPending}
      onClick={(e) => {
        e.stopPropagation();
        adoptSource.mutate();
      }}
      className="flex items-center justify-center border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] rounded-[var(--radius)] disabled:opacity-50"
      style={{ width: "2.25rem", height: "2.25rem", minHeight: "2.25rem" }}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
      </svg>
    </button>
  );

  // The image area's bottom-right button trio (download / save /
  // delete), shared by the Editor image area and the Preview
  // pane. The Editor passes its adopt button （元画像に採用） as
  // the leading element, left of download; the Preview passes
  // nothing. Self-gating: renders only for a job image or an
  // upload source (a legacy single-slot upload gets the
  // download button only, having no record to save or delete).
  const renderEditorImageButtons = (leading?: ReactNode) => (
  ((editorSource.kind === "job" && editorSource.jobId != null) ||
    editorSource.kind === "upload") && (
    <div className="absolute bottom-2 right-2 z-10 flex gap-2">
      {leading}
      {editorSource.imageUrl && (
        <DownloadButton
          url={editorSource.imageUrl}
          fileName={
            editorSource.kind === "job"
              ? `${editorSource.jobId}-${editorSource.resultSeed ?? "x"}.png`
              : editorImageName
          }
          ariaLabel="画像をダウンロード"
          stopPropagation
          onSettled={reconcileAfterDownload}
          className="flex items-center justify-center border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] rounded-[var(--radius)] disabled:opacity-50"
          style={{ width: "2.25rem", height: "2.25rem", minHeight: "2.25rem" }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 4v11" />
            <path d="M7 11l5 5 5-5" />
            <path d="M4 20h16" />
          </svg>
        </DownloadButton>
      )}
      {((editorSource.kind === "job" && editorSource.jobId != null) ||
        (editorSource.kind === "upload" &&
          editorSource.uploadId != null)) && (
        <>
          <button
            type="button"
            aria-label="画像を保存"
            disabled={saveImage.isPending || saveUpload.isPending}
            onClick={(e) => {
              e.stopPropagation();
              setSaveNotice(null);
              setSaveError(null);
              if (editorSource.kind === "job" && editorSource.jobId != null) {
                saveImage.mutate(editorSource.jobId);
              } else if (
                editorSource.kind === "upload" &&
                editorSource.uploadId != null
              ) {
                saveUpload.mutate(editorSource.uploadId);
              }
            }}
            className="flex items-center justify-center border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] rounded-[var(--radius)] disabled:opacity-50"
            style={{ width: "2.25rem", height: "2.25rem", minHeight: "2.25rem" }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
              <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
              <path d="M7 3v4a1 1 0 0 0 1 1h7" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="この画像を削除"
            onClick={(e) => {
              e.stopPropagation();
              setUploadError(null);
              setShowEditorDeleteConfirm(true);
            }}
            className="flex items-center justify-center border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] rounded-[var(--radius)]"
            style={{ width: "2.25rem", height: "2.25rem", minHeight: "2.25rem" }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 7h16" />
              <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              <path d="M6.5 7l.8 12.2A1 1 0 0 0 8.3 20h7.4a1 1 0 0 0 1-0.8L17.5 7" />
              <path d="M10 11v5" />
              <path d="M14 11v5" />
            </svg>
          </button>
        </>
      )}
    </div>
  )
  );

  // --- Preview pane ---
  // The Preview pane shows the same editor-source image as the
  // Editor, full-screen like the Inpaint pane. The position of
  // the shown image within the merged list (newest first — the
  // Editor side column's order, and the pane's own thumbnail
  // strip's: left = newest) drives the left/right eighth-tap
  // navigation: a tap in the image's left eighth moves to the
  // item on its left in the list, the right eighth to its right.
  const previewIndex = mergedPreview.findIndex((item) =>
    item.kind === "job"
      ? editorSource.kind === "job" && editorSource.jobId === item.job.id
      : editorSource.kind === "upload" &&
        editorSource.uploadId != null &&
        editorSource.uploadId === item.upload.id,
  );
  // Preview navigation is a plain Editor-slot change: like
  // every image selection it never switches the generation
  // mode toggle (the pane is a viewer; the mode stays the
  // Editor's concern), so it calls the bare mutations.
  function goToPreviewItem(item: MergedPreviewItem) {
    setUploadError(null);
    if (item.kind === "job") {
      setSourceFromJob.mutate({ jobId: item.job.id });
    } else {
      setSourceFromUpload.mutate({ uploadId: item.upload.id });
    }
  }
  const previewStripRef = useRef<HTMLDivElement | null>(null);
  // Keep the strip's current thumbnail in view as the preview
  // moves (eighth-tap navigation, thumbnail taps, delete-next
  // loads).
  useEffect(() => {
    if (tab !== "preview") return;
    previewStripRef.current
      ?.querySelector('[data-current="true"]')
      ?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [tab, previewIndex, editorSourceIdentity]);
  // The pane has nothing to show once the source is gone (the
  // last image deleted, or the slot cleared elsewhere): fall
  // back to the Editor hub.
  useEffect(() => {
    if (tab === "preview" && editorSource.kind === "none") {
      setTab("editor");
    }
  }, [tab, editorSource.kind]);

  // --- Source image area (Editor, img2img side only) ---
  // The right half of the prompt row while the mode toggle is on
  // the img2img(inpaint) side: shows the conversion source (the
  // shared editor slot image) with the painted mask laid over
  // it. The mask canvas is a replaced element, so object-fit:
  // contain letterboxes its bitmap exactly like the image under
  // it (the mask bitmap shares the image's natural size) — no
  // measured rect needed here. Tapping the image opens the
  // Inpaint pane; with no image set, tapping opens the file
  // picker (this area is the Editor's only upload entry point).
  // The round × at the top-right detaches the source image; the
  // mode stays on the img2img side, so the area remains as the
  // upload target.
  const sourceImageArea = (
    <div
      className="relative min-h-0 min-w-0 border border-[var(--border)] bg-[var(--surface-alt)]"
      aria-label="元画像エリア"
    >
      {sourceImage.kind !== "none" && sourceImage.displayUrl ? (
        <>
          <img
            src={sourceImage.displayUrl}
            alt="変換元画像"
            className="absolute inset-0 h-full w-full object-contain"
          />
          {maskNatural && (
            <canvas
              ref={sourceMaskDisplayRef}
              aria-hidden="true"
              width={maskNatural.w}
              height={maskNatural.h}
              className="pointer-events-none absolute inset-0 h-full w-full object-contain"
              style={{ opacity: 0.5 }}
            />
          )}
          <button
            type="button"
            aria-label="Inpaintペインへ移動"
            onClick={() => switchTab("inpaint")}
            className="absolute inset-0 cursor-pointer bg-transparent"
            style={{ minHeight: 0 }}
          />
          <button
            type="button"
            aria-label="元画像を外す"
            onClick={(e) => {
              e.stopPropagation();
              clearSourceImage.mutate();
            }}
            className="absolute right-1 top-1 z-10 flex items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
            style={{ width: "2rem", height: "2rem", minHeight: "2rem" }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12" />
              <path d="M18 6L6 18" />
            </svg>
          </button>
        </>
      ) : (
        <>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="px-2 text-center text-xs text-[var(--dim)]">
              {uploadImage.isPending
                ? "アップロード中…"
                : "元画像がありません。タップでアップロードできます。"}
            </span>
          </div>
          <button
            type="button"
            aria-label="元画像をアップロード"
            onClick={() => editorFileInputRef.current?.click()}
            className="absolute inset-0 cursor-pointer bg-transparent"
            style={{ minHeight: 0 }}
          />
        </>
      )}
      {uploadError && (
        <p
          role="alert"
          className="absolute bottom-1 left-1 right-1 border border-[var(--err)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--err)]"
        >
          {uploadError}
        </p>
      )}
    </div>
  );

  const sharedImageDisplay = (
    <div
      ref={editorBoxRef}
      className="relative min-h-0 min-w-0 flex-1"
      style={{
        border:
          editorHasImage &&
          img2imgChecked &&
          editorSourceIdentity === sourceIdentity
            ? "4px solid var(--accent)"
            : "4px solid transparent",
      }}
    >
      {editorSource.kind !== "none" && editorSource.displayUrl ? (
        <>
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--surface-alt)]">
            <img
              src={editorSource.displayUrl}
              alt="現在の画像"
              className="h-full w-full object-contain"
            />
          </div>
          <button
            type="button"
            aria-label="プレビューを開く"
            onClick={onEditorAreaTap}
            className="absolute inset-0 cursor-pointer bg-transparent"
            style={{ minHeight: 0 }}
          />
          {editorMaskRect &&
            maskNatural &&
            editorSourceIdentity === sourceIdentity && (
            <canvas
              ref={editorMaskDisplayRef}
              data-editor-mask-canvas="true"
              aria-hidden="true"
              width={maskNatural.w}
              height={maskNatural.h}
              className="pointer-events-none absolute"
              style={{
                left: editorMaskRect.left,
                top: editorMaskRect.top,
                width: editorMaskRect.w,
                height: editorMaskRect.h,
                opacity: 0.5,
              }}
            />
          )}
          {imageNamePlate("left-0")}
          {renderEditorImageButtons(adoptSourceButton)}
        </>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--surface-alt)]">
          <span className="px-4 text-center text-sm text-[var(--dim)]">
            画像はまだありません。生成結果や履歴からの転送で表示されます。
          </span>
        </div>
      )}
      {(saveNotice || saveError) && tab === "editor" && (
        <p
          role={saveError ? "alert" : "status"}
          className="absolute bottom-2 left-2 max-w-[calc(100%-12rem)] border bg-[var(--surface)] px-3 py-2 text-sm"
          style={{
            borderColor: saveError ? "var(--err)" : "var(--ok)",
            color: saveError ? "var(--err)" : "var(--ok)",
          }}
        >
          {saveError ?? saveNotice}
        </p>
      )}
    </div>
  );

  // --- Editor generation mode ---
  // The operation panel's mode cell is a TOGGLE between the
  // txt2img side and the img2img(inpaint) side (img2imgChecked).
  // Its label names the selected side: "txt2img", or on the i2i
  // side "inpaint" while the mask has paint and "img2img"
  // otherwise — the mask alone splits those two (see
  // buildJobArgs). The toggle is enabled with no image set:
  // switching to the i2i side reveals the source image area in
  // the prompt row, whose tap uploads the source. Generation
  // itself still falls back to txt2img while no source image is
  // set. The i2i side is shown in the accent fill (the
  // active-family signal, matching the image area's thick frame
  // while a source image is set); the txt2img side stays plain.
  // Automatic switches to the i2i side: uploading, and a user
  // image-list selection (preview-column tap / History pane
  // set). A completed generation's auto-set and the delete-next
  // load never move this.
  const modeSideLabel = img2imgChecked
    ? maskPainted
      ? "inpaint"
      : "img2img"
    : "txt2img";

  function toggleEditorPopup(name: "model" | "style" | "denoise" | "blur" | "brush" | "resize") {
    setEditorPopup((prev) => (prev === name ? null : name));
  }

  // --- Inpaint image display: the SOURCE slot's image (the
  // img2img source), independent of the Editor slot's image.
  // pane, with the mask canvas laid exactly over the image's drawn
  // rectangle (the object-contain letterbox area). Unlike the
  // Editor display it carries NO clear (×) button, NO mode
  // toggle row and NO name plate (the file name and size stay
  // hidden here); it carries the round
  // 「<」 back button at the top-left instead, plus a round trash
  // button at the bottom-right that clears the whole mask. Taps /
  // drags here never navigate panes — the canvas is for mask
  // painting only.
  // The canvas
  // bitmap is the mask's natural size; it renders at 50% opacity
  // so painted areas read as 50% white over the image. While the
  // brush-size popup is open, a sample circle of the current brush
  // diameter (in display pixels) is shown at the preview's centre.
  const brushDiameter = Number(brushSize) || 100;
  let maskRect: { left: number; top: number; w: number; h: number } | null = null;
  if (inpaintBox && maskNatural && inpaintBox.w > 0 && inpaintBox.h > 0) {
    const aspect = maskNatural.w / maskNatural.h;
    let w = inpaintBox.w;
    let h = w / aspect;
    if (h > inpaintBox.h) {
      h = inpaintBox.h;
      w = h * aspect;
    }
    maskRect = {
      left: (inpaintBox.w - w) / 2,
      top: (inpaintBox.h - h) / 2,
      w,
      h,
    };
  }

  const inpaintImageDisplay = (
    <div ref={inpaintBoxRef} className="relative min-h-0 min-w-0 flex-1">
      {sourceImage.kind !== "none" && sourceImage.displayUrl ? (
        <>
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--surface-alt)]">
            <img
              src={sourceImage.displayUrl}
              alt="元画像"
              className="h-full w-full object-contain"
            />
          </div>
          {maskRect && maskNatural && (
            <canvas
              ref={maskDisplayRef}
              data-mask-canvas="true"
              aria-label="マスク描画エリア"
              width={maskNatural.w}
              height={maskNatural.h}
              onPointerDown={onMaskPointerDown}
              onPointerMove={onMaskPointerMove}
              onPointerUp={onMaskPointerEnd}
              onPointerCancel={onMaskPointerEnd}
              className="absolute"
              style={{
                left: maskRect.left,
                top: maskRect.top,
                width: maskRect.w,
                height: maskRect.h,
                opacity: 0.5,
                touchAction: "none",
                cursor: "crosshair",
              }}
            />
          )}
          {editorPopup === "brush" && (
            <div
              aria-hidden="true"
              data-brush-sample="true"
              className="pointer-events-none absolute rounded-full"
              style={{
                left: "50%",
                top: "50%",
                width: brushDiameter,
                height: brushDiameter,
                transform: "translate(-50%, -50%)",
                backgroundColor: "rgba(255, 255, 255, 0.5)",
                border: "2px solid var(--accent2)",
              }}
            />
          )}
        </>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--surface-alt)]">
          <span className="px-4 text-center text-sm text-[var(--dim)]">
            画像はまだありません。Editor で画像を設定してください。
          </span>
        </div>
      )}
      {/* Round 「<」 back button (top-left): returns to the Editor
          hub. Shown whether or not an image is set, and painted
          above the mask canvas. */}
      <div className="absolute left-2 top-2 z-10">{inpaintBackToEditorButton}</div>
      {/* Round trash button (bottom-right): clears the whole mask
          back to fully transparent in one tap, with no
          confirmation. Shown only while an image is set (there is
          no mask without one), painted above the mask canvas.
          Rendered at 1.5× the standard round-button size (disc
          and glyph), like this pane's back button. */}
      {sourceImage.kind !== "none" && sourceImage.displayUrl && (
        <button
          type="button"
          aria-label="マスクを全削除"
          onClick={clearMask}
          className="absolute bottom-2 right-2 z-10 flex items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
          style={{ width: "3.375rem", height: "3.375rem", minHeight: "3.375rem" }}
        >
          <svg
            width="27"
            height="27"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 7h16" />
            <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            <path d="M6.5 7l.8 12.2A1 1 0 0 0 8.3 20h7.4a1 1 0 0 0 1-0.8L17.5 7" />
            <path d="M10 11v5" />
            <path d="M14 11v5" />
          </svg>
        </button>
      )}
      {uploadError && tab === "inpaint" && (
        <p
          role="alert"
          className="absolute bottom-2 left-2 right-2 border border-[var(--err)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--err)]"
        >
          {uploadError}
        </p>
      )}
    </div>
  );

  const popupPanelCls =
    "absolute inset-x-0 bottom-full z-40 border border-b-0 border-[var(--border)] bg-[var(--surface)] p-3";
  // Vertically compressed variant for the style / denoise slider
  // popups: same panel, tighter padding. These two popups carry no
  // explanation text, no prompt preview and no close button —
  // dismissal is the general outside-tap rule only.
  const popupPanelCompactCls =
    "absolute inset-x-0 bottom-full z-40 border border-b-0 border-[var(--border)] bg-[var(--surface)] px-3 py-2";

  // Editor parameter panel popups (open upward from the panel).
  const editorPopupContent = editorPopup === "model" ? (
    <div className={popupPanelCls} role="dialog" aria-label="モデル選択">
      <div className="flex border border-[var(--border)]" role="group" aria-label="モデル選択">
        {MODELS.map((m, i) => (
          <button
            key={m.key}
            type="button"
            aria-pressed={model === m.key}
            onClick={() => { applyModel(m.key); setEditorPopup(null); }}
            className={`flex-1 px-2 py-2 text-sm font-medium ${model === m.key ? "" : "bg-[var(--surface)]"}`}
            style={{
              borderLeft: i > 0 ? "1px solid var(--border)" : undefined,
              ...(model === m.key ? { backgroundColor: "var(--accent)", color: "var(--accent-text)" } : {}),
            }}
          >
            {m.shortLabel}
          </button>
        ))}
      </div>
      <p className={`mt-1 text-xs text-[var(--dim)] ${MONO}`}>
        {MODELS.find((m) => m.key === model)?.checkpoint}
      </p>
    </div>
  ) : editorPopup === "style" ? (
    <div className={popupPanelCompactCls} role="dialog" aria-label="調整設定">
      {styleParams.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">
          テンプレートに数値パラメータがありません。
        </p>
      ) : (
        styleParams.map((p, i) => (
          <div key={p.label} className={i > 0 ? "mt-1.5" : undefined}>
            <label
              htmlFor={`style-param-${i}`}
              className="flex items-center justify-between text-sm"
            >
              <span>{p.label}</span>
              <span className={MONO}>
                {formatTemplateValue(templateValues[p.label] ?? p.def, p.step)}
              </span>
            </label>
            <input
              id={`style-param-${i}`}
              aria-label={`${p.label} の値`}
              type="range"
              min={p.min}
              max={p.max}
              step={p.step}
              value={templateValues[p.label] ?? p.def}
              onChange={(e) =>
                setTemplateValues((prev) => ({
                  ...prev,
                  [p.label]: Number(e.target.value),
                }))
              }
              onBlur={flushSettingsSave}
              className="w-full"
            />
          </div>
        ))
      )}
    </div>
  ) : editorPopup === "denoise" ? (
    <div className={popupPanelCompactCls} role="dialog" aria-label="デノイズ設定">
      <label htmlFor="denoise-slider" className="flex items-center justify-between text-sm">
        <span>denoise（img2img）</span>
        <span className={MONO}>{editorDenoise}</span>
      </label>
      <input
        {...FIELDS.createJob.denoisingStrength}
        id="denoise-slider"
        aria-label="img2img デノイズ値"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={editorDenoise}
        onChange={(e) => setEditorDenoise(e.target.value)}
        onBlur={flushSettingsSave}
        className="w-full"
      />
    </div>
  ) : editorPopup === "resize" ? (
    <div className={popupPanelCls} role="dialog" aria-label="リサイズ方法選択">
      <div className="flex border border-[var(--border)]" role="group" aria-label="リサイズ方法選択">
        {RESIZE_MODES.map((r, i) => (
          <button
            key={r.value}
            type="button"
            aria-pressed={resizeMode === r.value}
            onClick={() => {
              markSettingsImmediate();
              setResizeMode(r.value);
              setEditorPopup(null);
            }}
            className={`flex-1 px-2 py-2 text-sm font-medium ${resizeMode === r.value ? "" : "bg-[var(--surface)]"}`}
            style={{
              borderLeft: i > 0 ? "1px solid var(--border)" : undefined,
              ...(resizeMode === r.value
                ? { backgroundColor: "var(--accent)", color: "var(--accent-text)" }
                : {}),
            }}
          >
            {r.label}
          </button>
        ))}
      </div>
    </div>
  ) : editorPopup === "blur" ? (
    <div className={popupPanelCompactCls} role="dialog" aria-label="ブラー設定">
      <label htmlFor="blur-slider" className="flex items-center justify-between text-sm">
        <span>ブラー</span>
        <span className={MONO}>{maskBlur}px</span>
      </label>
      <input
        id="blur-slider"
        aria-label="マスクのブラー値"
        type="range"
        min={0}
        max={16}
        step={1}
        value={maskBlur}
        onChange={(e) => { markSettingsImmediate(); setMaskBlur(e.target.value); }}
        className="w-full"
      />
    </div>
  ) : editorPopup === "brush" ? (
    <div className={popupPanelCompactCls} role="dialog" aria-label="線幅設定">
      <label htmlFor="brush-slider" className="flex items-center justify-between text-sm">
        <span>線幅</span>
        <span className={MONO}>{brushSize}px</span>
      </label>
      <input
        id="brush-slider"
        aria-label="マスクの線幅"
        type="range"
        min={4}
        max={200}
        step={4}
        value={brushSize}
        onChange={(e) => { markSettingsImmediate(); setBrushSize(e.target.value); }}
        className="w-full"
      />
    </div>
  ) : null;

  return (
    <div
      className="grid overflow-hidden bg-[var(--bg)] text-[var(--text)]"
      style={{
        overflow: "hidden",
        gridTemplateRows: "1fr auto",
        // Pin the single column to the container width: without this,
        // a row whose min-content is wider than the viewport (e.g. the
        // active-job banner's long prompt text) stretches the column
        // past the screen edge and pushes right-side controls off it.
        gridTemplateColumns: "minmax(0, 1fr)",
        // Pin the root to the viewport with position: fixed so it is
        // fully detached from the host page's document flow: earlier
        // fixes (height compensation against the shell wrapper's
        // padding, overflow: hidden on this root) still left the page
        // scrollable on phones with the host shell's background
        // (#f4f7fb) visible outside the pane area, which points at
        // the scroll happening on the host side. A fixed root
        // cannot be scrolled by the host document, and
        // overscroll-behavior: none breaks scroll chaining so
        // gestures at the edge of an internal scroll region
        // (history list, parameters pane) do not propagate
        // outward. Top stays at the shell's header reserve; bottom
        // reaches the very bottom of the viewport so the footer
        // generate row paints to the screen edge — the footer
        // keeps its own env(safe-area-inset-bottom) padding so
        // the buttons stay clear of the home indicator.
        position: "fixed",
        top: "var(--header-height, 0px)",
        right: 0,
        bottom: 0,
        left: 0,
        overscrollBehavior: "none",
      }}
    >
      <main className="min-h-0 min-w-0">
        {/* ============ Editor pane (formerly Prompt): rows =
            text area / image area / parameter panel. The text
            area and the image area share the height 3:7 in the
            default view. The text area is a single cell (1x1):
            the prompt textarea fills it entirely (the former
            left operation panel is abolished). While the
            prompt is focused, the image area and the parameter
            panel are hidden and the prompt auxiliary panel
            (3 rows x 6 cols: word candidates / word operations /
            定型文・Undo・Redo + 3 blank cells) shows instead;
            defocus — or the software keyboard closing while the
            textarea is still focused (viewport-height detection,
            see the keyboard-close watcher near promptRef) —
            returns to the default view.
            Auxiliary-panel buttons preventDefault on mousedown
            so operating them never blurs the prompt (see the
            panel markup). ============ */}
        {tab === "editor" && (
          <section
            aria-label="Editor"
            className="relative grid h-full min-h-0 min-w-0"
            style={{
              gridTemplateRows: promptFocused ? "1fr auto" : "3fr 7fr auto",
              gridTemplateColumns: "minmax(0, 1fr)",
            }}
          >
            {/* --- text area: prompt textarea (1x1). On the
                img2img(inpaint) side (and not while the prompt
                is focused) the row splits in half: the right
                half is the source image area. --- */}
            <div
              className="grid min-h-0 px-3 py-1.5"
              style={{
                gridTemplateColumns:
                  img2imgChecked && !promptFocused
                    ? "minmax(0, 1fr) minmax(0, 1fr)"
                    : "minmax(0, 1fr)",
                gap: img2imgChecked && !promptFocused ? "0.5rem" : undefined,
              }}
            >
              <textarea
                {...FIELDS.createJob.prompt}
                id="prompt"
                aria-label="プロンプト"
                ref={promptRef}
                value={prompt}
                onFocus={() => setPromptFocused(true)}
                onBlur={(e) => {
                  // Stay in focused layout while focus moves into
                  // the auxiliary panel itself (its buttons mostly
                  // preventDefault, but the snippet launcher and
                  // range inputs do take focus).
                  const next = e.relatedTarget as Node | null;
                  if (next && e.currentTarget.closest("section")?.contains(next)) {
                    return;
                  }
                  setPromptFocused(false);
                }}
                onChange={(e) => {
                  const value = e.target.value;
                  setPrompt(value);
                  setCursorPos(e.target.selectionStart ?? value.length);
                  setSelStart(e.target.selectionStart ?? value.length);
                  setSelEnd(e.target.selectionEnd ?? value.length);
                  const ne = e.nativeEvent as InputEvent;
                  if (
                    ne.inputType === "insertFromPaste" ||
                    ne.inputType === "insertLineBreak" ||
                    (ne.inputType === "insertText" &&
                      ne.data != null &&
                      /[ \n]/.test(ne.data))
                  ) {
                    recordHistory(value);
                  }
                }}
                onPaste={() => {
                  window.setTimeout(() => {
                    const v = promptRef.current?.value;
                    if (v != null) recordHistory(v);
                  }, 0);
                }}
                onSelect={(e) => {
                  setCursorPos(e.currentTarget.selectionStart ?? 0);
                  setSelStart(e.currentTarget.selectionStart ?? 0);
                  setSelEnd(e.currentTarget.selectionEnd ?? 0);
                }}
                placeholder="例: Mizuki Seira, adult woman, street dance, stage, smile"
                // Same field styling as inputCls but with narrower
                // inner padding, so more of the fixed area shows
                // prompt text (font size and layout are unchanged).
                className="h-full w-full min-w-0 resize-none border border-[var(--border)] bg-[var(--surface)] px-1.5 py-1 text-base text-[var(--text)]"
                style={{ borderRadius: "var(--radius)" }}
              />
              {img2imgChecked && !promptFocused && sourceImageArea}
            </div>

            {/* --- auxiliary panel (focused only): 3 rows x 6 cols
                (word candidates / word operations / 定型文・
                Undo・Redo + 3 blank cells). --- */}
            {promptFocused && (
            <div
              className="grid grid-cols-6 border-t border-[var(--border)] bg-[var(--surface)]"
              role="group"
              aria-label="プロンプト操作パネル"
              onMouseDown={(e) => {
                // Keep the textarea focused while operating the
                // panel, except for controls that need focus
                // themselves (the snippet dialog handles its own).
                if ((e.target as HTMLElement).closest("input, textarea, select")) return;
                e.preventDefault();
              }}
            >
              {Array.from({ length: 6 }, (_, i) => {
                const c = candidates[i];
                const cellStyle = {
                  minHeight: "2rem",
                  borderRight: i < 5 ? "1px solid var(--border)" : undefined,
                  borderBottom: "1px solid var(--border)",
                } as const;
                return c ? (
                  <button
                    key={`cand-${i}`}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onClickCandidate(c.word)}
                    title={c.word}
                    className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap bg-[var(--surface)] px-0 py-1 text-xs"
                    style={cellStyle}
                  >
                    {c.word}
                  </button>
                ) : (
                  <span key={`cand-empty-${i}`} aria-hidden="true" style={cellStyle} />
                );
              })}
              <button
                type="button"
                aria-label="前の単語"
                onMouseDown={(e) => e.preventDefault()}
                onClick={onSelectPrevWord}
                className="bg-[var(--surface)] px-1 py-1.5 text-xs"
                style={{ minHeight: "2rem", borderRight: "1px solid var(--border)" }}
              >
                ◀
              </button>
              <button
                type="button"
                aria-label="単語選択"
                aria-pressed={wordSelectMode}
                onMouseDown={(e) => e.preventDefault()}
                onClick={onToggleSelectWord}
                className="px-1 py-1.5 text-xs font-medium"
                style={{
                  minHeight: "2rem",
                  borderRight: "1px solid var(--border)",
                  ...(wordSelectMode
                    ? { backgroundColor: "var(--accent2)", color: "var(--on-accent2)" }
                    : { backgroundColor: "var(--surface)" }),
                }}
              >
                ■
              </button>
              <button
                type="button"
                aria-label="次の単語"
                onMouseDown={(e) => e.preventDefault()}
                onClick={onSelectNextWord}
                className="bg-[var(--surface)] px-1 py-1.5 text-xs"
                style={{ minHeight: "2rem", borderRight: "1px solid var(--border)" }}
              >
                ▶
              </button>
              <button
                type="button"
                aria-label="括弧で囲う"
                onMouseDown={(e) => e.preventDefault()}
                onClick={onEmphasize}
                className={`bg-[var(--surface)] px-1 py-1.5 text-sm ${MONO}`}
                style={{ minHeight: "2rem", borderRight: "1px solid var(--border)" }}
              >
                (...)
              </button>
              <button
                type="button"
                aria-label="重みを 0.1 下げる"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onChangeRate(-0.1)}
                className={`bg-[var(--surface)] px-1 py-1.5 text-sm ${MONO}`}
                style={{ minHeight: "2rem", borderRight: "1px solid var(--border)" }}
              >
                :-0.1
              </button>
              <button
                type="button"
                aria-label="重みを 0.1 上げる"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onChangeRate(0.1)}
                className={`bg-[var(--surface)] px-1 py-1.5 text-sm ${MONO}`}
                style={{ minHeight: "2rem" }}
              >
                :+0.1
              </button>
              {/* Row 3: 定型文 / Undo / Redo (inherited from the
                  abolished operation panel) + 3 blank cells that
                  keep the seamless 6-column grid look. */}
              <button
                type="button"
                aria-label="定型文を開く"
                aria-haspopup="dialog"
                aria-expanded={snippetPopupOpen}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setSnippetPopupOpen(true)}
                className="bg-[var(--surface)] px-1 py-1.5 text-sm font-medium"
                style={{ minHeight: "2rem", borderRight: "1px solid var(--border)", borderTop: "1px solid var(--border)" }}
              >
                ≡
              </button>
              <button
                type="button"
                aria-label="元に戻す"
                onMouseDown={(e) => e.preventDefault()}
                onClick={onUndo}
                disabled={!canUndo}
                className="flex items-center justify-center bg-[var(--surface)] px-1 py-1.5 disabled:opacity-40"
                style={{ minHeight: "2rem", borderRight: "1px solid var(--border)", borderTop: "1px solid var(--border)" }}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M9 14 4 9l5-5" />
                  <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
                </svg>
              </button>
              <button
                type="button"
                aria-label="やり直す"
                onMouseDown={(e) => e.preventDefault()}
                onClick={onRedo}
                disabled={!canRedo}
                className="flex items-center justify-center bg-[var(--surface)] px-1 py-1.5 disabled:opacity-40"
                style={{ minHeight: "2rem", borderRight: "1px solid var(--border)", borderTop: "1px solid var(--border)" }}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m15 14 5-5-5-5" />
                  <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13" />
                </svg>
              </button>
              <span aria-hidden="true" style={{ minHeight: "2rem", borderRight: "1px solid var(--border)", borderTop: "1px solid var(--border)" }} />
              <span aria-hidden="true" style={{ minHeight: "2rem", borderRight: "1px solid var(--border)", borderTop: "1px solid var(--border)" }} />
              <span aria-hidden="true" style={{ minHeight: "2rem", borderTop: "1px solid var(--border)" }} />
            </div>
            )}

            {/* --- image row (default view only): split 5:1 into
                the image display area and the history panel. The
                display area itself is the control surface (see
                sharedImageDisplay) — a tap switches to the
                Preview pane while an image is set and does
                nothing otherwise (uploading lives on the prompt
                row's source image area). The file input carries
                type="file" ONLY and deliberately NO accept
                attribute: an accept filter changes which picker
                UI mobile browsers present.
                The history panel (right, width ratio 1) stacks
                the merged preview list vertically, newest first:
                past generations' previews and upload-library
                thumbnails interleaved by time (saved images are
                not mixed in), each square with cover fit; only
                that preview column scrolls. Upload thumbnails
                carry a small 「↑ UP」 chip in their corner so
                they can be told apart from outputs. Tapping a
                preview of either kind sets that image as the
                Editor's current image (the same editor_source
                setting as 「Editorへ転送」, no pane move) and
                switches the generation mode to the i2i/inpaint
                side. The History button pinned at the panel's
                bottom opens the History pane. --- */}
            {!promptFocused && (
            <div
              className="grid min-h-0 min-w-0 border-t border-[var(--border)]"
              style={{ gridTemplateColumns: "5fr 1fr" }}
            >
              <div className="flex min-h-0 min-w-0 flex-col">
                {sharedImageDisplay}
                <input
                  ref={editorFileInputRef}
                  id="editor-image"
                  type="file"
                  aria-label="画像をアップロード"
                  className="sr-only"
                  style={{ minHeight: 0, height: "1px", width: "1px", margin: 0, padding: 0 }}
                  onChange={(e) => {
                    void onEditorImageChange(e.target.files?.[0] ?? null);
                    e.target.value = "";
                  }}
                />
              </div>
              <div
                className="flex min-h-0 min-w-0 flex-col border-l border-[var(--border)] bg-[var(--surface)]"
                role="group"
                aria-label="履歴パネル"
              >
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {mergedPreview.map((item) => {
                    if (item.kind === "upload") {
                      const u = item.upload;
                      const selectedUploadThumb =
                        editorSource.kind === "upload" &&
                        editorSource.uploadId === u.id;
                      return (
                        <button
                          key={`upload-${u.id}`}
                          type="button"
                          aria-label={`アップロード画像 ${u.fileName ?? u.storedName} を Editor に設定`}
                          onClick={() => setSourceFromUploadPreview(u)}
                          className="relative block aspect-square w-full overflow-hidden p-0"
                          style={{
                            minHeight: 0,
                            borderBottom: "1px solid var(--border)",
                            ...(selectedUploadThumb
                              ? { outline: "2px solid var(--accent2)", outlineOffset: "-2px" }
                              : {}),
                          }}
                        >
                          <img
                            src={(u.displayUrl ?? u.imageUrl) ?? undefined}
                            alt=""
                            className="block h-full w-full object-cover"
                          />
                          <span
                            aria-hidden="true"
                            className="absolute bottom-1 left-1 flex items-center justify-center border border-[var(--border)] bg-[var(--surface)] px-1 text-[10px] font-semibold leading-tight text-[var(--text)]"
                            style={{ minHeight: "1rem" }}
                          >
                            <svg
                              width="10"
                              height="10"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M12 19V5" />
                              <path d="M5 12l7-7 7 7" />
                            </svg>
                            UP
                          </span>
                        </button>
                      );
                    }
                    const j = item.job;
                    return j.canSendToEditor ? (
                      <button
                        key={`job-${j.id}`}
                        type="button"
                        aria-label={`履歴 ${j.id} の画像を Editor に設定`}
                        onClick={() => setSourceFromPreview(j)}
                        className="block aspect-square w-full overflow-hidden p-0"
                        style={{
                          minHeight: 0,
                          borderBottom: "1px solid var(--border)",
                          ...(editorSource.kind === "job" && editorSource.jobId === j.id
                            ? { outline: "2px solid var(--accent2)", outlineOffset: "-2px" }
                            : {}),
                        }}
                      >
                        <img
                          src={j.displayUrl ?? undefined}
                          alt=""
                          className="block h-full w-full object-cover"
                        />
                      </button>
                    ) : (
                      <div
                        key={`job-${j.id}`}
                        className="aspect-square w-full overflow-hidden"
                        style={{ borderBottom: "1px solid var(--border)" }}
                      >
                        <img
                          src={j.displayUrl ?? undefined}
                          alt=""
                          className="block h-full w-full object-cover"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            )}

            {/* --- operation panel (default view only): 2 rows x
                4 columns directly above the footer generate row.
                Top row: mode (txt2img / img2img(inpaint) toggle)
                / denoise / resize (Cover / Crop / Contain /
                Latent popup; plain img2img only — inpaint keeps
                its fixed crop) / list (routes to the History
                pane). Bottom row: model / style / blank /
                parameter (routes to the Parameter pane). Popups
                open upward over the image row, as before. --- */}
            {!promptFocused && (
            <div data-popup-area="true" className="relative shrink-0 border-t border-[var(--border)] bg-[var(--surface)]">
              {editorPopup != null && editorPopup !== "blur" && editorPopup !== "brush" && (
                <div className="absolute inset-x-0 bottom-full">{editorPopupContent}</div>
              )}
              <div
                className="grid"
                role="group"
                aria-label="操作パネル"
                style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}
              >
                <button
                  type="button"
                  aria-label="生成モード切り替え"
                  aria-pressed={img2imgChecked}
                  onClick={() => {
                    markSettingsImmediate();
                    setImg2imgChecked(!img2imgChecked);
                  }}
                  className={`flex flex-col items-center justify-center px-1 py-0 ${img2imgChecked ? "" : "bg-[var(--surface)]"}`}
                  style={{
                    minHeight: "2.5rem",
                    ...(img2imgChecked
                      ? { backgroundColor: "var(--accent)", color: "var(--accent-text)" }
                      : {}),
                  }}
                >
                  <span className={`text-[10px] leading-tight ${img2imgChecked ? "" : "text-[var(--dim)]"}`}>モード</span>
                  <span className={`text-sm font-semibold leading-tight ${MONO}`}>{modeSideLabel}</span>
                </button>
                <button
                  type="button"
                  aria-label="デノイズ設定"
                  aria-haspopup="dialog"
                  aria-expanded={editorPopup === "denoise"}
                  onClick={() => toggleEditorPopup("denoise")}
                  disabled={!img2imgChecked}
                  className="flex flex-col items-center justify-center bg-[var(--surface)] px-1 py-0 disabled:opacity-40"
                  style={{ minHeight: "2.5rem", borderLeft: "1px solid var(--border)" }}
                >
                  <span className="text-[10px] leading-tight text-[var(--dim)]">デノイズ</span>
                  <span className={`text-sm font-semibold leading-tight ${MONO}`}>{editorDenoise}</span>
                </button>
                <button
                  type="button"
                  aria-label="リサイズ方法選択"
                  aria-haspopup="dialog"
                  aria-expanded={editorPopup === "resize"}
                  onClick={() => toggleEditorPopup("resize")}
                  disabled={!img2imgChecked || maskPainted}
                  className="flex flex-col items-center justify-center bg-[var(--surface)] px-1 py-0 disabled:opacity-40"
                  style={{ minHeight: "2.5rem", borderLeft: "1px solid var(--border)" }}
                >
                  <span className="text-[10px] leading-tight text-[var(--dim)]">リサイズ</span>
                  <span className="text-sm font-semibold leading-tight">{img2imgChecked && maskPainted ? "Crop" : RESIZE_MODES[resizeMode]?.label}</span>
                </button>
                <button
                  type="button"
                  aria-label="リストペインへ移動"
                  onClick={() => switchTab("history")}
                  className="flex flex-col items-center justify-center bg-[var(--surface)] px-1 py-0"
                  style={{ minHeight: "2.5rem", borderLeft: "1px solid var(--border)" }}
                >
                  <span className="text-sm font-semibold leading-tight">リスト &gt;</span>
                </button>
                <button
                  type="button"
                  aria-label="モデル選択"
                  aria-haspopup="dialog"
                  aria-expanded={editorPopup === "model"}
                  onClick={() => toggleEditorPopup("model")}
                  className="flex flex-col items-center justify-center bg-[var(--surface)] px-1 py-0"
                  style={{ minHeight: "2.5rem", borderTop: "1px solid var(--border)" }}
                >
                  <span className="text-[10px] leading-tight text-[var(--dim)]">モデル</span>
                  <span className={`text-sm font-semibold leading-tight ${MONO}`}>{modelShortLabel(model)}</span>
                </button>
                <button
                  type="button"
                  aria-label="調整設定"
                  aria-haspopup="dialog"
                  aria-expanded={editorPopup === "style"}
                  onClick={() => toggleEditorPopup("style")}
                  className="flex flex-col items-center justify-center bg-[var(--surface)] px-1 py-0"
                  style={{ minHeight: "2.5rem", borderLeft: "1px solid var(--border)", borderTop: "1px solid var(--border)" }}
                >
                  <span className="text-[10px] leading-tight text-[var(--dim)]">調整</span>
                  <span className={`text-sm font-semibold leading-tight ${MONO}`}>{styleParams.length > 0 ? `(${styleParams.map((p) => formatTemplateValue(templateValues[p.label] ?? p.def, p.step)).join(", ")})` : "なし"}</span>
                </button>
                <span
                  aria-hidden="true"
                  style={{ minHeight: "2.5rem", borderLeft: "1px solid var(--border)", borderTop: "1px solid var(--border)" }}
                />
                <button
                  type="button"
                  aria-label="パラメータペインへ移動"
                  onClick={() => switchTab("parameters")}
                  className="flex flex-col items-center justify-center bg-[var(--surface)] px-1 py-0"
                  style={{ minHeight: "2.5rem", borderLeft: "1px solid var(--border)", borderTop: "1px solid var(--border)" }}
                >
                  <span className="text-sm font-semibold leading-tight">パラメータ &gt;</span>
                </button>
              </div>
            </div>
            )}
          </section>
        )}

        {/* ============ Inpaint pane: rows = image (with the mask
            canvas overlaid) / parameter panel (1 row x 4:
            変更範囲 / ブラー / 線幅 / ペン, 2.5rem — the same height
            as the Editor's parameter panel, no description text).
            Generating from here always uses the target image —
            an inpaint job when the mask has paint, plain img2img
            when it does not — regardless of the Editor mode
            toggle (see buildJobArgs). The image area shows the
            the img2img source image. */}
        {tab === "inpaint" && (
          <section
            aria-label="Inpaint"
            className="relative grid h-full min-h-0 min-w-0"
            style={{
              gridTemplateRows: "1fr auto",
              gridTemplateColumns: "minmax(0, 1fr)",
            }}
          >
            <div className="flex min-h-0 min-w-0 flex-col">
              {inpaintImageDisplay}
            </div>
            <div data-popup-area="true" className="relative shrink-0 border-t border-[var(--border)] bg-[var(--surface)]">
              {(editorPopup === "blur" || editorPopup === "brush") && (
                <div className="absolute inset-x-0 bottom-full">{editorPopupContent}</div>
              )}
              <div
                className="flex items-stretch"
                role="group"
                aria-label="Inpaintパラメータ"
                style={{ height: "2.5rem" }}
              >
                <button
                  type="button"
                  aria-label="変更範囲の切り替え"
                  aria-pressed={maskMode === "not masked"}
                  onClick={() => {
                    markSettingsImmediate();
                    setMaskMode((prev) => (prev === "masked" ? "not masked" : "masked"));
                  }}
                  className="flex flex-1 flex-col items-center justify-center bg-[var(--surface)] px-1 py-0"
                  style={{ minHeight: "2.5rem" }}
                >
                  <span className="text-[10px] leading-tight text-[var(--dim)]">変更範囲</span>
                  <span className={`text-sm font-semibold leading-tight ${MONO}`}>
                    {maskMode === "not masked" ? "outside" : "inside"}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label="ブラー設定"
                  aria-haspopup="dialog"
                  aria-expanded={editorPopup === "blur"}
                  onClick={() => toggleEditorPopup("blur")}
                  className="flex flex-1 flex-col items-center justify-center bg-[var(--surface)] px-1 py-0"
                  style={{ minHeight: "2.5rem", borderLeft: "1px solid var(--border)" }}
                >
                  <span className="text-[10px] leading-tight text-[var(--dim)]">ブラー</span>
                  <span className={`text-sm font-semibold leading-tight ${MONO}`}>{`${maskBlur}px`}</span>
                </button>
                <button
                  type="button"
                  aria-label="線幅設定"
                  aria-haspopup="dialog"
                  aria-expanded={editorPopup === "brush"}
                  onClick={() => toggleEditorPopup("brush")}
                  className="flex flex-1 flex-col items-center justify-center bg-[var(--surface)] px-1 py-0"
                  style={{ minHeight: "2.5rem", borderLeft: "1px solid var(--border)" }}
                >
                  <span className="text-[10px] leading-tight text-[var(--dim)]">線幅</span>
                  <span className={`text-sm font-semibold leading-tight ${MONO}`}>{`${brushSize}px`}</span>
                </button>
                <button
                  type="button"
                  aria-label="ペンと消しゴムの切り替え"
                  aria-pressed={penTool === "eraser"}
                  onClick={() => {
                    markSettingsImmediate();
                    setPenTool((prev) => (prev === "pen" ? "eraser" : "pen"));
                  }}
                  className="flex flex-1 flex-col items-center justify-center bg-[var(--surface)] px-1 py-0"
                  style={{ minHeight: "2.5rem", borderLeft: "1px solid var(--border)" }}
                >
                  <span className="text-[10px] leading-tight text-[var(--dim)]">モード</span>
                  <span className="text-sm font-semibold leading-tight">
                    {penTool === "eraser" ? "消しゴム" : "ペン"}
                  </span>
                </button>
              </div>
            </div>
          </section>
        )}

        {/* ============ Preview pane: the Editor's current image
            full-screen (the image display mirrors the Inpaint
            pane's), over a bottom thumbnail strip instead of the
            footer generate row (the footer is hidden on this
            pane). The strip is the merged preview list — outputs
            and uploads interleaved by time, newest first, left =
            newest — laid out in one horizontally scrolling row;
            tapping a thumbnail, or the image's left / right
            eighth, moves the preview through the list. The name
            plate (top-left) and the download / save / delete trio
            (bottom-right) are the Editor image area's own. The
            round pencil button (bottom-left) is the route into
            the Inpaint pane with the shown image; the round ×
            (top-right) closes back to the Editor. ============ */}
        {tab === "preview" && (
          <section
            aria-label="プレビュー"
            className="relative grid h-full min-h-0 min-w-0"
            style={{
              gridTemplateRows: "1fr auto",
              gridTemplateColumns: "minmax(0, 1fr)",
            }}
          >
            <div className="relative min-h-0 min-w-0">
              {editorSource.kind !== "none" && editorSource.displayUrl ? (
                <>
                  <div className="absolute inset-0 flex items-center justify-center bg-[var(--surface-alt)]">
                    <img
                      src={editorSource.displayUrl}
                      alt="現在の画像"
                      className="h-full w-full object-contain"
                    />
                  </div>
                  <button
                    type="button"
                    aria-label="左の画像へ移動"
                    disabled={previewIndex <= 0}
                    onClick={() => {
                      const item = mergedPreview[previewIndex - 1];
                      if (item) goToPreviewItem(item);
                    }}
                    className="absolute inset-y-0 left-0 w-[12.5%] cursor-pointer bg-transparent disabled:cursor-default"
                    style={{ minHeight: 0 }}
                  />
                  <button
                    type="button"
                    aria-label="右の画像へ移動"
                    disabled={
                      previewIndex < 0 ||
                      previewIndex >= mergedPreview.length - 1
                    }
                    onClick={() => {
                      const item = mergedPreview[previewIndex + 1];
                      if (item) goToPreviewItem(item);
                    }}
                    className="absolute inset-y-0 right-0 w-[12.5%] cursor-pointer bg-transparent disabled:cursor-default"
                    style={{ minHeight: 0 }}
                  />
                  {imageNamePlate("left-0")}
                  <button
                    type="button"
                    aria-label="プレビューを閉じる"
                    onClick={() => switchTab("editor")}
                    className="absolute right-2 top-2 z-10 flex items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                    style={{ width: "3.375rem", height: "3.375rem", minHeight: "3.375rem" }}
                  >
                    <svg
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      aria-hidden="true"
                    >
                      <path d="M6 6l12 12" />
                      <path d="M18 6L6 18" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    aria-label="Inpaintへ移動"
                    onClick={() => switchTab("inpaint")}
                    className="absolute bottom-2 left-2 z-10 flex items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                    style={{ width: "3.375rem", height: "3.375rem", minHeight: "3.375rem" }}
                  >
                    <svg
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                      <path d="m15 5 4 4" />
                    </svg>
                  </button>
                  {renderEditorImageButtons()}
                  {(saveNotice || saveError) && (
                    <p
                      role={saveError ? "alert" : "status"}
                      className="absolute bottom-2 max-w-[calc(100%-11rem)] border bg-[var(--surface)] px-3 py-2 text-sm"
                      style={{
                        left: "4.5rem",
                        borderColor: saveError ? "var(--err)" : "var(--ok)",
                        color: saveError ? "var(--err)" : "var(--ok)",
                      }}
                    >
                      {saveError ?? saveNotice}
                    </p>
                  )}
                  {uploadError && (
                    <p
                      role="alert"
                      className="absolute bottom-2 max-w-[calc(100%-11rem)] border border-[var(--err)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--err)]"
                      style={{ left: "4.5rem" }}
                    >
                      {uploadError}
                    </p>
                  )}
                </>
              ) : (
                <div className="absolute inset-0 flex items-center justify-center bg-[var(--surface-alt)]">
                  <span className="px-4 text-center text-sm text-[var(--dim)]">
                    画像はまだありません。Editor で画像を設定してください。
                  </span>
                </div>
              )}
            </div>
            <div
              className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)]"
              style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
            >
              <div
                ref={previewStripRef}
                className="flex overflow-x-auto"
                role="group"
                aria-label="画像一覧"
                style={{ height: "4.5rem" }}
              >
                {mergedPreview.map((item) => {
                  const current =
                    (item.kind === "job" &&
                      editorSource.kind === "job" &&
                      editorSource.jobId === item.job.id) ||
                    (item.kind === "upload" &&
                      editorSource.kind === "upload" &&
                      editorSource.uploadId != null &&
                      editorSource.uploadId === item.upload.id);
                  const thumbCls =
                    "relative block aspect-square h-full shrink-0 overflow-hidden p-0";
                  const thumbStyle = {
                    minHeight: 0,
                    borderRight: "1px solid var(--border)",
                    ...(current
                      ? {
                          outline: "2px solid var(--accent2)",
                          outlineOffset: "-2px",
                        }
                      : {}),
                  };
                  if (item.kind === "upload") {
                    const u = item.upload;
                    return (
                      <button
                        key={`upload-${u.id}`}
                        type="button"
                        data-current={current || undefined}
                        aria-label={`アップロード画像 ${u.fileName ?? u.storedName} を表示`}
                        onClick={() => goToPreviewItem(item)}
                        className={thumbCls}
                        style={thumbStyle}
                      >
                        <img
                          src={(u.displayUrl ?? u.imageUrl) ?? undefined}
                          alt=""
                          className="block h-full w-full object-cover"
                        />
                        <span
                          aria-hidden="true"
                          className="absolute bottom-1 left-1 flex items-center justify-center border border-[var(--border)] bg-[var(--surface)] px-1 text-[10px] font-semibold leading-tight text-[var(--text)]"
                          style={{ minHeight: "1rem" }}
                        >
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M12 19V5" />
                            <path d="M5 12l7-7 7 7" />
                          </svg>
                          UP
                        </span>
                      </button>
                    );
                  }
                  const j = item.job;
                  return j.canSendToEditor ? (
                    <button
                      key={`job-${j.id}`}
                      type="button"
                      data-current={current || undefined}
                      aria-label={`履歴 ${j.id} の画像を表示`}
                      onClick={() => goToPreviewItem(item)}
                      className={thumbCls}
                      style={thumbStyle}
                    >
                      <img
                        src={j.displayUrl ?? undefined}
                        alt=""
                        className="block h-full w-full object-cover"
                      />
                    </button>
                  ) : (
                    <div
                      key={`job-${j.id}`}
                      data-current={current || undefined}
                      className={thumbCls}
                      style={thumbStyle}
                    >
                      <img
                        src={j.displayUrl ?? undefined}
                        alt=""
                        className="block h-full w-full object-cover"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        )}

        {/* ============ Parameter pane: model / style controls
            moved to the Editor pane; this pane keeps seed, the
            editable negative prompt (fixed height), and the
            detailed generation settings. ============ */}
        {tab === "parameters" && (
          <section
            aria-label="生成パラメータ"
            className="h-full min-h-0 overflow-y-auto px-3 py-2"
            style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom))" }}
          >
            {/* Top row: the round 「<」 back button at the left
                returns to the Editor hub; the 「リロード」 button at
                the right reloads the page itself — the escape hatch
                when the phone-side client stalls, so the user can
                recover without force-stopping the app. Pending
                settings / prompt saves are flushed first so the
                workspace_state restore after the reload picks up
                the latest values, exactly as before. */}
            <div className="mb-2 flex items-center justify-between">
              {backToEditorButton}
              <button
                type="button"
                aria-label="ページをリロード"
                onClick={() => {
                  flushSettingsSave();
                  flushPromptSave();
                  // Give the flushed saves a moment to leave before
                  // the navigation tears the page down.
                  window.setTimeout(() => window.location.reload(), 350);
                }}
                className="flex shrink-0 items-center gap-1.5 border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)]"
                style={{ borderRadius: "var(--radius)", minHeight: "2.25rem" }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <path d="M21 3v6h-6" />
                </svg>
                リロード
              </button>
            </div>
            {/* Prompt template editor (per model): the draft is
                committed by the テンプレート保存 button above the
                textarea; committing a changed template resets the
                numeric parameter values to the new template's
                defaults. */}
            <div className="mb-2">
              <div className="mb-1 flex items-center justify-between">
                <label htmlFor="prompt-template" className={labelCls}>ポジティブプロンプトテンプレート</label>
                <button
                  type="button"
                  onClick={savePromptTemplate}
                  disabled={templateDraft === promptTemplate}
                  className="shrink-0 border px-2.5 py-1 text-xs font-medium rounded-[var(--radius)] disabled:opacity-40"
                  style={{
                    color: "var(--accent-text)",
                    backgroundColor: "var(--accent)",
                    borderColor: "var(--accent)",
                  }}
                >
                  テンプレート保存
                </button>
              </div>
              <textarea
                id="prompt-template"
                aria-label="ポジティブプロンプトテンプレート"
                value={templateDraft}
                onChange={(e) => setTemplateDraft(e.target.value)}
                className={`${inputCls} resize-none ${MONO}`}
                style={{ height: "5.5rem" }}
              />
              <p className="mt-1 text-xs text-[var(--dim)]">
                %prompt% にプロンプト本文が入り、%ラベル:最小:最大:ステップ:初期値% は調整パネルのスライダーになります。テンプレートを保存すると、数値パラメータは初期値に戻ります。
              </p>
            </div>
            <div className="grid gap-2">
              <div>
                <label htmlFor="negative-prompt" className={labelCls}>ネガティブプロンプト</label>
                <textarea
                  {...FIELDS.createJob.negativePrompt}
                  id="negative-prompt"
                  aria-label="ネガティブプロンプト"
                  value={negativePrompt}
                  onChange={(e) => setNegativePrompt(e.target.value)}
                  className={`${inputCls} resize-none`}
                  style={{ height: "7.5rem" }}
                />
                <p className="mt-1 text-xs text-[var(--dim)]">
                  この内容がそのままネガティブとして使われます（z-image では空になります）。初期値は標準ネガティブです。
                </p>
              </div>

              <div>
                <span className={labelCls}>seed</span>
                <div className="flex border border-[var(--border)]" role="group" aria-label="seed の決め方">
                  {(
                    [
                      { key: "random", label: "ランダム" },
                      { key: "fixed", label: "固定" },
                      { key: "reuse", label: "前回を再利用" },
                    ] as { key: SeedMode; label: string }[]
                  ).map((o, i) => (
                    <button
                      key={o.key}
                      type="button"
                      aria-pressed={seedMode === o.key}
                      onClick={() => { markSettingsImmediate(); setSeedMode(o.key); }}
                      className={`flex-1 px-2 py-2 text-sm ${
                        seedMode === o.key ? "" : "bg-[var(--surface)]"
                      }`}
                      style={{
                        borderLeft: i > 0 ? "1px solid var(--border)" : undefined,
                        ...(seedMode === o.key
                          ? { backgroundColor: "var(--accent)", color: "var(--accent-text)" }
                          : {}),
                      }}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                {seedMode === "fixed" && (
                  <input
                    {...FIELDS.createJob.seed}
                    aria-label="固定 seed の値"
                    inputMode="numeric"
                    value={seedText}
                    onChange={(e) => setSeedText(e.target.value)}
                    onBlur={flushSettingsSave}
                    placeholder="例: 123456789"
                    className={`${inputCls} ${MONO} mt-1`}
                  />
                )}
                {seedMode === "reuse" && (
                  <p className={`mt-1 text-sm text-[var(--dim)] ${MONO}`}>
                    {lastSeed != null ? `前回の seed: ${lastSeed}` : "再利用できる前回の seed がまだありません"}
                  </p>
                )}
              </div>

              <details>
                <summary className="cursor-pointer text-sm font-medium py-1">詳細設定（Steps / CFG / サンプラー / スケジューラ / inpaint 等）</summary>
                <div className="mt-1 grid grid-cols-2 gap-2">
                  <div>
                    <label htmlFor="steps" className="block text-xs text-[var(--dim)] mb-1">Steps</label>
                    <input {...FIELDS.createJob.steps} id="steps" inputMode="numeric" value={steps} onChange={(e) => setSteps(e.target.value)} onBlur={flushSettingsSave} className={`${inputCls} ${MONO}`} />
                  </div>
                  <div>
                    <label htmlFor="cfg" className="block text-xs text-[var(--dim)] mb-1">CFG</label>
                    <input {...FIELDS.createJob.cfg} id="cfg" inputMode="decimal" value={cfg} onChange={(e) => setCfg(e.target.value)} onBlur={flushSettingsSave} className={`${inputCls} ${MONO}`} />
                  </div>
                  <div>
                    <label htmlFor="sampler" className="block text-xs text-[var(--dim)] mb-1">サンプラー</label>
                    <select id="sampler" value={sampler} onChange={(e) => { markSettingsImmediate(); setSampler(e.target.value); }} className={inputCls}>
                      {SAMPLERS.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="scheduler" className="block text-xs text-[var(--dim)] mb-1">スケジューラ</label>
                    <select id="scheduler" value={scheduler} onChange={(e) => { markSettingsImmediate(); setScheduler(e.target.value); }} className={inputCls}>
                      {SCHEDULERS.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                </div>
                {/* The payload's formerly fixed values: every key
                    the client puts in the payload is now set here. */}
                <div className="mt-2 grid gap-2">
                  <SegmentedSetting
                    label="生成後にモデルを元に戻す（override_settings_restore_afterwards）"
                    options={[
                      { key: "on", label: "戻す" },
                      { key: "off", label: "戻さない" },
                    ]}
                    value={restoreAfterwards ? "on" : "off"}
                    onPick={(k) => { markSettingsImmediate(); setRestoreAfterwards(k === "on"); }}
                  />
                  <SegmentedSetting
                    label="inpaint の処理範囲（inpaint_full_res）"
                    options={[
                      { key: "whole", label: "全体（Whole picture）" },
                      { key: "masked", label: "マスク周辺のみ（Only masked）" },
                    ]}
                    value={inpaintFullRes ? "masked" : "whole"}
                    onPick={(k) => { markSettingsImmediate(); setInpaintFullRes(k === "masked"); }}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label htmlFor="inpainting-fill" className="block text-xs text-[var(--dim)] mb-1">inpaint の埋め方（inpainting_fill）</label>
                      <select id="inpainting-fill" value={inpaintingFill} onChange={(e) => { markSettingsImmediate(); setInpaintingFill(Number(e.target.value)); }} className={inputCls}>
                        <option value={0}>fill</option>
                        <option value={1}>original</option>
                        <option value={2}>latent noise</option>
                        <option value={3}>latent nothing</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor="inpaint-full-res-padding" className="block text-xs text-[var(--dim)] mb-1">Only masked の余白 px（inpaint_full_res_padding）</label>
                      <input id="inpaint-full-res-padding" inputMode="numeric" value={inpaintFullResPadding} onChange={(e) => setInpaintFullResPadding(e.target.value)} onBlur={flushSettingsSave} className={`${inputCls} ${MONO}`} />
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={resetModelSettings}
                  className="mt-3 w-full border px-3 py-2 text-sm font-medium rounded-[var(--radius)]"
                  style={{ color: "var(--err)", borderColor: "var(--err)", backgroundColor: "var(--surface)" }}
                >
                  選択中のモデルのパラメータをデフォルトに戻す
                </button>
              </details>

            </div>
          </section>
        )}

        {/* ============ History pane: rows = heading / list (internal scroll) ============ */}
        {tab === "history" && (
          <section
            aria-label="生成履歴"
            className="grid h-full min-h-0 min-w-0"
            style={{
              gridTemplateRows: "auto 1fr",
              gridTemplateColumns: "minmax(0, 1fr)",
              // The generate row is hidden on this pane, so the
              // section itself is the bottom-most element and
              // carries the safe-area inset.
              paddingBottom: "env(safe-area-inset-bottom)",
            }}
          >
            {/* --- heading / operation row + pane tabs --- */}
            <div className="border-b border-[var(--border)] px-3 py-1.5">
              <div className="flex items-center gap-1.5">
                {backToEditorButton}
                <h2 className="mr-auto text-sm font-semibold">生成履歴</h2>
                {historyTab === "output" && history.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={toggleSelectAll}
                      disabled={deletableJobs.length === 0}
                      className="border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-medium disabled:opacity-50 rounded-[var(--radius)]"
                      aria-label={allDeletableSelected ? "全解除" : "全選択"}
                    >
                      {allDeletableSelected ? "全解除" : "全選択"}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setDeleteError(null); setShowDeleteConfirm(true); }}
                      disabled={checkedIds.length === 0 || deleteJobs.isPending}
                      className="border px-3 py-2 text-sm font-medium disabled:opacity-50 rounded-[var(--radius)]"
                      style={{ color: "var(--err)", borderColor: "var(--border)", backgroundColor: "var(--surface)" }}
                      aria-label={`選択削除（${checkedIds.length}）`}
                    >
                      {`選択削除（${checkedIds.length}）`}
                    </button>
                  </>
                )}
                {historyTab === "saved" && savedImages.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={toggleSelectAllSaved}
                      className="border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-medium rounded-[var(--radius)]"
                      aria-label={allSavedSelected ? "全解除" : "全選択"}
                    >
                      {allSavedSelected ? "全解除" : "全選択"}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setSavedDeleteError(null); setShowSavedDeleteConfirm(true); }}
                      disabled={checkedSavedIds.length === 0 || deleteSaved.isPending}
                      className="border px-3 py-2 text-sm font-medium disabled:opacity-50 rounded-[var(--radius)]"
                      style={{ color: "var(--err)", borderColor: "var(--border)", backgroundColor: "var(--surface)" }}
                      aria-label={`保存画像の選択削除（${checkedSavedIds.length}）`}
                    >
                      {`選択削除（${checkedSavedIds.length}）`}
                    </button>
                  </>
                )}
                {historyTab === "uploads" && uploadImages.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={toggleSelectAllUploads}
                      className="border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-medium rounded-[var(--radius)]"
                      aria-label={allUploadsSelected ? "全解除" : "全選択"}
                    >
                      {allUploadsSelected ? "全解除" : "全選択"}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setUploadDeleteError(null); setShowUploadBulkDeleteConfirm(true); }}
                      disabled={checkedUploadIds.length === 0 || deleteUploads.isPending}
                      className="border px-3 py-2 text-sm font-medium disabled:opacity-50 rounded-[var(--radius)]"
                      style={{ color: "var(--err)", borderColor: "var(--border)", backgroundColor: "var(--surface)" }}
                      aria-label={`アップロード画像の選択削除（${checkedUploadIds.length}）`}
                    >
                      {`選択削除（${checkedUploadIds.length}）`}
                    </button>
                  </>
                )}
              </div>
              {/* Pane-local tabs: 「出力」 is the generation history
                  below as before; 「保存」 switches the list region
                  to the saved-image list. This is NOT a revival of
                  the hub navigation — it only switches this pane. */}
              <div className="mt-1.5 flex" role="tablist" aria-label="一覧の切り替え">
                <button
                  type="button"
                  role="tab"
                  aria-selected={historyTab === "output"}
                  onClick={() => setHistoryTab("output")}
                  className="flex-1 border border-[var(--border)] px-3 py-1.5 text-sm font-semibold rounded-l-[var(--radius)]"
                  style={
                    historyTab === "output"
                      ? { backgroundColor: "var(--accent)", color: "var(--accent-text)" }
                      : { backgroundColor: "var(--surface)", color: "var(--text)" }
                  }
                >
                  出力
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={historyTab === "saved"}
                  onClick={() => setHistoryTab("saved")}
                  className="flex-1 border border-l-0 border-[var(--border)] px-3 py-1.5 text-sm font-semibold"
                  style={
                    historyTab === "saved"
                      ? { backgroundColor: "var(--accent)", color: "var(--accent-text)" }
                      : { backgroundColor: "var(--surface)", color: "var(--text)" }
                  }
                >
                  保存
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={historyTab === "uploads"}
                  onClick={() => setHistoryTab("uploads")}
                  className="flex-1 border border-l-0 border-[var(--border)] px-3 py-1.5 text-sm font-semibold rounded-r-[var(--radius)]"
                  style={
                    historyTab === "uploads"
                      ? { backgroundColor: "var(--accent)", color: "var(--accent-text)" }
                      : { backgroundColor: "var(--surface)", color: "var(--text)" }
                  }
                >
                  アップロード
                </button>
              </div>
              {historyTab === "output" && deleteError && (
                <p className="mt-1 text-sm" style={{ color: "var(--err)" }} role="alert">{deleteError}</p>
              )}
              {historyTab === "saved" && savedDeleteError && (
                <p className="mt-1 text-sm" style={{ color: "var(--err)" }} role="alert">{savedDeleteError}</p>
              )}
              {historyTab === "uploads" && uploadDeleteError && (
                <p className="mt-1 text-sm" style={{ color: "var(--err)" }} role="alert">{uploadDeleteError}</p>
              )}
              {(saveNotice || saveError) && (
                <p
                  className="mt-1 text-sm"
                  style={{ color: saveError ? "var(--err)" : "var(--ok)" }}
                  role={saveError ? "alert" : "status"}
                >
                  {saveError ?? saveNotice}
                </p>
              )}
            </div>

            {/* --- list region (only this region scrolls) --- */}
            <div className="min-h-0 overflow-y-auto">
              {historyTab === "output" && (
              <>
              {/* selected job detail */}
              {selected != null && selected.status === "completed" && (
                <div className="border-b border-[var(--border)] px-3 py-2" aria-label="生成結果の詳細">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-base font-semibold">生成結果</h3>
                    <button
                      type="button"
                      onClick={() => setSelectedId(null)}
                      className="border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm rounded-[var(--radius)]"
                    >
                      閉じる
                    </button>
                  </div>
                  {selected.imageUrl && (
                    <img
                      src={selected.displayUrl ?? selected.imageUrl}
                      alt={`生成画像 seed ${selected.resultSeed ?? ""}`}
                      className="mt-2 w-full border border-[var(--border)]"
                    />
                  )}
                  <dl className={`mt-2 space-y-0.5 text-sm ${MONO}`}>
                    <div className="flex gap-2"><dt className="text-[var(--dim)] shrink-0">seed</dt><dd>{selected.resultSeed ?? "—"}</dd></div>
                    <div className="flex gap-2"><dt className="text-[var(--dim)] shrink-0">モデル</dt><dd>{modelLabel(selected.model)}</dd></div>
                    <div className="flex gap-2"><dt className="text-[var(--dim)] shrink-0">サイズ</dt><dd>{selected.width}×{selected.height}</dd></div>
                    {selected.mode === "img2img" && (
                      <div className="flex gap-2">
                        <dt className="text-[var(--dim)] shrink-0">処理</dt>
                        <dd>{`img2img（denoise ${selected.denoisingStrength ?? "—"}）`}</dd>
                      </div>
                    )}
                    <div className="flex gap-2">
                      <dt className="text-[var(--dim)] shrink-0">調整</dt>
                      <dd className="break-all">
                        {selected.photorealisticWeight == null && selected.comicloWeight == null
                          ? "未記録"
                          : baseStringOf(selected) ?? "付けない"}
                      </dd>
                    </div>
                    {selected.negativePrompt != null && (
                      <div className="flex gap-2">
                        <dt className="text-[var(--dim)] shrink-0">ネガティブ</dt>
                        <dd className="break-all">{selected.negativePrompt || "（空）"}</dd>
                      </div>
                    )}
                    {selected.loraHashes && (
                      <div className="flex gap-2"><dt className="text-[var(--dim)] shrink-0">LoRA</dt><dd className="break-all">{selected.loraHashes}</dd></div>
                    )}
                    <div className="flex gap-2"><dt className="text-[var(--dim)] shrink-0">時刻</dt><dd>{fmtTime(selected.createdAt)}</dd></div>
                  </dl>
                  {selected.usedParams && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-sm font-medium py-1">使用パラメータ（最終ペイロード）</summary>
                      <pre className={`mt-2 overflow-x-auto bg-[var(--surface-alt)] p-3 text-xs ${MONO}`}>
                        {(() => {
                          try {
                            return JSON.stringify(JSON.parse(selected.usedParams), null, 2);
                          } catch {
                            return selected.usedParams;
                          }
                        })()}
                      </pre>
                    </details>
                  )}
                  {selected.canSendToEditor ? (
                    <button
                      type="button"
                      onClick={() => transferToEditor(selected)}
                      className="mt-2 block w-full border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-center text-base font-semibold rounded-[var(--radius)]"
                      style={{ minHeight: "3rem" }}
                    >
                      Editorへ転送
                    </button>
                  ) : (
                    selected.imageUrl && (
                      <p className="mt-2 text-xs text-[var(--dim)]">
                        この画像は Editor へ転送できません（ホスト側の元ファイルパスが記録されていない生成です）。
                      </p>
                    )
                  )}
                  {selected.imageUrl && (
                    <div className="mt-2 flex gap-2">
                      <DownloadButton
                        url={selected.imageUrl}
                        fileName={`illu-sd-job${selected.id}-seed${selected.resultSeed ?? "x"}.png`}
                        onSettled={reconcileAfterDownload}
                        className="flex flex-1 items-center justify-center px-4 py-3 text-center text-base font-semibold rounded-[var(--radius)] disabled:opacity-50"
                        style={{ backgroundColor: "var(--accent2)", color: "var(--on-accent2)", minHeight: "3rem" }}
                      >
                        PNGをダウンロード
                      </DownloadButton>
                      <button
                        type="button"
                        onClick={() => {
                          setSaveNotice(null);
                          setSaveError(null);
                          saveImage.mutate(selected.id);
                        }}
                        disabled={
                          saveImage.isPending ||
                          !selected.canSendToEditor ||
                          selected.resultSeed == null
                        }
                        className="flex flex-1 items-center justify-center gap-2 border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-center text-base font-semibold disabled:opacity-50 rounded-[var(--radius)]"
                        style={{ minHeight: "3rem" }}
                        aria-label={`生成結果 ${selected.id} を保存`}
                      >
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
                          <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
                          <path d="M7 3v4a1 1 0 0 0 1 1h7" />
                        </svg>
                        {saveImage.isPending ? "保存中…" : "保存"}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {jobsQuery.isPending && <p className="px-3 py-2 text-sm text-[var(--dim)]">読み込み中…</p>}
              {jobsQuery.error && (
                <p className="px-3 py-2 text-sm" style={{ color: "var(--err)" }}>
                  履歴を読み込めませんでした。
                  <button type="button" onClick={() => void jobsQuery.refetch()} className="ml-2 underline">再読み込み</button>
                </p>
              )}
              {jobsQuery.data && history.length === 0 && (
                <p className="px-3 py-2 text-sm text-[var(--dim)]">まだ生成履歴がありません。</p>
              )}
              <ul>
                {history.map((j) => {
                  const deletable = isDeletable(j);
                  const isChecked = checkedIds.includes(j.id);
                  const title = j.prompt ?? "";
                  return (
                  <li key={j.id} className="border-b border-[var(--border)]">
                    <div className="flex w-full items-center gap-2 px-3 py-2">
                      <label
                        className={`flex shrink-0 items-center justify-center p-1 ${deletable ? "cursor-pointer" : "opacity-40"}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={!deletable}
                          onChange={(e) => toggleChecked(j.id, e.target.checked)}
                          className="h-5 w-5"
                          style={{ accentColor: "var(--accent)" }}
                          aria-label={`履歴 ${j.id} を選択`}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => j.status === "completed" && setSelectedId(j.id === selectedId ? null : j.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        aria-label={`履歴 ${j.id}: ${title}（${statusLabel(j)}）`}
                      >
                        {j.displayUrl ? (
                          <img src={j.displayUrl} alt="" className="h-16 w-16 shrink-0 object-cover" />
                        ) : (
                          <span className="flex h-16 w-16 shrink-0 items-center justify-center bg-[var(--surface-alt)] text-xs text-[var(--dim)]">
                            {statusLabel(j)}
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{title}</span>
                          <span className={`mt-0.5 block text-xs text-[var(--dim)] ${MONO}`}>
                            {`${modelLabel(j.model)} ・ ${j.width}×${j.height}${j.resultSeed != null ? ` ・ seed ${j.resultSeed}` : ""} ・ ${fmtTime(j.createdAt)}`}
                          </span>
                          {j.status === "failed" && (
                            <span className="mt-0.5 block text-xs" style={{ color: "var(--err)" }}>{j.error}</span>
                          )}
                          {isActive(j) && (
                            <span className="mt-0.5 block text-xs text-[var(--dim)]">
                              {phaseLabel(j) ?? statusLabel(j)} ・ このフェーズ {fmtElapsed(phaseSince(j), now)} ・ 全体 {fmtElapsed(j.createdAt, now)}
                            </span>
                          )}
                        </span>
                        <span
                          className="shrink-0 px-2.5 py-1 text-xs font-semibold"
                          style={{
                            color:
                              j.status === "completed"
                                ? "var(--ok)"
                                : j.status === "failed"
                                  ? "var(--err)"
                                  : "var(--accent2)",
                          }}
                        >
                          {statusLabel(j)}
                        </span>
                      </button>
                    </div>
                  </li>
                  );
                })}
              </ul>
              </>
              )}

              {historyTab === "saved" && (
              <>
              {/* selected saved-image detail */}
              {selectedSaved != null && (
                <div className="border-b border-[var(--border)] px-3 py-2" aria-label="保存画像の詳細">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-base font-semibold">保存画像</h3>
                    <button
                      type="button"
                      onClick={() => setSelectedSavedId(null)}
                      className="border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm rounded-[var(--radius)]"
                    >
                      閉じる
                    </button>
                  </div>
                  {selectedSaved.imageUrl && (
                    <img
                      src={selectedSaved.displayUrl ?? selectedSaved.imageUrl}
                      alt={`保存画像 ${selectedSaved.name}`}
                      className="mt-2 w-full border border-[var(--border)]"
                    />
                  )}
                  <dl className={`mt-2 space-y-0.5 text-sm ${MONO}`}>
                    <div className="flex gap-2"><dt className="text-[var(--dim)] shrink-0">名前</dt><dd>{selectedSaved.name}</dd></div>
                    <div className="flex gap-2"><dt className="text-[var(--dim)] shrink-0">seed</dt><dd>{selectedSaved.seed}</dd></div>
                    {selectedSaved.sourceJobId != null && (
                      <div className="flex gap-2"><dt className="text-[var(--dim)] shrink-0">元ジョブ</dt><dd>{selectedSaved.sourceJobId}</dd></div>
                    )}
                    {selectedSaved.sourceKind === "upload" && (
                      <div className="flex gap-2"><dt className="text-[var(--dim)] shrink-0">元画像</dt><dd>{`アップロード${selectedSaved.sourceUploadId != null ? ` #${selectedSaved.sourceUploadId}` : ""}`}</dd></div>
                    )}
                    <div className="flex gap-2"><dt className="text-[var(--dim)] shrink-0">時刻</dt><dd>{fmtTime(selectedSaved.createdAt)}</dd></div>
                  </dl>
                  {selectedSaved.imageUrl && (
                    <DownloadButton
                      url={selectedSaved.imageUrl}
                      fileName={`${selectedSaved.name}.${selectedSaved.fileExt}`}
                      onSettled={reconcileAfterDownload}
                      className="mt-2 block w-full px-4 py-3 text-center text-base font-semibold rounded-[var(--radius)] disabled:opacity-50"
                      style={{ backgroundColor: "var(--accent2)", color: "var(--on-accent2)", minHeight: "3rem" }}
                    >
                      {selectedSaved.fileExt === "jpg" ? "JPEGをダウンロード" : "PNGをダウンロード"}
                    </DownloadButton>
                  )}
                </div>
              )}

              {savedQuery.isPending && <p className="px-3 py-2 text-sm text-[var(--dim)]">読み込み中…</p>}
              {savedQuery.error && (
                <p className="px-3 py-2 text-sm" style={{ color: "var(--err)" }}>
                  保存一覧を読み込めませんでした。
                  <button type="button" onClick={() => void savedQuery.refetch()} className="ml-2 underline">再読み込み</button>
                </p>
              )}
              {savedQuery.data && savedImages.length === 0 && (
                <p className="px-3 py-2 text-sm text-[var(--dim)]">まだ保存した画像がありません。</p>
              )}
              <ul>
                {savedImages.map((s) => {
                  const isChecked = checkedSavedIds.includes(s.id);
                  const thumb = s.displayUrl ?? s.imageUrl;
                  return (
                  <li key={s.id} className="border-b border-[var(--border)]">
                    <div className="flex w-full items-center gap-2 px-3 py-2">
                      <label
                        className="flex shrink-0 cursor-pointer items-center justify-center p-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => toggleCheckedSaved(s.id, e.target.checked)}
                          className="h-5 w-5"
                          style={{ accentColor: "var(--accent)" }}
                          aria-label={`保存画像 ${s.name} を選択`}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => setSelectedSavedId(s.id === selectedSavedId ? null : s.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        aria-label={`保存画像 ${s.name}`}
                      >
                        {thumb ? (
                          <img src={thumb} alt="" className="h-16 w-16 shrink-0 object-cover" />
                        ) : (
                          <span className="flex h-16 w-16 shrink-0 items-center justify-center bg-[var(--surface-alt)] text-xs text-[var(--dim)]">
                            画像なし
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate text-sm font-medium ${MONO}`}>{s.name}</span>
                          <span className={`mt-0.5 block text-xs text-[var(--dim)] ${MONO}`}>
                            {`seed ${s.seed}${s.sourceKind === "upload" ? " ・ アップロードから保存" : ""} ・ ${fmtTime(s.createdAt)}`}
                          </span>
                        </span>
                      </button>
                      {s.imageUrl && (
                        <DownloadButton
                          url={s.imageUrl}
                          fileName={`${s.name}.${s.fileExt}`}
                          ariaLabel={`保存画像 ${s.name} をダウンロード`}
                          onSettled={reconcileAfterDownload}
                          className="flex shrink-0 items-center justify-center border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] rounded-[var(--radius)] disabled:opacity-50"
                          style={{ width: "2.25rem", height: "2.25rem", minHeight: "2.25rem" }}
                        >
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M12 4v11" />
                            <path d="M7 11l5 5 5-5" />
                            <path d="M4 20h16" />
                          </svg>
                        </DownloadButton>
                      )}
                    </div>
                  </li>
                  );
                })}
              </ul>
              </>
              )}

              {historyTab === "uploads" && (
              <>
              {/* selected upload detail: file facts only (name /
                  format / size / upload time) — uploads have no
                  generation parameters to show. Actions: set as
                  the Editor source (no mode change), download
                  under the original file name, save into the
                  saved-image area as "{counter}-0", and delete
                  (record + blobs + host file, one action). */}
              {selectedUpload != null && (
                <div className="border-b border-[var(--border)] px-3 py-2" aria-label="アップロード画像の詳細">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-base font-semibold">アップロード画像</h3>
                    <button
                      type="button"
                      onClick={() => setSelectedUploadId(null)}
                      className="border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm rounded-[var(--radius)]"
                    >
                      閉じる
                    </button>
                  </div>
                  {selectedUpload.imageUrl && (
                    <img
                      src={selectedUpload.displayUrl ?? selectedUpload.imageUrl}
                      alt={`アップロード画像 ${selectedUpload.fileName ?? selectedUpload.storedName}`}
                      className="mt-2 w-full border border-[var(--border)]"
                    />
                  )}
                  <dl className={`mt-2 space-y-0.5 text-sm ${MONO}`}>
                    <div className="flex gap-2"><dt className="text-[var(--dim)] shrink-0">ファイル名</dt><dd className="break-all">{selectedUpload.fileName ?? selectedUpload.storedName}</dd></div>
                    <div className="flex gap-2"><dt className="text-[var(--dim)] shrink-0">形式</dt><dd>{selectedUpload.mimeType === "image/png" ? "PNG" : selectedUpload.mimeType === "image/jpeg" ? "JPEG" : selectedUpload.mimeType}</dd></div>
                    <div className="flex gap-2"><dt className="text-[var(--dim)] shrink-0">サイズ</dt><dd>{fmtBytes(selectedUpload.byteSize)}</dd></div>
                    <div className="flex gap-2"><dt className="text-[var(--dim)] shrink-0">アップ時刻</dt><dd>{fmtTime(selectedUpload.createdAt)}</dd></div>
                  </dl>
                  {selectedUpload.prompt && (
                    <div className="mt-2">
                      <div className="text-sm text-[var(--dim)]">ポジティブプロンプト</div>
                      <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">{selectedUpload.prompt}</p>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => transferUploadToEditor(selectedUpload)}
                    className="mt-2 block w-full border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-center text-base font-semibold rounded-[var(--radius)]"
                    style={{ minHeight: "3rem" }}
                  >
                    Editorへセット
                  </button>
                  {selectedUpload.imageUrl && (
                    <div className="mt-2 flex gap-2">
                      <DownloadButton
                        url={selectedUpload.imageUrl}
                        fileName={selectedUpload.fileName ?? selectedUpload.storedName}
                        onSettled={reconcileAfterDownload}
                        className="flex flex-1 items-center justify-center px-4 py-3 text-center text-base font-semibold rounded-[var(--radius)] disabled:opacity-50"
                        style={{ backgroundColor: "var(--accent2)", color: "var(--on-accent2)", minHeight: "3rem" }}
                      >
                        ダウンロード
                      </DownloadButton>
                      <button
                        type="button"
                        onClick={() => {
                          setSaveNotice(null);
                          setSaveError(null);
                          saveUpload.mutate(selectedUpload.id);
                        }}
                        disabled={saveUpload.isPending}
                        className="flex flex-1 items-center justify-center gap-2 border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-center text-base font-semibold disabled:opacity-50 rounded-[var(--radius)]"
                        style={{ minHeight: "3rem" }}
                        aria-label={`アップロード画像 ${selectedUpload.fileName ?? selectedUpload.storedName} を保存`}
                      >
                        {saveUpload.isPending ? "保存中…" : "保存"}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setUploadDeleteError(null); setShowUploadDeleteConfirm(true); }}
                        className="flex flex-1 items-center justify-center border px-4 py-3 text-center text-base font-semibold rounded-[var(--radius)]"
                        style={{ color: "var(--err)", borderColor: "var(--border)", backgroundColor: "var(--surface)", minHeight: "3rem" }}
                        aria-label={`アップロード画像 ${selectedUpload.fileName ?? selectedUpload.storedName} を削除`}
                      >
                        削除
                      </button>
                    </div>
                  )}
                </div>
              )}

              {uploadsQuery.isPending && <p className="px-3 py-2 text-sm text-[var(--dim)]">読み込み中…</p>}
              {uploadsQuery.error && (
                <p className="px-3 py-2 text-sm" style={{ color: "var(--err)" }}>
                  アップロード一覧を読み込めませんでした。
                  <button type="button" onClick={() => void uploadsQuery.refetch()} className="ml-2 underline">再読み込み</button>
                </p>
              )}
              {uploadsQuery.data && uploadImages.length === 0 && (
                <p className="px-3 py-2 text-sm text-[var(--dim)]">まだアップロードした画像がありません。</p>
              )}
              <ul>
                {uploadImages.map((u) => {
                  const isChecked = checkedUploadIds.includes(u.id);
                  const thumb = u.displayUrl ?? u.imageUrl;
                  return (
                  <li key={u.id} className="border-b border-[var(--border)]">
                    <div className="flex w-full items-center gap-2 px-3 py-2">
                      <label
                        className="flex shrink-0 cursor-pointer items-center justify-center p-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => toggleCheckedUpload(u.id, e.target.checked)}
                          className="h-5 w-5"
                          style={{ accentColor: "var(--accent)" }}
                          aria-label={`アップロード画像 ${u.fileName ?? u.storedName} を選択`}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => setSelectedUploadId(u.id === selectedUploadId ? null : u.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        aria-label={`アップロード画像 ${u.fileName ?? u.storedName}`}
                      >
                        {thumb ? (
                          <img src={thumb} alt="" className="h-16 w-16 shrink-0 object-cover" />
                        ) : (
                          <span className="flex h-16 w-16 shrink-0 items-center justify-center bg-[var(--surface-alt)] text-xs text-[var(--dim)]">
                            画像なし
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{u.fileName ?? u.storedName}</span>
                          <span className={`mt-0.5 block text-xs text-[var(--dim)] ${MONO}`}>
                            {`${fmtTime(u.createdAt)} ・ ${fmtBytes(u.byteSize)}`}
                          </span>
                        </span>
                      </button>
                    </div>
                  </li>
                  );
                })}
              </ul>
              </>
              )}
            </div>
          </section>
        )}
      </main>

      {/* --- footer generate row (the only fixed bottom row —
          there is no tab bar; shown on every pane except
          History and Preview — the Preview pane's bottom row is
          its thumbnail strip instead): generate button (about
          2/3, its label doubles
          as the job status display) + size popup toggle (about
          1/3, labelled with the current dimensions as
          "width×height"; a dot at its top-right corner flags
          that those dimensions differ from the displayed
          image's own pixel size). The size popup opens directly above
          this row and never covers it; the size button itself
          toggles it, and a tap anywhere outside the popup closes
          it (the document-level outside-pointer-down handler at
          the sizePopupOpen state). The row carries the Android
          safe-area bottom padding itself now that it is the
          bottom-most element. --- */}
      {tab !== "history" && tab !== "preview" && (
        <div
          className="relative border-t border-[var(--border)] bg-[var(--surface)]"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          {sizePopupOpen && (
              <div
                className="absolute inset-x-0 bottom-full z-50 flex justify-center"
                role="dialog"
                aria-modal="true"
                aria-label="サイズ選択"
              >
                <div
                  ref={sizePopupRef}
                  className="flex w-full max-w-md flex-col border border-b-0 border-[var(--border)] bg-[var(--surface)] p-4"
                  // Bottom padding is the plain p-4 1rem only. This
                  // panel is NOT flush with the viewport bottom — it
                  // sits directly above the generate row (3.2rem),
                  // and the generate row already carries the
                  // Android safe-area bottom padding
                  // (env(safe-area-inset-bottom)) at the real screen
                  // edge. Adding the same inset inside this panel as
                  // well double-counted it and showed up as an extra
                  // blank strip under the width/height inputs.
                  // The panel may use the height up to just under
                  // the shell header (8rem + the generate row's
                  // 1.2rem growth = 9.2rem); together with the
                  // height-capped aspect grid, the whole popup fits
                  // without scrolling.
                  style={{
                    maxHeight: "calc(100dvh - 9.2rem)",
                  }}
                >
                  {/* No title row. The popup's bottom row is the
                      「画像サイズをあわせる」 button: enabled only
                      while the SOURCE image's own pixel size
                      differs from the form's width/height
                      (sizeMismatch — the same condition that shows
                      the size button's corner dot); pressing it
                      adopts the source image's dimensions
                      verbatim. */}
                  <div className="min-h-0 overflow-y-auto">{sizeSettings}</div>
                  <button
                    type="button"
                    onClick={applyImageSize}
                    disabled={!sizeMismatch}
                    className="mt-3 w-full shrink-0 border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-medium disabled:opacity-40 rounded-[var(--radius)]"
                  >
                    画像サイズをあわせる
                  </button>
                </div>
              </div>
          )}
          {formError && (
            <p className="px-3 pt-2 text-sm" style={{ color: "var(--err)" }} role="alert">{formError}</p>
          )}
          {/* The popup opens above this row and never covers it:
              the size button receives its own taps (it is the
              popup's toggle), and Generate stays tappable while the
              popup is open. Both buttons centre their labels
              vertically with flex alignment. */}
          <div className="flex" style={{ position: "relative", zIndex: 50 }}>
            <button
              type="button"
              onClick={submit}
              disabled={createJob.isPending || prompt.trim() === ""}
              className="flex min-w-0 flex-[2] items-center justify-center px-2 py-1 text-sm font-semibold disabled:opacity-50"
              style={{ backgroundColor: "var(--accent2)", color: "var(--on-accent2)", height: "3.2rem", minHeight: "3.2rem" }}
            >
              {generateSubLabel != null ? (
                <span className="flex min-w-0 flex-col items-center justify-center">
                  <span className="leading-tight">{generateLabel}</span>
                  <span className="max-w-full truncate text-[10px] font-normal leading-tight opacity-90">
                    {generateSubLabel}
                  </span>
                </span>
              ) : (
                <span className="min-w-0 truncate">{generateLabel}</span>
              )}
            </button>
            <button
              ref={sizeToggleRef}
              type="button"
              aria-label="サイズ選択を開く"
              aria-haspopup="dialog"
              aria-expanded={sizePopupOpen}
              onClick={() => setSizePopupOpen((v) => !v)}
              className="relative flex min-w-0 flex-1 flex-col items-center justify-center bg-[var(--surface)] px-2 py-1"
              style={{ height: "3.2rem", minHeight: "3.2rem", borderLeft: "1px solid var(--border)" }}
            >
              <span className={`text-sm font-medium leading-tight ${MONO}`}>{`${width}×${height}`}</span>
              {sizeKey != null && (
                <span className={`text-[10px] leading-tight text-[var(--dim)] ${MONO}`}>
                  {`${sizeKey} (${pixelSize ?? DEFAULT_PIXEL_SIZE}p)`}
                </span>
              )}
              {/* Size-mismatch dot (top-right corner): shown
                  only while a SOURCE image is set whose own
                  pixel size differs from the size selected
                  here — a quiet hint that generating at the
                  current size would not match the img2img
                  init image in the source area. */}
              {sizeMismatch && (
                <span
                  aria-hidden="true"
                  className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full"
                  style={{ backgroundColor: "var(--accent2)" }}
                />
              )}
            </button>
          </div>
        </div>
      )}

      {/* --- text snippet popup (selection / toggle / edit / add) --- */}
      {snippetPopupOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
          style={{ backgroundColor: "rgba(38,24,58,0.55)" }}
          role="dialog"
          aria-modal="true"
          aria-label="定型文スニペット"
          onClick={closeSnippetPopup}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-md flex-col border border-[var(--border)] bg-[var(--surface)] rounded-[var(--radius)]"
            // The sheet is flush with the viewport's bottom edge, so
            // its bottom content would sit under the Android 3-button
            // navigation bar. Add the safe-area inset to the panel's
            // bottom padding, like the footer generate row.
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header row: no title — the new-snippet 「＋」 sits
                where the title was (left), the close 「✕」 is
                right-aligned. */}
            <div className="flex items-center justify-between px-1.5 py-1">
              <button
                type="button"
                aria-label="スニペットを追加"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setSnippetEditError(null); setSnippetEdit({ index: null, value: "" }); }}
                className="shrink-0 px-2.5 py-1 text-base font-medium"
                style={{ minHeight: "2rem" }}
              >
                ＋
              </button>
              <button
                type="button"
                aria-label="定型文を閉じる"
                onClick={closeSnippetPopup}
                className="shrink-0 px-2.5 py-1 text-base"
                style={{ minHeight: "2rem" }}
              >
                ✕
              </button>
            </div>

            {/* Snippet list: seamless rows sharing edges — no gaps,
                no margins around or between rows, so the freed width
                goes to the snippet text, which wraps instead of
                truncating. */}
            <div className="min-h-0 overflow-y-auto border-t border-[var(--border)]">
              {snippets.length === 0 && !snippetEdit && (
                <p className="px-2 py-2 text-sm text-[var(--dim)]">登録済みの定型文はありません。</p>
              )}
              <ul>
                {snippets.map((text, index) => {
                  // Port of TextSelector.updateToggleStates: recomputed
                  // on every prompt change.
                  const toggled = findPromptTextMatch(prompt, text) !== null;
                  const editing = snippetEdit?.index === index;
                  return (
                    <li
                      key={`${index}-${text}`}
                      className={index > 0 ? "border-t border-[var(--border)]" : undefined}
                    >
                      <div
                        className={`flex items-stretch ${toggled ? "" : "bg-[var(--surface)]"}`}
                        style={
                          toggled
                            ? { backgroundColor: "var(--accent)", color: "var(--accent-text)" }
                            : undefined
                        }
                      >
                        <button
                          type="button"
                          aria-label={`スニペット「${text}」を切り替え`}
                          aria-pressed={toggled}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => onToggleSnippet(text)}
                          className="min-w-0 flex-1 whitespace-normal break-words px-2 py-1.5 text-left text-sm"
                          style={{ minHeight: "2.25rem" }}
                        >
                          {text}
                        </button>
                        <button
                          type="button"
                          aria-label={`スニペット「${text}」を編集`}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => { setSnippetEditError(null); setSnippetEdit({ index, value: text }); }}
                          className="shrink-0 px-2.5 text-sm opacity-70"
                          style={{ minHeight: "2.25rem" }}
                        >
                          ✎
                        </button>
                      </div>
                      {editing && <div className="px-2 py-1.5">{snippetEditor}</div>}
                    </li>
                  );
                })}
              </ul>

              {snippetEdit?.index == null && (
                <div className="border-t border-[var(--border)] px-2 py-1.5">{snippetEditor}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* --- editor image delete confirmation dialog (job and
          upload sources alike; the confirm dispatches to the
          matching delete, each pre-resolved with the merged
          list's next image) --- */}
      {showEditorDeleteConfirm &&
        ((editorSource.kind === "job" && editorSource.jobId != null) ||
          (editorSource.kind === "upload" && editorSource.uploadId != null)) && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ backgroundColor: "rgba(38,24,58,0.55)" }}
            role="dialog"
            aria-modal="true"
            aria-label="画像削除の確認"
            onClick={() => setShowEditorDeleteConfirm(false)}
          >
            <div
              className="w-full max-w-sm border border-[var(--border)] bg-[var(--surface)] p-5 rounded-[var(--radius)]"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-base font-semibold">この画像を削除しますか？</h3>
              <p className="mt-2 text-sm text-[var(--text)]">
                {editorSource.kind === "job"
                  ? `生成画像 ${editorSource.jobId}-${editorSource.resultSeed ?? "x"} を履歴から削除します。`
                  : `アップロード画像「${editorImageName}」を削除します。保存したコピーは削除されません。`}
              </p>
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowEditorDeleteConfirm(false)}
                  className="flex-1 border border-[var(--border)] bg-[var(--surface-alt)] px-4 py-2.5 text-sm font-medium rounded-[var(--radius)]"
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (editorSource.kind === "job" && editorSource.jobId != null) {
                      deleteEditorJob.mutate({
                        jobId: editorSource.jobId,
                        next: nextEditorImage(editorSource.jobId),
                      });
                    } else if (
                      editorSource.kind === "upload" &&
                      editorSource.uploadId != null
                    ) {
                      deleteEditorUpload.mutate({
                        uploadId: editorSource.uploadId,
                        next: nextEditorImageForUpload(editorSource.uploadId),
                      });
                    }
                  }}
                  disabled={deleteEditorJob.isPending || deleteEditorUpload.isPending}
                  className="flex-1 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 rounded-[var(--radius)]"
                  style={{ backgroundColor: "var(--err)" }}
                >
                  {deleteEditorJob.isPending || deleteEditorUpload.isPending
                    ? "削除中…"
                    : "削除する"}
                </button>
              </div>
            </div>
          </div>
        )}

      {/* --- delete confirmation dialog --- */}
      {showDeleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: "rgba(38,24,58,0.55)" }}
          role="dialog"
          aria-modal="true"
          aria-label="履歴削除の確認"
          onClick={() => setShowDeleteConfirm(false)}
        >
          <div
            className="w-full max-w-sm border border-[var(--border)] bg-[var(--surface)] p-5 rounded-[var(--radius)]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold">履歴を削除しますか？</h3>
            <p className="mt-2 text-sm text-[var(--text)]">
              {`選択した ${checkedIds.length} 件の履歴を削除します。`}
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 border border-[var(--border)] bg-[var(--surface-alt)] px-4 py-2.5 text-sm font-medium rounded-[var(--radius)]"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => deleteJobs.mutate([...checkedIds])}
                disabled={deleteJobs.isPending || checkedIds.length === 0}
                className="flex-1 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 rounded-[var(--radius)]"
                style={{ backgroundColor: "var(--err)" }}
              >
                {deleteJobs.isPending ? "削除中…" : "削除する"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- upload-image delete confirmation dialog --- */}
      {showUploadDeleteConfirm && selectedUpload != null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: "rgba(38,24,58,0.55)" }}
          role="dialog"
          aria-modal="true"
          aria-label="アップロード画像削除の確認"
          onClick={() => setShowUploadDeleteConfirm(false)}
        >
          <div
            className="w-full max-w-sm border border-[var(--border)] bg-[var(--surface)] p-5 rounded-[var(--radius)]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold">アップロード画像を削除しますか？</h3>
            <p className="mt-2 text-sm text-[var(--text)]">
              {`「${selectedUpload.fileName ?? selectedUpload.storedName}」を削除します。保存したコピーは削除されません。`}
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setShowUploadDeleteConfirm(false)}
                className="flex-1 border border-[var(--border)] bg-[var(--surface-alt)] px-4 py-2.5 text-sm font-medium rounded-[var(--radius)]"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => deleteUpload.mutate(selectedUpload.id)}
                disabled={deleteUpload.isPending}
                className="flex-1 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 rounded-[var(--radius)]"
                style={{ backgroundColor: "var(--err)" }}
              >
                {deleteUpload.isPending ? "削除中…" : "削除する"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- saved-image delete confirmation dialog --- */}
      {showSavedDeleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: "rgba(38,24,58,0.55)" }}
          role="dialog"
          aria-modal="true"
          aria-label="保存画像削除の確認"
          onClick={() => setShowSavedDeleteConfirm(false)}
        >
          <div
            className="w-full max-w-sm border border-[var(--border)] bg-[var(--surface)] p-5 rounded-[var(--radius)]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold">保存画像を削除しますか？</h3>
            <p className="mt-2 text-sm text-[var(--text)]">
              {`選択した ${checkedSavedIds.length} 件の保存画像を削除します。元の生成結果は削除されません。`}
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setShowSavedDeleteConfirm(false)}
                className="flex-1 border border-[var(--border)] bg-[var(--surface-alt)] px-4 py-2.5 text-sm font-medium rounded-[var(--radius)]"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => deleteSaved.mutate([...checkedSavedIds])}
                disabled={deleteSaved.isPending || checkedSavedIds.length === 0}
                className="flex-1 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 rounded-[var(--radius)]"
                style={{ backgroundColor: "var(--err)" }}
              >
                {deleteSaved.isPending ? "削除中…" : "削除する"}
              </button>
            </div>
          </div>
        </div>
      )}
      {showUploadBulkDeleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: "rgba(38,24,58,0.55)" }}
          role="dialog"
          aria-modal="true"
          aria-label="アップロード画像削除の確認"
          onClick={() => setShowUploadBulkDeleteConfirm(false)}
        >
          <div
            className="w-full max-w-sm border border-[var(--border)] bg-[var(--surface)] p-5 rounded-[var(--radius)]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold">アップロード画像を削除しますか？</h3>
            <p className="mt-2 text-sm text-[var(--text)]">
              {`選択した ${checkedUploadIds.length} 件のアップロード画像を削除します。`}
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setShowUploadBulkDeleteConfirm(false)}
                className="flex-1 border border-[var(--border)] bg-[var(--surface-alt)] px-4 py-2.5 text-sm font-medium rounded-[var(--radius)]"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => deleteUploads.mutate([...checkedUploadIds])}
                disabled={deleteUploads.isPending || checkedUploadIds.length === 0}
                className="flex-1 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 rounded-[var(--radius)]"
                style={{ backgroundColor: "var(--err)" }}
              >
                {deleteUploads.isPending ? "削除中…" : "削除する"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
