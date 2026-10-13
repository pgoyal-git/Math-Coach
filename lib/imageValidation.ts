import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  type AllowedImageMimeType,
} from "@/lib/inputLimits";
import { RequestValidationError } from "@/lib/requestSafety";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_IMAGE_EDGE = 10_000;
const MAX_IMAGE_PIXELS = 25_000_000;

export type ValidatedImage = {
  imageBase64: string;
  mimeType: AllowedImageMimeType;
  width: number;
  height: number;
  byteLength: number;
};

function startsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number) {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function uint16be(bytes: Uint8Array, offset: number) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function uint24le(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function uint32le(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset] +
    bytes[offset + 1] * 0x100 +
    bytes[offset + 2] * 0x10000 +
    bytes[offset + 3] * 0x1000000
  );
}

function uint32be(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function pngDimensions(bytes: Uint8Array) {
  if (
    bytes.length < 45 ||
    !startsWith(bytes, PNG_SIGNATURE) ||
    uint32be(bytes, 8) !== 13 ||
    ascii(bytes, 12, 4) !== "IHDR" ||
    ascii(bytes, bytes.length - 8, 4) !== "IEND"
  ) {
    return null;
  }
  return { width: uint32be(bytes, 16), height: uint32be(bytes, 20) };
}

function jpegDimensions(bytes: Uint8Array) {
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  ) return null;

  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;
    if (offset + 1 >= bytes.length) break;

    const segmentLength = uint16be(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && segmentLength >= 7) {
      return {
        height: uint16be(bytes, offset + 3),
        width: uint16be(bytes, offset + 5),
      };
    }

    offset += segmentLength;
  }

  return null;
}

function webpDimensions(bytes: Uint8Array) {
  if (
    bytes.length < 25 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP" ||
    uint32le(bytes, 4) + 8 !== bytes.length
  ) {
    return null;
  }

  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    return {
      width: uint24le(bytes, 24) + 1,
      height: uint24le(bytes, 27) + 1,
    };
  }

  if (
    chunk === "VP8 " &&
    bytes.length >= 30 &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return {
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    };
  }

  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b1 = bytes[21];
    const b2 = bytes[22];
    const b3 = bytes[23];
    const b4 = bytes[24];
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | (b2 >> 6)),
    };
  }

  return null;
}

function decodeStrictBase64(imageBase64: string) {
  if (
    !imageBase64 ||
    imageBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(imageBase64)
  ) {
    throw new RequestValidationError(
      "Image data is not valid base64.",
      400,
      "invalid_image_data"
    );
  }

  const padding = imageBase64.endsWith("==") ? 2 : imageBase64.endsWith("=") ? 1 : 0;
  const estimatedBytes = (imageBase64.length / 4) * 3 - padding;
  if (estimatedBytes > MAX_IMAGE_BYTES) {
    throw new RequestValidationError(
      "Image must be 3 MB or smaller.",
      413,
      "image_too_large"
    );
  }

  const decoded = Buffer.from(imageBase64, "base64");
  if (decoded.byteLength !== estimatedBytes) {
    throw new RequestValidationError(
      "Image data is not valid base64.",
      400,
      "invalid_image_data"
    );
  }

  return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
}

function normalizeMimeType(value: unknown): AllowedImageMimeType {
  const mimeType = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!ALLOWED_IMAGE_MIME_TYPES.includes(mimeType as AllowedImageMimeType)) {
    throw new RequestValidationError(
      "Use a PNG, JPEG, or WebP image.",
      415,
      "unsupported_image_type"
    );
  }
  return mimeType as AllowedImageMimeType;
}

export function validateImageUpload(
  imageBase64Value: unknown,
  mimeTypeValue: unknown
): ValidatedImage {
  if (typeof imageBase64Value !== "string") {
    throw new RequestValidationError("Missing image data.", 400, "missing_image_data");
  }

  const mimeType = normalizeMimeType(mimeTypeValue);
  const bytes = decodeStrictBase64(imageBase64Value);
  const dimensions =
    mimeType === "image/png"
      ? pngDimensions(bytes)
      : mimeType === "image/jpeg"
        ? jpegDimensions(bytes)
        : webpDimensions(bytes);

  if (!dimensions) {
    throw new RequestValidationError(
      "The file contents do not match the selected image type.",
      415,
      "image_signature_mismatch"
    );
  }

  const { width, height } = dimensions;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_IMAGE_EDGE ||
    height > MAX_IMAGE_EDGE ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw new RequestValidationError(
      "Image dimensions are too large. Use an image under 25 megapixels and 10,000 pixels per side.",
      413,
      "image_dimensions_too_large"
    );
  }

  return {
    imageBase64: imageBase64Value,
    mimeType,
    width,
    height,
    byteLength: bytes.byteLength,
  };
}
