// Error codes of the media layer (spec §5.2). Providers throw MediaError; the runner decides
// what to do with each code (§5.4).
export const ERROR_CODES = ['auth', 'quota', 'moderation', 'invalid', 'unsupported', 'transient'];

export class MediaError extends Error {
  constructor(code, message, raw) {
    super(message);
    if (!ERROR_CODES.includes(code)) throw new Error(`unknown media error code ${code}`);
    this.code = code;
    this.raw = raw;
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.raw !== undefined ? { raw: this.raw } : {}) };
  }
}

// HTTP status → error code. Providers refine it (e.g. a 400 whose body says "content policy"
// becomes moderation) before throwing.
export function codeForStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || status === 429) return 'quota';
  // Gone: the endpoint or model was withdrawn (e.g. closed to this account); retrying cannot help.
  if (status === 410) return 'unsupported';
  if (status === 400 || status === 404 || status === 409 || status === 413 || status === 422) return 'invalid';
  return 'transient';
}

const MODERATION_HINTS = /moderat|content policy|safety|sensitive|nsfw|violat|inappropriate|blocked by|审核|敏感|违规/i;

export function looksLikeModeration(text) {
  return MODERATION_HINTS.test(String(text || ''));
}

// Any error carrying a known code counts, so a provider loaded from outside the plugin (or from an
// older plugin version) keeps its classification.
export function asMediaError(err) {
  if (err instanceof MediaError) return err;
  if (ERROR_CODES.includes(err?.code)) return new MediaError(err.code, err.message, err.raw);
  return new MediaError('transient', err?.message || String(err));
}
