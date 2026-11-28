// In-browser port of mock/server.mjs for the temporary Pages
// preview build (see backend.mock.ts). The logic mirrors the
// Bun mock server action-for-action — same state machine, same
// response shapes, same fixtures — with the file system
// replaced by an in-memory byte map surfaced through cached
// blob URLs, and the fixture images bundled as build assets.
// State lives in module memory only: a reload reseeds, exactly
// like restarting the Bun mock. Used ONLY by the MOCK_PAGES
// build; the standard build never imports this module.

import sample1PngUrl from "../mock/fixtures/sample-1.png";
import sample1JpgUrl from "../mock/fixtures/sample-1.display.jpg";
import sample2PngUrl from "../mock/fixtures/sample-2.png";
import sample2JpgUrl from "../mock/fixtures/sample-2.display.jpg";
import sample3PngUrl from "../mock/fixtures/sample-3.png";
import sample3JpgUrl from "../mock/fixtures/sample-3.display.jpg";
import seedDictionaryJson from "../mock/fixtures/dictionary.json";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = { [key: string]: any };

const nowIso = () => new Date().toISOString();

// --- file store (bytes in memory, blob URLs cached per key) --------------
const files = new Map<string, Uint8Array>();
const blobUrls = new Map<string, string>();

function mimeFor(key: string): string {
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".jpg") || key.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

function fileUrl(key: string | null | undefined): string | null {
  if (!key) return null;
  const cached = blobUrls.get(key);
  if (cached) return cached;
  const bytes = files.get(key);
  if (!bytes) return null;
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: mimeFor(key) }),
  );
  blobUrls.set(key, url);
  return url;
}

function putFile(key: string, bytes: Uint8Array) {
  files.set(key, bytes);
  const old = blobUrls.get(key);
  if (old) {
    URL.revokeObjectURL(old);
    blobUrls.delete(key);
  }
}

function deleteFile(key: string | null | undefined) {
  if (!key) return;
  files.delete(key);
  const old = blobUrls.get(key);
  if (old) {
    URL.revokeObjectURL(old);
    blobUrls.delete(key);
  }
}

// --- base64 ---------------------------------------------------------------
function b64Decode(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- fixtures ---------------------------------------------------------------
const FIXTURE_URLS: Record<string, string> = {
  "sample-1.png": sample1PngUrl,
  "sample-1.display.jpg": sample1JpgUrl,
  "sample-2.png": sample2PngUrl,
  "sample-2.display.jpg": sample2JpgUrl,
  "sample-3.png": sample3PngUrl,
  "sample-3.display.jpg": sample3JpgUrl,
};
const fixtureBytes = new Map<string, Uint8Array>();

async function loadFixtures() {
  for (const [name, url] of Object.entries(FIXTURE_URLS)) {
    const res = await fetch(url);
    fixtureBytes.set(name, new Uint8Array(await res.arrayBuffer()));
  }
}

function copyFixtureTo(sampleFile: string, key: string) {
  const bytes = fixtureBytes.get(sampleFile);
  if (bytes) putFile(key, bytes);
}

// --- state ------------------------------------------------------------------
const SAMPLES = ["sample-1", "sample-2", "sample-3"];
const MODEL_STEPS: Record<string, number> = {
  "Template A": 20,
  "Template B": 20,
  "Template C": 10,
};
const GEN_MS = 7000; // simulated generation duration

const state: Rec = {
  jobs: new Map<number, Rec>(),
  uploads: new Map<number, Rec>(),
  saved: new Map<number, Rec>(),
  nextJobId: 1,
  nextUploadId: 1,
  nextSavedId: 1,
  editor: null as Rec | null,
  source: null as Rec | null,
  dictionary: structuredClone(seedDictionaryJson) as Rec,
  snippets: JSON.stringify(["masterpiece, best quality", "1girl, solo"]),
  settings: "",
  prompt: "",
  saveIndex: 12719,
};

function seedJob(
  id: number,
  model: string,
  prompt: string,
  width: number,
  height: number,
  seed: number,
  sample: string,
  createdAt: string,
) {
  state.jobs.set(id, {
    id, kind: "generate", status: "completed", phase: null,
    phaseUpdatedAt: createdAt, model, prompt,
    negativePrompt: "low quality, blurry",
    width, height, seedMode: "random", seedInput: null,
    steps: 20, cfg: 5.5, sampler: "DPM++ 2M", scheduler: "Karras",
    mode: "txt2img", denoisingStrength: null,
    resultSeed: seed, imageKey: `jobs/${id}.png`,
    displayKey: `jobs/${id}.display.jpg`,
    usedParams: JSON.stringify({ prompt, steps: MODEL_STEPS[model] }),
    loraHashes: null, error: null,
    createdAt, updatedAt: createdAt, startedAt: 0, sample,
  });
  state.nextJobId = id + 1;
}

function seed() {
  const t = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  seedJob(1, "Template A", "1girl, solo, seaside, summer", 1088, 1472, 1111111111, "sample-1", iso(t - 7200e3));
  seedJob(2, "Template B", "scenery, mountain, lake, sunset", 1472, 1088, 2222222222, "sample-2", iso(t - 3600e3));
  seedJob(3, "Template C", "scenery, city, night, neon", 1984, 832, 3333333333, "sample-3", iso(t - 1800e3));
  for (const job of state.jobs.values()) {
    copyFixtureTo(`${job.sample}.png`, job.imageKey);
    copyFixtureTo(`${job.sample}.display.jpg`, job.displayKey);
  }
  state.saveIndex = 12719;
  copyFixtureTo("sample-1.png", "saved/12713-3035825825.png");
  copyFixtureTo("sample-1.display.jpg", "saved/12713-3035825825.display.jpg");
  copyFixtureTo("sample-2.png", "saved/12719-0.png");
  state.saved.set(1, {
    id: 1, counter: 12713, seed: 3035825825, sourceJobId: 1,
    sourceKind: "job", sourceUploadId: null, fileExt: "png",
    imageKey: "saved/12713-3035825825.png",
    displayKey: "saved/12713-3035825825.display.jpg",
    createdAt: iso(t - 3500e3),
  });
  state.nextSavedId = 2;
  state.editor = { kind: "job", jobId: 3 };
  state.source = null;
}

let seedPromise: Promise<void> | null = null;
function ensureSeeded(): Promise<void> {
  seedPromise ??= (async () => {
    await loadFixtures();
    seed();
  })();
  return seedPromise;
}

// --- views (mirror mock/server.mjs) ----------------------------------------
function jobView(j: Rec) {
  const completed = j.status === "completed";
  return {
    id: j.id, kind: j.kind, status: j.status,
    phase: j.phase, phaseUpdatedAt: j.phaseUpdatedAt, model: j.model,
    prompt: j.prompt,
    negativePrompt: j.negativePrompt, width: j.width, height: j.height,
    seedMode: j.seedMode, seedInput: j.seedInput, steps: j.steps,
    cfg: j.cfg, sampler: j.sampler, scheduler: j.scheduler,
    mode: j.mode,
    denoisingStrength: j.denoisingStrength,
    canSendToEditor: completed && !!j.imageKey,
    resultSeed: j.resultSeed,
    imageUrl: completed ? fileUrl(j.imageKey) : null,
    displayUrl: completed ? fileUrl(j.displayKey || j.imageKey) : null,
    usedParams: j.usedParams, loraHashes: j.loraHashes,
    error: j.error, createdAt: j.createdAt, updatedAt: j.updatedAt,
  };
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The positive prompt embedded in a PNG's WebUI infotext —
// mirrors extractPngPrompt in mock/server.mjs (zTXt/iTXt go
// through DecompressionStream instead of node:zlib).
async function extractPngPrompt(bytes: Uint8Array): Promise<string | null> {
  const texts: Record<string, string> = {};
  const ascii = (arr: Uint8Array) =>
    String.fromCharCode(...arr);
  const utf8 = (arr: Uint8Array) => new TextDecoder("utf-8").decode(arr);
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const length =
      ((bytes[pos] ?? 0) << 24) |
      ((bytes[pos + 1] ?? 0) << 16) |
      ((bytes[pos + 2] ?? 0) << 8) |
      (bytes[pos + 3] ?? 0);
    const type = ascii(bytes.subarray(pos + 4, pos + 8));
    const chunk = bytes.subarray(pos + 8, pos + 8 + length);
    if (chunk.length < length) break;
    pos += 8 + length + 4;
    if (type === "IEND") break;
    try {
      if (type === "tEXt") {
        const i = chunk.indexOf(0);
        texts[ascii(chunk.subarray(0, i))] = utf8(chunk.subarray(i + 1));
      } else if (type === "zTXt") {
        const i = chunk.indexOf(0);
        if (chunk[i + 1] === 0) {
          texts[ascii(chunk.subarray(0, i))] = utf8(
            await inflateZlib(chunk.subarray(i + 2)),
          );
        }
      } else if (type === "iTXt") {
        const i = chunk.indexOf(0);
        const compressed = chunk[i + 1];
        let rest = chunk.subarray(i + 3);
        rest = rest.subarray(rest.indexOf(0) + 1);
        let text = rest.subarray(rest.indexOf(0) + 1);
        if (compressed === 1) text = await inflateZlib(text);
        texts[utf8(chunk.subarray(0, i))] = utf8(text);
      }
    } catch { /* skip malformed chunks */ }
  }
  if (texts.parameters) {
    const lines = texts.parameters.split("\n");
    if (lines.length && lines[lines.length - 1]?.startsWith("Steps: ")) lines.pop();
    const out: string[] = [];
    for (const line of lines) {
      if (line.startsWith("Negative prompt:")) break;
      out.push(line);
    }
    return out.join("\n").trim() || null;
  }
  if (texts.prompt) return texts.prompt.trim() || null;
  return null;
}

function uploadView(u: Rec) {
  return {
    id: u.id, fileName: u.fileName, storedName: u.storedName,
    mimeType: u.mimeType, byteSize: u.byteSize,
    imageUrl: fileUrl(u.imageKey),
    displayUrl: fileUrl(u.displayKey || u.imageKey),
    prompt: u.prompt ?? null,
    createdAt: u.createdAt,
  };
}

function savedView(s: Rec) {
  return {
    id: s.id, counter: s.counter, seed: s.seed,
    name: `${s.counter}-${s.seed}`, sourceJobId: s.sourceJobId,
    sourceKind: s.sourceKind, sourceUploadId: s.sourceUploadId,
    fileExt: s.fileExt, imageUrl: fileUrl(s.imageKey),
    displayUrl: fileUrl(s.displayKey || s.imageKey),
    createdAt: s.createdAt,
  };
}

const noneSource = () => ({
  kind: "none", jobId: null, uploadId: null, resultSeed: null,
  displayUrl: null, imageUrl: null, mimeType: null, byteSize: null,
  fileName: null,
});

function fileSize(key: string | null | undefined): number | null {
  if (!key) return null;
  return files.get(key)?.length ?? null;
}

function editorSourceView(slot: Rec | null = state.editor) {
  const src = slot;
  if (!src) return noneSource();
  if (src.kind === "job") {
    const job = state.jobs.get(src.jobId);
    if (job && job.status === "completed" && job.imageKey) {
      return {
        kind: "job", jobId: job.id, uploadId: null,
        resultSeed: job.resultSeed,
        displayUrl: fileUrl(job.displayKey || job.imageKey),
        imageUrl: fileUrl(job.imageKey), mimeType: "image/png",
        byteSize: fileSize(job.imageKey), fileName: null,
      };
    }
    return noneSource();
  }
  const upload = state.uploads.get(src.uploadId);
  if (upload) {
    return {
      kind: "upload", jobId: null, uploadId: upload.id,
      resultSeed: null,
      displayUrl: fileUrl(upload.displayKey || upload.imageKey),
      imageUrl: fileUrl(upload.imageKey), mimeType: upload.mimeType,
      byteSize: upload.byteSize, fileName: upload.fileName,
    };
  }
  return noneSource();
}

// --- dictionary learning (port of the server mock's) ------------------------
function splitPromptWords(prompt: string): string[] {
  return prompt
    .split(/[\s,()]+|:\s*[\d.]+\s*\)/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w !== "");
}

function learnPromptWords(dictionary: Rec, prompt: string) {
  for (const word of Object.keys(dictionary)) {
    const contexts = dictionary[word];
    for (const ctx of Object.keys(contexts)) {
      const decayed = contexts[ctx] * 0.95;
      if (decayed < 0.01) delete contexts[ctx];
      else contexts[ctx] = decayed;
    }
  }
  dictionary.__first__ ??= {};
  const words = splitPromptWords(prompt);
  const add = (a: string, b: string, points: number) => {
    dictionary[a] ??= {};
    dictionary[a][b] = (dictionary[a][b] || 0) + points;
  };
  words.forEach((a, i) => {
    dictionary[a] ??= {};
    for (let d = 1; d <= 5; d++) {
      if (i + d >= words.length) break;
      const b = words[i + d] as string;
      dictionary[b] ??= {};
      add(a, b, 6 - d);
      add(b, a, 6 - d);
    }
  });
  for (let i = 0; i < Math.min(5, words.length); i++) {
    const first = dictionary.__first__;
    const w = words[i] as string;
    first[w] = (first[w] || 0) + (5 - i);
  }
}

// --- simulated generation -----------------------------------------------------
function tick() {
  const now = Date.now();
  for (const job of state.jobs.values()) {
    if (job.status !== "running") continue;
    const elapsed = now - job.startedAt;
    const phase =
      elapsed < 800 ? "agent_starting"
      : elapsed < 1600 ? "connecting"
      : elapsed < GEN_MS ? "generating"
      : "saving";
    if (elapsed < GEN_MS) {
      if (job.phase !== phase) {
        job.phase = phase;
        job.phaseUpdatedAt = nowIso();
      }
      continue;
    }
    const sample = SAMPLES[job.id % SAMPLES.length] as string;
    job.imageKey = `jobs/${job.id}.png`;
    job.displayKey = `jobs/${job.id}.display.jpg`;
    copyFixtureTo(`${sample}.png`, job.imageKey);
    copyFixtureTo(`${sample}.display.jpg`, job.displayKey);
    job.resultSeed =
      job.seedInput ?? Math.floor(Math.random() * 4294967295);
    const p = job.payload ?? {};
    const elide = (v: unknown) =>
      typeof v === "string" ? { bytes: Math.floor((v.length * 3) / 4) } : v;
    job.usedParams = JSON.stringify({
      ...p,
      ...(Array.isArray(p.init_images)
        ? { init_images: p.init_images.map(elide) }
        : {}),
      ...(typeof p.mask === "string" ? { mask: elide(p.mask) } : {}),
      mock: true,
      ...(job.mode === "img2img"
        ? { init_source: job.initSource, init_source_job: job.sourceJobId }
        : {}),
    });
    job.status = "completed";
    job.phase = null;
    job.updatedAt = nowIso();
    if (!(state.editor?.kind === "job" && state.editor.jobId === job.id)) {
      state.editor = { kind: "job", jobId: job.id };
    }
  }
}

function jobProgress(job: Rec) {
  if (job.status !== "running" || job.phase !== "generating") return null;
  const steps = job.payload?.steps ?? MODEL_STEPS[job.model] ?? 20;
  const frac = Math.min(0.99, (Date.now() - job.startedAt) / GEN_MS);
  return {
    step: Math.max(1, Math.floor(frac * steps)),
    steps,
    fraction: frac,
  };
}

// --- save index ----------------------------------------------------------------
function storedSaveIndex(): number {
  return state.saveIndex ?? 0;
}
function indexFromArgs(args: Rec): number {
  if (Number.isInteger(args.index) && args.index >= 0) return args.index;
  return storedSaveIndex() + 1;
}

// --- sdapi fixtures --------------------------------------------------------------
export const SD_MODELS = [
  { title: "anime-base-1.safetensors", model_name: "anime-base-1", filename: "anime-base-1.safetensors" },
  { title: "big-checkpoint-29b.safetensors", model_name: "big-checkpoint-29b", filename: "big-checkpoint-29b.safetensors" },
  { title: "Example RealSkin _v1 n.safetensors", model_name: "Example RealSkin _v1 n", filename: "Example RealSkin _v1 n.safetensors" },
  { title: "illustrious_checkpoint-a.safetensors", model_name: "illustrious_checkpoint-a", filename: "illustrious/checkpoint-a.safetensors" },
  { title: "illustrious_checkpoint-b.safetensors", model_name: "illustrious_checkpoint-b", filename: "illustrious/checkpoint-b.safetensors" },
  { title: "photo-checkpoint-1.safetensors", model_name: "photo-checkpoint-1", filename: "photo-checkpoint-1.safetensors" },
  { title: "turbo-bundle-x.safetensors", model_name: "turbo-bundle-x", filename: "turbo-bundle-x.safetensors" },
];
export const SD_SAMPLERS = [
  "DPM++ 2M", "DPM++ 2M SDE", "DPM++ SDE", "DPM++ 3M SDE",
  "DPM2", "DPM++ 2S a", "Euler", "Euler a", "DDIM", "LMS",
  "Heun", "UniPC", "Restart",
];
export const SD_SCHEDULERS = [
  "Karras", "Exponential", "Normal", "Simple", "Beta",
  "DDIM Uniform", "SGM Uniform", "Align Your Steps",
];

// --- actions (port of the server mock's ACTIONS) ------------------------------
const ACTIONS: Record<string, (args: Rec) => Promise<unknown>> = {
  getWordDictionary: async () => ({
    dictionary: JSON.stringify(state.dictionary),
  }),
  getTextSnippets: async () => ({ snippets: state.snippets }),
  saveTextSnippets: async (args) => {
    state.snippets = JSON.stringify(args.snippets ?? []);
    return { ok: true };
  },
  getWorkspaceState: async () => ({
    settings: state.settings,
    prompt: state.prompt,
    saveIndex: storedSaveIndex(),
  }),
  setSaveIndex: async (args) => {
    if (!Number.isInteger(args.index) || args.index < 0 || args.index > 999999999) {
      return { ok: false, error: "保存インデクスは 0 以上の整数で指定してください。" };
    }
    state.saveIndex = args.index;
    return { ok: true, error: null };
  },
  saveSettings: async (args) => {
    state.settings = String(args.settings ?? "");
    return { ok: true };
  },
  savePrompt: async (args) => {
    state.prompt = String(args.prompt ?? "");
    return { ok: true };
  },
  listJobs: async (args) => {
    tick();
    const limit = args.limit ?? 50;
    const jobs = [...state.jobs.values()]
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map(jobView);
    return { jobs };
  },
  getEditorSource: async () => {
    tick();
    return { source: editorSourceView() };
  },
  uploadEditorImage: async (args) => {
    const bytes = b64Decode(args.dataBase64);
    const isPng =
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const ext = isPng ? "png" : "jpg";
    const id = state.nextUploadId++;
    const now = new Date();
    const stamp =
      now.toISOString().replace(/[-:T]/g, "").slice(0, 14) +
      "-" + String(Math.floor(Math.random() * 9000) + 1000);
    const storedName = `upload-${stamp}.${ext}`;
    const imageKey = `uploads/${storedName}`;
    putFile(imageKey, bytes);
    let displayKey: string | null = null;
    if (args.displayDataBase64) {
      const disp = b64Decode(args.displayDataBase64);
      if (disp[0] === 0xff && disp[1] === 0xd8) {
        displayKey = `uploads/${storedName}.display.jpg`;
        putFile(displayKey, disp);
      }
    }
    state.uploads.set(id, {
      id, fileName: args.fileName || storedName, storedName,
      mimeType: args.mimeType || (isPng ? "image/png" : "image/jpeg"),
      byteSize: bytes.length, imageKey, displayKey,
      prompt: isPng ? await extractPngPrompt(bytes) : null,
      createdAt: nowIso(),
    });
    state.source = { kind: "upload", uploadId: id };
    return { ok: true, error: null, source: editorSourceView(state.source) };
  },
  listUploadImages: async (args) => {
    const limit = args.limit ?? 100;
    const uploads = [...state.uploads.values()]
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map(uploadView);
    return { uploads };
  },
  setEditorSourceFromUpload: async (args) => {
    if (!state.uploads.has(args.uploadId)) {
      return { ok: false, error: "アップロード画像が見つかりません。", source: editorSourceView() };
    }
    state.editor = { kind: "upload", uploadId: args.uploadId };
    return { ok: true, error: null, source: editorSourceView() };
  },
  deleteUploadImage: async (args) => {
    const upload = state.uploads.get(args.uploadId);
    if (!upload) return { ok: true, deleted: 0 };
    state.uploads.delete(args.uploadId);
    deleteFile(upload.imageKey);
    deleteFile(upload.displayKey);
    if (state.editor?.kind === "upload" && state.editor.uploadId === args.uploadId) {
      state.editor = null;
    }
    if (state.source?.kind === "upload" && state.source.uploadId === args.uploadId) {
      state.source = null;
    }
    return { ok: true, deleted: 1 };
  },
  saveUploadImage: async (args) => {
    const upload = state.uploads.get(args.uploadId);
    if (!upload) {
      return { ok: false, error: "アップロード画像が見つかりません。", name: null, counter: null, seed: null };
    }
    const counter = indexFromArgs(args);
    state.saveIndex = counter;
    const ext = upload.imageKey.endsWith(".png") ? "png" : "jpg";
    const imageKey = `saved/${counter}-0.${ext}`;
    const bytes = files.get(upload.imageKey);
    if (bytes) putFile(imageKey, bytes);
    let displayKey: string | null = null;
    if (upload.displayKey) {
      displayKey = `saved/${counter}-0.display.jpg`;
      const disp = files.get(upload.displayKey);
      if (disp) putFile(displayKey, disp);
    }
    const id = state.nextSavedId++;
    state.saved.set(id, {
      id, counter, seed: 0, sourceJobId: null, sourceKind: "upload",
      sourceUploadId: upload.id, fileExt: ext, imageKey, displayKey,
      createdAt: nowIso(),
    });
    return { ok: true, error: null, name: `${counter}-0`, counter, seed: 0 };
  },
  setEditorSourceFromJob: async (args) => {
    const job = state.jobs.get(args.jobId);
    if (!job || job.status !== "completed") {
      return { ok: false, error: "生成ジョブが見つかりません。", source: editorSourceView() };
    }
    state.editor = { kind: "job", jobId: job.id };
    return { ok: true, error: null, source: editorSourceView() };
  },
  clearEditorSource: async () => {
    state.editor = null;
    return { ok: true, error: null, source: noneSource() };
  },
  getSourceImage: async () => {
    tick();
    return { source: editorSourceView(state.source) };
  },
  adoptEditorSource: async () => {
    if (!state.editor) {
      return { ok: false, error: "画像エリアに画像がありません。", source: editorSourceView(state.source) };
    }
    state.source = { ...state.editor };
    return { ok: true, error: null, source: editorSourceView(state.source) };
  },
  clearSourceImage: async () => {
    state.source = null;
    return { ok: true, error: null, source: noneSource() };
  },
  createJob: async (args) => {
    tick();
    if (!args.payload || typeof args.payload !== "object") {
      return { ok: false, jobId: null, error: "payload が必要です。" };
    }
    const id = state.nextJobId++;
    const job: Rec = {
      id, kind: "generate", status: "running", phase: "agent_starting",
      phaseUpdatedAt: nowIso(), model: args.model, prompt: args.prompt,
      negativePrompt: args.negativePrompt ?? null,
      width: args.width, height: args.height,
      seedMode: args.seedMode ?? "random", seedInput: args.seed ?? null,
      steps: args.steps, cfg: args.cfg, sampler: args.sampler,
      scheduler: args.scheduler,
      mode: args.mode ?? "txt2img",
      sourceJobId: args.sourceJobId ?? null,
      initSource: args.initSource ?? null,
      denoisingStrength: args.denoisingStrength ?? null,
      resizeMode: args.resizeMode ?? null,
      payload: args.payload,
      maskSent: typeof args.payload.mask === "string",
      resultSeed: null, imageKey: null, displayKey: null,
      usedParams: null, loraHashes: null, error: null,
      createdAt: nowIso(), updatedAt: nowIso(),
      startedAt: Date.now(), sample: null,
    };
    state.jobs.set(id, job);
    try {
      learnPromptWords(state.dictionary, args.prompt ?? "");
    } catch {
      // learning must not block generation
    }
    return { ok: true, jobId: id, error: null };
  },
  createEditedJob: async (args) => {
    tick();
    const clampPct = (v: unknown) =>
      Math.max(-100, Math.min(100, Math.round(Number(v) || 0)));
    const brightness = clampPct(args.brightness);
    const saturation = clampPct(args.saturation);
    const contrast = clampPct(args.contrast);
    const temperature = clampPct(args.temperature);
    const drawing =
      typeof args.drawing === "string" && args.drawing.length > 0;
    const srcJob =
      args.sourceKind === "job" ? state.jobs.get(args.jobId) : undefined;
    const srcUpload =
      args.sourceKind === "upload"
        ? state.uploads.get(args.uploadId)
        : undefined;
    if (!srcJob && !srcUpload) {
      return { ok: false, jobId: null, error: "加工元の画像が見つかりません。" };
    }
    const id = state.nextJobId++;
    const sample = SAMPLES[id % SAMPLES.length] as string;
    const job: Rec = {
      id, kind: "generate", status: "completed", phase: null,
      phaseUpdatedAt: nowIso(),
      model: srcJob?.model ?? null,
      prompt: srcJob?.prompt ?? srcUpload?.prompt ?? null,
      negativePrompt: srcJob?.negativePrompt ?? null,
      width: srcJob?.width ?? 768, height: srcJob?.height ?? 1024,
      seedMode: srcJob?.seedMode ?? "random",
      seedInput: srcJob?.seedInput ?? null,
      steps: srcJob?.steps ?? null, cfg: srcJob?.cfg ?? null,
      sampler: srcJob?.sampler ?? null,
      scheduler: srcJob?.scheduler ?? null,
      mode: srcJob?.mode ?? "txt2img",
      sourceJobId: null, initSource: null,
      denoisingStrength: null, resizeMode: null,
      payload: null, maskSent: false,
      resultSeed: srcJob?.resultSeed ?? null,
      imageKey: `jobs/${id}.png`, displayKey: `jobs/${id}.display.jpg`,
      usedParams: JSON.stringify({
        edited: true,
        sourceKind: args.sourceKind,
        sourceJobId: srcJob?.id ?? null,
        sourceUploadId: srcUpload?.id ?? null,
        brightness, saturation, contrast, temperature,
        drawing,
        mock: true,
      }),
      loraHashes: null, error: null,
      createdAt: nowIso(), updatedAt: nowIso(),
      startedAt: Date.now(), sample: null,
    };
    state.jobs.set(id, job);
    copyFixtureTo(`${sample}.png`, job.imageKey);
    copyFixtureTo(`${sample}.display.jpg`, job.displayKey);
    state.editor = { kind: "job", jobId: id };
    return { ok: true, jobId: id, error: null };
  },
  pollGenerationJob: async (args) => {
    tick();
    const job = state.jobs.get(args.jobId);
    if (!job) return { state: "missing", error: null, progress: null };
    if (job.status === "completed") {
      return { state: "completed", error: null, progress: null };
    }
    if (job.status === "failed") {
      return { state: "failed", error: job.error, progress: null };
    }
    return { state: "running", error: null, progress: jobProgress(job) };
  },
  deleteJobs: async (args) => {
    let deleted = 0;
    for (const jobId of args.jobIds ?? []) {
      const job = state.jobs.get(jobId);
      if (!job) continue;
      state.jobs.delete(jobId);
      deleteFile(job.imageKey);
      deleteFile(job.displayKey);
      if (state.editor?.kind === "job" && state.editor.jobId === jobId) {
        state.editor = null;
      }
      if (state.source?.kind === "job" && state.source.jobId === jobId) {
        state.source = null;
      }
      deleted++;
    }
    return { ok: true, deleted };
  },
  saveJobImage: async (args) => {
    const job = state.jobs.get(args.jobId);
    if (!job || job.status !== "completed" || !job.imageKey) {
      return { ok: false, error: "生成ジョブが見つかりません。", name: null, counter: null, seed: null };
    }
    const counter = indexFromArgs(args);
    state.saveIndex = counter;
    const seed = job.resultSeed ?? 0;
    const imageKey = `saved/${counter}-${seed}.png`;
    const bytes = files.get(job.imageKey);
    if (bytes) putFile(imageKey, bytes);
    let displayKey: string | null = null;
    if (job.displayKey) {
      displayKey = `saved/${counter}-${seed}.display.jpg`;
      const disp = files.get(job.displayKey);
      if (disp) putFile(displayKey, disp);
    }
    const id = state.nextSavedId++;
    state.saved.set(id, {
      id, counter, seed, sourceJobId: job.id, sourceKind: "job",
      sourceUploadId: null, fileExt: "png", imageKey, displayKey,
      createdAt: nowIso(),
    });
    return { ok: true, error: null, name: `${counter}-${seed}`, counter, seed };
  },
  listSavedImages: async (args) => {
    const limit = args.limit ?? 100;
    const saved = [...state.saved.values()]
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map(savedView);
    return { saved };
  },
  deleteSavedImages: async (args) => {
    let deleted = 0;
    for (const id of args.ids ?? []) {
      const row = state.saved.get(id);
      if (!row) continue;
      state.saved.delete(id);
      deleteFile(row.imageKey);
      deleteFile(row.displayKey);
      deleted++;
    }
    return { ok: true, deleted };
  },
};

// The backend.mock.ts entry point: same contract as the real
// transport — results are returned directly, failures throw an
// Error carrying the message.
export async function callMockAction(
  action: string,
  args: unknown,
): Promise<unknown> {
  await ensureSeeded();
  const handler = ACTIONS[action];
  if (!handler) throw new Error(`unknown action: ${action}`);
  try {
    return await handler((args ?? {}) as Rec);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }
}
