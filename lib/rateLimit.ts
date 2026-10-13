import { createHash } from "node:crypto";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export type RateLimitEndpoint = "create" | "message" | "image" | "shortcut";

type WindowPolicy = {
  name: string;
  limit: number;
  window: Parameters<typeof Ratelimit.slidingWindow>[1];
  windowMs: number;
};

type RateLimitDecision = {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
};

const endpointPolicies: Record<RateLimitEndpoint, WindowPolicy[]> = {
  create: [
    { name: "10m", limit: 5, window: "10 m", windowMs: 10 * 60_000 },
    { name: "1h", limit: 30, window: "1 h", windowMs: 60 * 60_000 },
  ],
  message: [
    { name: "1m", limit: 15, window: "1 m", windowMs: 60_000 },
    { name: "1h", limit: 120, window: "1 h", windowMs: 60 * 60_000 },
  ],
  image: [
    { name: "1m", limit: 3, window: "1 m", windowMs: 60_000 },
    { name: "1h", limit: 15, window: "1 h", windowMs: 60 * 60_000 },
  ],
  shortcut: [
    { name: "1h", limit: 10, window: "1 h", windowMs: 60 * 60_000 },
  ],
};

const sessionPolicies: Partial<Record<RateLimitEndpoint, WindowPolicy[]>> = {
  message: [
    { name: "session-1m", limit: 20, window: "1 m", windowMs: 60_000 },
    { name: "session-1h", limit: 150, window: "1 h", windowMs: 60 * 60_000 },
  ],
};

const memoryEvents = new Map<string, number[]>();
const redisLimiters = new Map<string, Ratelimit>();
let warnedAboutMemoryFallback = false;

function rateLimitingDisabled() {
  return process.env.RATE_LIMIT_DISABLED === "true";
}

function hasRedisConfiguration() {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

function hashIdentifier(value: string) {
  const salt = process.env.RATE_LIMIT_HASH_SALT || "socratic-math-coach";
  return createHash("sha256").update(`${salt}:${value}`).digest("hex");
}

function firstForwardedValue(value: string | null) {
  return value?.split(",")[0]?.trim() || null;
}

export function trustedClientIdentifier(req: Request) {
  const configuredHeader = process.env.RATE_LIMIT_IP_HEADER?.trim().toLowerCase();
  let clientAddress: string | null = null;

  if (configuredHeader) {
    clientAddress = firstForwardedValue(req.headers.get(configuredHeader));
  } else if (process.env.VERCEL) {
    clientAddress =
      firstForwardedValue(req.headers.get("x-vercel-forwarded-for")) ||
      firstForwardedValue(req.headers.get("x-forwarded-for"));
  } else if (process.env.CF_PAGES) {
    clientAddress = firstForwardedValue(req.headers.get("cf-connecting-ip"));
  } else if (process.env.RATE_LIMIT_TRUST_PROXY === "true") {
    clientAddress =
      firstForwardedValue(req.headers.get("x-forwarded-for")) ||
      firstForwardedValue(req.headers.get("x-real-ip"));
  } else if (process.env.NODE_ENV !== "production") {
    clientAddress =
      firstForwardedValue(req.headers.get("x-forwarded-for")) ||
      firstForwardedValue(req.headers.get("x-real-ip")) ||
      "local-development";
  }

  return hashIdentifier(clientAddress || "unidentified-client");
}

export function consumeMemoryRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now()
): RateLimitDecision {
  const cutoff = now - windowMs;
  const recent = (memoryEvents.get(key) || []).filter((timestamp) => timestamp > cutoff);
  recent.push(now);
  memoryEvents.set(key, recent);

  const remaining = Math.max(0, limit - recent.length);
  return {
    success: recent.length <= limit,
    limit,
    remaining,
    reset: (recent[0] || now) + windowMs,
  };
}

export function resetMemoryRateLimits() {
  memoryEvents.clear();
}

function redisLimiter(policy: WindowPolicy, scope: string) {
  const key = `${scope}:${policy.name}:${policy.limit}`;
  const existing = redisLimiters.get(key);
  if (existing) return existing;

  const limiter = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(policy.limit, policy.window),
    analytics: false,
    prefix: `math-coach:rate-limit:${scope}:${policy.name}`,
  });
  redisLimiters.set(key, limiter);
  return limiter;
}

async function consumePolicy(
  scope: string,
  identifier: string,
  policy: WindowPolicy
): Promise<RateLimitDecision> {
  const memoryKey = `${scope}:${policy.name}:${identifier}`;
  if (!hasRedisConfiguration()) {
    if (process.env.NODE_ENV === "production" && !warnedAboutMemoryFallback) {
      warnedAboutMemoryFallback = true;
      console.warn(
        "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are not configured; rate limiting is local to each server instance."
      );
    }
    return consumeMemoryRateLimit(memoryKey, policy.limit, policy.windowMs);
  }

  try {
    const result = await redisLimiter(policy, scope).limit(identifier);
    return {
      success: result.success,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
    };
  } catch (error) {
    console.error("Distributed rate limit check failed; using the local fallback.", error);
    return consumeMemoryRateLimit(memoryKey, policy.limit, policy.windowMs);
  }
}

async function checkPolicies(
  scope: string,
  identifier: string,
  policies: WindowPolicy[]
) {
  if (rateLimitingDisabled()) return null;

  for (const policy of policies) {
    const decision = await consumePolicy(scope, identifier, policy);
    if (!decision.success) return decision;
  }
  return null;
}

export async function checkApiRateLimit(req: Request, endpoint: RateLimitEndpoint) {
  return checkPolicies(
    `ip:${endpoint}`,
    trustedClientIdentifier(req),
    endpointPolicies[endpoint]
  );
}

export async function checkSessionRateLimit(
  endpoint: RateLimitEndpoint,
  sessionId: string
) {
  const policies = sessionPolicies[endpoint];
  if (!policies) return null;
  return checkPolicies(`session:${endpoint}`, hashIdentifier(sessionId), policies);
}

export function rateLimitResponse(decision: RateLimitDecision) {
  const retryAfterSeconds = Math.max(1, Math.ceil((decision.reset - Date.now()) / 1000));
  return Response.json(
    {
      error: "Too many requests. Please wait a moment and try again.",
      code: "rate_limited",
      retry_after_seconds: retryAfterSeconds,
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSeconds),
        "X-RateLimit-Limit": String(decision.limit),
        "X-RateLimit-Remaining": String(decision.remaining),
        "X-RateLimit-Reset": String(Math.ceil(decision.reset / 1000)),
      },
    }
  );
}
