/** Default response body cap (2 MiB). */
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Smallest cap a user can set. */
export const MIN_MAX_BODY_BYTES = 1024;

/** ceiling: 32 MiB per response; upgrade: raise MAX_MAX_BODY_BYTES. */
export const MAX_MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Parses a body cap: integer bytes, or an integer with a `kb` / `mb` suffix (1024-based).
 */
export function parseMaxBodyBytes(raw: string): number {
  const text = raw.trim().toLowerCase().replace(/[\s_]/g, '');
  const match = /^(\d+)(kb|mb)?$/.exec(text);

  if (!match) {
    throw new Error(maxBodyBytesMessage());
  }

  const amount = Number(match[1]);
  const unit = match[2];
  let multiplier = 1;

  if (unit === 'kb') {
    multiplier = 1024;
  } else if (unit === 'mb') {
    multiplier = 1024 * 1024;
  }

  const bytes = amount * multiplier;

  if (!Number.isSafeInteger(bytes) || bytes < MIN_MAX_BODY_BYTES || bytes > MAX_MAX_BODY_BYTES) {
    throw new Error(maxBodyBytesMessage());
  }

  return bytes;
}

function maxBodyBytesMessage(): string {
  return `--max-bytes / max_body_bytes must be an integer from ${MIN_MAX_BODY_BYTES} to ${MAX_MAX_BODY_BYTES} bytes (optional kb or mb suffix)`;
}
