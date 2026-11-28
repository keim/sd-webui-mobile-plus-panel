// Mock backend for workbench UI development without a live WebUI.
//
// Serves the built UI (../dist) under /mobileplus/ and implements the
// full 22-action contract (see src/contract.ts) with in-memory state
// and fixture images, mirroring the extension backend's observable
// behavior — including the response envelope ({"data": ...}), the
// job lifecycle (createJob returns immediately; a simulated run
// completes a few seconds later), progress reporting on poll, the
// save counter's filename-max rule, dictionary learning at createJob,
// and the editor slot moving to a job when its generation completes.
//
// Usage: bun run build && bun run mock   (http://127.0.0.1:8899/mobileplus/)
// State is reseeded on every server start; files live in mock/.data/.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, copyFile, rm, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { inflateSync } from "node:zlib";

const PORT = Number(process.env.MOCK_PORT || 8899);
const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const FIXTURES = join(ROOT, "mock", "fixtures");
const DATA = join(ROOT, "mock", ".data");
const FILES = join(DATA, "files");

const nowIso = () => new Date().toISOString();
const fileUrl = (key) => (key ? `/mobileplus/files/${key}` : null);

// --- fixtures ------------------------------------------------------------
const seedDictionary = JSON.parse(
  await readFile(join(FIXTURES, "dictionary.json"), "utf8"),
);
const SAMPLES = ["sample-1", "sample-2", "sample-3"];

// --- state ---------------------------------------------------------------
const state = {
  jobs: new Map(), // id -> job record (backend-row shaped)
  uploads: new Map(), // id -> upload record
  saved: new Map(), // id -> saved record
  nextJobId: 1,
  nextUploadId: 1,
  nextSavedId: 1,
  editor: null, // { kind: "job"|"upload", jobId?, uploadId? }
  dictionary: structuredClone(seedDictionary),
  snippets: JSON.stringify(["masterpiece, best quality", "1girl, solo"]),
  settings: "",
  prompt: "",
  saveSettingsCalls: 0,
  savePromptCalls: 0,
};

const MODEL_STEPS = { "Template A": 20, "Template B": 20, "Template C": 10 };
const GEN_MS = 7000; // simulated generation duration

async function putFile(key, bytes) {
  const path = join(FILES, key);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, bytes);
}
async function copyFixtureTo(sample, key) {
  const path = join(FILES, key);
  await mkdir(join(path, ".."), { recursive: true });
  await copyFile(join(FIXTURES, sample), path);
}
async function deleteFile(key) {
  if (!key) return;
  await rm(join(FILES, key), { force: true });
}

function seedJob(id, model, prompt, width, height, seed, sample, createdAt) {
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

async function seed() {
  await rm(DATA, { recursive: true, force: true });
  await mkdir(FILES, { recursive: true });
  const t = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  seedJob(1, "Template A", "1girl, solo, seaside, summer", 1088, 1472, 1111111111, "sample-1", iso(t - 7200e3));
  seedJob(2, "Template B", "scenery, mountain, lake, sunset", 1472, 1088, 2222222222, "sample-2", iso(t - 3600e3));
  seedJob(3, "Template C", "scenery, city, night, neon", 1984, 832, 3333333333, "sample-3", iso(t - 1800e3));
  for (const job of state.jobs.values()) {
    await copyFixtureTo(`${job.sample}.png`, job.imageKey);
    await copyFixtureTo(`${job.sample}.display.jpg`, job.displayKey);
  }
  // One listed save (from job 1) plus the unlisted 12719-0 seed
  // file; the stored save index is seeded to 12719 below, so the
  // client's first save becomes 12720.
  state.saveIndex = 12719;
  await copyFixtureTo("sample-1.png", "saved/12713-3035825825.png");
  await copyFixtureTo("sample-1.display.jpg", "saved/12713-3035825825.display.jpg");
  await copyFixtureTo("sample-2.png", "saved/12719-0.png");
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

// --- views (mirror workbench_backend.py) ---------------------------------
function jobView(j) {
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
// The positive prompt embedded in a PNG's WebUI infotext —
// mirrors _extract_png_prompt in the extension backend.
function extractPngPrompt(bytes) {
  const texts = {};
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(pos);
    const type = bytes.toString("latin1", pos + 4, pos + 8);
    const chunk = bytes.subarray(pos + 8, pos + 8 + length);
    if (chunk.length < length) break;
    pos += 8 + length + 4;
    if (type === "IEND") break;
    try {
      if (type === "tEXt") {
        const i = chunk.indexOf(0);
        texts[chunk.toString("latin1", 0, i)] = chunk.toString("utf8", i + 1);
      } else if (type === "zTXt") {
        const i = chunk.indexOf(0);
        if (chunk[i + 1] === 0) {
          texts[chunk.toString("latin1", 0, i)] =
            inflateSync(chunk.subarray(i + 2)).toString("utf8");
        }
      } else if (type === "iTXt") {
        const i = chunk.indexOf(0);
        const compressed = chunk[i + 1];
        let rest = chunk.subarray(i + 3);
        rest = rest.subarray(rest.indexOf(0) + 1);
        let text = rest.subarray(rest.indexOf(0) + 1);
        if (compressed === 1) text = inflateSync(text);
        texts[chunk.toString("utf8", 0, i)] = text.toString("utf8");
      }
    } catch { /* skip malformed chunks */ }
  }
  if (texts.parameters) {
    const lines = texts.parameters.split("\n");
    if (lines.length && lines[lines.length - 1].startsWith("Steps: ")) lines.pop();
    const out = [];
    for (const line of lines) {
      if (line.startsWith("Negative prompt:")) break;
      out.push(line);
    }
    return out.join("\n").trim() || null;
  }
  if (texts.prompt) return texts.prompt.trim() || null;
  return null;
}
function uploadView(u) {
  return {
    id: u.id, fileName: u.fileName, storedName: u.storedName,
    mimeType: u.mimeType, byteSize: u.byteSize,
    imageUrl: fileUrl(u.imageKey),
    displayUrl: fileUrl(u.displayKey || u.imageKey),
    prompt: u.prompt ?? null,
    createdAt: u.createdAt,
  };
}
function savedView(s) {
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
async function fileSize(key) {
  try {
    return (await readFile(join(FILES, key))).length;
  } catch {
    return null;
  }
}
async function editorSourceView(slot = state.editor) {
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
        byteSize: await fileSize(job.imageKey), fileName: null,
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

// --- dictionary learning (port of _learn_prompt_words) -------------------
function splitPromptWords(prompt) {
  return prompt
    .split(/[\s,()]+|:\s*[\d.]+\s*\)/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w !== "");
}
function learnPromptWords(dictionary, prompt) {
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
  const add = (a, b, points) => {
    dictionary[a] ??= {};
    dictionary[a][b] = (dictionary[a][b] || 0) + points;
  };
  words.forEach((a, i) => {
    dictionary[a] ??= {};
    for (let d = 1; d <= 5; d++) {
      if (i + d >= words.length) break;
      const b = words[i + d];
      dictionary[b] ??= {};
      add(a, b, 6 - d);
      add(b, a, 6 - d);
    }
  });
  for (let i = 0; i < Math.min(5, words.length); i++) {
    const first = dictionary.__first__;
    first[words[i]] = (first[words[i]] || 0) + (5 - i);
  }
}

// --- simulated generation --------------------------------------------------
// Payload passthrough mirrors production: createJob stores the
// client's payload untouched and the completion records it (image
// blobs elided) as usedParams. No composition, no guardrails.

// Advance running jobs whose simulated time has elapsed. Called from
// the read paths so no timers are involved.
async function tick() {
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
    // Complete the job.
    const sample = SAMPLES[job.id % SAMPLES.length];
    job.imageKey = `jobs/${job.id}.png`;
    job.displayKey = `jobs/${job.id}.display.jpg`;
    await copyFixtureTo(`${sample}.png`, job.imageKey);
    await copyFixtureTo(`${sample}.display.jpg`, job.displayKey);
    job.resultSeed =
      job.seedInput ?? Math.floor(Math.random() * 4294967295);
    const p = job.payload ?? {};
    const elide = (v) =>
      typeof v === "string" ? { bytes: Math.floor((v.length * 3) / 4) } : v;
    job.usedParams = JSON.stringify({
      ...p,
      ...(Array.isArray(p.init_images)
        ? { init_images: p.init_images.map(elide) }
        : {}),
      ...(typeof p.mask === "string" ? { mask: elide(p.mask) } : {}),
      mock: true,
      // Test-only provenance (not a payload field): which source
      // the client said the init image came from.
      ...(job.mode === "img2img"
        ? { init_source: job.initSource, init_source_job: job.sourceJobId }
        : {}),
    });
    job.status = "completed";
    job.phase = null;
    job.updatedAt = nowIso();
    // Mirror production: a finished generation becomes the Editor's
    // image (best-effort, never deletes the previous slot's upload).
    if (!(state.editor?.kind === "job" && state.editor.jobId === job.id)) {
      state.editor = { kind: "job", jobId: job.id };
    }
  }
}
function jobProgress(job) {
  if (job.status !== "running" || job.phase !== "generating") return null;
  const steps = job.payload?.steps ?? MODEL_STEPS[job.model] ?? 20;
  const frac = Math.min(0.99, (Date.now() - job.startedAt) / GEN_MS);
  return {
    step: Math.max(1, Math.floor(frac * steps)),
    steps,
    fraction: frac,
  };
}

// --- save index (client-managed; mirrors the backend) ---------------------
// The server only remembers the latest index it received and
// hands it back at startup; a fresh install starts at 0. The
// seed below stores 12719 (as if a long-running install had
// received it), so the client's first save becomes 12720.
async function storedSaveIndex() {
  return state.saveIndex ?? 0;
}
async function indexFromArgs(args) {
  if (Number.isInteger(args.index) && args.index >= 0) return args.index;
  return (await storedSaveIndex()) + 1;
}

// --- sdapi fixtures ----------------------------------------------------------
// The panel fetches the read-only lists directly from the
// WebUI's own API (2026-11-27), so the mock serves them in
// sdapi's native shapes: plain names, one subfolder-prefixed
// pair (canonical name vs bare stem), and a name with spaces.
const SD_MODELS = [
  { title: "anime-base-1.safetensors", model_name: "anime-base-1", filename: "anime-base-1.safetensors" },
  { title: "big-checkpoint-29b.safetensors", model_name: "big-checkpoint-29b", filename: "big-checkpoint-29b.safetensors" },
  { title: "Example RealSkin _v1 n.safetensors", model_name: "Example RealSkin _v1 n", filename: "Example RealSkin _v1 n.safetensors" },
  { title: "illustrious_checkpoint-a.safetensors", model_name: "illustrious_checkpoint-a", filename: "illustrious/checkpoint-a.safetensors" },
  { title: "illustrious_checkpoint-b.safetensors", model_name: "illustrious_checkpoint-b", filename: "illustrious/checkpoint-b.safetensors" },
  { title: "photo-checkpoint-1.safetensors", model_name: "photo-checkpoint-1", filename: "photo-checkpoint-1.safetensors" },
  { title: "turbo-bundle-x.safetensors", model_name: "turbo-bundle-x", filename: "turbo-bundle-x.safetensors" },
];
const SD_SAMPLERS = [
  "DPM++ 2M", "DPM++ 2M SDE", "DPM++ SDE", "DPM++ 3M SDE",
  "DPM2", "DPM++ 2S a", "Euler", "Euler a", "DDIM", "LMS",
  "Heun", "UniPC", "Restart",
];
const SD_SCHEDULERS = [
  "Karras", "Exponential", "Normal", "Simple", "Beta",
  "DDIM Uniform", "SGM Uniform", "Align Your Steps",
];

// --- actions ---------------------------------------------------------------
const ACTIONS = {
  getWordDictionary: async () => ({
    dictionary: JSON.stringify(state.dictionary),
  }),
  getTextSnippets: async () => ({ snippets: state.snippets }),
  saveTextSnippets: async (args) => {
    state.snippets = JSON.stringify(args.snippets ?? []);
    return { ok: true };
  },
  getWorkspaceState: async () => {
    if (process.env.MOCK_FAIL_WORKSPACE === "1") {
      throw new Error("simulated workspace load failure");
    }
    return {
    settings: state.settings,
    prompt: state.prompt,
    saveIndex: await storedSaveIndex(),
    };
  },
  setSaveIndex: async (args) => {
    if (!Number.isInteger(args.index) || args.index < 0 || args.index > 999999999) {
      return { ok: false, error: "保存インデクスは 0 以上の整数で指定してください。" };
    }
    state.saveIndex = args.index;
    return { ok: true, error: null };
  },
  saveSettings: async (args) => {
    state.saveSettingsCalls += 1;
    state.settings = String(args.settings ?? "");
    return { ok: true };
  },
  savePrompt: async (args) => {
    state.savePromptCalls += 1;
    state.prompt = String(args.prompt ?? "");
    return { ok: true };
  },
  listJobs: async (args) => {
    await tick();
    const limit = args.limit ?? 50;
    const jobs = [...state.jobs.values()]
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map(jobView);
    return { jobs };
  },
  getEditorSource: async () => {
    await tick();
    return { source: await editorSourceView() };
  },
  uploadEditorImage: async (args) => {
    const bytes = Buffer.from(args.dataBase64, "base64");
    const isPng = bytes.subarray(0, 4).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const ext = isPng ? "png" : "jpg";
    const id = state.nextUploadId++;
    const now = new Date();
    const stamp =
      now.toISOString().replace(/[-:T]/g, "").slice(0, 14) +
      "-" + String(Math.floor(Math.random() * 9000) + 1000);
    const storedName = `upload-${stamp}.${ext}`;
    const imageKey = `uploads/${storedName}`;
    await putFile(imageKey, bytes);
    let displayKey = null;
    if (args.displayDataBase64) {
      const disp = Buffer.from(args.displayDataBase64, "base64");
      if (disp[0] === 0xff && disp[1] === 0xd8) {
        displayKey = `uploads/${storedName}.display.jpg`;
        await putFile(displayKey, disp);
      }
    }
    state.uploads.set(id, {
      id, fileName: args.fileName || storedName, storedName,
      mimeType: args.mimeType || (isPng ? "image/png" : "image/jpeg"),
      byteSize: bytes.length, imageKey, displayKey,
      prompt: isPng ? extractPngPrompt(bytes) : null,
      createdAt: nowIso(),
    });
    state.source = { kind: "upload", uploadId: id };
    return { ok: true, error: null, source: await editorSourceView(state.source) };
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
      return { ok: false, error: "アップロード画像が見つかりません。", source: await editorSourceView() };
    }
    state.editor = { kind: "upload", uploadId: args.uploadId };
    return { ok: true, error: null, source: await editorSourceView() };
  },
  deleteUploadImage: async (args) => {
    const upload = state.uploads.get(args.uploadId);
    if (!upload) return { ok: true, deleted: 0 };
    state.uploads.delete(args.uploadId);
    await deleteFile(upload.imageKey);
    await deleteFile(upload.displayKey);
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
    const counter = await indexFromArgs(args);
    state.saveIndex = counter;
    const ext = upload.imageKey.endsWith(".png") ? "png" : "jpg";
    const imageKey = `saved/${counter}-0.${ext}`;
    await putFile(imageKey, await readFile(join(FILES, upload.imageKey)));
    let displayKey = null;
    if (upload.displayKey) {
      displayKey = `saved/${counter}-0.display.jpg`;
      await putFile(displayKey, await readFile(join(FILES, upload.displayKey)));
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
      return { ok: false, error: "生成ジョブが見つかりません。", source: await editorSourceView() };
    }
    state.editor = { kind: "job", jobId: job.id };
    return { ok: true, error: null, source: await editorSourceView() };
  },
  clearEditorSource: async () => {
    state.editor = null;
    return { ok: true, error: null, source: noneSource() };
  },
  getSourceImage: async () => {
    await tick();
    return { source: await editorSourceView(state.source) };
  },
  adoptEditorSource: async () => {
    if (!state.editor) {
      return { ok: false, error: "画像エリアに画像がありません。", source: await editorSourceView(state.source) };
    }
    state.source = { ...state.editor };
    return { ok: true, error: null, source: await editorSourceView(state.source) };
  },
  clearSourceImage: async () => {
    state.source = null;
    return { ok: true, error: null, source: noneSource() };
  },
  createJob: async (args) => {
    await tick();
    // Payload passthrough, like production: the only requirement
    // is that a payload object arrived.
    if (!args.payload || typeof args.payload !== "object") {
      return { ok: false, jobId: null, error: "payload が必要です。" };
    }
    const id = state.nextJobId++;
    const job = {
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
    await tick();
    const clampPct = (v) =>
      Math.max(-100, Math.min(100, Math.round(Number(v) || 0)));
    const brightness = clampPct(args.brightness);
    const saturation = clampPct(args.saturation);
    const contrast = clampPct(args.contrast);
    const drawing =
      typeof args.drawing === "string" && args.drawing.length > 0;
    state.lastEditedDrawing = drawing;
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
    const sample = SAMPLES[id % SAMPLES.length];
    const job = {
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
        brightness, saturation, contrast,
        drawing,
        mock: true,
      }),
      loraHashes: null, error: null,
      createdAt: nowIso(), updatedAt: nowIso(),
      startedAt: Date.now(), sample: null,
    };
    state.jobs.set(id, job);
    await copyFixtureTo(`${sample}.png`, job.imageKey);
    await copyFixtureTo(`${sample}.display.jpg`, job.displayKey);
    // Mirror production: the edited image becomes the Editor's image.
    state.editor = { kind: "job", jobId: id };
    return { ok: true, jobId: id, error: null };
  },
  pollGenerationJob: async (args) => {
    await tick();
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
      await deleteFile(job.imageKey);
      await deleteFile(job.displayKey);
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
    const counter = await indexFromArgs(args);
    state.saveIndex = counter;
    const seed = job.resultSeed ?? 0;
    const imageKey = `saved/${counter}-${seed}.png`;
    await putFile(imageKey, await readFile(join(FILES, job.imageKey)));
    let displayKey = null;
    if (job.displayKey) {
      displayKey = `saved/${counter}-${seed}.display.jpg`;
      await putFile(displayKey, await readFile(join(FILES, job.displayKey)));
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
      await deleteFile(row.imageKey);
      await deleteFile(row.displayKey);
      deleted++;
    }
    return { ok: true, deleted };
  },
};

// --- HTTP server -----------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

await seed();

if (!existsSync(join(DIST, "index.html"))) {
  console.warn("[mock] dist/index.html not found — run `bun run build` first.");
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/") {
      return Response.redirect("/mobileplus/", 302);
    }
    if (path === "/sdapi/v1/sd-models") {
      return Response.json(SD_MODELS);
    }
    if (path === "/sdapi/v1/samplers") {
      return Response.json(
        SD_SAMPLERS.map((name) => ({ name, aliases: [], options: {} })),
      );
    }
    if (path === "/sdapi/v1/schedulers") {
      return Response.json(
        SD_SCHEDULERS.map((name) => ({ name, label: name, aliases: [] })),
      );
    }
    if (path.startsWith("/mobileplus/api/") && req.method === "POST") {
      const action = decodeURIComponent(
        path.slice("/mobileplus/api/".length),
      );
      let args;
      try {
        args = await req.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const handler = ACTIONS[action];
      if (!handler) {
        return Response.json(
          { error: `unknown action: ${action}` },
          { status: 404 },
        );
      }
      try {
        const data = await handler(args ?? {});
        return Response.json(data);
      } catch (e) {
        return Response.json(
          { error: String(e?.message ?? e) },
          { status: 500 },
        );
      }
    }
    if (path.startsWith("/mobileplus/files/")) {
      const key = decodeURIComponent(path.slice("/mobileplus/files/".length));
      const filePath = join(FILES, key);
      if (!filePath.startsWith(FILES) || !existsSync(filePath)) {
        return new Response("not found", { status: 404 });
      }
      return new Response(Bun.file(filePath));
    }
    if (path === "/__mock/state" && req.method === "GET") {
      return Response.json({
        saveSettingsCalls: state.saveSettingsCalls,
        savePromptCalls: state.savePromptCalls,
        lastEditedDrawing: state.lastEditedDrawing ?? false,
        settingsEmpty: state.settings === "",
      });
    }
    if (path === "/mobileplus" || path.startsWith("/mobileplus/")) {
      const rel = path.slice("/mobileplus/".length) || "index.html";
      const filePath = join(DIST, rel);
      if (filePath.startsWith(DIST) && existsSync(filePath)) {
        const headers = {};
        if (rel === "index.html" || rel === "sw.js") {
          headers["Cache-Control"] = "no-cache";
        }
        return new Response(Bun.file(filePath), { headers });
      }
      // SPA fallback
      const indexPath = join(DIST, "index.html");
      if (existsSync(indexPath)) {
        return new Response(Bun.file(indexPath), {
          headers: { "Cache-Control": "no-cache", "Content-Type": MIME[".html"] },
        });
      }
      return new Response("dist not built — run `bun run build`", { status: 503 });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(
  `[mock] workbench mock at http://127.0.0.1:${server.port}/mobileplus/ ` +
  `(27 actions, seeded jobs 1-3, generation ~${GEN_MS / 1000}s)`,
);
