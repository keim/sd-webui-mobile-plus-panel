// Action contract for the workbench UI: the shared zod view
// schemas, plus each client-facing action's request and response
// schema. Worker-internal actions (createCheck, completeJob,
// completeCheck, updatePhase, failJob) are intentionally not part
// of this contract — the extension backend replaces both sides.
//
// This file is the reference the FastAPI backend under /mobileplus/actions
// will be implemented against. It is imported type-only by src/api.ts.

import { z } from "zod";

const jobView = z.object({
  id: z.number(),
  kind: z.enum(["generate"]),
  status: z.enum(["queued", "running", "completed", "failed"]),
  phase: z.string().nullable(),
  phaseUpdatedAt: z.string().nullable(),
  model: z.string().nullable(),
  prompt: z.string().nullable(),
  negativePrompt: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  seedMode: z.string().nullable(),
  seedInput: z.number().nullable(),
  steps: z.number().nullable(),
  cfg: z.number().nullable(),
  sampler: z.string().nullable(),
  scheduler: z.string().nullable(),
  // Generation mode: "txt2img" | "img2img" (null on rows recorded
  // before the column existed; reads as txt2img).
  mode: z.string().nullable(),
  denoisingStrength: z.number().nullable(),
  // True when this completed job's generated PNG has a recorded
  // host file path, so it can be sent to the Editor as an img2img
  // init image (the path itself never leaves the server).
  canSendToEditor: z.boolean(),
  resultSeed: z.number().nullable(),
  imageUrl: z.string().nullable(),
  displayUrl: z.string().nullable(),
  usedParams: z.string().nullable(),
  loraHashes: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createResponse = z.object({
  ok: z.boolean(),
  jobId: z.number().nullable(),
  error: z.string().nullable(),
});

const pollResponse = z.object({
  state: z.enum(["running", "completed", "failed", "not_direct", "missing"]),
  error: z.string().nullable(),
  // Display-only live sampling progress, piggybacked on the poll:
  // present only when this poll found the job in its generating
  // phase AND the server reported a job in flight or a sampling signal
  // (see fetchSdProgress). The raw counters are passed through as
  // reported — including pre-sampling readings (step 0 while the
  // model loads / the init image encodes, with steps still at the
  // payload value before an img2img run's real total settles). The
  // CLIENT owns the display rules built on these counters (show
  // nothing until sampling has observably started, fix the total
  // at that moment, treat a lost reading after the start as
  // sampling-complete); `fraction` (the server's progress ratio) rides
  // along because it is one of the two sampling-start signals.
  // Step counts only — no percentage, no ETA, and never an
  // in-progress image (the host progress route asks the server with
  // skip_current_image=true). Never stored in the DB.
  progress: z
    .object({
      step: z.number(),
      steps: z.number().nullable(),
      fraction: z.number().nullable(),
    })
    .nullable(),
});

const okResponse = z.object({ ok: z.boolean() });

const generationRequest = z.object({
  prompt: z.string().min(1).max(4000),
  // The active generation template's title (selection is by
  // template, not by model — 2026-11-24). The checkpoint the run
  // actually used travels inside the payload's override_settings.
  model: z.string().min(1).max(200),
  // Editable full negative prompt (Parameter pane). Used verbatim
  // as the payload's negative_prompt. This field is the job
  // record's copy of the user's negative text.
  negativePrompt: z.string().max(4000).optional(),
  width: z.number().int().min(64).max(4096),
  height: z.number().int().min(64).max(4096),
  seedMode: z.enum(["random", "fixed"]),
  seed: z.number().int().min(0).max(4294967295).nullable().default(null),
  steps: z.number().int().min(1).max(150),
  cfg: z.number().min(0).max(30),
  sampler: z.string().min(1).max(80),
  scheduler: z.string().min(1).max(80),
  // img2img (i2i): mode "img2img" runs the job against an init
  // image with denoisingStrength from the Editor pane. Which image
  // the init was: "job" = the generated image of sourceJobId, or
  // "upload" = the uploaded image in the source slot. These two
  // fields are the job record's provenance only — since the
  // payload-passthrough rework the client itself fetches the
  // source image and carries its bytes in payload.init_images;
  // the worker resolves nothing. initSource null with a
  // sourceJobId set reads as "job" for compatibility.
  mode: z.enum(["txt2img", "img2img"]).default("txt2img"),
  sourceJobId: z.number().int().positive().nullable().default(null),
  initSource: z.enum(["job", "upload"]).nullable().default(null),
  denoisingStrength: z.number().min(0).max(1).nullable().default(null),
  // img2img resize mode (the Editor operation panel's Cover /
  // Crop / Contain / Latent selector): 0 = just resize (Cover),
  // 1 = crop and resize (Crop), 2 = resize and fill (Contain),
  // 3 = just resize in latent space (Latent). Record copy of the
  // selection; the payload carries the effective resize_mode for
  // img2img and inpaint alike (txt2img records null).
  resizeMode: z.number().int().min(0).max(3).nullable().default(null),
  // The complete sdapi payload, composed by the client: prompt
  // (style base included), negative_prompt, steps / cfg_scale /
  // sampler / scheduler from the form, the model's checkpoint in
  // override_settings, and for img2img the init_images base64,
  // denoising_strength, resize_mode and — when a mask is painted —
  // the mask base64 with the inpaint parameters. The worker
  // passes this object to the WebUI API verbatim: it composes
  // nothing, fixes nothing and guards nothing.
  payload: z.record(z.string(), z.unknown()),
});

const editorSourceView = z.object({
  kind: z.enum(["none", "job", "upload"]),
  jobId: z.number().nullable(),
  // For kind "upload" pointing at the upload library: the
  // upload_images record's id. Null for legacy single-slot
  // uploads, jobs, and none.
  uploadId: z.number().nullable(),
  // For kind "job": the source job's resulting seed. Together with
  // jobId it forms the generated image's display name and download
  // file name ("{jobId}-{resultSeed}"). Null for uploads / none.
  resultSeed: z.number().nullable(),
  displayUrl: z.string().nullable(),
  // Original-resolution image URL (the job's PNG blob; for uploads
  // the upload blob itself). displayUrl may be a resized display
  // JPEG (max 1280px), so anything that needs the source's REAL
  // pixel dimensions — the Inpaint mask canvas — must size from
  // this URL, never from displayUrl.
  imageUrl: z.string().nullable(),
  mimeType: z.string().nullable(),
  byteSize: z.number().nullable(),
  fileName: z.string().nullable(),
});

const editorSourceResponse = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  source: editorSourceView,
});

const uploadImageView = z.object({
  id: z.number(),
  fileName: z.string().nullable(),
  storedName: z.string(),
  mimeType: z.string(),
  byteSize: z.number(),
  imageUrl: z.string().nullable(),
  displayUrl: z.string().nullable(),
  // The positive prompt extracted from a PNG's embedded WebUI
  // infotext at upload time; null for JPEGs and metadata-less
  // PNGs.
  prompt: z.string().nullable(),
  createdAt: z.string(),
});

const savedImageView = z.object({
  id: z.number(),
  counter: z.number(),
  seed: z.number(),
  // Display / download name stem: "{counter}-{seed}".
  name: z.string(),
  sourceJobId: z.number().nullable(),
  // Origin of the copy: "job" or "upload" (null on the oldest
  // rows, which are job saves). For "upload", sourceUploadId is
  // the upload_images record the copy came from and seed is 0.
  sourceKind: z.string().nullable(),
  sourceUploadId: z.number().nullable(),
  // File extension of the saved original ("png" | "jpg"), from
  // its blob key — upload saves keep the upload's own format.
  fileExt: z.string(),
  imageUrl: z.string().nullable(),
  displayUrl: z.string().nullable(),
  createdAt: z.string(),
});

const saveImageResponse = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  // Assigned saved name "{counter}-{seed}" on success.
  name: z.string().nullable(),
  counter: z.number().nullable(),
  seed: z.number().nullable(),
});

export const Actions = {
  getWordDictionary: {
    request: z.object({}),
    response: z.object({ dictionary: z.string() }),
  },
  getTextSnippets: {
    request: z.object({}),
    response: z.object({ snippets: z.string() }),
  },
  saveTextSnippets: {
    request: z.object({
      snippets: z.array(z.string().max(2000)).max(500),
    }),
    response: okResponse,
  },
  getWorkspaceState: {
    request: z.object({}),
    response: z.object({
      settings: z.string(),
      prompt: z.string(),
      // The server's latest save index — the client's initial
      // value at startup (the counter itself is client-managed).
      saveIndex: z.number(),
    }),
  },
  setSaveIndex: {
    request: z.object({
      index: z.number().int().min(0).max(999999999),
    }),
    response: okResponse,
  },
  saveSettings: {
    request: z.object({
      settings: z.string().max(20000),
    }),
    response: okResponse,
  },
  savePrompt: {
    request: z.object({
      prompt: z.string().max(20000),
    }),
    response: okResponse,
  },
  listJobs: {
    request: z.object({
      limit: z.number().int().positive().max(100).default(50),
    }),
    response: z.object({ jobs: z.array(jobView) }),
  },
  getEditorSource: {
    request: z.object({}),
    response: z.object({ source: editorSourceView }),
  },
  uploadEditorImage: {
    request: z.object({
      // base64 of at most 25 MB of image bytes is ~35M characters.
      dataBase64: z.string().min(1).max(35000000),
      mimeType: z.string().max(100),
      fileName: z.string().max(200).default(""),
      // Optional client-generated display JPEG (max 1280px),
      // base64. Validated as JPEG when present; a bad one is
      // simply not stored (the original still thumbnails).
      displayDataBase64: z.string().max(35000000).optional(),
    }),
    response: editorSourceResponse,
  },
  listUploadImages: {
    request: z.object({
      limit: z.number().int().positive().max(200).default(100),
    }),
    response: z.object({ uploads: z.array(uploadImageView) }),
  },
  setEditorSourceFromUpload: {
    request: z.object({
      uploadId: z.number().int().positive(),
    }),
    response: editorSourceResponse,
  },
  deleteUploadImage: {
    request: z.object({
      uploadId: z.number().int().positive(),
    }),
    response: z.object({ ok: z.boolean(), deleted: z.number() }),
  },
  saveUploadImage: {
    request: z.object({
      uploadId: z.number().int().positive(),
      // The client-managed save index (already incremented by
      // the client); the server names the file with it verbatim
      // and remembers it as the latest.
      index: z.number().int().min(0),
    }),
    response: saveImageResponse,
  },
  setEditorSourceFromJob: {
    request: z.object({
      jobId: z.number().int().positive(),
    }),
    response: editorSourceResponse,
  },
  clearEditorSource: {
    request: z.object({}),
    response: editorSourceResponse,
  },
  // The img2img source slot, independent of the Editor slot:
  // the image shown in the prompt row's source image area and
  // used as the img2img / inpaint init image. Uploads land
  // here; the Editor image is copied here only by the explicit
  // adopt action (the image area's 元画像に採用 button).
  getSourceImage: {
    request: z.object({}),
    response: editorSourceResponse,
  },
  adoptEditorSource: {
    request: z.object({}),
    response: editorSourceResponse,
  },
  clearSourceImage: {
    request: z.object({}),
    response: editorSourceResponse,
  },
  createJob: {
    request: generationRequest,
    response: createResponse,
  },
  pollGenerationJob: {
    request: z.object({
      jobId: z.number().int().positive(),
    }),
    response: pollResponse,
  },
  deleteJobs: {
    request: z.object({
      jobIds: z.array(z.number().int().positive()).min(1).max(100),
    }),
    response: z.object({ ok: z.boolean(), deleted: z.number() }),
  },
  saveJobImage: {
    request: z.object({
      jobId: z.number().int().positive(),
      index: z.number().int().min(0),
    }),
    response: saveImageResponse,
  },
  listSavedImages: {
    request: z.object({
      limit: z.number().int().positive().max(200).default(100),
    }),
    response: z.object({ saved: z.array(savedImageView) }),
  },
  deleteSavedImages: {
    request: z.object({
      ids: z.array(z.number().int().positive()).min(1).max(100),
    }),
    response: z.object({ ok: z.boolean(), deleted: z.number() }),
  }
};
