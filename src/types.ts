// API types for the workbench UI: the shared view types, plus
// each client-facing action's request and response shape.
// Worker-internal actions (createCheck, completeJob,
// completeCheck, updatePhase, failJob) are intentionally not
// part of this surface — the extension backend replaces both
// sides.
//
// Plain TypeScript interfaces (2026-11-27): the zod contract
// and the Space actions protocol were retired; the client
// posts each action's args as JSON to ./api/<action> and the
// FastAPI backend under /mobileplus/api/ implements against
// these shapes.

export interface JobView {
  id: number;
  kind: "generate";
  status: "queued" | "running" | "completed" | "failed";
  phase: string | null;
  phaseUpdatedAt: string | null;
  model: string | null;
  prompt: string | null;
  negativePrompt: string | null;
  width: number | null;
  height: number | null;
  seedMode: string | null;
  seedInput: number | null;
  steps: number | null;
  cfg: number | null;
  sampler: string | null;
  scheduler: string | null;
  // Generation mode: "txt2img" | "img2img" (null on rows recorded
  // before the column existed; reads as txt2img).
  mode: string | null;
  denoisingStrength: number | null;
  // True when this completed job's generated PNG has a recorded
  // host file path, so it can be sent to the Editor as an img2img
  // init image (the path itself never leaves the server).
  canSendToEditor: boolean;
  resultSeed: number | null;
  imageUrl: string | null;
  displayUrl: string | null;
  usedParams: string | null;
  loraHashes: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateJobResponse {
  ok: boolean;
  jobId: number | null;
  error: string | null;
}

export interface PollGenerationJobResponse {
  state: "running" | "completed" | "failed" | "not_direct" | "missing";
  error: string | null;
  // Display-only live sampling progress, piggybacked on the poll:
  // present only when this poll found the job in its generating
  // phase AND the server reported a job in flight or a sampling
  // signal. The raw counters are passed through as reported; the
  // CLIENT owns the display rules built on these counters.
  // Step counts only — no percentage, no ETA, and never an
  // in-progress image. Never stored in the DB.
  progress: {
    step: number;
    steps: number | null;
    fraction: number | null;
  } | null;
}

export interface OkResponse {
  ok: boolean;
}

export interface CreateJobRequest {
  prompt: string;
  // The active generation template's title (selection is by
  // template, not by model — 2026-11-24). The checkpoint the run
  // actually used travels inside the payload's override_settings.
  model: string;
  // Editable full negative prompt (Parameter pane). Used verbatim
  // as the payload's negative_prompt. This field is the job
  // record's copy of the user's negative text.
  negativePrompt?: string;
  width: number;
  height: number;
  seedMode: "random" | "fixed";
  seed?: number | null;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  // img2img (i2i) provenance: which image the init was — "job" =
  // the generated image of sourceJobId, or "upload" = the
  // uploaded image in the source slot. Since the
  // payload-passthrough rework the client itself fetches the
  // source image and carries its bytes in payload.init_images;
  // the worker resolves nothing. initSource null with a
  // sourceJobId set reads as "job" for compatibility.
  mode?: "txt2img" | "img2img";
  sourceJobId?: number | null;
  initSource?: "job" | "upload" | null;
  denoisingStrength?: number | null;
  // img2img resize mode (the Editor operation panel's Cover /
  // Crop / Contain / Latent selector): 0 = just resize (Cover),
  // 1 = crop and resize (Crop), 2 = resize and fill (Contain),
  // 3 = just resize in latent space (Latent). Record copy of the
  // selection; the payload carries the effective resize_mode.
  resizeMode?: number | null;
  // The complete sdapi payload, composed by the client. The
  // worker passes this object to the WebUI API verbatim: it
  // composes nothing, fixes nothing and guards nothing.
  payload: Record<string, unknown>;
}

export interface EditorSourceView {
  kind: "none" | "job" | "upload";
  jobId: number | null;
  // For kind "upload" pointing at the upload library: the
  // upload_images record's id. Null for legacy single-slot
  // uploads, jobs, and none.
  uploadId: number | null;
  // For kind "job": the source job's resulting seed. Together
  // with jobId it forms the generated image's display name and
  // download file name ("{jobId}-{resultSeed}"). Null for
  // uploads / none.
  resultSeed: number | null;
  displayUrl: string | null;
  // Original-resolution image URL. displayUrl may be a resized
  // display JPEG (max 1280px), so anything that needs the
  // source's REAL pixel dimensions — the Inpaint mask canvas —
  // must size from this URL, never from displayUrl.
  imageUrl: string | null;
  mimeType: string | null;
  byteSize: number | null;
  fileName: string | null;
}

export interface EditorSourceResponse {
  ok: boolean;
  error: string | null;
  source: EditorSourceView;
}

export interface UploadImageView {
  id: number;
  fileName: string | null;
  storedName: string;
  mimeType: string;
  byteSize: number;
  imageUrl: string | null;
  displayUrl: string | null;
  // The positive prompt extracted from a PNG's embedded WebUI
  // infotext at upload time; null for JPEGs and metadata-less
  // PNGs.
  prompt: string | null;
  createdAt: string;
}

export interface SavedImageView {
  id: number;
  counter: number;
  seed: number;
  // Display / download name stem: "{counter}-{seed}".
  name: string;
  sourceJobId: number | null;
  // Origin of the copy: "job" or "upload" (null on the oldest
  // rows, which are job saves). For "upload", sourceUploadId is
  // the upload_images record the copy came from and seed is 0.
  sourceKind: string | null;
  sourceUploadId: number | null;
  // File extension of the saved original ("png" | "jpg"), from
  // its blob key — upload saves keep the upload's own format.
  fileExt: string;
  imageUrl: string | null;
  displayUrl: string | null;
  createdAt: string;
}

export interface SaveImageResponse {
  ok: boolean;
  error: string | null;
  // Assigned saved name "{counter}-{seed}" on success.
  name: string | null;
  counter: number | null;
  seed: number | null;
}

export interface Actions {
  getWordDictionary: {
    request: Record<string, never>;
    response: { dictionary: string };
  };
  getTextSnippets: {
    request: Record<string, never>;
    response: { snippets: string };
  };
  saveTextSnippets: {
    request: { snippets: string[] };
    response: OkResponse;
  };
  getWorkspaceState: {
    request: Record<string, never>;
    response: {
      settings: string;
      prompt: string;
      // The server's latest save index — the client's initial
      // value at startup (the counter itself is client-managed).
      saveIndex: number;
    };
  };
  setSaveIndex: {
    request: { index: number };
    response: OkResponse;
  };
  saveSettings: {
    request: { settings: string };
    response: OkResponse;
  };
  savePrompt: {
    request: { prompt: string };
    response: OkResponse;
  };
  listJobs: {
    request: { limit?: number };
    response: { jobs: JobView[] };
  };
  getEditorSource: {
    request: Record<string, never>;
    response: { source: EditorSourceView };
  };
  uploadEditorImage: {
    request: {
      // base64 of at most 25 MB of image bytes is ~35M characters.
      dataBase64: string;
      mimeType: string;
      fileName?: string;
      // Optional client-generated display JPEG (max 1280px),
      // base64. Validated as JPEG when present; a bad one is
      // simply not stored (the original still thumbnails).
      displayDataBase64?: string;
    };
    response: EditorSourceResponse;
  };
  listUploadImages: {
    request: { limit?: number };
    response: { uploads: UploadImageView[] };
  };
  setEditorSourceFromUpload: {
    request: { uploadId: number };
    response: EditorSourceResponse;
  };
  deleteUploadImage: {
    request: { uploadId: number };
    response: { ok: boolean; deleted: number };
  };
  saveUploadImage: {
    request: {
      uploadId: number;
      // The client-managed save index (already incremented by
      // the client); the server names the file with it verbatim
      // and remembers it as the latest.
      index: number;
    };
    response: SaveImageResponse;
  };
  setEditorSourceFromJob: {
    request: { jobId: number };
    response: EditorSourceResponse;
  };
  clearEditorSource: {
    request: Record<string, never>;
    response: EditorSourceResponse;
  };
  // The img2img source slot, independent of the Editor slot:
  // the image shown in the prompt row's source image area and
  // used as the img2img / inpaint init image. Uploads land
  // here; the Editor image is copied here only by the explicit
  // adopt action (the image area's 元画像に採用 button).
  getSourceImage: {
    request: Record<string, never>;
    response: EditorSourceResponse;
  };
  adoptEditorSource: {
    request: Record<string, never>;
    response: EditorSourceResponse;
  };
  clearSourceImage: {
    request: Record<string, never>;
    response: EditorSourceResponse;
  };
  createJob: {
    request: CreateJobRequest;
    response: CreateJobResponse;
  };
  pollGenerationJob: {
    request: { jobId: number };
    response: PollGenerationJobResponse;
  };
  deleteJobs: {
    request: { jobIds: number[] };
    response: { ok: boolean; deleted: number };
  };
  saveJobImage: {
    request: { jobId: number; index: number };
    response: SaveImageResponse;
  };
  listSavedImages: {
    request: { limit?: number };
    response: { saved: SavedImageView[] };
  };
  deleteSavedImages: {
    request: { ids: number[] };
    response: { ok: boolean; deleted: number };
  };
}
