// Per-action request field attributes (min/max/maxLength/step/required),
// inlined from the contract's zod schemas. Originally produced at bundle
// time by the @hatch/space-sdk/fields macro; here it is a checked-in
// snapshot of that output (generated 2026-11-22). Regenerate it if
// contract.ts limits change.

export const FIELDS = {
  "getModelList": {},
  "getSamplerList": {},
  "getWordDictionary": {},
  "getTextSnippets": {},
  "saveTextSnippets": {
    "snippets": {
      "name": "snippets",
      "maxLength": 2000
    }
  },
  "getWorkspaceState": {},
  "saveSettings": {
    "settings": {
      "name": "settings",
      "maxLength": 20000
    }
  },
  "savePrompt": {
    "prompt": {
      "name": "prompt",
      "maxLength": 20000
    }
  },
  "listJobs": {
    "limit": {
      "name": "limit",
      "type": "number",
      "step": 1,
      "min": 1,
      "max": 100
    }
  },
  "getEditorSource": {},
  "uploadEditorImage": {
    "dataBase64": {
      "name": "dataBase64",
      "minLength": 1,
      "required": true,
      "maxLength": 35000000
    },
    "mimeType": {
      "name": "mimeType",
      "maxLength": 100
    },
    "fileName": {
      "name": "fileName",
      "maxLength": 200
    },
    "displayDataBase64": {
      "name": "displayDataBase64",
      "maxLength": 35000000
    }
  },
  "listUploadImages": {
    "limit": {
      "name": "limit",
      "type": "number",
      "step": 1,
      "min": 1,
      "max": 200
    }
  },
  "setEditorSourceFromUpload": {
    "uploadId": {
      "name": "uploadId",
      "type": "number",
      "step": 1,
      "required": true,
      "min": 1
    }
  },
  "deleteUploadImage": {
    "uploadId": {
      "name": "uploadId",
      "type": "number",
      "step": 1,
      "required": true,
      "min": 1
    }
  },
  "saveUploadImage": {
    "uploadId": {
      "name": "uploadId",
      "type": "number",
      "step": 1,
      "required": true,
      "min": 1
    }
  },
  "setEditorSourceFromJob": {
    "jobId": {
      "name": "jobId",
      "type": "number",
      "step": 1,
      "required": true,
      "min": 1
    }
  },
  "clearEditorSource": {},
  "createJob": {
    "prompt": {
      "name": "prompt",
      "minLength": 1,
      "required": true,
      "maxLength": 4000
    },
    "model": {
      "name": "model"
    },
    "extraNegative": {
      "name": "extraNegative",
      "maxLength": 2000
    },
    "negativePrompt": {
      "name": "negativePrompt",
      "maxLength": 4000
    },
    "width": {
      "name": "width",
      "type": "number",
      "step": 1,
      "required": true,
      "min": 64,
      "max": 4096
    },
    "height": {
      "name": "height",
      "type": "number",
      "step": 1,
      "required": true,
      "min": 64,
      "max": 4096
    },
    "seedMode": {
      "name": "seedMode"
    },
    "seed": {
      "name": "seed",
      "type": "number",
      "step": 1,
      "min": 0,
      "max": 4294967295
    },
    "steps": {
      "name": "steps",
      "type": "number",
      "step": 1,
      "required": true,
      "min": 1,
      "max": 150
    },
    "cfg": {
      "name": "cfg",
      "type": "number",
      "step": "any",
      "required": true,
      "min": 0,
      "max": 30
    },
    "sampler": {
      "name": "sampler",
      "minLength": 1,
      "required": true,
      "maxLength": 80
    },
    "scheduler": {
      "name": "scheduler",
      "minLength": 1,
      "required": true,
      "maxLength": 80
    },
    "mode": {
      "name": "mode"
    },
    "sourceJobId": {
      "name": "sourceJobId",
      "type": "number",
      "step": 1,
      "min": 1
    },
    "initSource": {
      "name": "initSource"
    },
    "denoisingStrength": {
      "name": "denoisingStrength",
      "type": "number",
      "step": "any",
      "min": 0,
      "max": 1
    },
    "maskDataBase64": {
      "name": "maskDataBase64",
      "maxLength": 35000000
    },
    "maskBlur": {
      "name": "maskBlur",
      "type": "number",
      "step": 1,
      "min": 0,
      "max": 16
    },
    "maskInvert": {
      "name": "maskInvert",
      "type": "number",
      "step": 1,
      "min": 0,
      "max": 1
    }
  },
  "pollGenerationJob": {
    "jobId": {
      "name": "jobId",
      "type": "number",
      "step": 1,
      "required": true,
      "min": 1
    }
  },
  "createCheck": {},
  "completeJob": {
    "jobId": {
      "name": "jobId",
      "type": "number",
      "step": 1,
      "required": true,
      "min": 1
    },
    "filePath": {
      "name": "filePath",
      "minLength": 1,
      "required": true,
      "maxLength": 500
    },
    "displayPath": {
      "name": "displayPath",
      "minLength": 1,
      "required": true,
      "maxLength": 500
    },
    "seed": {
      "name": "seed",
      "type": "number",
      "step": 1,
      "required": true
    },
    "usedParams": {
      "name": "usedParams",
      "maxLength": 20000
    },
    "loraHashes": {
      "name": "loraHashes",
      "maxLength": 500
    }
  },
  "completeCheck": {
    "jobId": {
      "name": "jobId",
      "type": "number",
      "step": 1,
      "required": true,
      "min": 1
    },
    "samplers": {
      "name": "samplers",
      "type": "number",
      "step": 1,
      "required": true,
      "min": 0
    },
    "models": {
      "name": "models",
      "maxLength": 300
    },
    "checkpoint": {
      "name": "checkpoint",
      "maxLength": 500
    }
  },
  "deleteJobs": {
    "jobIds": {
      "name": "jobIds",
      "type": "number",
      "step": 1,
      "min": 1
    }
  },
  "saveJobImage": {
    "jobId": {
      "name": "jobId",
      "type": "number",
      "step": 1,
      "required": true,
      "min": 1
    }
  },
  "listSavedImages": {
    "limit": {
      "name": "limit",
      "type": "number",
      "step": 1,
      "min": 1,
      "max": 200
    }
  },
  "deleteSavedImages": {
    "ids": {
      "name": "ids",
      "type": "number",
      "step": 1,
      "min": 1
    }
  },
  "updatePhase": {
    "jobId": {
      "name": "jobId",
      "type": "number",
      "step": 1,
      "required": true,
      "min": 1
    },
    "phase": {
      "name": "phase",
      "minLength": 1,
      "required": true,
      "maxLength": 40
    }
  },
  "failJob": {
    "jobId": {
      "name": "jobId",
      "type": "number",
      "step": 1,
      "required": true,
      "min": 1
    },
    "error": {
      "name": "error",
      "minLength": 1,
      "required": true,
      "maxLength": 1000
    }
  }
} as const;
