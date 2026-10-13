export const MAX_STUDENT_MESSAGE_CHARS = 2_000;
export const MAX_PROBLEM_CHARS = 8_000;
export const MAX_OCR_TEXT_CHARS = 8_000;
// Keep the base64-encoded JSON request comfortably below Vercel's 4.5 MB
// Function payload limit.
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

export const MAX_MESSAGE_REQUEST_BYTES = 16 * 1024;
export const MAX_SHORTCUT_REQUEST_BYTES = 4 * 1024;
export const MAX_IMAGE_REQUEST_BYTES =
  Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + MAX_PROBLEM_CHARS * 4 + 64 * 1024;

export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type AllowedImageMimeType = typeof ALLOWED_IMAGE_MIME_TYPES[number];
