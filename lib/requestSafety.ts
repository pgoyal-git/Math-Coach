export class RequestValidationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "RequestValidationError";
  }
}

function declaredContentLength(req: Request) {
  const value = req.headers.get("content-length");
  if (!value) return null;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function readJsonBody<T>(req: Request, maxBytes: number): Promise<T> {
  const declaredBytes = declaredContentLength(req);
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    throw new RequestValidationError(
      "Request body is too large.",
      413,
      "request_too_large"
    );
  }

  if (!req.body) {
    throw new RequestValidationError("Missing request body.", 400, "missing_body");
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new RequestValidationError(
          "Request body is too large.",
          413,
          "request_too_large"
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as T;
  } catch (error) {
    if (error instanceof RequestValidationError) throw error;
    throw new RequestValidationError("Request body must be valid JSON.", 400, "invalid_json");
  }
}

export function requireStringWithinLimit(
  value: unknown,
  fieldName: string,
  maxChars: number,
  options: { allowEmpty?: boolean } = {}
) {
  if (typeof value !== "string") {
    throw new RequestValidationError(`Missing ${fieldName}.`, 400, `missing_${fieldName}`);
  }

  const trimmed = value.trim();
  if (!options.allowEmpty && !trimmed) {
    throw new RequestValidationError(`Missing ${fieldName}.`, 400, `missing_${fieldName}`);
  }
  if (value.length > maxChars) {
    throw new RequestValidationError(
      `${fieldName} must be ${maxChars.toLocaleString("en-US")} characters or fewer.`,
      413,
      `${fieldName}_too_long`
    );
  }

  return trimmed;
}

export function requestValidationResponse(error: unknown) {
  if (!(error instanceof RequestValidationError)) return null;

  return Response.json(
    { error: error.message, code: error.code },
    { status: error.status }
  );
}
