/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "verifier-regression-test-key";
process.env.RATE_LIMIT_DISABLED = "true";

// Route-level regression tests must not make network calls. Individual moderation
// tests below inject their own clients and exercise flagged and failure behavior.
const { Moderations } = require("openai/resources/moderations");
const allowModerationFixture = async function createModerationFixture() {
  return {
    id: "moderation-regression-fixture",
    model: "omni-moderation-latest",
    results: [{ flagged: false, categories: {} }],
  };
};
Moderations.prototype.create = allowModerationFixture;

const rootDir = path.resolve(__dirname, "..");
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveAlias(request, parent, isMain, options) {
  if (request.startsWith("@/")) {
    return originalResolveFilename.call(
      this,
      path.join(rootDir, request.slice(2)),
      parent,
      isMain,
      options
    );
  }

  return originalResolveFilename.call(this, request, parent, isMain, options);
};

Module._extensions[".ts"] = function loadTs(module, filename) {
  const source = require("node:fs").readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });

  module._compile(output.outputText, filename);
};

const { deterministicVerify } = require("../lib/coachVerifier.ts");
const { composeCoachResponse } = require("../lib/coachResponse.ts");
const {
  POST: messagePost,
  applyConservativePolicy,
  formulaHelpResponse,
  fallbackForwardHint,
  hasReachedHintCeiling,
  HINT_CEILING_RESPONSE,
  ensureWorkState,
  looksUnevaluatedFinalExpression,
  normalizeForwardStuckHint,
  requireEvaluationForUnevaluatedFinal,
  stuckHelpPrompt,
  stuckHelpResponse,
  updateWorkState,
  vocabularyHelpResponse,
} = require("../app/api/session/message/route.ts");
const { POST: statePost } = require("../app/api/session/state/route.ts");
const {
  POST: ingestImagePost,
  imageExtractionPrompt,
} = require("../app/api/ingest-image/route.ts");
const {
  deleteSession,
  getSession,
  sessionHydrationStore,
  sessionStore,
  setSession,
} = require("../lib/sessionStore.ts");
const {
  POST: createSessionPost,
  sanitizeStrategy,
} = require("../app/api/session/create/route.ts");
const {
  verifyCanonicalNumericClaim,
} = require("../lib/coach-verifier/canonicalNumeric.ts");
const {
  verifyCombinationClaim,
  verifyFactorialClaim,
  verifyPermutationClaim,
} = require("../lib/coach-verifier/combinatorics.ts");
const {
  canonicalFinalAnswerMatches,
  canonicalSympyVerify,
} = require("../lib/canonicalSympyVerifier.ts");
const {
  verifyBorrowedConsecutiveSheetsSetup,
  verifyMissingConsecutivePagesFinalAnswer,
  verifyMissingConsecutivePagesSetup,
} = require("../lib/coach-verifier/pageNumbers.ts");
const {
  verifyProblemRelevance,
} = require("../lib/coach-verifier/relevance.ts");
const {
  verifyArithmeticEquality,
  verifyMixedNumberEquality,
} = require("../lib/coach-verifier/arithmetic.ts");
const {
  parseSingleArithmeticCandidate,
} = require("../lib/coach-verifier/math.ts");
const {
  expressionToLatex,
  inlineLatexForDisplay,
  mathLiveLatexToMixedDisplay,
  mathLiveLatexToSubmitText,
  splitExplicitLatex,
  splitPlainMath,
} = require("../lib/mathText.ts");
const {
  normalizeStudentProseTypos,
} = require("../lib/coach-verifier/typos.ts");
const {
  directInteractionIntent,
} = require("../lib/interactionIntent.ts");
const {
  canonicalizeNumericTokens,
} = require("../lib/numericText.ts");
const { parseClaim } = require("../lib/claimNormalizer.ts");
const {
  isSupportedDerivedFinalCandidate,
  runVerifierRegistry,
  shouldCanonicalOverrideLocalRejection,
} = require("../lib/verifierRegistry.ts");
const { strategyPrompt } = require("../lib/prompts/strategyPrompt.ts");
const {
  ContentModerationUnavailableError,
  moderateUserContent,
  moderationBlockedMessage,
} = require("../lib/contentModeration.ts");
const {
  consumeMemoryRateLimit,
  rateLimitResponse,
  resetMemoryRateLimits,
} = require("../lib/rateLimit.ts");
const { validateImageUpload } = require("../lib/imageValidation.ts");
const {
  readJsonBody,
  RequestValidationError,
} = require("../lib/requestSafety.ts");
const {
  MAX_IMAGE_REQUEST_BYTES,
  MAX_PROBLEM_CHARS,
  MAX_STUDENT_MESSAGE_CHARS,
} = require("../lib/inputLimits.ts");

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test("numeric token canonicalization removes only thousands separators", () => {
  assert.equal(canonicalizeNumericTokens("222,222"), "222222");
  assert.equal(canonicalizeNumericTokens("222{,}222"), "222222");
  assert.equal(canonicalizeNumericTokens("1\\,234\\,567"), "1234567");
  assert.equal(canonicalizeNumericTokens("(2, 3) and 11, 13, 17"), "(2, 3) and 11, 13, 17");
  assert.equal(canonicalizeNumericTokens("11,13,17"), "11,13,17");
  assert.equal(canonicalizeNumericTokens("11,113,17"), "11,113,17");
  assert.equal(parseSingleArithmeticCandidate("222{,}222 - 22{,}222").numerator, BigInt(200000));
  assert.equal(parseClaim("222{,}222 - 22{,}222 = 200{,}000").normalized, "222222 - 22222 = 200000");
});

test("moderation gate uses omni moderation for text and images", async () => {
  let request = null;
  const decision = await moderateUserContent(
    {
      moderations: {
        create: async (body) => {
          request = body;
          return {
            results: [
              {
                flagged: true,
                categories: { harassment: true, hate: false },
              },
            ],
          };
        },
      },
    },
    {
      text: "unsafe text",
      image: { imageBase64: "abc123", mimeType: "image/png" },
    }
  );

  assert.equal(request.model, "omni-moderation-latest");
  assert.deepEqual(request.input, [
    { type: "text", text: "unsafe text" },
    { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
  ]);
  assert.deepEqual(decision, { flagged: true, categories: ["harassment"] });
});

test("moderation failures are fail-closed and self-harm gets supportive copy", async () => {
  await assert.rejects(
    moderateUserContent(
      {
        moderations: {
          create: async () => {
            throw new Error("network failure");
          },
        },
      },
      { text: "hello" }
    ),
    ContentModerationUnavailableError
  );

  assert.match(
    moderationBlockedMessage({ flagged: true, categories: ["self-harm/intent"] }),
    /trusted adult/i
  );
  assert.match(
    moderationBlockedMessage({ flagged: true, categories: ["hate"] }),
    /respectful.*math problem/i
  );
});

test("route moderation precedes prompt-injection scanning and model work", () => {
  const fs = require("node:fs");
  const createSource = fs.readFileSync(
    path.join(rootDir, "app/api/session/create/route.ts"),
    "utf8"
  );
  const messageSource = fs.readFileSync(
    path.join(rootDir, "app/api/session/message/route.ts"),
    "utf8"
  );
  const imageSource = fs.readFileSync(
    path.join(rootDir, "app/api/ingest-image/route.ts"),
    "utf8"
  );

  const createPost = createSource.slice(createSource.indexOf("export async function POST"));
  const messagePostSource = messageSource.slice(messageSource.indexOf("export async function POST"));
  const imagePost = imageSource.slice(imageSource.indexOf("export async function POST"));

  assert.ok(createPost.indexOf("moderateUserContent") < createPost.indexOf("scanPromptInjection"));
  assert.ok(messagePostSource.indexOf("moderateUserContent") < messagePostSource.indexOf("scanPromptInjection"));
  assert.ok(imagePost.indexOf("moderateUserContent") < imagePost.indexOf("client.responses.create"));
  assert.ok(imagePost.lastIndexOf("moderateUserContent") < imagePost.indexOf("scanPromptInjection"));
  assert.ok(createPost.indexOf("checkApiRateLimit") < createPost.indexOf("moderateUserContent"));
  assert.ok(messagePostSource.indexOf("checkApiRateLimit") < messagePostSource.indexOf("moderateUserContent"));
  assert.ok(imagePost.indexOf("checkApiRateLimit") < imagePost.indexOf("moderateUserContent"));
  assert.ok(imagePost.indexOf("validateImageUpload") < imagePost.indexOf("moderateUserContent"));
});

test("flagged route input stops before session, history, or OCR processing", async () => {
  Moderations.prototype.create = async () => ({
    id: "flagged-moderation-fixture",
    model: "omni-moderation-latest",
    results: [
      {
        flagged: true,
        categories: { harassment: true },
      },
    ],
  });

  try {
    const createResponse = await createSessionPost(
      new Request("http://localhost/api/session/create", {
        method: "POST",
        body: JSON.stringify({ problem: "flagged problem" }),
      })
    );
    assert.equal(createResponse.status, 422);
    assert.equal((await createResponse.json()).moderation_blocked, true);

    const session = makeSession({
      sessionId: "moderation-route-test",
      problem: "What is 2+2?",
      solutionGuideStatus: "ready",
    });
    sessionStore.set(session.sessionId, session);
    const messageResponse = await messagePost(
      new Request("http://localhost/api/session/message", {
        method: "POST",
        body: JSON.stringify({ sessionId: session.sessionId, message: "flagged message" }),
      })
    );
    assert.equal(messageResponse.status, 422);
    assert.equal((await messageResponse.json()).moderation_blocked, true);
    assert.deepEqual(sessionStore.get(session.sessionId).history, []);

    const imageResponse = await ingestImagePost(
      new Request("http://localhost/api/ingest-image", {
        method: "POST",
        body: JSON.stringify({
          imageBase64:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          mimeType: "image/png",
        }),
      })
    );
    assert.equal(imageResponse.status, 422);
    assert.equal((await imageResponse.json()).moderation_blocked, true);
  } finally {
    Moderations.prototype.create = allowModerationFixture;
  }
});

test("request body reader enforces actual bytes even without content-length", async () => {
  const request = new Request("http://localhost/api/test", {
    method: "POST",
    body: JSON.stringify({ message: "x".repeat(100) }),
  });

  await assert.rejects(
    () => readJsonBody(request, 40),
    (error) =>
      error instanceof RequestValidationError &&
      error.status === 413 &&
      error.code === "request_too_large"
  );
});

test("session routes reject oversized text before normal processing", async () => {
  const messageResponse = await messagePost(
    new Request("http://localhost/api/session/message", {
      method: "POST",
      body: JSON.stringify({
        sessionId: "oversized-message-test",
        message: "x".repeat(MAX_STUDENT_MESSAGE_CHARS + 1),
      }),
    })
  );
  assert.equal(messageResponse.status, 413);
  assert.match((await messageResponse.json()).error, /characters or fewer/i);

  const createResponse = await createSessionPost(
    new Request("http://localhost/api/session/create", {
      method: "POST",
      body: JSON.stringify({ problem: "x".repeat(MAX_PROBLEM_CHARS + 1) }),
    })
  );
  assert.equal(createResponse.status, 413);
  assert.match((await createResponse.json()).error, /characters or fewer/i);
});

test("image validation checks MIME, magic bytes, decoded size, and dimensions", () => {
  const onePixelPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const valid = validateImageUpload(onePixelPng, "image/png");
  assert.equal(valid.width, 1);
  assert.equal(valid.height, 1);
  assert.ok(valid.byteLength > 0);

  assert.throws(
    () => validateImageUpload(onePixelPng, "image/jpeg"),
    (error) => error.code === "image_signature_mismatch" && error.status === 415
  );
  assert.throws(
    () => validateImageUpload(onePixelPng, "image/gif"),
    (error) => error.code === "unsupported_image_type" && error.status === 415
  );

  const oversizedPngHeader = Buffer.alloc(45);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversizedPngHeader);
  oversizedPngHeader.writeUInt32BE(13, 8);
  Buffer.from("IHDR").copy(oversizedPngHeader, 12);
  oversizedPngHeader.writeUInt32BE(10_001, 16);
  oversizedPngHeader.writeUInt32BE(1, 20);
  Buffer.from("IEND").copy(oversizedPngHeader, oversizedPngHeader.length - 8);
  assert.throws(
    () => validateImageUpload(oversizedPngHeader.toString("base64"), "image/png"),
    (error) => error.code === "image_dimensions_too_large" && error.status === 413
  );
});

test("Vercel image request budget remains below the Function payload limit", () => {
  assert.ok(MAX_IMAGE_REQUEST_BYTES < 4.5 * 1024 * 1024);
});

test("session repository preserves the local in-memory fallback", async () => {
  const session = makeSession({ sessionId: "session-repository-local-test" });
  await setSession(session.sessionId, session);
  assert.deepEqual(await getSession(session.sessionId), session);
  await deleteSession(session.sessionId);
  assert.equal(await getSession(session.sessionId), null);
});

test("local rate limiter blocks over-budget requests and returns retry metadata", async () => {
  resetMemoryRateLimits();
  const now = 1_000_000;
  assert.equal(consumeMemoryRateLimit("message:test", 2, 60_000, now).success, true);
  assert.equal(consumeMemoryRateLimit("message:test", 2, 60_000, now + 1).success, true);
  const blocked = consumeMemoryRateLimit("message:test", 2, 60_000, now + 2);
  assert.equal(blocked.success, false);
  assert.equal(blocked.remaining, 0);

  const response = rateLimitResponse({ ...blocked, reset: Date.now() + 5_000 });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("Retry-After")) >= 1);
  assert.equal((await response.json()).code, "rate_limited");
});

test("ordinary prose ending in is-number is not misclassified as a final answer", () => {
  const plain = parseClaim("the last number in the sequence is 4257375");
  const grouped = parseClaim("the last number in the sequence is 4,257,375");

  assert.notEqual(plain.kind, "final_answer");
  assert.equal(plain.kind, grouped.kind);
});

test("Terra message calls do not send an unsupported temperature override", () => {
  const source = require("node:fs").readFileSync(
    path.join(rootDir, "app/api/session/message/route.ts"),
    "utf8"
  );

  assert.doesNotMatch(
    source,
    /model:\s*"gpt-5\.6-terra"[\s\S]{0,120}?temperature:\s*0/
  );
});

test("semantic verifier flags an explicitly requested strategy relation", () => {
  const source = require("node:fs").readFileSync(
    path.join(rootDir, "app/api/session/message/route.ts"),
    "utf8"
  );

  assert.match(source, /strategyExplicitlyRequestedRelation/);
  assert.match(source, /explicitlyRequestedStrategyRelation,/);
  assert.match(
    source,
    /check that relation directly against the original problem and hidden guide/
  );
  assert.match(source, /do not demand an intermediate derivation/);
});

test("step input preserves its mode when a submission is cleared", () => {
  const source = require("node:fs").readFileSync(
    path.join(rootDir, "app/MathStepInput.tsx"),
    "utf8"
  );
  const pageSource = require("node:fs").readFileSync(
    path.join(rootDir, "app/page.tsx"),
    "utf8"
  );
  const clearEffect = source.match(
    /if \(!value && mathfield\.value\)[\s\S]{0,220}?\}, \[value\]\);/
  )?.[0];
  const focusEffect = source.match(
    /const focusInput = \(\) => \{[\s\S]{0,280}?\}, \[autoFocus, disabled\]\);/
  )?.[0];

  assert.ok(clearEffect);
  assert.ok(focusEffect);
  assert.doesNotMatch(clearEffect, /switchMode|setEntryMode/);
  assert.doesNotMatch(focusEffect, /switchMode|setEntryMode/);
  assert.match(source, /\[modeResetKey\]/);
  assert.match(pageSource, /modeResetKey=\{sessionId\}/);
  assert.doesNotMatch(source, /visualViewport\.addEventListener\("scroll"/);
  assert.match(source, /visualViewport\.scale !== 1/);
});

test("step input keeps multi-digit numeric exponents together", () => {
  const source = require("node:fs").readFileSync(
    path.join(rootDir, "app/MathStepInput.tsx"),
    "utf8"
  );

  assert.match(source, /mathfield\.smartSuperscript = false/);
  assert.match(source, /mathfield\.executeCommand\("moveAfterParent"\)/);
  assert.ok(source.includes("!/[0-9.]/.test(event.key)"));
  assert.ok(source.includes("!/^[0-9.]+$/.test(insertedText)"));
});

test("starter strategy uses Terra on text and image paths", () => {
  const source = require("node:fs").readFileSync(
    path.join(rootDir, "app/api/session/create/route.ts"),
    "utf8"
  );
  const strategySource = source.match(
    /async function generateStrategy[\s\S]+?(?=\nasync function generateSolutionGuide|\nfunction normalizeSolutionGuide|\nasync function|\nexport async function)/
  )?.[0];

  assert.ok(strategySource, "expected to find starter-strategy generator");
  assert.equal(
    [...strategySource.matchAll(/model:\s*"gpt-5\.6-terra"/g)].length,
    2
  );
  assert.doesNotMatch(strategySource, /model:\s*"gpt-5\.6-luna"/);
});

test("hidden solution guide uses Terra on text and image paths", () => {
  const source = require("node:fs").readFileSync(
    path.join(rootDir, "app/api/session/create/route.ts"),
    "utf8"
  );
  const guideSource = source.match(
    /async function generateSolutionGuide[\s\S]+?(?=\nfunction normalizeSolutionGuide|\nasync function|\nexport async function)/
  )?.[0];

  assert.ok(guideSource, "expected to find hidden solution-guide generator");
  assert.equal(
    [...guideSource.matchAll(/model:\s*"gpt-5\.6-terra"/g)].length,
    2
  );
  assert.doesNotMatch(guideSource, /model:\s*"gpt-5-mini"/);
  assert.doesNotMatch(
    guideSource,
    /model:\s*"gpt-5\.6-terra"[\s\S]{0,120}?temperature:\s*0/
  );
  assert.match(guideSource, /custom operations[\s\S]*innermost operation[\s\S]*outer operation/i);
  assert.match(guideSource, /multi-segment rate[\s\S]*sum all requested segments/i);
});

test("hidden solution guide requires the final requested geometry quantity", () => {
  const source = require("node:fs").readFileSync(
    path.join(rootDir, "app/api/session/create/route.ts"),
    "utf8"
  );
  assert.match(source, /do not use an intermediate radius, length, area, or angle as finalAnswer/i);
});

function makeSession(overrides = {}) {
  return {
    sessionId: "test-session",
    problem: "Test problem",
    problemImage: null,
    topic: "General Math",
    securityFlags: [],
    strategy: {},
    history: [],
    summary: "",
    hintState: {
      stepIndex: 0,
      hintLevel: 0,
      stuckCount: 0,
      completedSteps: [],
    },
    workState: {
      acceptedLines: [],
      lastValidLine: null,
      rejectedLines: [],
    },
    coachingState: {
      lastSubstantiveAcceptedStep: null,
      knownFacts: [],
      currentGoal: null,
      currentSubgoal: null,
      lastCoachQuestion: null,
      expectedResponseShape: null,
      activeMethod: null,
      misconceptions: [],
      helpEpisode: {
        active: false,
        target: null,
        helpRequestCount: 0,
        nonProgressCount: 0,
        previousHints: [],
      },
    },
    solved: false,
    competitionShortcut: null,
    solutionGuide: null,
    solutionGuideStatus: "failed",
    ...overrides,
    workState: {
      acceptedLines: [],
      lastValidLine: null,
      rejectedLines: [],
      ...(overrides.workState || {}),
    },
    coachingState: {
      lastSubstantiveAcceptedStep: null,
      knownFacts: [],
      currentGoal: null,
      currentSubgoal: null,
      lastCoachQuestion: null,
      expectedResponseShape: null,
      activeMethod: null,
      misconceptions: [],
      helpEpisode: {
        active: false,
        target: null,
        helpRequestCount: 0,
        nonProgressCount: 0,
        previousHints: [],
      },
      ...(overrides.coachingState || {}),
      helpEpisode: {
        active: false,
        target: null,
        helpRequestCount: 0,
        nonProgressCount: 0,
        previousHints: [],
        ...(overrides.coachingState?.helpEpisode || {}),
      },
    },
  };
}

function assertStatus(result, status) {
  assert.ok(result, "expected a verification result");
  assert.equal(result.status, status);
}

test("shoelace formula help explains the method with renderable latex", () => {
  const response = formulaHelpResponse("can you explain the shoelace formula to me?");

  assert.ok(response);
  assert.match(response, /area of a polygon/i);
  assert.match(response, /ordered vertices/i);
  assert.ok(response.includes("$A=\\frac{1}{2}|S_1-S_2|$"));
  assert.doesNotMatch(response, /\\sum/);
  assert.doesNotMatch(response, /\\\(|\\\)/);

  assert.equal(
    formulaHelpResponse("after using shoelace formula, I get 1/2|-66 - 94|"),
    null
  );
});

test("annulus vocabulary help defines the word without solving the problem", () => {
  const response = vocabularyHelpResponse("what is an annuli?");

  assert.ok(response);
  assert.match(response, /ring-shaped region/i);
  assert.match(response, /same center/i);
  assert.match(response, /plural is annuli/i);
  assert.doesNotMatch(response, /sector|12|one-twelfth|\\pi|r\^?2/i);
});

test("strategy sanitizer removes complete numeric setup expressions", () => {
  const sanitized = sanitizeStrategy({
    game_plan:
      "Recognize this as a fractional-area problem and relate the shaded area to the whole rectangle using area = length times width.",
    what_to_look_for:
      "Notice the given dimensions 10 inches and 16 inches and the statement that the shaded region is one-fourth of the rectangle's area.",
    smart_move:
      "Set up the total area as the product 10 × 16 and express the shaded area as $\\frac{1}{4}$ of that product, leaving arithmetic for scratch work.",
    your_turn:
      "On your scratch paper write the expression $\\frac{1}{4}(10 \\times 16)$ as the starting setup.",
  });

  assert.match(sanitized.game_plan || "", /fractional-area problem/i);
  assert.match(sanitized.what_to_look_for || "", /10 inches and 16 inches/i);
  assert.doesNotMatch(sanitized.smart_move || "", /10|16|\\frac|one-fourth/i);
  assert.doesNotMatch(sanitized.your_turn || "", /10|16|\\frac|one-fourth/i);
  assert.match(sanitized.your_turn || "", /relationship/i);
});

test("strategy sanitizer removes malformed latex placeholders", () => {
  const sanitized = sanitizeStrategy({
    game_plan: "Look for powers with the same base.",
    what_to_look_for: "Notice the expression is built from powers.",
    smart_move: "Keep the structure symbolic instead of simplifying.",
    your_turn:
      "Write the expression in symbolic form as $frac{2^k cdot(textnum)}{2^m cdot(textden)}$ before simplifying.",
  });

  assert.doesNotMatch(sanitized.your_turn || "", /frac|cdot|textnum|textden/i);
  assert.match(sanitized.your_turn || "", /relationship|variables|plugging/i);
});

test("strategy sanitizer removes compact malformed latex fractions", () => {
  const sanitized = sanitizeStrategy({
    game_plan:
      "Treat this as arithmetic with rational numbers and plan to rewrite the nested denominator.",
    what_to_look_for:
      "Notice the denominator contains the inner fraction $\\frac45$, so the structure is a fraction divided by a sum.",
    smart_move:
      "Introduce a short symbol for the inner denominator or convert the inner sum into a single fraction.",
    your_turn:
      "Set $D=3+\\frac45$ and write the original expression as $1+\\frac2D$.",
  });

  assert.match(sanitized.game_plan || "", /rational numbers/i);
  assert.doesNotMatch(sanitized.what_to_look_for || "", /\\frac45|frac45/i);
  assert.match(sanitized.what_to_look_for || "", /whole object|requested part/i);
  assert.doesNotMatch(sanitized.your_turn || "", /\\frac2D|frac2D/i);
  assert.match(sanitized.your_turn || "", /relationship/i);
});

test("strategy sanitizer repairs malformed unit exponents", () => {
  const sanitized = sanitizeStrategy({
    game_plan: "Convert units before using area.",
    what_to_look_for: "Notice the result is an area.",
    smart_move:
      "Convert both linear measurements to centimeters, then apply $A=w\\times L$ to obtain the area in cm$^2$.",
    your_turn: "Write the relationship first.",
  });

  assert.match(sanitized.smart_move || "", /\$\\text\{cm\}\^2\$/);
  assert.doesNotMatch(sanitized.smart_move || "", /cm\$?\^2\$/);
});

test("strategy sanitizer repairs JSON tab damage in latex times commands", () => {
  const sanitized = sanitizeStrategy({
    game_plan: "Use multiplicative factors.",
    what_to_look_for: "Notice the two changes.",
    smart_move:
      "Set $S_{after}=S_{orig}\times F_1$ and $S_{final}=S_{after}times F_2$.",
    your_turn: "Write the relationship without simplifying.",
  });

  assert.equal(
    sanitized.smart_move,
    "Set $S_{after}=S_{orig}\\times F_1$ and $S_{final}=S_{after}\\times F_2$."
  );
});

test("strategy sanitizer repairs malformed divisibility-by dollar spans", () => {
  const sanitized = sanitizeStrategy({
    game_plan:
      "This is a divisibility-$by - 9$ problem—treat it as a digit-sum congruence question.",
  });

  assert.equal(
    sanitized.game_plan,
    "This is a divisibility by 9 problem—treat it as a digit-sum congruence question."
  );
  assert.doesNotMatch(sanitized.game_plan || "", /\$|divisibility-/);
});

test("strategy prompt requires delimited subscript variable lists", () => {
  assert.match(strategyPrompt, /\$h_\{Joe\}\$/);
  assert.match(strategyPrompt, /\$h_\{Mary\}\$/);
  assert.match(strategyPrompt, /each variable in its own dollar signs/i);
  assert.match(strategyPrompt, /not "h_\{Joe\},h_\{Mary\},h_\{Sue\}"/);
  assert.match(strategyPrompt, /Do NOT use LaTeX spacing commands/i);
});

test("coach rendering repairs escaped letter subscripts in setup equations", () => {
  assert.equal(
    inlineLatexForDisplay("S_{11}=aW\\_a+bW\\_b", "coach"),
    "S_{11}=aW_{a}+bW_{b}"
  );
});

test("image extraction prompt guards against invented diagram endpoints", () => {
  assert.match(imageExtractionPrompt, /Treat the image as canonical/i);
  assert.match(imageExtractionPrompt, /describe only relationships that are visible/i);
  assert.match(imageExtractionPrompt, /top\/bottom\/left\/right and corner names/i);
  assert.match(imageExtractionPrompt, /Before naming an endpoint, verify the endpoint/i);
  assert.match(imageExtractionPrompt, /If a line segment endpoint[\s\S]+is not visually certain/i);
  assert.match(imageExtractionPrompt, /use neutral language/i);
});

test("quadrilateral shoelace area computation is accepted as final", () => {
  const session = makeSession({
    problem:
      "What is the area of the quadrilateral whose vertices are (4, -4),(-4, 2),(6, 7) and (10, -1)?",
  });

  const screenshotLine = deterministicVerify(
    session,
    "shoelace formula yields: 1/2|94 + 66| = 1/2(160) = 80"
  );
  assertStatus(screenshotLine, "correct");
  assert.equal(screenshotLine.intent, "final_answer");
  assert.equal(screenshotLine.should_finish, true);

  const alternateOrientation = deterministicVerify(session, "after using shoelace formula, I get 1/2|-66 - 94|");
  assertStatus(alternateOrientation, "correct");
  assert.equal(alternateOrientation.should_finish, false);

  const wrongArea = deterministicVerify(session, "shoelace formula yields: 1/2|94 + 66| = 70");
  assertStatus(wrongArea, "incorrect");
  assert.match(wrongArea.local_error || "", /\$80\$/);
});

test("rhombus diagonal quotient is treated as partial progress", () => {
  const session = makeSession({
    problem:
      "A rhombus has an area of 84 in^2 and a diagonal of length 14 inches. What is the length, in inches, of the other diagonal?",
  });

  const formula = deterministicVerify(session, "area of rhombus = product of diagonals/2");
  assertStatus(formula, "correct");
  assert.equal(formula.should_finish, false);
  assert.match(formula.valid_progress || "", /correct area formula/i);

  const symbolicFormula = deterministicVerify(session, "A = d1d2/2");
  assertStatus(symbolicFormula, "correct");
  assert.equal(symbolicFormula.should_finish, false);

  const quotient = deterministicVerify(session, "\\frac{84}{14}");
  assertStatus(quotient, "partially_correct");
  assert.equal(quotient.should_finish, false);
  assert.match(quotient.valid_progress || "", /half of the missing diagonal/i);

  const wrongFinal = deterministicVerify(session, "the answer is 6");
  assertStatus(wrongFinal, "incorrect");
  assert.match(wrongFinal.local_error || "", /half of the missing diagonal/i);

  const final = deterministicVerify(session, "2*84/14 = 12");
  assertStatus(final, "correct");
  assert.equal(final.intent, "final_answer");
  assert.equal(final.should_finish, true);
});

test("fractional rectangle shaded area catches wrong fraction locally", () => {
  const session = makeSession({
    problem:
      "The shaded rectangular region covers one-fourth of the area of the large 10-inch by 16-inch rectangle. What is the number of square inches in the area of the shaded region?",
    workState: {
      acceptedLines: ["A_big = 10 * 16"],
      lastValidLine: "A_big = 10 * 16",
      rejectedLines: [],
    },
  });

  const wrongFraction = deterministicVerify(
    session,
    "big A = 160 => shaded A = 160/2 = 80"
  );
  assertStatus(wrongFraction, "incorrect");
  assert.match(wrongFraction.local_error || "", /\$\\frac\{1\}\{2\}\$/);
  assert.match(wrongFraction.local_error || "", /\$\\frac\{1\}\{4\}\$/);
  assert.doesNotMatch(wrongFraction.local_error || "", /\$40\$/);
  assert.doesNotMatch(wrongFraction.suggested_next_check || "", /\$40\$/);

  const correct = deterministicVerify(session, "shaded area = 160/4 = 40");
  assertStatus(correct, "correct");
  assert.equal(correct.intent, "final_answer");
  assert.equal(correct.should_finish, true);
});

test("concentric equal-region circle accepts innermost area ratio", () => {
  const session = makeSession({
    problem:
      "Find the ratio of the radius of the innermost of the three concentric circles to the radius of the outer circle given that each region represents 1/12 of the total area. Express your answer as a decimal to the nearest hundredth.",
  });

  const screenshotLine = deterministicVerify(
    session,
    "the smallest circle's area is 1/3 the area of the whole circle"
  );
  assertStatus(screenshotLine, "correct");
  assert.equal(screenshotLine.should_finish, false);
  assert.match(screenshotLine.valid_progress || "", /area relationship/i);
  assert.match(screenshotLine.suggested_next_check || "", /circle area formula/i);
  assert.doesNotMatch(screenshotLine.suggested_next_check || "", /0\.58|sqrt|\\sqrt/i);

  const equivalentFraction = deterministicVerify(
    session,
    "innermost circle area is 4/12 of the total area"
  );
  assertStatus(equivalentFraction, "correct");
  assert.equal(equivalentFraction.should_finish, false);

  const wrongFraction = deterministicVerify(
    session,
    "the smallest circle's area is 1/4 the area of the whole circle"
  );
  assertStatus(wrongFraction, "incorrect");
  assert.match(wrongFraction.local_error || "", /equal regions/i);
  assert.doesNotMatch(wrongFraction.local_error || "", /1\/3|one-third/i);

  const mismatchedRadiusTarget = deterministicVerify(
    session,
    "smallest circle radius = sqrt(1/3) whole circle area"
  );
  assertStatus(mismatchedRadiusTarget, "incorrect");
  assert.match(mismatchedRadiusTarget.local_error || "", /radius/i);
  assert.match(mismatchedRadiusTarget.local_error || "", /not its area/i);
  assert.match(mismatchedRadiusTarget.suggested_next_check || "", /outer radius|outer circle's radius/i);

  const radiusRelationship = deterministicVerify(
    session,
    "smallest circle radius = sqrt(1/3) whole circle radius"
  );
  assertStatus(radiusRelationship, "correct");
  assert.equal(radiusRelationship.should_finish, false);
  assert.match(radiusRelationship.valid_progress || "", /radius-ratio relationship/i);
  assert.match(radiusRelationship.suggested_next_check || "", /decimal/i);
  assert.doesNotMatch(radiusRelationship.suggested_next_check || "", /intermediate step/i);
});

test("right-triangle hypotenuse setup must add leg squares", () => {
  const session = makeSession({
    problem:
      "A right triangle has legs with lengths of 5 units and 12 units. How many units long is the hypotenuse?",
  });

  const productSetup = deterministicVerify(session, "\\sqrt{5^2 \\cdot 12^2}");
  assertStatus(productSetup, "incorrect");
  assert.match(productSetup.local_error || "", /adds the two leg squares/i);
  assert.match(productSetup.local_error || "", /multiplies/i);
  assert.doesNotMatch(productSetup.valid_progress || "", /power forms/i);

  const unicodeProductSetup = deterministicVerify(session, "√(5^2 · 12^2)");
  assertStatus(unicodeProductSetup, "incorrect");
  assert.match(unicodeProductSetup.local_error || "", /adds the two leg squares/i);

  const sumSetup = deterministicVerify(session, "\\sqrt{5^2 + 12^2}");
  assertStatus(sumSetup, "correct");
  assert.equal(sumSetup.should_finish, false);
  assert.match(sumSetup.valid_progress || "", /Pythagorean setup/i);

  const final = deterministicVerify(session, "hypotenuse is 13");
  assertStatus(final, "correct");
  assert.equal(final.intent, "final_answer");
  assert.equal(final.should_finish, true);

  const bareFinal = deterministicVerify(session, "13");
  assertStatus(bareFinal, "correct");
  assert.equal(bareFinal.intent, "final_answer");
  assert.equal(bareFinal.should_finish, true);

  const wrongBareFinal = deterministicVerify(session, "12");
  assertStatus(wrongBareFinal, "incorrect");
  assert.equal(wrongBareFinal.intent, "final_answer");
  assert.match(wrongBareFinal.local_error || "", /Pythagorean theorem/i);
});

test("two-square area and perimeter differences accept valid setup equations", () => {
  const session = makeSession({
    problem:
      "The areas of two squares differ by 100 square units, and the perimeters of the two squares differ by 10 units. What is the perimeter, in units, of the smaller square?",
  });

  const perimeterSetup = deterministicVerify(session, "4s - 4t = 10");
  assertStatus(perimeterSetup, "correct");
  assert.equal(perimeterSetup.should_finish, false);
  assert.match(perimeterSetup.valid_progress || "", /perimeters/i);
  assert.doesNotMatch(perimeterSetup.local_error || "", /symbolic equality/i);

  const areaSetup = deterministicVerify(session, "s^2 - t^2 = 100");
  assertStatus(areaSetup, "correct");
  assert.equal(areaSetup.should_finish, false);
  assert.match(areaSetup.valid_progress || "", /areas/i);

  const sideDifference = deterministicVerify(session, "s - t = 2.5");
  assertStatus(sideDifference, "correct");
  assert.equal(sideDifference.should_finish, false);
  assert.match(sideDifference.valid_progress || "", /side-length difference/i);

  const final = deterministicVerify(session, "75");
  assertStatus(final, "correct");
  assert.equal(final.intent, "final_answer");
  assert.equal(final.should_finish, true);

  const wrongSideDifference = deterministicVerify(session, "s - t = 25");
  assertStatus(wrongSideDifference, "incorrect");
  assert.match(wrongSideDifference.local_error || "", /perimeter difference/i);
});

test("square area context accepts its radical side length and given-area restatement", () => {
  const session = makeSession({
    problem:
      "The square inscribed in triangle ABC has an area of 15 square centimeters. Find the requested measurement in the diagram.",
  });

  const sideClaim = deterministicVerify(
    session,
    "side length of square is \\sqrt{15}"
  );
  assertStatus(sideClaim, "correct");
  assert.match(sideClaim.valid_progress || "", /side length/i);

  const conditionalClaim = deterministicVerify(
    session,
    "if the area of the square is 15, then its side length is \\sqrt{15}"
  );
  assertStatus(conditionalClaim, "correct");

  for (const message of [
    "inscribed square has side length \\sqrt{15}",
    "the square inscribed in triangle ABC has side length \\sqrt{15}",
  ]) {
    const subjectFirstSideClaim = deterministicVerify(session, message);
    assertStatus(subjectFirstSideClaim, "correct");
    assert.match(subjectFirstSideClaim.valid_progress || "", /side length/i);
  }

  const areaRestatement = deterministicVerify(
    session,
    "the area of the inscribed square is 15"
  );
  assertStatus(areaRestatement, "correct");
  assert.match(areaRestatement.valid_progress || "", /given area/i);
});

test("square area context rejects the wrong radical side length", () => {
  const session = makeSession({
    problem: "A square has an area of 15 square units.",
  });

  const result = deterministicVerify(
    session,
    "the side length of the square is \\sqrt{12}"
  );

  assertStatus(result, "incorrect");
  assert.match(result.local_error || "", /under the square root/i);
});

test("inscribed-square leg variables add to the outer square side", () => {
  const session = makeSession({
    problem:
      "A square of area 2 is inscribed in a square of area 3, creating four congruent triangles. What is the ratio of the shorter leg to the longer leg?",
    strategy: {
      game_plan: "Use the square areas and the congruent corner triangles.",
      what_to_look_for: "Each triangle has legs along the sides of the outer square.",
      smart_move: "Label the two legs of one shaded triangle.",
      your_turn: "Call the shorter and longer legs x and y, then write their geometric relationships.",
    },
  });

  const result = deterministicVerify(session, "x+y=\\sqrt{3}");

  assertStatus(result, "correct");
  assert.equal(result.intent, "submitted_work");
  assert.equal(result.should_finish, false);
  assert.match(result.valid_progress || "", /outer square/i);
});

test("exterior angle triangle flow accepts the correct final answer", () => {
  const session = makeSession({
    problem:
      "The measure of an exterior angle of a triangle is 105 degrees. If one of the non-adjacent interior angles measures 38 degrees, what is the number of degrees in the other non-adjacent interior angle?",
  });

  const setup = deterministicVerify(session, "38+x = 105");
  assertStatus(setup, "correct");
  assert.equal(setup.should_finish, false);
  assert.match(setup.valid_progress || "", /exterior angle/i);

  const subtraction = deterministicVerify(session, "x = 105 - 38");
  assertStatus(subtraction, "correct");
  assert.equal(subtraction.intent, "submitted_work");
  assert.equal(subtraction.should_finish, false);
  assert.match(subtraction.valid_progress || "", /subtraction setup/i);

  const wrong = deterministicVerify(session, "x = 77");
  assertStatus(wrong, "incorrect");
  assert.equal(wrong.intent, "final_answer");
  assert.match(wrong.local_error || "", /exterior-angle equation/i);

  const finalAssignment = deterministicVerify(session, "x = 67");
  assertStatus(finalAssignment, "correct");
  assert.equal(finalAssignment.intent, "final_answer");
  assert.equal(finalAssignment.should_finish, true);

  const bareFinal = deterministicVerify(session, "67");
  assertStatus(bareFinal, "correct");
  assert.equal(bareFinal.intent, "final_answer");
  assert.equal(bareFinal.should_finish, true);

  const laterSession = makeSession({
    ...session,
    workState: {
      acceptedLines: ["38+x = 105", "x = 67"],
      lastValidLine: "x = 67",
      rejectedLines: ["x = 77", "x = 87"],
    },
  });
  const repeatedSubtraction = deterministicVerify(laterSession, "x = 105 - 38");
  assertStatus(repeatedSubtraction, "correct");
  assert.doesNotMatch(repeatedSubtraction.local_error || "", /does not solve/i);
});

test("unsimplified hypotenuse radical is not marked solved", async () => {
  const session = makeSession({
    problem:
      "A right triangle has legs with lengths of 5 units and 12 units. How many units long is the hypotenuse?",
    workState: {
      acceptedLines: ["\\sqrt{5^2 + 12^2}"],
      lastValidLine: "\\sqrt{5^2 + 12^2}",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "13",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const result = await runVerifierRegistry({
    session,
    message: "\\sqrt{169}",
    modelVerifyFinalAnswer: async () => ({
      intent: "final_answer",
      status: "correct",
      local_error: null,
      valid_progress: "That is equivalent to the answer.",
      suggested_next_check: null,
      should_finish: true,
      confidence: 0.98,
      source: "model",
    }),
    modelVerify: async () => ({
      intent: "submitted_work",
      status: "uncertain",
      local_error: null,
      valid_progress: null,
      suggested_next_check: "Evaluate the square root.",
      should_finish: false,
      confidence: 0.4,
      source: "model",
    }),
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal,
  });

  assertStatus(result, "partially_correct");
  assert.equal(result.intent, "submitted_work");
  assert.equal(result.should_finish, false);
  assert.match(result.suggested_next_check || "", /Evaluate/i);

  const final = await runVerifierRegistry({
    session,
    message: "13",
    modelVerifyFinalAnswer: async () => ({
      intent: "final_answer",
      status: "correct",
      local_error: null,
      valid_progress: "That is the answer.",
      suggested_next_check: null,
      should_finish: true,
      confidence: 0.98,
      source: "model",
    }),
    modelVerify: async () => ({
      intent: "unclear",
      status: "uncertain",
      local_error: null,
      valid_progress: null,
      suggested_next_check: null,
      should_finish: false,
      confidence: 0.2,
      source: "model",
    }),
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal,
  });

  assertStatus(final, "correct");
  assert.equal(final.intent, "final_answer");
  assert.equal(final.should_finish, true);
});

test("count questions do not finish when the student only lists qualifying items", async () => {
  const session = makeSession({
    problem:
      "The following data was reported regarding residential recycling in Tallahassee, Florida. How many recycled products on the list below experienced at least a 100% increase from 1989 to 1999?",
    solutionGuide: {
      finalAnswer: "3",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 0.9,
      caution: null,
    },
  });

  const listedItems = await runVerifierRegistry({
    session,
    message: "There is a 100% increase in aluminum, newspaper, and plastic",
    modelVerifyFinalAnswer: async () => ({
      intent: "submitted_work",
      status: "partially_correct",
      local_error: null,
      valid_progress: "Those are the qualifying products.",
      suggested_next_check: "Now answer with the count of those products.",
      should_finish: false,
      confidence: 0.96,
      source: "model",
    }),
    modelVerify: async () => ({
      intent: "final_answer",
      status: "correct",
      local_error: null,
      valid_progress: "Those are the qualifying products.",
      suggested_next_check: null,
      should_finish: true,
      confidence: 0.96,
      source: "model",
    }),
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal,
  });

  assertStatus(listedItems, "partially_correct");
  assert.equal(listedItems.intent, "submitted_work");
  assert.equal(listedItems.should_finish, false);
  assert.match(listedItems.suggested_next_check || "", /count/i);

  const nonWholeCount = await runVerifierRegistry({
    session,
    message: "there are pi items that have a 100% increase",
    modelVerifyFinalAnswer: async () => ({
      intent: "final_answer",
      status: "incorrect",
      local_error: "$\\pi$ is not a valid count of products.",
      valid_progress: null,
      suggested_next_check: "Answer with the number of products that meet the condition.",
      should_finish: false,
      confidence: 0.96,
      source: "model",
    }),
    modelVerify: async () => ({
      intent: "final_answer",
      status: "correct",
      local_error: null,
      valid_progress: "That is the requested count.",
      suggested_next_check: null,
      should_finish: true,
      confidence: 0.96,
      source: "model",
    }),
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal,
  });

  assertStatus(nonWholeCount, "incorrect");
  assert.equal(nonWholeCount.intent, "final_answer");
  assert.equal(nonWholeCount.should_finish, false);
  assert.match(nonWholeCount.local_error || "", /valid count/i);
  assert.doesNotMatch(nonWholeCount.suggested_next_check || "", /\b3\b|three/i);

  const wrongWholeCount = await runVerifierRegistry({
    session,
    message: "the answer is 2",
    modelVerifyFinalAnswer: async () => ({
      intent: "final_answer",
      status: "correct",
      local_error: null,
      valid_progress: "That is the requested count.",
      suggested_next_check: null,
      should_finish: true,
      confidence: 0.96,
      source: "model",
    }),
    modelVerify: async () => ({
      intent: "final_answer",
      status: "correct",
      local_error: null,
      valid_progress: "That is the requested count.",
      suggested_next_check: null,
      should_finish: true,
      confidence: 0.96,
      source: "model",
    }),
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal,
  });

  assertStatus(wrongWholeCount, "incorrect");
  assert.equal(wrongWholeCount.intent, "final_answer");
  assert.equal(wrongWholeCount.should_finish, false);
  assert.match(wrongWholeCount.local_error || "", /does not match/i);
  assert.doesNotMatch(wrongWholeCount.suggested_next_check || "", /\b3\b|three/i);

  const countedFinal = await runVerifierRegistry({
    session,
    message: "3 products",
    modelVerifyFinalAnswer: async () => ({
      intent: "final_answer",
      status: "correct",
      local_error: null,
      valid_progress: "That is the requested count.",
      suggested_next_check: null,
      should_finish: true,
      confidence: 0.96,
      source: "model",
    }),
    modelVerify: async () => ({
      intent: "submitted_work",
      status: "uncertain",
      local_error: null,
      valid_progress: null,
      suggested_next_check: null,
      should_finish: false,
      confidence: 0.2,
      source: "model",
    }),
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal,
  });

  assertStatus(countedFinal, "correct");
  assert.equal(countedFinal.intent, "final_answer");
  assert.equal(countedFinal.should_finish, true);
});

test("stuck help moves forward instead of resetting to the previous checkpoint", () => {
  const session = makeSession({
    problem: "Find the value of x in the equation.",
    hintState: {
      stepIndex: 0,
      hintLevel: 1,
      stuckCount: 1,
      completedSteps: [],
    },
    history: [
      {
        role: "assistant",
        content:
          "That line is not equivalent to the original expression. Check the arithmetic or transformation in that fraction before continuing.",
      },
      { role: "user", content: "I'm stuck" },
      {
        role: "assistant",
        content:
          "Let's stay with the current checkpoint: That line is not equivalent to the original expression. Check the arithmetic or transformation in that fraction before continuing.",
      },
    ],
  });

  const response = stuckHelpResponse(session, "I'm stuck");
  assert.match(response, /relationship.*requested unknown|unknown.*relationship/i);
  assert.doesNotMatch(response, /last valid|reset|checkpoint|which part/i);
});

test("contextual interaction routing recognizes confusion and clarification", () => {
  assert.equal(
    directInteractionIntent("I'm confusedd")?.intent,
    "forward_help"
  );
  assert.equal(
    directInteractionIntent("What does that mean?")?.intent,
    "clarification"
  );
  assert.equal(
    directInteractionIntent("That hint didn't help")?.intent,
    "method_not_working"
  );
  assert.equal(
    directInteractionIntent("45 - 36 = 9")?.intent,
    "submitted_work"
  );
});

test("square-divisor transcript preserves context and verifies local checkpoints", () => {
  const session = makeSession({
    problem:
      "How many perfect squares are divisors of the product 1! · 2! · 3! · 4! · 5! · 6! · 7! ?",
    solutionGuide: {
      finalAnswer: "72",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
    solutionGuideStatus: "ready",
  });

  ensureWorkState(session);
  const factorization = deterministicVerify(
    session,
    "2^16 \\cdot 3^7 \\cdot 5^3 \\cdot 7"
  );
  assertStatus(factorization, "correct");
  assert.match(factorization.valid_progress || "", /factorization is correct/i);
  assert.match(factorization.suggested_next_check || "", /even exponent choices/i);

  const factorCoach = composeCoachResponse(factorization);
  updateWorkState(
    session,
    "2^16 \\cdot 3^7 \\cdot 5^3 \\cdot 7",
    factorization,
    factorCoach
  );
  assert.equal(
    session.coachingState.lastSubstantiveAcceptedStep,
    "2^16 \\cdot 3^7 \\cdot 5^3 \\cdot 7"
  );

  const ambiguous = {
    intent: "question",
    status: "uncertain",
    local_error: null,
    valid_progress: null,
    suggested_next_check: "What part would you like explained?",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
  updateWorkState(session, "2^16 ?", ambiguous, "What part would you like explained?");
  assert.equal(
    session.coachingState.lastSubstantiveAcceptedStep,
    "2^16 \\cdot 3^7 \\cdot 5^3 \\cdot 7"
  );

  session.coachingState.lastCoachQuestion =
    "For $2^{16}$, list the even exponent choices from $0$ through $16$.";
  const options = deterministicVerify(
    session,
    "0,2,4,6,8,10,12,14,16"
  );
  assertStatus(options, "correct");
  updateWorkState(
    session,
    "0,2,4,6,8,10,12,14,16",
    options,
    composeCoachResponse(options)
  );

  session.coachingState.lastCoachQuestion =
    "How many exponent choices are in that list for $2^{16}$?";
  const count = deterministicVerify(session, "9");
  assertStatus(count, "correct");
  assert.equal(count.should_finish, false);
  assert.match(count.valid_progress || "", /9 choices.*exponent of 2/i);
  assert.doesNotMatch(count.local_error || "", /fix|incorrect/i);
});

test("square-divisor help escalates from cue to explanation to scaffold", () => {
  const session = makeSession({
    problem:
      "How many perfect squares are divisors of the product 1! · 2! · 3! · 4! · 5! · 6! · 7! ?",
    workState: {
      acceptedLines: ["2^16 \\cdot 3^7 \\cdot 5^3 \\cdot 7"],
      lastValidLine: "2^16 \\cdot 3^7 \\cdot 5^3 \\cdot 7",
      rejectedLines: [],
    },
    coachingState: {
      lastSubstantiveAcceptedStep:
        "2^16 \\cdot 3^7 \\cdot 5^3 \\cdot 7",
      currentSubgoal: "Count even exponent choices for $2^{16}$.",
    },
  });

  session.coachingState.helpEpisode.helpRequestCount = 1;
  assert.match(fallbackForwardHint(session), /perfect square.*even exponent/i);

  session.coachingState.helpEpisode.helpRequestCount = 2;
  assert.match(fallbackForwardHint(session, "clarification"), /exponent \$0\$ means/i);

  session.coachingState.helpEpisode.helpRequestCount = 3;
  assert.match(fallbackForwardHint(session), /complete this exponent list/i);
  assert.match(fallbackForwardHint(session), /\\_\\_/);
});

test("stuck help gives a forward probability action", () => {
  const session = makeSession({
    problem: "What is the probability that the running total first reaches 3?",
    hintState: {
      stepIndex: 0,
      hintLevel: 1,
      stuckCount: 1,
      completedSteps: [],
    },
    history: [
      {
        role: "assistant",
        content:
          "Nice work, that's a reasonable step. Calculate the probability that the running total first hits 3 at the third roll.",
      },
      { role: "user", content: "I'm stuck" },
      {
        role: "assistant",
        content:
          "Let's stay with the current checkpoint: Calculate the probability that the running total first hits 3 at the third roll.",
      },
    ],
  });

  const response = stuckHelpResponse(session, "I'm stuck");
  assert.match(response, /choose one case/i);
  assert.match(response, /what must happen/i);
  assert.doesNotMatch(response, /stay|checkpoint|which part/i);
});

test("stuck prompt escalates to a fill-in scaffold without completing it", () => {
  const session = makeSession({
    problem: "What is the probability that the running total first reaches 3?",
    hintState: {
      stepIndex: 0,
      hintLevel: 3,
      stuckCount: 3,
      completedSteps: [],
    },
    history: [
      {
        role: "assistant",
        content:
          "Nice work, that's a reasonable step. Calculate the probability that the running total first hits 3 at the third roll.",
      },
      { role: "user", content: "I'm stuck" },
      {
        role: "assistant",
        content:
          "You are still on this checkpoint: Calculate the probability that the running total first hits 3 at the third roll. Say which part is hard to start: identifying the event to count, splitting into cases, or turning the count into a probability.",
      },
    ],
  });

  const prompt = stuckHelpPrompt(session, "I'm stuck");
  assert.match(prompt, /fill-in scaffold/i);
  assert.match(prompt, /do not fill the blanks/i);
  assert.match(prompt, /do not reveal the final answer/i);
  assert.doesNotMatch(prompt, /ask the student which part is difficult\.\s*$/i);
});

test("stuck hint guard rejects derived values and chained future actions", () => {
  const session = makeSession({
    problem:
      "A recording takes 412 minutes. Each disc can hold up to 56 minutes. How many minutes of reading will each disc contain?",
    workState: {
      acceptedLines: ["412/56"],
      lastValidLine: "412/56",
      rejectedLines: [],
    },
  });

  assert.equal(
    normalizeForwardStuckHint(
      "Instead of estimating the quotient, compare 7 discs' capacity with 412 minutes.",
      session
    ),
    null
  );
  assert.equal(
    normalizeForwardStuckHint(
      "Since $7\\cdot56=392$, use 8 discs, then divide 412 equally among those discs.",
      session
    ),
    null
  );
  assert.equal(
    normalizeForwardStuckHint(
      "What does the quotient $412/56$ represent, and which rounding direction ensures the entire recording fits?",
      session
    ),
    "What does the quotient $412/56$ represent, and which rounding direction ensures the entire recording fits?"
  );

  session.coachingState.helpEpisode.helpRequestCount = 1;
  const firstFallback = fallbackForwardHint(session);
  assert.match(firstFallback, /what your quotient counts|rounding direction/i);
  assert.doesNotMatch(firstFallback, /\b(?:7|8|392)\b/);

  session.coachingState.helpEpisode.helpRequestCount = 2;
  const secondFallback = fallbackForwardHint(session);
  assert.match(secondFallback, /whole-number count below|must increase/i);
  assert.doesNotMatch(secondFallback, /\b(?:7|8|392)\b/);

  const prompt = stuckHelpPrompt(session, "I'm stuck");
  assert.match(prompt, /do not perform arithmetic/i);
  assert.match(prompt, /do not reveal a new count/i);
  assert.match(prompt, /at most one student action/i);
});

test("hint ceiling waits for the full ladder and resets only after verified progress", () => {
  const session = makeSession({
    problem: "Solve for x.",
    hintState: {
      stepIndex: 0,
      hintLevel: 3,
      stuckCount: 3,
      completedSteps: [],
    },
  });
  session.coachingState.helpEpisode.active = true;
  session.coachingState.helpEpisode.helpRequestCount = 3;

  assert.equal(hasReachedHintCeiling(session), true);
  assert.match(HINT_CEILING_RESPONSE, /incomplete one/i);

  updateWorkState(session, "x=2", {
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: "Plausible, but not verified.",
    suggested_next_check: null,
    should_finish: false,
    confidence: 0.6,
    source: "model",
  });
  assert.equal(hasReachedHintCeiling(session), true);

  updateWorkState(session, "x=3", {
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: "Verified.",
    suggested_next_check: null,
    should_finish: false,
    confidence: 0.9,
    source: "model",
  });
  assert.equal(hasReachedHintCeiling(session), false);
  assert.equal(session.coachingState.helpEpisode.helpRequestCount, 0);
  assert.equal(session.hintState.hintLevel, 0);
});

test("message route freezes hint specificity after three no-progress help requests", async () => {
  const session = makeSession({
    sessionId: "hint-ceiling-route-test",
    problem: "Solve for x.",
    solutionGuideStatus: "ready",
    hintState: {
      stepIndex: 0,
      hintLevel: 3,
      stuckCount: 3,
      completedSteps: [],
    },
  });
  session.coachingState.helpEpisode.active = true;
  session.coachingState.helpEpisode.helpRequestCount = 3;
  sessionStore.set(session.sessionId, session);

  const response = await messagePost(
    new Request("http://localhost/api/session/message", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.sessionId, message: "I'm stuck" }),
    })
  );
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.hint_ceiling_reached, true);
  assert.equal(data.message, HINT_CEILING_RESPONSE);
  assert.equal(data.verification.source, "deterministic");
  assert.equal(session.coachingState.helpEpisode.helpRequestCount, 3);
});

test("stuck help abandons a repeatedly unproductive Law of Sines path", () => {
  const session = makeSession({
    problem: "In the triangle diagram, find the requested angle.",
    hintState: {
      stepIndex: 0,
      hintLevel: 2,
      stuckCount: 2,
      completedSteps: [],
    },
    history: [
      {
        role: "assistant",
        content: "Use the Law of Sines to express one side.",
      },
      {
        role: "user",
        content: "$AB=\\frac{\\sin 40}{\\sin 60}AE$",
      },
      {
        role: "assistant",
        content: "Use the Law of Sines again to express another side.",
      },
    ],
  });

  const response = stuckHelpResponse(session, "I'm stuck");
  assert.match(response, /pause the side-length calculations/i);
  assert.match(response, /angle relationship/i);
  assert.doesNotMatch(response, /law of sines|last valid|reset|checkpoint/i);
});

test("stuck prompt tells the model to switch methods after repeated non-progress", () => {
  const session = makeSession({
    problem: "In the diagram, find the requested angle.",
    hintState: {
      stepIndex: 0,
      hintLevel: 2,
      stuckCount: 2,
      completedSteps: [],
    },
  });

  const prompt = stuckHelpPrompt(session, "I don't know what to do next");
  assert.match(prompt, /switch to a more productive observation or method/i);
  assert.match(prompt, /exactly one actionable hint/i);
  assert.match(prompt, /attached image when present/i);
  assert.doesNotMatch(prompt, /merely repeat the last coach instruction\.\s*$/i);
});

test("percent conversion accepts 15/4% as progress, not solved", () => {
  const session = makeSession({
    problem: "Express 3 3/4% as a common fraction.",
    solutionGuide: {
      finalAnswer: "3/80",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const result = verifyCanonicalNumericClaim(session, "15/4%");
  assertStatus(result, "correct");
  assert.equal(result.should_finish, false);
  assert.match(result.suggested_next_check || "", /common fraction/i);
});

test("successive percent changes accept equivalent multiplier work but require percent form to solve", async () => {
  const session = makeSession({
    problem:
      "Brynn's savings decreased by 20% in July, then increased by 50% in August. Brynn's savings are now what percent of the original amount?",
    solutionGuide: {
      finalAnswer: "120%",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const chain = deterministicVerify(
    session,
    "(1 - 0.2)(1 + 0.5) = 0.8 \\cdot 1.5 = 1.2"
  );
  assertStatus(chain, "correct");
  assert.equal(chain.should_finish, false);
  assert.match(chain.suggested_next_check || "", /percent/i);

  const product = deterministicVerify(session, "(1 - 0.2)(1 + 0.5)");
  assertStatus(product, "partially_correct");
  assert.equal(product.should_finish, false);
  assert.match(product.suggested_next_check || "", /evaluate/i);

  const multiplier = deterministicVerify(session, "1.2");
  assertStatus(multiplier, "correct");
  assert.equal(multiplier.should_finish, false);
  assert.match(multiplier.suggested_next_check || "", /percent/i);

  const percent = deterministicVerify(session, "120%");
  assertStatus(percent, "correct");
  assert.equal(percent.should_finish, true);

  assert.equal(await canonicalFinalAnswerMatches(session, "1.2"), false);
  assert.equal(await canonicalFinalAnswerMatches(session, "120%"), true);
});

test("decimal percent-change equality chain is arithmetically equivalent without a guide", () => {
  const session = makeSession({
    problem:
      "Brynn's savings decreased by 20% in July, then increased by 50% in August.",
    solutionGuide: null,
  });

  const result = verifyArithmeticEquality(
    "(1 - 0.2)(1 + 0.5) = 0.8 \\cdot 1.5 = 1.2",
    session
  );
  assertStatus(result, "correct");
  assert.equal(result.should_finish, false);

  const product = parseSingleArithmeticCandidate("(1 - 0.2)(1 + 0.5)");
  assert.deepEqual(product, { numerator: 6n, denominator: 5n });
});

test("successive percent multiplier setups get semantic feedback before symbolic rejection", async () => {
  const session = makeSession({
    problem:
      "Brynn's savings decreased by 20% in July, then increased by 50% in August. Brynn's savings are now what percent of the original amount?",
    solutionGuide: {
      finalAnswer: "120%",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  for (const message of ["P(1 - 0.8)(1 + 0.5)", "(1 - 0.8)(1 + 0.5)"]) {
    let modelChecks = 0;
    const result = await runVerifierRegistry({
      session,
      message,
      modelVerifyFinalAnswer: async () => null,
      modelVerify: async () => {
        modelChecks += 1;
        return {
          intent: "submitted_work",
          status: "incorrect",
          local_error:
            "You used $0.8$ as the decrease rate, but it is already the remaining multiplier.",
          valid_progress: null,
          suggested_next_check: "Replace only the decrease rate in the first factor.",
          should_finish: false,
          confidence: 0.99,
          source: "model",
        };
      },
      applyConservativePolicy: (verification) => verification,
      requireEvaluationForUnevaluatedFinal: (verification) => verification,
    });

    assertStatus(result, "incorrect");
    assert.equal(result.source, "model");
    assert.equal(modelChecks, 1);
    assert.match(result.local_error || "", /remaining multiplier/i);
    assert.doesNotMatch(result.local_error || "", /symbolic equality/i);
  }
});

test("correct successive percent factor setup is accepted deterministically", () => {
  const session = makeSession({
    problem:
      "Brynn's savings decreased by 20% in July, then increased by 50% in August. Brynn's savings are now what percent of the original amount?",
  });

  for (const message of [
    "A(1 - 0.2)(1 + 0.5)",
    "(1 - 20%)(1 + 50%)",
    String.raw`A\mleft(1-0.2\mright)\mleft(1+0.5\mright)`,
    String.raw`\mathopen{}\left(1-0.2\right)\mathclose{}\left(1+0.5\right)`,
    "A(1 − 0.2)(1 ＋ 0.5)",
  ]) {
    const result = deterministicVerify(session, message);
    assertStatus(result, "partially_correct");
    assert.equal(result.source, "deterministic");
    assert.match(result.valid_progress || "", /factors correctly model/i);
    assert.equal(result.should_finish, false);
  }
});

test("registry accepts a correct successive percent setup with a leading variable", async () => {
  const session = makeSession({
    problem:
      "Brynn's savings decreased by 20% in July, then increased by 50% in August. Brynn's savings are now what percent of the original amount?",
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "A(1 - 0.2)(1 + 0.5)",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "unclear",
        status: "uncertain",
        local_error: null,
        valid_progress: null,
        suggested_next_check: "Show another line.",
        should_finish: false,
        confidence: 0,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "partially_correct");
  assert.equal(result.source, "deterministic");
  assert.equal(modelChecks, 0);
  assert.match(result.valid_progress || "", /factors correctly model/i);
});

test("standalone wrong percent is not accepted just because it appears in the problem", () => {
  const session = makeSession({
    problem:
      "Brynn's savings decreased by 20% in July, then increased by 50% in August. Brynn's savings are now what percent of the original amount?",
    solutionGuide: {
      finalAnswer: "120%",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
    workState: {
      acceptedLines: ["1.2"],
      lastValidLine: "1.2",
      rejectedLines: [],
    },
  });

  const result = deterministicVerify(session, "20%");
  assertStatus(result, "incorrect");
  assert.equal(result.intent, "final_answer");
  assert.match(result.local_error || "", /percentage/i);
  assert.equal(result.should_finish, false);
});

test("percentage relationship answers solve in prose and implicit-product forms", async () => {
  const session = makeSession({
    problem: "Suppose 15% of z equals 20% of y. What percentage of z is y?",
    solutionGuide: {
      finalAnswer: "75%",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
    workState: {
      acceptedLines: ["y=15/20 z"],
      lastValidLine: "y=15/20 z",
      rejectedLines: [],
    },
  });

  for (const message of ["y = 75% of z", "y=75%z", "75% of z = y"]) {
    const result = await runVerifierRegistry({
      session,
      message,
      modelVerifyFinalAnswer: async () => null,
      modelVerify: async () => {
        throw new Error("checked percentage relationship should finish deterministically");
      },
      applyConservativePolicy: (verification) => verification,
      requireEvaluationForUnevaluatedFinal: (verification) => verification,
    });

    assertStatus(result, "correct");
    assert.equal(result.intent, "final_answer");
    assert.equal(result.should_finish, true);
  }

  assert.equal(await canonicalFinalAnswerMatches(session, "75"), false);
});

test("percent increase setup accepts corrected old/new expression", () => {
  const session = makeSession({
    problem:
      "A quantity increased from 6 to 13.5. What is the percent increase?",
    history: [
      {
        role: "assistant",
        content:
          "Calculate the percent increase using the formula $(new_area/original_area - 1) * 100%$.",
      },
    ],
  });

  const wrongSetup = deterministicVerify(
    session,
    "=(((13.6)/6) - 1) * 100%"
  );
  assertStatus(wrongSetup, "incorrect");
  assert.match(wrongSetup.local_error || "", /old and new values/i);
  assert.doesNotMatch(wrongSetup.local_error || "", /not equivalent/i);

  const correctedSetup = deterministicVerify(
    session,
    "=(((13.5)/6) - 1) * 100%"
  );
  assertStatus(correctedSetup, "correct");
  assert.equal(correctedSetup.should_finish, false);
  assert.match(correctedSetup.valid_progress || "", /correct old and new values/i);
  assert.doesNotMatch(correctedSetup.local_error || "", /not equivalent/i);

  const response = composeCoachResponse(correctedSetup);
  assert.match(response, /percent-change setup/i);
  assert.doesNotMatch(response, /not equivalent/i);

  const closeExpression = deterministicVerify(session, "(2.25 - 1) * 100%");
  assertStatus(closeExpression, "correct");
  assert.equal(closeExpression.intent, "submitted_work");
  assert.equal(closeExpression.should_finish, false);
  assert.match(closeExpression.suggested_next_check || "", /evaluate/i);

  const final = deterministicVerify(session, "125%");
  assertStatus(final, "correct");
  assert.equal(final.intent, "final_answer");
  assert.equal(final.should_finish, true);
});

test("true arithmetic with problem-number overlap gets semantic review before relevance rejection", async () => {
  const session = makeSession({
    problem:
      "The Train & Accesories hobby store at the Westside Mall pays a monthly rent of the larger of 7% of sales or $2000. In dollars, what is the rent payment of this establishment for a month in which they sell $28, 600 of merchandise?",
  });
  let modelChecks = 0;

  const relevance = verifyProblemRelevance(session, "0.07 * 28600 = 2002");
  assert.equal(relevance, null);

  const result = await runVerifierRegistry({
    session,
    message: "0.07 * 28600 = 2002",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "final_answer",
        status: "correct",
        local_error: null,
        valid_progress:
          "That computes seven percent of the sales, and it is larger than the fixed rent.",
        suggested_next_check: null,
        should_finish: true,
        confidence: 0.94,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.intent, "final_answer");
  assert.equal(result.should_finish, true);
  assert.equal(result.source, "model");
  assert.equal(modelChecks, 1);
});

test("semantic arithmetic fallback can keep threshold comparison as progress", async () => {
  const session = makeSession({
    problem:
      "A store pays the larger of 7% of monthly sales or $2000. In dollars, what is the rent payment for a month in which sales are $10,000?",
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "0.07 * 10000 = 700",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress:
          "That computes seven percent of the sales.",
        suggested_next_check:
          "Now compare that amount with the fixed dollar amount.",
        should_finish: false,
        confidence: 0.94,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.intent, "submitted_work");
  assert.equal(result.should_finish, false);
  assert.equal(result.source, "model");
  assert.equal(modelChecks, 1);
  assert.match(result.suggested_next_check || "", /compare/i);
});

test("unevaluated percent expression is progress, not solved", () => {
  assert.equal(looksUnevaluatedFinalExpression("(2.25 - 1) * 100%"), true);
  assert.equal(looksUnevaluatedFinalExpression("8 \u00b7 7 \u00b7 5"), true);
  assert.equal(looksUnevaluatedFinalExpression("\\frac{8 \\cdot 7 \\cdot 6 \\cdot 5}{6}"), true);
  assert.equal(looksUnevaluatedFinalExpression("\\frac{160}{3}"), false);
  assert.equal(looksUnevaluatedFinalExpression("49/216"), false);
  assert.equal(looksUnevaluatedFinalExpression("60/6"), true);
  assert.equal(looksUnevaluatedFinalExpression("125%"), false);
  assert.equal(looksUnevaluatedFinalExpression("answer is 125%"), false);
  assert.equal(looksUnevaluatedFinalExpression("6\\sqrt{10}"), false);
  assert.equal(looksUnevaluatedFinalExpression("2-\\sqrt{3}"), false);
  assert.equal(looksUnevaluatedFinalExpression("\\sqrt{169}"), true);
  assert.equal(looksUnevaluatedFinalExpression("\\sqrt{72}"), true);

  const modelSolved = {
    intent: "final_answer",
    status: "correct",
    local_error: null,
    valid_progress: "That is correct.",
    suggested_next_check: null,
    should_finish: true,
    confidence: 0.95,
    source: "model",
  };
  const clamped = requireEvaluationForUnevaluatedFinal(
    modelSolved,
    "(2.25 - 1) * 100%"
  );

  assertStatus(clamped, "partially_correct");
  assert.equal(clamped.intent, "submitted_work");
  assert.equal(clamped.should_finish, false);
  assert.match(clamped.suggested_next_check || "", /Evaluate/i);

  const finished = requireEvaluationForUnevaluatedFinal(modelSolved, "125%");
  assertStatus(finished, "correct");
  assert.equal(finished.intent, "final_answer");
  assert.equal(finished.should_finish, true);

  const symbolicSolved = {
    ...modelSolved,
    source: "symbolic",
  };
  const clampedSymbolic = requireEvaluationForUnevaluatedFinal(
    symbolicSolved,
    "\\sqrt{169}"
  );
  assertStatus(clampedSymbolic, "partially_correct");
  assert.equal(clampedSymbolic.intent, "submitted_work");
  assert.equal(clampedSymbolic.should_finish, false);

  const clampedDivision = requireEvaluationForUnevaluatedFinal(
    symbolicSolved,
    "60/6"
  );
  assertStatus(clampedDivision, "partially_correct");
  assert.equal(clampedDivision.should_finish, false);
  assert.match(clampedDivision.suggested_next_check || "", /Evaluate/i);

  const coordinateSetup = requireEvaluationForUnevaluatedFinal(
    {
      ...symbolicSolved,
      source: "deterministic",
    },
    "B=(0,0); C=(2,4); F=(6,5); A=(7,3)"
  );
  assertStatus(coordinateSetup, "correct");
  assert.equal(coordinateSetup.intent, "submitted_work");
  assert.equal(coordinateSetup.should_finish, false);
  assert.match(coordinateSetup.valid_progress || "", /coordinate assignments/i);

  const radiusForVolume = requireEvaluationForUnevaluatedFinal(
    modelSolved,
    "r=6",
    makeSession({
      problem: "A sphere is placed inside a cone. What is the volume of the sphere?",
    })
  );
  assertStatus(radiusForVolume, "correct");
  assert.equal(radiusForVolume.intent, "submitted_work");
  assert.equal(radiusForVolume.should_finish, false);
  assert.match(radiusForVolume.suggested_next_check || "", /volume requested/i);
});

test("arithmetic expression equal to final answer is progress, not solved", () => {
  const session = makeSession({
    problem: "How many arrangements are possible?",
    solutionGuide: {
      finalAnswer: "280",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const product = deterministicVerify(session, "8*7*5");
  assertStatus(product, "partially_correct");
  assert.equal(product.intent, "submitted_work");
  assert.equal(product.should_finish, false);
  assert.match(product.suggested_next_check || "", /Evaluate/i);

  const middleDotProduct = deterministicVerify(session, "8 \u00b7 7 \u00b7 5");
  assertStatus(middleDotProduct, "partially_correct");
  assert.equal(middleDotProduct.should_finish, false);

  const latexFraction = deterministicVerify(
    session,
    "\\frac{8 \\cdot 7 \\cdot 6 \\cdot 5}{6}"
  );
  assertStatus(latexFraction, "partially_correct");
  assert.equal(latexFraction.should_finish, false);
});

test("common-fraction path keeps 15/400 partial and 3/80 solved", () => {
  const session = makeSession({
    problem: "Express 3 3/4% as a common fraction.",
    solutionGuide: {
      finalAnswer: "3/80",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const unreduced = verifyCanonicalNumericClaim(session, "15/400");
  assertStatus(unreduced, "partially_correct");
  assert.equal(unreduced.should_finish, false);
  assert.match(unreduced.suggested_next_check || "", /reduce/i);

  const final = verifyCanonicalNumericClaim(session, "3/80");
  assertStatus(final, "correct");
  assert.equal(final.intent, "final_answer");
  assert.equal(final.should_finish, true);
});

test("common-fraction final answer accepts answer-is reduced fraction", () => {
  const session = makeSession({
    problem:
      "The expression \\frac{2^{2010}+2^{2008}}{2^{2005}-2^{2003}} is equivalent to what common fraction?",
    workState: {
      acceptedLines: ["(5/3) * (2^5)"],
      lastValidLine: "(5/3) * (2^5)",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "160/3",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const result = deterministicVerify(session, "answer is 160/3");
  assertStatus(result, "correct");
  assert.equal(result.intent, "final_answer");
  assert.equal(result.should_finish, true);
  assert.doesNotMatch(result.suggested_next_check || "", /reduce/i);

  const bareFraction = deterministicVerify(session, "160/3");
  assertStatus(bareFraction, "correct");
  assert.equal(bareFraction.intent, "final_answer");
  assert.equal(bareFraction.should_finish, true);
  assert.doesNotMatch(bareFraction.suggested_next_check || "", /intermediate|next step|reduce/i);

  const displayStyleFraction = deterministicVerify(session, "\\dfrac{160}{3}");
  assertStatus(displayStyleFraction, "correct");
  assert.equal(displayStyleFraction.intent, "final_answer");
  assert.equal(displayStyleFraction.should_finish, true);
});

test("variable assignment matching final answer solves variable-value problem", () => {
  const session = makeSession({
    problem: "Solve for x.",
    workState: {
      acceptedLines: ["10^x = 10^64"],
      lastValidLine: "10^x = 10^64",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "64",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const result = deterministicVerify(session, "x = 64");
  assertStatus(result, "correct");
  assert.equal(result.intent, "final_answer");
  assert.equal(result.should_finish, true);
  assert.equal(result.suggested_next_check, null);
});

test("coach-defined requested variable assignment matching final answer solves", () => {
  const session = makeSession({
    problem:
      "A sample has 30 target fish among 180 fish, while the lake has 250 target fish. How many fish are in the lake?",
    history: [
      {
        role: "assistant",
        content: "Let N be the lake's total fish count and write the equal ratio.",
      },
    ],
    workState: {
      acceptedLines: ["30/180 = 250/N", "30N = 45000"],
      lastValidLine: "30N = 45000",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "1500",
      confidence: 1,
    },
  });

  const result = deterministicVerify(session, "N = 1500");
  assertStatus(result, "correct");
  assert.equal(result.intent, "final_answer");
  assert.equal(result.should_finish, true);
});

test("unrelated variable assignment matching scalar answer does not solve", () => {
  const session = makeSession({
    problem: "How many fish are in the lake?",
    history: [{ role: "assistant", content: "Continue simplifying the ratio." }],
    solutionGuide: {
      finalAnswer: "1500",
      confidence: 1,
    },
  });

  const result = deterministicVerify(session, "q = 1500");
  assert.notEqual(result?.should_finish, true);
});

test("integer variable assignments matching final answer are not treated as reducible fractions", async () => {
  const session = makeSession({
    problem:
      "Solve for x and express the answer as a common fraction if needed.",
    solutionGuide: {
      finalAnswer: "3",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const result = await runVerifierRegistry({
    session,
    message: "x = 3",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      throw new Error("model should not be needed for scalar integer final assignment");
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.intent, "final_answer");
  assert.equal(result.should_finish, true);
  assert.doesNotMatch(result.suggested_next_check || "", /reduce|fraction/i);
});

test("standalone checked final number solves instead of repeating numeric rewrite", () => {
  const session = makeSession({
    problem: "What is the product?",
    workState: {
      acceptedLines: ["64 * 54"],
      lastValidLine: "64 * 54",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "3456",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const bareAnswer = deterministicVerify(session, "3456");
  assertStatus(bareAnswer, "correct");
  assert.equal(bareAnswer.intent, "final_answer");
  assert.equal(bareAnswer.should_finish, true);

  const labeledAnswer = deterministicVerify(session, "answer is 3456");
  assertStatus(labeledAnswer, "correct");
  assert.equal(labeledAnswer.intent, "final_answer");
  assert.equal(labeledAnswer.should_finish, true);
});

test("descriptive labeled value matching the checked answer solves immediately", () => {
  const session = makeSession({
    problem: "Find the sum of the digits of the resulting number.",
    solutionGuide: {
      finalAnswer: "16",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const result = verifyCanonicalNumericClaim(session, "sum of digits = 16");
  assertStatus(result, "correct");
  assert.equal(result.intent, "final_answer");
  assert.equal(result.should_finish, true);
});

test("standalone number solves variable question after accepted final equality", () => {
  const session = makeSession({
    problem: "If C = \\frac{5}{9}(F - 32), what is F when C = 20?",
    workState: {
      acceptedLines: ["F=\\frac95 C + 32", "F = 36 + 32 = 68"],
      lastValidLine: "F = 36 + 32 = 68",
      rejectedLines: [],
    },
  });

  const bareAnswer = deterministicVerify(session, "68");
  assertStatus(bareAnswer, "correct");
  assert.equal(bareAnswer.intent, "final_answer");
  assert.equal(bareAnswer.should_finish, true);
});

test("checked final number accepts common trailing unit labels", () => {
  const triangleSession = makeSession({
    problem:
      "A right triangle has legs with lengths of 5 units and 12 units. How many units long is the hypotenuse?",
    solutionGuide: {
      finalAnswer: "13",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const integerUnits = verifyCanonicalNumericClaim(triangleSession, "13 units");
  assertStatus(integerUnits, "correct");
  assert.equal(integerUnits.intent, "final_answer");
  assert.equal(integerUnits.should_finish, true);

  const decimalSession = makeSession({
    problem:
      "Find the ratio of two lengths. Express your answer as a decimal to the nearest hundredth.",
    solutionGuide: {
      finalAnswer: "0.58",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const decimalUnits = verifyCanonicalNumericClaim(decimalSession, "answer is 0.58 units");
  assertStatus(decimalUnits, "correct");
  assert.equal(decimalUnits.intent, "final_answer");
  assert.equal(decimalUnits.should_finish, true);
});

test("target expression with accepted variable value can finish through symbolic substitution", async () => {
  const session = makeSession({
    problem:
      "A nylon rope of length 140 feet is cut into three pieces. The longest piece is five times as long as each of the other two pieces. How many feet are in the length of the longest piece?",
    workState: {
      acceptedLines: ["x+x+5x=140", "7x=140", "x=20"],
      lastValidLine: "x=20",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "100",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const longestEquation = await runVerifierRegistry({
    session,
    message: "answer is 5x=100",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      throw new Error("model should not be needed for target expression substitution");
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });
  assertStatus(longestEquation, "correct");
  assert.equal(longestEquation.intent, "final_answer");
  assert.equal(longestEquation.should_finish, true);

  const finalNumber = deterministicVerify(session, "answer is 100");
  assertStatus(finalNumber, "correct");
  assert.equal(finalNumber.intent, "final_answer");
  assert.equal(finalNumber.should_finish, true);

  const shortPiece = deterministicVerify(session, "answer is 20");
  assertStatus(shortPiece, "incorrect");
  assert.equal(shortPiece.intent, "final_answer");
  assert.match(shortPiece.local_error || "", /does not match/i);
});

test("canonical verifier preserves parallel equations during accepted substitution", async () => {
  const session = makeSession({
    problem: "A geometric length l is a diagonal. Use the perimeter equation to find b.",
    workState: {
      acceptedLines: ["3b = 12 + 2l", "l = \\sqrt{b^2+b^2}"],
      lastValidLine: "l = \\sqrt{b^2+b^2}",
      rejectedLines: [],
    },
  });

  const result = await canonicalSympyVerify(
    session,
    "3b = 12 + 2\\sqrt{b^2+b^2}"
  );

  assertStatus(result, "correct");
  assert.equal(result.should_finish, false);
  assert.equal(result.source, "symbolic");
});

test("unanchored numeric equalities are irrelevant before arithmetic correctness", () => {
  const session = makeSession({
    problem: "Express 3 3/4% as a common fraction.",
  });

  const falseEquality = verifyProblemRelevance(session, "4+4=4");
  assertStatus(falseEquality, "incorrect");
  assert.match(falseEquality.local_error || "", /not connected/i);

  const trueEquality = verifyProblemRelevance(session, "2+2=4");
  assertStatus(trueEquality, "incorrect");
  assert.match(trueEquality.local_error || "", /not connected/i);
});

test("anchored wrong arithmetic remains available for arithmetic feedback", () => {
  const session = makeSession({
    problem: "What is 4 + 4?",
  });

  const relevance = verifyProblemRelevance(session, "4+4=4");
  assert.equal(relevance, null);

  const arithmetic = deterministicVerify(session, "4+4=4");
  assertStatus(arithmetic, "incorrect");
  assert.match(arithmetic.local_error || "", /not the same value/i);
});

test("derived addends from the last accepted expression stay relevant", async () => {
  const session = makeSession({
    problem: "Find the area of the composite logo in square inches.",
    workState: {
      acceptedLines: ["(4*1) + (1/2*4*3)"],
      lastValidLine: "(4*1) + (1/2*4*3)",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "10",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  assert.equal(verifyProblemRelevance(session, "4+6=12"), null);
  const wrong = deterministicVerify(session, "4+6=12");
  assertStatus(wrong, "incorrect");
  assert.match(wrong.local_error || "", /not the same value/i);

  const correct = await runVerifierRegistry({
    session,
    message: "4+6=10",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => { throw new Error("checked arithmetic final should be deterministic"); },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });
  assertStatus(correct, "correct");
  assert.equal(correct.intent, "final_answer");
  assert.equal(correct.should_finish, true);
});

test("arithmetic remains relevant when the problem uses latex thousands separators", () => {
  const session = makeSession({
    problem:
      "What is the unit digit of: \\[222{,}222-22{,}222-2{,}222-222-22-2?\\]",
  });
  const message = "222222 - 22222 = 200000";

  assert.equal(verifyProblemRelevance(session, message), null);

  const arithmetic = deterministicVerify(session, message);
  assertStatus(arithmetic, "correct");
  assert.equal(arithmetic.should_finish, false);
});

test("arithmetic using numbers from the last accepted list stays relevant", async () => {
  const session = makeSession({
    problem: "What is the sum of the palindromic primes less than 50?",
    workState: {
      acceptedLines: ["the palindromic primes less than 50 are: 11, 13, 17, 31, 37"],
      lastValidLine: "the palindromic primes less than 50 are: 11, 13, 17, 31, 37",
      rejectedLines: [],
    },
  });

  const relevance = verifyProblemRelevance(session, "11+13+17+31+37=109");
  assert.equal(relevance, null);

  const result = await runVerifierRegistry({
    session,
    message: "11+13+17+31+37=109",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => ({
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That sum follows from your listed palindromic primes.",
      suggested_next_check: "Send the final numeric answer.",
      should_finish: false,
      confidence: 0.9,
      source: "model",
    }),
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });
  assertStatus(result, "correct");
});

test("subtraction using values established in accepted prose stays relevant", async () => {
  const session = makeSession({
    problem:
      "Eric had 11 marbles. After receiving the same number twice from each of three friends, he had 36 marbles. How many marbles did Eric receive?",
    workState: {
      acceptedLines: ["3x=108", "x=36", "Eric had 11 and now has 36"],
      lastValidLine: "Eric had 11 and now has 36",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "25",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  assert.equal(verifyProblemRelevance(session, "36-11=25"), null);

  const result = await runVerifierRegistry({
    session,
    message: "36-11=25",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      throw new Error("accepted-context subtraction should be deterministic");
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.should_finish, true);
  assert.notEqual(result.source, "model");
});

test("coach-requested digit sum stays relevant and can solve", async () => {
  const session = makeSession({
    problem: "Find the smallest three-digit multiple of 11 that is not a palindrome, then find the sum of its digits.",
    history: [
      { role: "assistant", content: "You correctly identified N=110. Compute the sum of the digits of 110." },
    ],
    workState: {
      acceptedLines: ["N=110"],
      lastValidLine: "N=110",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "2",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  assert.equal(verifyProblemRelevance(session, "1+1+0=2"), null);
  const result = await runVerifierRegistry({
    session,
    message: "1+1+0=2",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => { throw new Error("anchored checked digit sum should be deterministic"); },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.intent, "final_answer");
  assert.equal(result.should_finish, true);
});

test("ordinary fraction sums are not treated as mixed-number conversions", () => {
  const message = "1 + \\frac{1}{2} + \\frac{1}{3} + \\frac{1}{6} = 2";

  assert.equal(verifyMixedNumberEquality(message), null);

  const arithmetic = verifyArithmeticEquality(message);
  assertStatus(arithmetic, "correct");
  assert.match(arithmetic.valid_progress || "", /arithmetic equality/i);
  assert.doesNotMatch(arithmetic.local_error || "", /mixed number/i);
});

test("shared digits alone do not make an unrelated equality relevant", () => {
  const session = makeSession({
    problem:
      "Express the value of the following expression as a fraction: 1 + 2/(3 + 4/5)",
  });

  const result = verifyProblemRelevance(session, "1+1=4");
  assertStatus(result, "incorrect");
  assert.match(result.local_error || "", /not connected/i);
});

test("subtraction from a recently accepted counting total receives semantic review", async () => {
  const session = makeSession({
    problem:
      "Twenty-one teams enter a tournament. Count the three-team selections satisfying the stated restriction.",
    workState: {
      acceptedLines: ["\\binom{21}{3}=1330"],
      lastValidLine: "\\binom{21}{3}=1330",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: null,
      solutionOutline: [
        "Subtract the 945 invalid selections from the 1330 total selections.",
      ],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "1330-945=385",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That subtraction correctly removes the invalid selections.",
        suggested_next_check: "What would you try next?",
        should_finish: false,
        confidence: 0.96,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.source, "model");
  assert.equal(modelChecks, 1);
});

test("page-number final answer rejects 43 and accepts 42", () => {
  const session = makeSession({
    problem:
      "Alex added the page numbers of a book together and got a total of 888. Unfortunately, he didn't notice that one of the sheets of the book was missing with an odd page number on the front and an even page number on the back. What was the page number on the final page in the book?",
  });

  const wrong = verifyMissingConsecutivePagesFinalAnswer(session, "the answer is 43");
  assertStatus(wrong, "incorrect");
  assert.equal(wrong.should_finish, false);

  const right = verifyMissingConsecutivePagesFinalAnswer(session, "the answer is 42");
  assertStatus(right, "correct");
  assert.equal(right.should_finish, true);

  const bareRight = verifyMissingConsecutivePagesFinalAnswer(session, "42");
  assertStatus(bareRight, "correct");
  assert.equal(bareRight.should_finish, true);

  const typoRight = verifyMissingConsecutivePagesFinalAnswer(session, "anwser is 42");
  assertStatus(typoRight, "correct");
  assert.equal(typoRight.should_finish, true);
});

test("page-number setup equation is accepted", () => {
  const session = makeSession({
    problem:
      "Alex added the page numbers of a book together and got a total of 888. Unfortunately, he didn't notice that one of the sheets of the book was missing with an odd page number on the front and an even page number on the back. What was the page number on the final page in the book?",
  });

  const result = verifyMissingConsecutivePagesSetup(
    session,
    "N(N+1)/2 - (p+p+1) = 888"
  );
  assertStatus(result, "correct");
  assert.equal(result.should_finish, false);
});

test("borrowed consecutive-sheet setup accepts the requested endpoint and count formulas", () => {
  const session = makeSession({
    problem:
      "Thierry's algebra notes are 51 pages long and are printed on 25 sheets of paper. The first sheet contains pages 1 and 2, the second sheet contains pages 3 and 4, and so on. One day he leaves his notes on the table before leaving for lunch, and his roommate decides to borrow some pages from the middle of the notes. When Thierry comes back, he discovers that his roommate has taken a consecutive set of sheets from the notes and that the average (mean) of the page numbers on all remaining sheets is exactly 19. How many sheets were borrowed?",
    history: [
      {
        role: "assistant",
        content:
          "If a is the first borrowed sheet and b is the last, express the number of borrowed sheets as b-a+1 and write the sum of their page numbers.",
      },
    ],
  });

  const endpoints = verifyBorrowedConsecutiveSheetsSetup(
    session,
    "The first borrowed page is page 2a - 1 and the last borrowed page is page 2b"
  );
  const first = verifyBorrowedConsecutiveSheetsSetup(
    session,
    "If the first borrowed sheet is sheet a, then the first borrowed page is page 2a - 1"
  );
  const last = verifyBorrowedConsecutiveSheetsSetup(
    session,
    "The last borrowed page is page 2b"
  );
  const count = verifyBorrowedConsecutiveSheetsSetup(
    session,
    "The number of borrowed sheets is b - a + 1"
  );

  for (const result of [endpoints, first, last, count]) {
    assertStatus(result, "correct");
    assert.equal(result.source, "deterministic");
    assert.equal(result.should_finish, false);
  }
});

test("borrowed consecutive-sheet setup is accepted before the generic symbolic verifier", async () => {
  let modelChecks = 0;
  const session = makeSession({
    problem:
      "A 51-page set of notes is printed on sheets, and a consecutive set of sheets is borrowed. The average page number on the remaining sheets is 19. How many sheets were borrowed?",
    history: [
      {
        role: "assistant",
        content:
          "If a is the first borrowed sheet and b is the last, express the number of borrowed sheets.",
      },
    ],
  });

  const result = await runVerifierRegistry({
    session,
    message: "The number of borrowed sheets is b-a+1",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      throw new Error("The model verifier should not run for this deterministic step.");
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.source, "deterministic");
  assert.equal(modelChecks, 0);
});

test("nearest-odd claims and difference setup are accepted", () => {
  const session = makeSession({
    problem:
      "Given any positive even integer, x, the positive difference between the smallest odd number greater than 7x - 2 and the largest odd number less than 3x + 5 can be written in the form ax + b. What is a + b?",
  });

  const nearestOdd = deterministicVerify(
    session,
    "when x is even, the smallest odd number greater than 7x - 2 is 7x - 1 and the largest odd less than 3x + 5 is 3x + 3"
  );
  assertStatus(nearestOdd, "correct");

  const difference = deterministicVerify(
    session,
    "the absolute difference between the two odds is |7x - 1 - (3x + 3)|"
  );
  assertStatus(difference, "correct");

  const coefficients = deterministicVerify(session, "a=4 and b=-4");
  assertStatus(coefficients, "correct");
  assert.equal(coefficients.should_finish, false);

  const final = deterministicVerify(session, "a+b=0");
  assertStatus(final, "correct");
  assert.equal(final.should_finish, true);

  const bareFinal = deterministicVerify(session, "0");
  assertStatus(bareFinal, "correct");
  assert.equal(bareFinal.should_finish, true);
});

test("multiple-of-eleven missing-digit setup accepts alternating digit sums", () => {
  const session = makeSession({
    problem:
      "If the six-digit number 123,D_{56} is a multiple of 11, what is the value of the missing digit D?",
  });

  const result = deterministicVerify(session, "1 + 3 + 5 = 2 + D + 6");
  assertStatus(result, "correct");
  assert.equal(result.should_finish, false);
  assert.match(result.valid_progress || "", /alternating digit sums/i);
  assert.match(result.suggested_next_check || "", /solve for the missing digit/i);

  const reversed = deterministicVerify(session, "2 + D + 6 = 1 + 3 + 5");
  assertStatus(reversed, "correct");

  const assignmentFinal = deterministicVerify(session, "D = 1");
  assertStatus(assignmentFinal, "correct");
  assert.equal(assignmentFinal.intent, "final_answer");
  assert.equal(assignmentFinal.should_finish, true);

  const bareFinal = deterministicVerify(session, "1");
  assertStatus(bareFinal, "correct");
  assert.equal(bareFinal.intent, "final_answer");
  assert.equal(bareFinal.should_finish, true);

  const wrongFinal = deterministicVerify(session, "D = 2");
  assertStatus(wrongFinal, "incorrect");
  assert.equal(wrongFinal.intent, "final_answer");
});

test("factor and divisor list claims are accepted as the same local step", () => {
  const session = makeSession({
    problem: "Find the sum of the reciprocals of the positive divisors of 6.",
  });

  const factors = deterministicVerify(session, "The factors of 6 are 1, 2, 3, 6");
  assertStatus(factors, "correct");
  assert.match(factors.valid_progress || "", /divisors of 6 are correct/i);
  assert.doesNotMatch(factors.suggested_next_check || "", /\\frac|reciprocal|1\/2|1\/3|1\/6/i);

  const divisors = deterministicVerify(session, "The divisors of 6 are 1, 2, 3, and 6");
  assertStatus(divisors, "correct");

  const missing = deterministicVerify(session, "The factors of 6 are 1, 2, 6");
  assertStatus(missing, "incorrect");
  assert.match(missing.local_error || "", /1, 2, 3, 6/);
});

test("odd perfect square factor reasoning accepts exponent conditions", () => {
  const session = makeSession({
    problem:
      "How many odd perfect square factors does 2^4 * 3^6 * 5^10 * 7^9 have?",
  });

  const squarePrinciple = deterministicVerify(
    session,
    "square means that each prime factor must have an even exponent"
  );
  assertStatus(squarePrinciple, "correct");
  assert.equal(squarePrinciple.intent, "submitted_work");
  assert.match(squarePrinciple.valid_progress || "", /perfect-square condition/i);

  const exponentOptions = deterministicVerify(
    session,
    "for a factor of the original number to be an odd perfect square, 2 must have an exponent of 0; 3 can have an exponent of 0, 2, 4, or 6; 5 could have an exponent of 0, 2, 4, 6, 8, or 10; and 7 has to have an exponent of 0, 2, 4, 6, or 8"
  );
  assertStatus(exponentOptions, "correct");
  assert.equal(exponentOptions.intent, "submitted_work");
  assert.match(exponentOptions.valid_progress || "", /exponent choices/i);

  const wrongOptions = deterministicVerify(
    session,
    "3 can have an exponent of 0, 2, 4, or 8"
  );
  assertStatus(wrongOptions, "incorrect");
  assert.match(wrongOptions.local_error || "", /no larger than 6/i);
});

test("repeating-decimal fraction rewrite is valid progress, not solved", () => {
  const session = makeSession({
    problem:
      "Express 0.\\overline{45} + 0.\\overline{54} + 0.5 + 0.4 as a common fraction.",
    solutionGuide: {
      finalAnswer: "19/10",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const result = verifyCanonicalNumericClaim(
    session,
    "54/99 + 45/99 + 5/10 + 4/10"
  );
  assert.ok(result, "expected repeating-decimal rewrite to verify");
  assert.notEqual(result.should_finish, true);
  assert.match(result.suggested_next_check || "", /reduce|one reduced|combine/i);
});

test("mixed-number-style rewrite gets common-fraction guidance", () => {
  const session = makeSession({
    problem:
      "Express 0.\\overline{45} + 0.\\overline{54} + 0.5 + 0.4 as a common fraction.",
    workState: {
      acceptedLines: ["54/99 + 45/99 + 5/10 + 4/10"],
      lastValidLine: "54/99 + 45/99 + 5/10 + 4/10",
    },
    solutionGuide: {
      finalAnswer: "19/10",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const result = verifyCanonicalNumericClaim(session, "1 + 9/10");
  assertStatus(result, "partially_correct");
  assert.equal(result.should_finish, false);
  assert.match(result.suggested_next_check || "", /reduce|one reduced common fraction/i);
});

test("nested fraction simplification gets common-fraction guidance", () => {
  const session = makeSession({
    problem:
      "Express the value of the following expression as a fraction: 1 + 2/(3 + 4/5)",
    workState: {
      acceptedLines: ["1 + 2/(19/5)", "1 + 10/19"],
      lastValidLine: "1 + 10/19",
    },
    solutionGuide: {
      finalAnswer: "29/19",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const result = verifyCanonicalNumericClaim(session, "1 + 10/19");
  assertStatus(result, "partially_correct");
  assert.equal(result.should_finish, false);
  assert.match(result.suggested_next_check || "", /one reduced common fraction/i);
});

test("registry finishes already reduced common fraction instead of asking to reduce", async () => {
  const session = makeSession({
    problem:
      "Express the value of the following expression as a fraction: 1 + 2/(3 + 4/5)",
    workState: {
      acceptedLines: ["1 + 2/(19/5)"],
      lastValidLine: "1 + 2/(19/5)",
    },
    solutionGuide: {
      finalAnswer: "29/19",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const result = await runVerifierRegistry({
    session,
    message: "29/19",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => ({
      intent: "submitted_work",
      status: "uncertain",
      local_error: null,
      valid_progress: null,
      suggested_next_check: null,
      should_finish: false,
      confidence: 0.2,
      source: "model",
    }),
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.intent, "final_answer");
  assert.equal(result.should_finish, true);
  assert.equal(result.suggested_next_check, null);
});

test("unreduced simple fraction remains progress when checked answer is reduced", async () => {
  const session = makeSession({
    problem: "Find the probability of the event.",
    solutionGuide: {
      finalAnswer: "7/25",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const unreduced = verifyCanonicalNumericClaim(session, "14/50");
  assertStatus(unreduced, "partially_correct");
  assert.equal(unreduced.should_finish, false);
  assert.match(unreduced.suggested_next_check || "", /reduce|lowest terms/i);

  const reduced = verifyCanonicalNumericClaim(session, "7/25");
  assertStatus(reduced, "correct");
  assert.equal(reduced.intent, "final_answer");
  assert.equal(reduced.should_finish, true);
});

test("high-confidence semantic final supported by accepted arithmetic can correct a faulty guide", async () => {
  const session = makeSession({
    problem: "Find the total travel time in minutes across both segments.",
    workState: {
      acceptedLines: ["coastal time = 30", "highway time = 50", "50+30=80"],
      lastValidLine: "50+30=80",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "40 minutes",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 0.7,
      caution: null,
    },
  });
  const semanticFinal = {
    intent: "final_answer",
    status: "correct",
    local_error: null,
    valid_progress: "The two segment times total 80 minutes.",
    suggested_next_check: null,
    should_finish: true,
    confidence: 0.96,
    source: "model",
  };

  for (const message of ["50+30=80", "80", "80 minutes"]) {
    const result = await runVerifierRegistry({
      session,
      message,
      modelVerifyFinalAnswer: async () => semanticFinal,
      modelVerify: async () => semanticFinal,
      applyConservativePolicy: (verification) => verification,
      requireEvaluationForUnevaluatedFinal: (verification) => verification,
    });

    assertStatus(result, "correct");
    assert.equal(result.intent, "final_answer");
    assert.equal(result.should_finish, true);
    assert.equal(result.source, "model");
  }

  const routeSource = require("node:fs").readFileSync(
    path.join(rootDir, "app/api/session/message/route.ts"),
    "utf8"
  );
  assert.match(routeSource, /verification\.source === "model"[\s\S]{0,80}?studentMessage\.trim\(\)/);
});

test("registry finishes compact MathLive common fraction on review step", async () => {
  const session = makeSession({
    problem: "Express the answer as a common fraction.",
    solutionGuide: {
      finalAnswer: "1/4",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const result = await runVerifierRegistry({
    session,
    message: "\\frac14",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      throw new Error("compact checked fraction should finish deterministically");
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.intent, "final_answer");
  assert.equal(result.should_finish, true);
});

test("semantic final review can finish a target ratio equality whose scalar side matches", async () => {
  const session = makeSession({
    problem: "What fraction of the total x is the favorable amount u?",
    solutionGuide: {
      finalAnswer: "1/4",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const semanticFinal = {
    intent: "final_answer",
    status: "correct",
    local_error: null,
    valid_progress: "That ratio answers the question.",
    suggested_next_check: null,
    should_finish: true,
    confidence: 0.96,
    source: "model",
  };
  const result = await runVerifierRegistry({
    session,
    message: "u/x = \\frac14",
    modelVerifyFinalAnswer: async () => semanticFinal,
    modelVerify: async () => semanticFinal,
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.intent, "final_answer");
  assert.equal(result.should_finish, true);
});

test("registry finishes standalone reduced probability fraction on review step", async () => {
  const session = makeSession({
    problem:
      "Find the probability that a running total first reaches 3 on or before the third roll.",
    workState: {
      acceptedLines: ["1/6 + 1/18 + 1/216"],
      lastValidLine: "1/6 + 1/18 + 1/216",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "49/216",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const result = await runVerifierRegistry({
    session,
    message: "49/216",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => ({
      intent: "submitted_work",
      status: "uncertain",
      local_error: null,
      valid_progress: null,
      suggested_next_check: null,
      should_finish: false,
      confidence: 0.2,
      source: "model",
    }),
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.intent, "final_answer");
  assert.equal(result.should_finish, true);
  assert.equal(result.suggested_next_check, null);
});

test("registry accepts scalar equation matching unit-bearing final answer", async () => {
  const session = makeSession({
    problem:
      "On the Breadus scale, B = (5/12)F + b. Use F = 110 and B = 0 to find b, then find B for the requested temperature.",
    workState: {
      acceptedLines: ["b = -275/6"],
      lastValidLine: "b = -275/6",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "37.5 degrees on the Breadus scale (75/2)",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const result = await runVerifierRegistry({
    session,
    message: "B = 450/12",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => ({
      intent: "submitted_work",
      status: "uncertain",
      local_error: null,
      valid_progress: null,
      suggested_next_check: null,
      should_finish: false,
      confidence: 0.2,
      source: "model",
    }),
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.intent, "final_answer");
  assert.equal(result.should_finish, true);
  assert.equal(result.suggested_next_check, null);
});

test("registry accepts standalone radical scalar final answer on review step", async () => {
  const session = makeSession({
    problem: "Find the exact value requested by the geometry problem.",
    workState: {
      acceptedLines: ["a^2 + b^2 = (\\sqrt{2})^2"],
      lastValidLine: "a^2 + b^2 = (\\sqrt{2})^2",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "2 - sqrt3",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const result = await runVerifierRegistry({
    session,
    message: "2-\\sqrt{3}",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => ({
      intent: "submitted_work",
      status: "uncertain",
      local_error: null,
      valid_progress: null,
      suggested_next_check: null,
      should_finish: false,
      confidence: 0.2,
      source: "model",
    }),
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.intent, "final_answer");
  assert.equal(result.should_finish, true);
  assert.equal(result.suggested_next_check, null);
});

test("message route final-answer override accepts radical scalar answer", async () => {
  const session = makeSession({
    sessionId: "final-answer-radical-scalar-route-test",
    problem: "Find the exact value requested by the geometry problem.",
    solutionGuide: {
      finalAnswer: "2 - sqrt3",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
    solutionGuideStatus: "ready",
  });
  sessionStore.set(session.sessionId, session);

  const response = await messagePost(
    new Request("http://localhost/api/session/message", {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: "2-\\sqrt{3}",
        intentOverride: "final_answer",
      }),
    })
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.is_finished, true);
  assert.equal(body.verification.intent, "final_answer");
  assert.equal(body.verification.status, "correct");
});

test("message route extracts a trailing radical from a labeled final-answer chain", async () => {
  const session = makeSession({
    sessionId: "final-answer-labeled-radical-chain-route-test",
    problem:
      "What is the ratio of the shorter leg to the longer leg in the shaded right triangle?",
    solutionGuide: {
      finalAnswer:
        "ratio of the shorter leg to the longer leg = (sqrt(3)-1)/(sqrt(3)+1) = 2-sqrt(3)",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
    solutionGuideStatus: "ready",
  });
  sessionStore.set(session.sessionId, session);

  assert.equal(
    await canonicalFinalAnswerMatches(session, "2-\\sqrt{3}"),
    true
  );

  const response = await messagePost(
    new Request("http://localhost/api/session/message", {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: "2-\\sqrt{3}",
        intentOverride: "final_answer",
      }),
    })
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.is_finished, true);
  assert.equal(body.verification.intent, "final_answer");
  assert.equal(body.verification.status, "correct");

  sessionStore.delete(session.sessionId);
});

test("message route final-answer override accepts coefficient radical scalar answer", async () => {
  const session = makeSession({
    sessionId: "final-answer-coefficient-radical-route-test",
    problem: "Find the exact length requested by the geometry problem.",
    solutionGuide: {
      finalAnswer: "6sqrt(10)",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
    solutionGuideStatus: "ready",
  });
  sessionStore.set(session.sessionId, session);

  const response = await messagePost(
    new Request("http://localhost/api/session/message", {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: "6\\sqrt{10}",
        intentOverride: "final_answer",
      }),
    })
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.is_finished, true);
  assert.equal(body.verification.intent, "final_answer");
  assert.equal(body.verification.status, "correct");
});

test("message route blocks student messages while hidden guide is pending", async () => {
  const session = makeSession({
    sessionId: "pending-guide-route-test",
    problem:
      "Express the value of the following expression as a fraction: 1 + 2/(3 + 4/5)",
    solutionGuide: null,
    solutionGuideStatus: "pending",
  });
  sessionStore.set(session.sessionId, session);

  const response = await messagePost(
    new Request("http://localhost/api/session/message", {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: "the denominator becomes nineteen fifths",
      }),
    })
  );
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.error, "Checker not ready");
  assert.match(body.message, /setting up the checker/i);
  assert.equal(sessionStore.get(session.sessionId)?.workState.acceptedLines.length, 0);
  assert.equal(sessionStore.get(session.sessionId)?.history.length, 0);

  sessionStore.delete(session.sessionId);
});

test("state route waits once for pending checker hydration", async () => {
  const session = makeSession({
    sessionId: "pending-guide-state-test",
    problem: "What is 2+2?",
    solutionGuide: null,
    solutionGuideStatus: "pending",
  });
  sessionStore.set(session.sessionId, session);

  sessionHydrationStore.set(
    session.sessionId,
    Promise.resolve().then(() => {
      const stored = sessionStore.get(session.sessionId);
      stored.solutionGuideStatus = "ready";
      stored.solutionGuide = {
        finalAnswer: "4",
        solutionOutline: [],
        keyCheckpoints: [],
        alternateMethods: [],
        commonWrongPaths: [],
        confidence: 1,
        caution: null,
      };
      sessionStore.set(session.sessionId, stored);
      sessionHydrationStore.delete(session.sessionId);
    })
  );

  const response = await statePost(
    new Request("http://localhost/api/session/state", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.sessionId }),
    })
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.solutionGuideStatus, "ready");

  sessionHydrationStore.delete(session.sessionId);
  sessionStore.delete(session.sessionId);
});

test("message route final-answer override checks answer strictly", async () => {
  const session = makeSession({
    sessionId: "final-answer-override-route-test",
    problem:
      "A nylon rope of length 140 feet is cut into three pieces. The longest piece is five times as long as each of the other two pieces. How many feet are in the length of the longest piece?",
    workState: {
      acceptedLines: ["x+x+5x=140", "7x=140", "x=20"],
      lastValidLine: "x=20",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "100",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
    solutionGuideStatus: "ready",
  });
  sessionStore.set(session.sessionId, session);

  const wrongResponse = await messagePost(
    new Request("http://localhost/api/session/message", {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: "20",
        intentOverride: "final_answer",
      }),
    })
  );
  const wrongBody = await wrongResponse.json();

  assert.equal(wrongResponse.status, 200);
  assert.equal(wrongBody.response_type, "correction");
  assert.equal(wrongBody.verification.intent, "final_answer");
  assert.equal(wrongBody.verification.status, "incorrect");
  assert.equal(wrongBody.is_finished, false);

  const correctResponse = await messagePost(
    new Request("http://localhost/api/session/message", {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: "100",
        intentOverride: "final_answer",
      }),
    })
  );
  const correctBody = await correctResponse.json();

  assert.equal(correctResponse.status, 200);
  assert.equal(correctBody.response_type, "encouragement");
  assert.equal(correctBody.verification.intent, "final_answer");
  assert.equal(correctBody.verification.status, "correct");
  assert.equal(correctBody.is_finished, true);

  sessionStore.delete(session.sessionId);
});

test("message route final-answer override accepts short text final answers", async () => {
  const session = makeSession({
    sessionId: "final-answer-text-route-test",
    problem:
      "Starting on January 1, what month will it be when exactly one-fifth of the year has passed?",
    workState: {
      acceptedLines: ["1/5 of the year = 365/5", "73 days"],
      lastValidLine: "73 days",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "March",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
    solutionGuideStatus: "ready",
  });
  sessionStore.set(session.sessionId, session);

  const wrongResponse = await messagePost(
    new Request("http://localhost/api/session/message", {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: "February",
        intentOverride: "final_answer",
      }),
    })
  );
  const wrongBody = await wrongResponse.json();

  assert.equal(wrongResponse.status, 200);
  assert.equal(wrongBody.response_type, "correction");
  assert.equal(wrongBody.verification.intent, "final_answer");
  assert.equal(wrongBody.verification.status, "incorrect");
  assert.equal(wrongBody.is_finished, false);

  const correctResponse = await messagePost(
    new Request("http://localhost/api/session/message", {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: "March",
        intentOverride: "final_answer",
      }),
    })
  );
  const correctBody = await correctResponse.json();

  assert.equal(correctResponse.status, 200);
  assert.equal(correctBody.response_type, "encouragement");
  assert.equal(correctBody.verification.intent, "final_answer");
  assert.equal(correctBody.verification.status, "correct");
  assert.equal(correctBody.is_finished, true);

  sessionStore.delete(session.sessionId);
});

test("message route final-answer override accepts variable assignment to scalar answer", async () => {
  const session = makeSession({
    sessionId: "final-answer-variable-assignment-route-test",
    problem: "Solve for x.",
    solutionGuide: {
      finalAnswer: "26/31",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
    solutionGuideStatus: "ready",
  });
  sessionStore.set(session.sessionId, session);

  const plainResponse = await messagePost(
    new Request("http://localhost/api/session/message", {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: "x = 26/31",
        intentOverride: "final_answer",
      }),
    })
  );
  const plainBody = await plainResponse.json();

  assert.equal(plainResponse.status, 200);
  assert.equal(plainBody.response_type, "encouragement");
  assert.equal(plainBody.verification.intent, "final_answer");
  assert.equal(plainBody.verification.status, "correct");
  assert.equal(plainBody.is_finished, true);

  const latexSession = makeSession({
    sessionId: "final-answer-variable-assignment-latex-route-test",
    problem: "Solve for x.",
    solutionGuide: {
      finalAnswer: "26/31",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
    solutionGuideStatus: "ready",
  });
  sessionStore.set(latexSession.sessionId, latexSession);

  const latexResponse = await messagePost(
    new Request("http://localhost/api/session/message", {
      method: "POST",
      body: JSON.stringify({
        sessionId: latexSession.sessionId,
        message: "x = \\frac{26}{31}",
        intentOverride: "final_answer",
      }),
    })
  );
  const latexBody = await latexResponse.json();

  assert.equal(latexResponse.status, 200);
  assert.equal(latexBody.response_type, "encouragement");
  assert.equal(latexBody.verification.intent, "final_answer");
  assert.equal(latexBody.verification.status, "correct");
  assert.equal(latexBody.is_finished, true);

  const commonFractionSession = makeSession({
    sessionId: "final-answer-variable-assignment-common-fraction-route-test",
    problem:
      "The strategy defines the expression as x. Express the value of the expression as a common fraction.",
    strategy: {
      your_turn: "Define the expression as x, then simplify x.",
    },
    solutionGuide: {
      finalAnswer: "26/31",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
    solutionGuideStatus: "ready",
  });
  sessionStore.set(commonFractionSession.sessionId, commonFractionSession);

  const commonFractionResponse = await messagePost(
    new Request("http://localhost/api/session/message", {
      method: "POST",
      body: JSON.stringify({
        sessionId: commonFractionSession.sessionId,
        message: "x = 26/31",
        intentOverride: "final_answer",
      }),
    })
  );
  const commonFractionBody = await commonFractionResponse.json();

  assert.equal(commonFractionResponse.status, 200);
  assert.equal(commonFractionBody.response_type, "encouragement");
  assert.equal(commonFractionBody.verification.intent, "final_answer");
  assert.equal(commonFractionBody.verification.status, "correct");
  assert.equal(commonFractionBody.is_finished, true);

  sessionStore.delete(session.sessionId);
  sessionStore.delete(latexSession.sessionId);
  sessionStore.delete(commonFractionSession.sessionId);
});

test("message route final-answer override accepts checked fraction with punctuation", async () => {
  const session = makeSession({
    sessionId: "final-answer-punctuated-common-fraction-route-test",
    problem: "What common fraction is equivalent to the expression?",
    solutionGuide: {
      finalAnswer: "1/2",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
    solutionGuideStatus: "ready",
  });
  sessionStore.set(session.sessionId, session);

  const response = await messagePost(
    new Request("http://localhost/api/session/message", {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: "is it 1/2?",
        intentOverride: "final_answer",
      }),
    })
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.response_type, "encouragement");
  assert.equal(body.verification.intent, "final_answer");
  assert.equal(body.verification.status, "correct");
  assert.equal(body.is_finished, true);

  sessionStore.delete(session.sessionId);
});

test("message route clarifies question-shaped proposed count answers", async () => {
  const session = makeSession({
    sessionId: "proposed-count-question-final-route-test",
    problem: "How many triangles are in the figure?",
    solutionGuide: {
      finalAnswer: "5",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
    solutionGuideStatus: "ready",
  });
  sessionStore.set(session.sessionId, session);

  const response = await messagePost(
    new Request("http://localhost/api/session/message", {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: "So, there are 5 triangles?",
      }),
    })
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.response_type, "question");
  assert.equal(body.verification.intent, "question");
  assert.equal(body.verification.status, "uncertain");
  assert.equal(body.is_finished, false);
  assert.match(body.message, /final answer is 5/i);

  sessionStore.delete(session.sessionId);
});

test("message route accepts reduced latex common fraction as final answer", async () => {
  const session = makeSession({
    sessionId: "final-answer-reduced-latex-common-fraction-route-test",
    problem: "What common fraction is equivalent to the expression?",
    solutionGuide: {
      finalAnswer: "44/125",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
    solutionGuideStatus: "ready",
  });
  sessionStore.set(session.sessionId, session);

  const response = await messagePost(
    new Request("http://localhost/api/session/message", {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: "\\frac{44}{125}",
        intentOverride: "final_answer",
      }),
    })
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.response_type, "encouragement");
  assert.equal(body.verification.intent, "final_answer");
  assert.equal(body.verification.status, "correct");
  assert.equal(body.is_finished, true);
  assert.equal(body.final_answer, "44/125");
  assert.doesNotMatch(body.message, /reduce/i);

  sessionStore.delete(session.sessionId);
});

test("message route final-answer override accepts numeric answer when guide includes units", async () => {
  const session = makeSession({
    sessionId: "final-answer-units-guide-route-test",
    problem:
      "What is the maximum number of unit cubes that can be used to create a structure with the front, top, and right-side views shown?",
    solutionGuide: {
      finalAnswer: "18 unit cubes",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
    solutionGuideStatus: "ready",
  });
  sessionStore.set(session.sessionId, session);

  const response = await messagePost(
    new Request("http://localhost/api/session/message", {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: "18",
        intentOverride: "final_answer",
      }),
    })
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.response_type, "encouragement");
  assert.equal(body.verification.intent, "final_answer");
  assert.equal(body.verification.status, "correct");
  assert.equal(body.is_finished, true);
  assert.equal(body.final_answer, "18 unit cubes");

  sessionStore.delete(session.sessionId);
});

test("message route final-answer override accepts final value from last accepted equality", async () => {
  const session = makeSession({
    sessionId: "final-answer-last-equality-route-test",
    problem: "If C = \\frac{5}{9}(F - 32), what is F when C = 20?",
    workState: {
      acceptedLines: ["F=\\frac95 C + 32", "F = 36 + 32 = 68"],
      lastValidLine: "F = 36 + 32 = 68",
      rejectedLines: [],
    },
  });
  sessionStore.set(session.sessionId, session);

  const response = await messagePost(
    new Request("http://localhost/api/session/message", {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: "68",
        intentOverride: "final_answer",
      }),
    })
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.response_type, "encouragement");
  assert.equal(body.verification.intent, "final_answer");
  assert.equal(body.verification.status, "correct");
  assert.equal(body.is_finished, true);

  sessionStore.delete(session.sessionId);
});

test("message route final-answer override accepts symbolic expression answer", async () => {
  const session = makeSession({
    sessionId: "final-answer-symbolic-expression-route-test",
    problem:
      "A cube measuring n inches on each side is painted only on the outside and then cut into 1-inch cubes. How many cubes have no painted faces?",
    workState: {
      acceptedLines: ["(n-2)^3"],
      lastValidLine: "(n-2)^3",
      rejectedLines: [],
    },
  });
  sessionStore.set(session.sessionId, session);

  const response = await messagePost(
    new Request("http://localhost/api/session/message", {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: "(n-2)^3",
        intentOverride: "final_answer",
      }),
    })
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.response_type, "encouragement");
  assert.equal(body.verification.intent, "final_answer");
  assert.equal(body.verification.status, "correct");
  assert.equal(body.is_finished, true);

  sessionStore.delete(session.sessionId);
});

test("canonical final answer matching only gives strict scalar verdicts for scalar guides", async () => {
  const scalarSession = makeSession({
    problem: "Solve for x.",
    solutionGuide: {
      finalAnswer: "26/31",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });
  assert.equal(await canonicalFinalAnswerMatches(scalarSession, "x = 26/31"), true);
  assert.equal(await canonicalFinalAnswerMatches(scalarSession, "x = 3"), false);

  const unitScalarSession = makeSession({
    problem: "How many unit cubes are in the structure?",
    solutionGuide: {
      finalAnswer: "18 unit cubes",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });
  assert.equal(await canonicalFinalAnswerMatches(unitScalarSession, "18"), true);
  assert.equal(await canonicalFinalAnswerMatches(unitScalarSession, "17"), false);

  const commaScalarSession = makeSession({
    problem: "What number is represented by the hieroglyphs?",
    solutionGuide: {
      finalAnswer: "10,423",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });
  assert.equal(await canonicalFinalAnswerMatches(commaScalarSession, "10423"), true);
  assert.equal(await canonicalFinalAnswerMatches(commaScalarSession, "10422"), false);

  const orderedPairSession = makeSession({
    problem: "Solve for the ordered pair $(x,y)$.",
    solutionGuide: {
      finalAnswer: "(3, 4)",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });
  assert.equal(await canonicalFinalAnswerMatches(orderedPairSession, "x=3, y=4"), null);
  assert.equal(await canonicalFinalAnswerMatches(orderedPairSession, "x=3"), null);

  const intervalSession = makeSession({
    problem: "Give the solution interval.",
    solutionGuide: {
      finalAnswer: "[2, 5)",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });
  assert.equal(await canonicalFinalAnswerMatches(intervalSession, "x=3"), null);
});

test("registry asks model for semantic formula setup before symbolic rejection", async () => {
  const session = makeSession({
    problem:
      "A trapezoid has bases 10 and 14 and height 5. What is its area?",
  });
  let modelChecks = 0;
  let finalAnswerChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "area of a trapezoid = (b1 + b2)h/2",
    modelVerifyFinalAnswer: async () => {
      finalAnswerChecks += 1;
      return null;
    },
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That is a relevant area formula for this problem.",
        suggested_next_check: "Substitute the two bases and the height into the formula.",
        should_finish: false,
        confidence: 0.92,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.source, "model");
  assert.equal(modelChecks, 1);
  assert.equal(finalAnswerChecks, 0);
});

test("registry asks model for contextual variable setup equations", async () => {
  const session = makeSession({
    problem:
      "A rhombus has an area of 84 in^2 and a diagonal of length 14 inches. What is the length, in inches, of the other diagonal?",
    workState: {
      acceptedLines: ["area of rhombus = product of diagonals/2"],
      lastValidLine: "area of rhombus = product of diagonals/2",
      rejectedLines: [],
    },
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "84 = 14*d/2",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That correctly substitutes the given area and diagonal.",
        suggested_next_check: "Now isolate the unknown diagonal.",
        should_finish: false,
        confidence: 0.93,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.source, "model");
  assert.equal(modelChecks, 1);
});

test("registry semantically reviews a strategy-requested inequality setup", async () => {
  const session = makeSession({
    problem:
      "A package has length x, width y, and height z. UPS requires length plus twice the width plus twice the height to be at most 130 inches.",
    strategy: {
      smart_move: "Translate the UPS rule into an inequality.",
      your_turn:
        "Write the relationship x + 2y + 2z <= 130 and label the height variable.",
    },
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "x + 2y + 2z <= 130",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That inequality correctly represents the UPS rule.",
        suggested_next_check: "What would you try next?",
        should_finish: false,
        confidence: 0.98,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assert.equal(modelChecks, 1);
  assertStatus(result, "correct");
  assert.equal(result.source, "model");
  assert.equal(result.should_finish, false);
});

test("allowed units-digit categories receive semantic review", async () => {
  const session = makeSession({
    problem:
      "A two-digit number is favorable if it is divisible by its tens digit or by its nonzero units digit. How many favorable numbers are there?",
  });
  const message =
    "every 2-digit number with a units digit of 0, 1, or 2 is favorable";

  assert.equal(deterministicVerify(session, message), null);
  let modelChecks = 0;
  const result = await runVerifierRegistry({
    session,
    message,
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress:
          "Those three units-digit categories do satisfy the divisibility condition.",
        suggested_next_check: "What would you try next?",
        should_finish: false,
        confidence: 0.97,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assert.equal(modelChecks, 1);
  assertStatus(result, "correct");
  assert.equal(result.source, "model");
});

test("stated length-and-girth inequality is accepted deterministically", () => {
  const session = makeSession({
    problem:
      "United Parcel Service requires that the sum of a package's length, x, and girth, 2y + 2z, not exceed 130 inches. The width is 20 and length is 36.",
  });

  for (const message of [
    "x + 2y + 2z <= 130",
    "x+2y+2z\\leq130",
    "130 >= x + 2y + 2z",
  ]) {
    const result = deterministicVerify(session, message);
    assertStatus(result, "correct");
    assert.equal(result.intent, "submitted_work");
    assert.equal(result.should_finish, false);
    assert.match(result.valid_progress || "", /length and girth constraint/i);
  }
});

test("registry asks model for purely symbolic proportional setups", async () => {
  const session = makeSession({
    problem:
      "The number of mice caught varies jointly with the number of cats and the number of days. Write a model for mice m, cats c, and days d.",
    strategy: {
      smart_move:
        "Introduce a rate constant k and express the proportional relationship in a formula.",
      your_turn:
        "Define c, d, m, and k, then write the symbolic relationship between them.",
    },
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "m=kcd",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That correctly models the joint variation.",
        suggested_next_check: "Use the given values to determine the rate constant.",
        should_finish: false,
        confidence: 0.96,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.source, "model");
  assert.equal(modelChecks, 1);
});

test("coach-requested second modeling equation is not compared to the first equation", async () => {
  const session = makeSession({
    problem:
      "A hiking-time model is T = aL + bG. One trail takes 69 minutes with L = 1.5 and G = 800. A second trail takes 69 minutes with L = 1.2 and G = 1100. Find the predicted time for a third trail.",
    workState: {
      acceptedLines: ["69 = 1.5a + 800b"],
      lastValidLine: "69 = 1.5a + 800b",
      rejectedLines: [],
    },
    history: [
      {
        role: "assistant",
        content:
          "That first model equation is correct. Write the second equation using the second trail data.",
      },
    ],
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "69 = 1.2a + 1100b",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That correctly models the second trail data.",
        suggested_next_check: "Use the two equations to determine the model constants.",
        should_finish: false,
        confidence: 0.96,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.source, "model");
  assert.equal(modelChecks, 1);
  assert.doesNotMatch(result.local_error || "", /numeric simplification|right side/i);
});

test("simple clue assignment reaches semantic step verifier", async () => {
  const session = makeSession({
    problem:
      "ABCDE is a five-digit number where A, B, C, D, and E are unique digits. None of the digits are prime or zero; even and odd digits alternate; C is a square number; and A + D = B. Determine the number.",
    solutionGuide: {
      finalAnswer: "89416",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
    solutionGuideStatus: "ready",
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "C = 4",
    modelVerifyFinalAnswer: async () => ({
      intent: "final_answer",
      status: "uncertain",
      local_error: null,
      valid_progress: null,
      suggested_next_check:
        "I cannot verify that as a final answer yet. Send one checkable line that supports it.",
      should_finish: false,
      confidence: 0.3,
      source: "model",
    }),
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "$C=4$ follows from the square-digit clue and the digit restrictions.",
        suggested_next_check: "Use that value with the parity and uniqueness clues.",
        should_finish: false,
        confidence: 0.76,
        source: "model",
      };
    },
    applyConservativePolicy,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.intent, "submitted_work");
  assert.equal(result.source, "model");
  assert.equal(modelChecks, 1);
  assert.match(result.valid_progress || "", /C=4/i);
});

test("linear solution is accepted after substituting a known variable", () => {
  const session = makeSession({
    problem:
      "A rectangle has perimeter 47 and length 16. Find its area.",
    workState: {
      acceptedLines: ["L = 16", "47 = 2L + 2W"],
      lastValidLine: "47 = 2L + 2W",
      rejectedLines: [],
    },
    history: [
      {
        role: "assistant",
        content:
          "Substitute $L=16$ into $47=2L+2W$ and solve for $W$, then send that line.",
      },
    ],
  });

  const correct = deterministicVerify(session, "W = 15/2");
  assertStatus(correct, "correct");
  assert.equal(correct.should_finish, false);
  assert.match(correct.valid_progress || "", /width is correct|after substituting/i);
  assert.doesNotMatch(correct.local_error || "", /not equivalent/i);

  const wrong = deterministicVerify(session, "W = 8");
  assertStatus(wrong, "incorrect");
  assert.match(wrong.local_error || "", /does not solve|does not match/i);
  assert.doesNotMatch(wrong.local_error || "", /not equivalent/i);
});

test("linear solution accepts implicit multiplication after a fraction coefficient", () => {
  const session = makeSession({
    problem: "Solve for S.",
    workState: {
      acceptedLines: ["5 = \\frac{1}{10}S"],
      lastValidLine: "5 = \\frac{1}{10}S",
      rejectedLines: [],
    },
  });

  const correct = deterministicVerify(session, "S = 50");
  assertStatus(correct, "correct");
  assert.equal(correct.intent, "final_answer");
  assert.equal(correct.should_finish, true);
  assert.match(correct.valid_progress || "", /linear equation/i);
});

test("rectangle perimeter area flow accepts width and final area", () => {
  const session = makeSession({
    problem:
      "A rectangle has perimeter 47 and length 16. Find its area.",
    workState: {
      acceptedLines: ["L = 16"],
      lastValidLine: "L = 16",
      rejectedLines: [],
    },
  });

  const decimalWidth = deterministicVerify(session, "W = 7.5");
  assertStatus(decimalWidth, "correct");
  assert.equal(decimalWidth.should_finish, false);
  assert.match(decimalWidth.valid_progress || "", /width is correct/i);

  const fractionWidth = deterministicVerify(session, "W = 15/2");
  assertStatus(fractionWidth, "correct");
  assert.equal(fractionWidth.should_finish, false);

  const finalArea = deterministicVerify(session, "answer is 120");
  assertStatus(finalArea, "correct");
  assert.equal(finalArea.intent, "final_answer");
  assert.equal(finalArea.should_finish, true);
});

test("numeric rewrite can use descriptive labeled prior line", () => {
  const session = makeSession({
    problem:
      "A line passes through the points (4, 3) and (7, -5). What is the slope of a line perpendicular to it? Express your answer as a common fraction.",
    workState: {
      acceptedLines: ["slope of first line = (-5 - 3)/(7 - 4)"],
      lastValidLine: "slope of first line = (-5 - 3)/(7 - 4)",
      rejectedLines: [],
    },
  });

  const result = deterministicVerify(session, "-(8/3)");
  assertStatus(result, "correct");
  assert.equal(result.should_finish, false);
  assert.match(result.valid_progress || "", /equivalent|rewrite/i);
  assert.match(result.suggested_next_check || "", /perpendicular line/i);
  assert.doesNotMatch(result.suggested_next_check || "", /reduced common fraction/i);
});

test("registry uses model semantics for natural-language geometry wording", async () => {
  const session = makeSession({
    problem:
      "Find the ratio of the radius of the innermost of the three concentric circles to the radius of the outer circle given that each region represents 1/12 of the total area. Express your answer as a decimal to the nearest hundredth.",
    workState: {
      acceptedLines: ["the smallest circle's area is 1/3 the area of the whole circle"],
      lastValidLine: "the smallest circle's area is 1/3 the area of the whole circle",
      rejectedLines: [],
    },
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message:
      "the radius of the smallest circle is sqrt(1/3) times the radius of the largest circle",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That is the correct radius-ratio relationship.",
        suggested_next_check: "Convert the ratio to a decimal rounded to the nearest hundredth.",
        should_finish: false,
        confidence: 0.93,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.source, "model");
  assert.equal(modelChecks, 1);
  assert.match(result.suggested_next_check || "", /decimal/i);

  const areaTarget = await runVerifierRegistry({
    session,
    message:
      "the radius of the smallest circle is sqrt(1/3) times the area of the largest circle",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "incorrect",
        local_error:
          "You are comparing a radius to an area. Compare the innermost radius to the outer radius.",
        valid_progress: null,
        suggested_next_check:
          "Rewrite the relationship using the radius of the largest circle.",
        should_finish: false,
        confidence: 0.97,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(areaTarget, "incorrect");
  assert.equal(areaTarget.source, "model");
  assert.equal(modelChecks, 2);
  assert.match(areaTarget.local_error || "", /radius to an area/i);
});

test("first word-problem setup equations get semantic modeling review before identity rejection", async () => {
  const session = makeSession({
    problem:
      "Which number can be subtracted from the numerator and added to the denominator of 12/15 to create a fraction that is equivalent to 1/2?",
    strategy: {
      game_plan:
        "Identify the relationship between the known quantities and the quantity being asked for.",
      what_to_look_for:
        "Notice the same number is taken from the numerator and added to the denominator.",
      smart_move:
        "Introduce a variable for the unknown and express the new numerator and denominator before doing algebra.",
      your_turn:
        "Let x be the unknown and write that the fraction formed by subtracting x from the numerator and adding x to the denominator is equal to 1/2.",
    },
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "(12-x)/(15+x)=1/2",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That equation correctly models the described fraction.",
        suggested_next_check: "Solve that equation for the unknown.",
        should_finish: false,
        confidence: 0.94,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.source, "model");
  assert.equal(result.should_finish, false);
  assert.equal(modelChecks, 1);
  assert.doesNotMatch(result.local_error || "", /symbolic equality/i);
});

test("review step solves simple variable assignment that matches checked final answer", async () => {
  const session = makeSession({
    problem:
      "The radius is represented by r. What is the value of r?",
    solutionGuide: {
      finalAnswer: "8",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const result = await runVerifierRegistry({
    session,
    message: "r = 8",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      throw new Error("model should not be needed when assignment matches checked final answer");
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.intent, "final_answer");
  assert.equal(result.should_finish, true);
});

test("semantic model accepts verbal permutation symmetry and total-count claims", async () => {
  const session = makeSession({
    problem:
      "The digits 1, 2, 3, 4 and 5 can be arranged to form many different 5-digit positive integers with five distinct digits. In how many such integers is the digit 1 to the left of the digit 2?",
  });
  let modelChecks = 0;

  const symmetry = await runVerifierRegistry({
    session,
    message: "half of the total permutations of the digits have 1 to the left of 2",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That symmetry observation is valid.",
        suggested_next_check: "Now find the total number of arrangements.",
        should_finish: false,
        confidence: 0.94,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(symmetry, "correct");
  assert.equal(symmetry.source, "model");

  const total = await runVerifierRegistry({
    session,
    message: "there are 120 total permutations of the digits",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That total arrangement count is correct.",
        suggested_next_check: "Use your symmetry observation to get the requested count.",
        should_finish: false,
        confidence: 0.94,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(total, "correct");
  assert.equal(total.source, "model");
  assert.equal(modelChecks, 2);
});

test("semantic model reviews contextual dice counting prose and expressions", async () => {
  const session = makeSession({
    problem:
      "When five standard six-sided dice are rolled sequentially there are 6^5 = 7776 possible outcomes. For how many outcomes is the sum of the five rolled numbers exactly 27?",
  });
  let modelChecks = 0;

  const maximum = await runVerifierRegistry({
    session,
    message: "the maximum output is 30 if all five die roll 6",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That maximum-sum observation is valid.",
        suggested_next_check: "Use that to reason about how far below the maximum the target sum is.",
        should_finish: false,
        confidence: 0.94,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(maximum, "correct");
  assert.equal(maximum.source, "model");

  const wrongCases = await runVerifierRegistry({
    session,
    message:
      "There are three ways for the sum of the five rolled numbers to equal 27: two 6s and three 5s; three 6s, one 5, and one 4; or four 6s and one 3.",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "incorrect",
        local_error: "Those are only three value patterns, not all ordered outcomes.",
        valid_progress: null,
        suggested_next_check: "Count the ordered arrangements for each value pattern.",
        should_finish: false,
        confidence: 0.95,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(wrongCases, "incorrect");
  assert.equal(wrongCases.source, "model");

  const countExpression = await runVerifierRegistry({
    session,
    message: "5!/(2!3!) + 5!/(3!1!1!) + 5!/(4!1!)",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That expression counts the ordered outcomes from the value patterns.",
        suggested_next_check: "Evaluate the expression to get the count.",
        should_finish: false,
        confidence: 0.93,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(countExpression, "correct");
  assert.equal(countExpression.source, "model");
  assert.equal(modelChecks, 3);
  assert.doesNotMatch(countExpression.local_error || "", /not equivalent/i);
});

test("wordy measurement setup claims get semantic review", async () => {
  const session = makeSession({
    problem:
      "At 4:00, what is the angle between the minute hand and the hour hand on a clock?",
    strategy: {
      game_plan: "Track each hand's position in degrees from 12 o'clock.",
      what_to_look_for: "Notice the minute hand and hour hand positions at the given time.",
      smart_move: "Use degrees around the clock face.",
      your_turn: "State where each hand is at the starting time.",
    },
    workState: {
      acceptedLines: [
        "the minute hand moves 6 degrees per minute and the hour hand moves 0.5 degrees per minute",
      ],
      lastValidLine:
        "the minute hand moves 6 degrees per minute and the hour hand moves 0.5 degrees per minute",
      rejectedLines: [],
    },
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "at 4 : 00, the minute hand is at 0 degrees and the hour hand is at 120 degrees",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That starting-position setup is correct.",
        suggested_next_check: "Compare the two hand positions.",
        should_finish: false,
        confidence: 0.93,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.source, "model");
  assert.equal(modelChecks, 1);
  assert.doesNotMatch(result.suggested_next_check || "", /intermediate|last line we know/i);
});

test("wordy bounded-range counting claims get semantic review", async () => {
  const session = makeSession({
    problem:
      "How many isosceles triangles are there with positive area whose side lengths are positive integers and whose longest side has length 2025?",
  });
  const message =
    "Case 1: The two sides with equal length are both smaller than 2025, which means that they range from 1013 to 2024. There are 1012 such cases.";
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message,
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress:
          "That range and its inclusive count are correct for this case.",
        suggested_next_check: "Now analyze the other isosceles case.",
        should_finish: false,
        confidence: 0.95,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.source, "model");
  assert.equal(modelChecks, 1);

  const uncertainResponse = composeCoachResponse(
    {
      intent: "unclear",
      status: "uncertain",
      local_error: null,
      valid_progress: null,
      suggested_next_check: null,
      should_finish: false,
      confidence: 0.2,
      source: "model",
    },
    { studentMessage: message }
  );
  assert.doesNotMatch(uncertainResponse, /typo/i);
});

test("metric conversions and anchored area product are accepted", async () => {
  const problem =
    "Jackson's paintbrush makes a narrow strip with a width of 6.5 millimeters. Jackson has enough paint to make a strip 25 meters long. How many square centimeters of paper could Jackson cover with paint?";

  const widthConversion = deterministicVerify(
    makeSession({ problem }),
    "6.5 millimeters is equal to 0.65 centimeters"
  );
  assertStatus(widthConversion, "correct");
  assert.match(widthConversion.valid_progress || "", /conversion/i);

  const lengthConversion = deterministicVerify(
    makeSession({ problem }),
    "25 meters is 2500 centimeters"
  );
  assertStatus(lengthConversion, "correct");

  const session = makeSession({
    problem,
    workState: {
      acceptedLines: [
        "6.5 millimeters is equal to 0.65 centimeters",
        "25 meters is 2500 centimeters",
      ],
      lastValidLine: "25 meters is 2500 centimeters",
      rejectedLines: [],
    },
  });
  let modelChecks = 0;

  const areaProduct = await runVerifierRegistry({
    session,
    message: "0.65 * 2500 = 1625",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "uncertain",
        local_error: null,
        valid_progress: null,
        suggested_next_check: null,
        should_finish: false,
        confidence: 0.2,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal,
  });

  assertStatus(areaProduct, "correct");
  assert.equal(areaProduct.should_finish, false);
  assert.equal(modelChecks, 0);
});

test("first-step compound-interest expression gets semantic setup review", async () => {
  const session = makeSession({
    problem:
      "Find the value in dollars of $1,000 invested at 7.5% for 4 years. Round your answer to the nearest dollar.",
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "1000(1.075)^4",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That is the right compound-interest setup.",
        suggested_next_check: "Evaluate the expression, then round to the nearest dollar.",
        should_finish: false,
        confidence: 0.93,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.source, "model");
  assert.equal(modelChecks, 1);
  assert.doesNotMatch(result.local_error || "", /not equivalent/i);
});

test("semantic expression uncertainty does not become a symbolic rejection", async () => {
  const session = makeSession({
    problem:
      "Find the ratio of the radius of the innermost of the three concentric circles to the radius of the outer circle given that each region represents 1/12 of the total area. Express your answer as a decimal to the nearest hundredth.",
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message:
      "the radius of the smallest circle is sqrt(1/3) times something in the largest circle",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "uncertain",
        local_error: null,
        valid_progress: null,
        suggested_next_check:
          "I am not sure what quantity you are comparing to. Can you rewrite that relationship?",
        should_finish: false,
        confidence: 0.45,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "uncertain");
  assert.equal(result.source, "model");
  assert.equal(modelChecks, 1);
  assert.doesNotMatch(result.suggested_next_check || "", /not equivalent/i);
});

test("uncertain model result falls through to symbolic equation equivalence", async () => {
  const session = makeSession({
    problem:
      "A rectangle has perimeter difference represented by $4t=4s-10$. Rewrite $t$ in terms of $s$.",
    workState: {
      acceptedLines: ["4t = 4s - 10"],
      lastValidLine: "4t = 4s - 10",
      rejectedLines: [],
    },
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "t = (4s - 10)/4",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "uncertain",
        local_error: null,
        valid_progress: null,
        suggested_next_check: "Can you show one intermediate step?",
        should_finish: false,
        confidence: 0.4,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.source, "symbolic");
  assert.equal(modelChecks, 1);
});

test("canonical sympy accepts cross-multiplying equivalent equations", async () => {
  const session = makeSession({
    problem: "Solve the equation for x.",
    workState: {
      acceptedLines: ["3x/(4(90-x)) = 3/14"],
      lastValidLine: "3x/(4(90-x)) = 3/14",
      rejectedLines: [],
    },
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "42x = 12(90 - x)",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      throw new Error("model should not be needed for cross-multiplication equivalence");
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.source, "symbolic");
  assert.equal(result.should_finish, false);
  assert.equal(modelChecks, 0);
});

test("canonical sympy checks nonlinear equation equivalence without model fallback", async () => {
  const session = makeSession({
    problem: "Solve $x^2+2x+1=0$.",
    workState: {
      acceptedLines: ["x^2 + 2x + 1 = 0"],
      lastValidLine: "x^2 + 2x + 1 = 0",
      rejectedLines: [],
    },
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "x^2 + 2x = -1",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "uncertain",
        local_error: null,
        valid_progress: null,
        suggested_next_check: "Can you show one intermediate step?",
        should_finish: false,
        confidence: 0.4,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.source, "symbolic");
  assert.equal(modelChecks, 0);
});

test("registry solves symbolic expression answers on review step", async () => {
  const session = makeSession({
    problem:
      "A cube measuring n inches on each side is painted only on the outside and then cut into 1-inch cubes. How many cubes have no painted faces?",
    workState: {
      acceptedLines: ["(n-2)(n-2)(n-2)"],
      lastValidLine: "(n-2)(n-2)(n-2)",
      rejectedLines: [],
    },
  });

  const result = await runVerifierRegistry({
    session,
    message: "(n-2)^3",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      throw new Error("model should not be needed for symbolic expression final answer");
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.intent, "final_answer");
  assert.equal(result.should_finish, true);
});

test("registry does not mark symbolic intermediate equations solved as expression answers", async () => {
  const session = makeSession({
    problem: "Find x.",
    workState: {
      acceptedLines: ["x^4 - 42x^2 + 441 = 0"],
      lastValidLine: "x^4 - 42x^2 + 441 = 0",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "sqrt(21)",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const result = await runVerifierRegistry({
    session,
    message: "16x^2 = -x^4 + 58x^2 - 441",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => ({
      intent: "submitted_work",
      status: "uncertain",
      local_error: null,
      valid_progress: null,
      suggested_next_check: null,
      should_finish: false,
      confidence: 0.2,
      source: "model",
    }),
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.intent, "submitted_work");
  assert.equal(result.should_finish, false);
});

test("canonical sympy accepts radical rationalization rewrites", async () => {
  const session = makeSession({
    problem: "Solve for r.",
    workState: {
      acceptedLines: ["r = \\frac{10}{\\sqrt{2}+1}"],
      lastValidLine: "r = \\frac{10}{\\sqrt{2}+1}",
      rejectedLines: [],
    },
  });

  const rationalized = await canonicalSympyVerify(session, "r = 10(\\sqrt{2}-1)");
  assertStatus(rationalized, "correct");
  assert.equal(rationalized.source, "symbolic");
  assert.equal(rationalized.should_finish, false);

  const expanded = await canonicalSympyVerify(session, "r = 10\\sqrt{2} - 10");
  assertStatus(expanded, "correct");
  assert.equal(expanded.source, "symbolic");
});

test("canonical sympy accepts quadratic-formula roots from an accepted quadratic", async () => {
  const session = makeSession({
    problem:
      "Find the ratio of the shorter leg to the longer leg in the inscribed-square diagram.",
    workState: {
      acceptedLines: ["y^2-\\sqrt{3}y+\\frac{1}{2}=0"],
      lastValidLine: "y^2-\\sqrt{3}y+\\frac{1}{2}=0",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "2-\\sqrt{3}",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });
  const submissions = [
    "y=\\frac{\\sqrt{3}\\pm\\sqrt{3-2}}{2}=\\frac{\\sqrt{3}\\pm1}{2}",
    "y=\\frac{-(-\\sqrt{3})\\pm\\sqrt{(-\\sqrt{3})^2-4(1)(\\frac{1}{2})}}{2(1)}",
  ];

  for (const submission of submissions) {
    const result = await canonicalSympyVerify(session, submission);
    assertStatus(result, "correct");
    assert.equal(result.intent, "submitted_work");
    assert.equal(result.should_finish, false);
    assert.match(result.valid_progress || "", /quadratic-formula|two roots/i);
  }
});

test("canonical sympy accepts the positive root of a squared geometric length", async () => {
  const session = makeSession({
    problem: "Find the side length L in the geometry diagram.",
    workState: {
      acceptedLines: ["L^2=4*15"],
      lastValidLine: "L^2=4*15",
      rejectedLines: [],
    },
  });

  const result = await canonicalSympyVerify(session, "L=2\\sqrt{15}");

  assertStatus(result, "correct");
  assert.equal(result.source, "symbolic");
  assert.equal(result.should_finish, false);
  assert.match(result.valid_progress || "", /positive-root/i);
});

test("registry accepts an equivalent simplified positive root without a coach correction", async () => {
  const session = makeSession({
    problem: "The slant length s is the hypotenuse of a right triangle with legs b and 6.",
    workState: {
      acceptedLines: ["3b=12+2s", "s^2=b^2+6^2"],
      lastValidLine: "s^2=b^2+6^2",
      rejectedLines: [],
    },
  });

  const result = await runVerifierRegistry({
    session,
    message: "s=\\sqrt{b^2+36}",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => ({
      intent: "submitted_work",
      status: "uncertain",
      local_error: null,
      valid_progress: null,
      suggested_next_check: "Show one intermediate line.",
      should_finish: false,
      confidence: 0.3,
      source: "model",
    }),
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.source, "symbolic");
  assert.match(result.valid_progress || "", /positive-root/i);
});

test("canonical sympy does not discard a negative algebraic root without context", async () => {
  const session = makeSession({
    problem: "Solve the equation for x.",
    workState: {
      acceptedLines: ["x^2=60"],
      lastValidLine: "x^2=60",
      rejectedLines: [],
    },
  });

  const result = await canonicalSympyVerify(session, "x=2\\sqrt{15}");

  assert.equal(result, null);
});

test("registry accepts radical like-term rewrites with multiplication dots", async () => {
  const session = makeSession({
    problem: "Simplify the radical expression.",
    workState: {
      acceptedLines: ["\\sqrt{108^2 + 16s^2 - 108\\cdot 8s + 2s^2}"],
      lastValidLine: "\\sqrt{108^2 + 16s^2 - 108\\cdot 8s + 2s^2}",
      rejectedLines: [],
    },
  });

  let modelChecks = 0;
  const result = await runVerifierRegistry({
    session,
    message: "\\sqrt{18s^2 - 108\\cdot8s + 108^2}",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "uncertain",
        local_error: null,
        valid_progress: null,
        suggested_next_check: "Can you show one intermediate step?",
        should_finish: false,
        confidence: 0.4,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.source, "symbolic");
  assert.equal(modelChecks, 0);

  const middleDot = await canonicalSympyVerify(
    session,
    "\\sqrt{18s^2 - 108\u00b78s + 108^2}"
  );
  assertStatus(middleDot, "correct");

  const labeledSession = makeSession({
    problem: "Simplify the radical expression.",
    workState: {
      acceptedLines: ["L = \\sqrt{2s^2 + (108 - 4s)^2}"],
      lastValidLine: "L = \\sqrt{2s^2 + (108 - 4s)^2}",
      rejectedLines: [],
    },
  });
  const unicodeRadical = await runVerifierRegistry({
    session: labeledSession,
    message: "L = \u221a(2s^2 + 108^2 + 16s^2 - 108\u00b78s)",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      throw new Error("model should not be needed for unicode radical equivalence");
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });
  assertStatus(unicodeRadical, "correct");
  assert.equal(unicodeRadical.source, "symbolic");
});

test("canonical sympy accepts variable assignment derived from a two-equation system", async () => {
  const session = makeSession({
    problem: "Use the equations to solve for the unknowns.",
    workState: {
      acceptedLines: ["o + t = 65, o + 2t = 89"],
      lastValidLine: "o + t = 65, o + 2t = 89",
      rejectedLines: [],
    },
  });

  const result = await runVerifierRegistry({
    session,
    message: "t = 24",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      throw new Error("model should not be needed for symbolic system solving");
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.source, "symbolic");
  assert.doesNotMatch(result.suggested_next_check || "", /inverse operation/i);
});

test("canonical sympy simplifies the right side of descriptive pi labels", async () => {
  const session = makeSession({
    problem: "What fraction of the large circle is shaded in the diagram?",
    problemImage: "data:image/png;base64,test",
    workState: {
      acceptedLines: [
        "shadedareainsidethecentralcircle=\\pi2^2-2\\pi",
      ],
      lastValidLine: "shadedareainsidethecentralcircle=\\pi2^2-2\\pi",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "5/18",
      confidence: 1,
    },
  });

  const result = await canonicalSympyVerify(
    session,
    "centralshadedarea=2\\pi"
  );
  assertStatus(result, "correct");
  assert.equal(result.intent, "submitted_work");
  assert.equal(result.should_finish, false);
});

test("canonical sympy finishes already reduced common fraction final answer", async () => {
  const session = makeSession({
    problem:
      "Express the value of the following expression as a fraction: 1 + 2/(3 + 4/5)",
    workState: {
      acceptedLines: ["1 + 10/19"],
      lastValidLine: "1 + 10/19",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "29/19",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  const result = await canonicalSympyVerify(session, "29/19");
  assertStatus(result, "correct");
  assert.equal(result.intent, "final_answer");
  assert.equal(result.should_finish, true);
  assert.equal(result.suggested_next_check, null);

  const latexResult = await canonicalSympyVerify(session, "\\frac{29}{19}");
  assertStatus(latexResult, "correct");
  assert.equal(latexResult.intent, "final_answer");
  assert.equal(latexResult.should_finish, true);
  assert.equal(latexResult.suggested_next_check, null);
});

test("canonical sympy can override generic local equivalence rejection", () => {
  const localRejection = {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "That equation is not equivalent to the previous one.",
    valid_progress: null,
    suggested_next_check: "Check that you applied the same operation to both sides.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
  const symbolicAcceptance = {
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: "That step is correct.",
    suggested_next_check: "Continue from this form and make the next useful step.",
    should_finish: false,
    confidence: 0.99,
    source: "symbolic",
  };

  assert.equal(
    shouldCanonicalOverrideLocalRejection(localRejection, symbolicAcceptance),
    true
  );
  assert.equal(
    shouldCanonicalOverrideLocalRejection(
      { ...localRejection, local_error: "That denominator is not the one from the problem." },
      symbolicAcceptance
    ),
    false
  );
});

test("absolute-value power rewrite is accepted", () => {
  const session = makeSession({
    problem: "Evaluate |2^{3}^{2} - 2^{2}^{3}|.",
    workState: {
      acceptedLines: ["|2^{3}^{2} - 2^{2}^{3}|"],
      lastValidLine: "|2^{3}^{2} - 2^{2}^{3}|",
    },
  });

  const result = deterministicVerify(session, "|64 - 64|");
  assertStatus(result, "correct");
  assert.match(result.valid_progress || "", /absolute-value rewrite/i);
});

test("power equation accepts removing same-base coefficient", () => {
  const session = makeSession({
    problem: "Solve $10(10^x)^2=10^5$.",
    workState: {
      acceptedLines: ["10(10^x)^2 = 10^5"],
      lastValidLine: "10(10^x)^2 = 10^5",
      rejectedLines: [],
    },
  });

  const numericRightSide = deterministicVerify(session, "(10^x)^2 = 10000");
  assertStatus(numericRightSide, "correct");
  assert.equal(numericRightSide.should_finish, false);
  assert.match(numericRightSide.valid_progress || "", /divides both sides/i);
  assert.doesNotMatch(numericRightSide.local_error || "", /not equivalent/i);

  const powerRightSide = deterministicVerify(session, "(10^x)^2 = 10^4");
  assertStatus(powerRightSide, "correct");
  assert.equal(powerRightSide.should_finish, false);
  assert.match(powerRightSide.suggested_next_check || "", /power-of-a-power/i);
});

test("power equation gives local feedback for power-of-power mistake", () => {
  const session = makeSession({
    problem: "Solve $10(10^x)^2=10^5$.",
    workState: {
      acceptedLines: ["10(10^x)^2 = 10^5", "(10^x)^2 = 10^4"],
      lastValidLine: "(10^x)^2 = 10^4",
      rejectedLines: [],
    },
  });

  const correctReduction = deterministicVerify(session, "10^x = 10^2");
  assertStatus(correctReduction, "correct");
  assert.equal(correctReduction.should_finish, false);
  assert.match(correctReduction.valid_progress || "", /power-of-a-power/i);
  assert.match(correctReduction.suggested_next_check || "", /compare the exponents/i);

  const wrongReduction = deterministicVerify(session, "x^2 = 4");
  assertStatus(wrongReduction, "incorrect");
  assert.match(wrongReduction.local_error || "", /multiplies exponents/i);
  assert.match(wrongReduction.local_error || "", /not \$x\^2\$/i);
  assert.doesNotMatch(wrongReduction.local_error || "", /not equivalent/i);
});

test("quadratic inequality factorization is accepted as progress", () => {
  const session = makeSession({
    problem: "Solve the inequality x^2 - x <= 0.",
    workState: {
      acceptedLines: ["x^2 - x <= 0"],
      lastValidLine: "x^2 - x <= 0",
    },
  });

  const factored = deterministicVerify(session, "x(x - 1) <= 0");
  assertStatus(factored, "correct");
  assert.equal(factored.should_finish, false);
  assert.match(factored.valid_progress || "", /correct factorization/i);
  assert.match(factored.suggested_next_check || "", /where each factor is zero/i);

  const wrongFactor = deterministicVerify(session, "x(x + 1) <= 0");
  assertStatus(wrongFactor, "incorrect");
  assert.match(wrongFactor.local_error || "", /does not match/i);
});

test("power factor prose can target only the numerator", () => {
  const session = makeSession({
    problem:
      "The expression \\frac{2^{2010}+2^{2008}}{2^{2005}-2^{2003}} is equivalent to what common fraction?",
  });

  const numeratorOnly = deterministicVerify(session, "take out 2^2008 from numerator");
  assertStatus(numeratorOnly, "correct");
  assert.match(numeratorOnly.valid_progress || "", /numerator/i);

  const commonFactor = deterministicVerify(
    session,
    "factor out 2^2008 from numerator and denominator"
  );
  assertStatus(commonFactor, "incorrect");
  assert.match(commonFactor.local_error || "", /numerator and denominator/i);
});

test("factorial inequality greatest-integer answers are checked directly", () => {
  const session = makeSession({
    problem: "What is the greatest integer n for which n!(n - 1)! < 5000?",
  });

  const tooSmall = deterministicVerify(session, "3");
  assertStatus(tooSmall, "incorrect");
  assert.equal(tooSmall.should_finish, false);
  assert.match(tooSmall.local_error || "", /not the greatest/i);

  const correct = deterministicVerify(session, "n = 5");
  assertStatus(correct, "correct");
  assert.equal(correct.intent, "final_answer");
  assert.equal(correct.should_finish, true);

  const tooLarge = deterministicVerify(session, "6");
  assertStatus(tooLarge, "incorrect");
  assert.match(tooLarge.local_error || "", /does not satisfy/i);
});

test("factorial product identities are accepted before numeric factorial claims", () => {
  const session = makeSession({
    problem: "What is the value of n for which n! * 23! = 24!?",
  });

  const identity = deterministicVerify(session, "24! = 24 \\cdot 23!");
  assertStatus(identity, "correct");
  assert.match(identity.valid_progress || "", /factorial identity/i);
  assert.doesNotMatch(identity.local_error || "", /620448401733239439360000|not 24/i);
  assert.equal(verifyProblemRelevance(session, "24! = 24 * 23!"), null);

  const unicodeIdentity = deterministicVerify(session, "24! = 24 · 23!");
  assertStatus(unicodeIdentity, "correct");

  const astIdentity = deterministicVerify(session, "24! = 24\\ast23!");
  assertStatus(astIdentity, "correct");

  const wrongAdjacentFactor = deterministicVerify(session, "24! = 23 * 23!");
  assertStatus(wrongAdjacentFactor, "incorrect");
  assert.match(wrongAdjacentFactor.local_error || "", /not equal/i);

  const wrongIntermediateAsFinal = deterministicVerify(session, "n = 24");
  assertStatus(wrongIntermediateAsFinal, "incorrect");
  assert.equal(wrongIntermediateAsFinal.should_finish, false);

  const exploratoryWrong = deterministicVerify(session, "we need to find n for which n = 24");
  assertStatus(exploratoryWrong, "incorrect");
  assert.equal(exploratoryWrong.should_finish, false);

  const finalAnswer = deterministicVerify(session, "n = 4");
  assertStatus(finalAnswer, "correct");
  assert.equal(finalAnswer.intent, "final_answer");
  assert.equal(finalAnswer.should_finish, true);
});

test("direct combinatorics equation claims require the whole message", () => {
  assert.equal(verifyFactorialClaim("24! = 24 * 23!"), null);
  assert.equal(verifyCombinationClaim("8 c 2 = 28 * 2"), null);
  assert.equal(verifyPermutationClaim("5 p 2 = 20 + 1"), null);

  assertStatus(verifyFactorialClaim("5! = 120"), "correct");
  assertStatus(verifyCombinationClaim("8 c 2 = 28"), "correct");
  assertStatus(verifyPermutationClaim("5 p 2 = 20"), "correct");
});

test("digit-rate total error gives only local correction", () => {
  const session = makeSession({
    problem:
      "Steve will write the list of consecutive integers, starting with 1, at the speed of 5 digits per second. What will be the sum of the final two digits he writes on his list at the end of 10 seconds?",
  });

  const wrongTotal = deterministicVerify(session, "Steve writes a total of 40 digits");
  assertStatus(wrongTotal, "incorrect");
  assert.match(wrongTotal.local_error || "", /\$5\\times 10\$/);
  assert.doesNotMatch(wrongTotal.suggested_next_check || "", /subtract|one-digit|final two/i);

  const correctTotal = deterministicVerify(session, "Steve writes a total of 50 digits");
  assertStatus(correctTotal, "correct");
  assert.equal(correctTotal.should_finish, false);
  assert.doesNotMatch(correctTotal.suggested_next_check || "", /final two digits/i);

  const typoTotal = deterministicVerify(session, "Steve rwites 50 total dgiits");
  assertStatus(typoTotal, "correct");
  assert.equal(typoTotal.should_finish, false);
  assert.doesNotMatch(typoTotal.suggested_next_check || "", /final two digits/i);
});

test("target-mean deviation setup accepts known score offsets", () => {
  const session = makeSession({
    problem:
      "Al has scores of 92, 87, 89, 90, and 85 on his mathematics exams. What must he score on the next exam in order to have a mean test score of 90?",
  });

  const sumSetup = deterministicVerify(
    session,
    "the sum of the 6 scores with Al's next test score being x is 92 + 87 + 89 + 90 + 85 + x = 443 + x"
  );
  assertStatus(sumSetup, "correct");
  assert.equal(sumSetup.should_finish, false);
  assert.match(sumSetup.valid_progress || "", /\$443\+x\$/);
  assert.match(sumSetup.suggested_next_check || "", /mean equation/i);

  const wrongSum = deterministicVerify(
    session,
    "the sum of the 6 scores with Al's next test score being x is 92 + 87 + 89 + 90 + 85 + x = 442 + x"
  );
  assertStatus(wrongSum, "incorrect");
  assert.match(wrongSum.local_error || "", /\$443\+x\$/);
  assert.doesNotMatch(wrongSum.suggested_next_check || "", /mean equation|solve for|subtract 443/i);

  const wrongDirectTotal = deterministicVerify(session, "total is 442 + x");
  assertStatus(wrongDirectTotal, "incorrect");
  assert.match(wrongDirectTotal.local_error || "", /\$443\+x\$/);
  assert.doesNotMatch(wrongDirectTotal.suggested_next_check || "", /mean equation|solve for|subtract 443/i);

  const wrongDirectTotalResponse = composeCoachResponse(wrongDirectTotal);
  assert.match(wrongDirectTotalResponse, /\$443\+x\$/);
  assert.doesNotMatch(wrongDirectTotalResponse, /mean equation|solve for|subtract 443/i);

  const isolatedFinal = deterministicVerify(
    makeSession({
      ...session,
      workState: {
        acceptedLines: ["443 + x = 540"],
        lastValidLine: "443 + x = 540",
        rejectedLines: [],
      },
    }),
    "x = 97"
  );
  assertStatus(isolatedFinal, "correct");
  assert.equal(isolatedFinal.intent, "final_answer");
  assert.equal(isolatedFinal.should_finish, true);

  const proseFinal = deterministicVerify(session, "the answer is 97");
  assertStatus(proseFinal, "correct");
  assert.equal(proseFinal.should_finish, true);

  const wrongFinal = deterministicVerify(session, "x = 96");
  assertStatus(wrongFinal, "incorrect");
  assert.equal(wrongFinal.should_finish, false);

  const deviationSetup = deterministicVerify(
    session,
    "when subtracting the average of 90 from each of the 6 scores we have: 2, -3, -1, 0, -5, and x - 90"
  );
  assertStatus(deviationSetup, "correct");
  assert.equal(deviationSetup.should_finish, false);
  assert.match(deviationSetup.suggested_next_check || "", /add to \$0\$/i);

  const wrongDeviation = deterministicVerify(
    session,
    "when subtracting the average of 90 from each of the 6 scores we have: 2, -2, -1, 0, -5, and x - 90"
  );
  assertStatus(wrongDeviation, "incorrect");
  assert.match(wrongDeviation.local_error || "", /deviations/i);
});

test("cents-per-good-item setup accepts total cents over accepted count", () => {
  const session = makeSession({
    problem:
      "Marcy bought 120 apples for $24. When she got home, she discovered that 1/5 of the apples were rotten. If she figures she spent the $24 on only the good apples how many cents did each good apple actually cost?",
    workState: {
      acceptedLines: ["good apples = (4/5) * 120 = 96"],
      lastValidLine: "good apples = (4/5) * 120 = 96",
      rejectedLines: [],
    },
  });

  const plainFraction = deterministicVerify(session, "2400/96");
  assertStatus(plainFraction, "correct");
  assert.equal(plainFraction.intent, "submitted_work");
  assert.equal(plainFraction.should_finish, false);
  assert.match(plainFraction.valid_progress || "", /total cents/i);
  assert.match(plainFraction.suggested_next_check || "", /evaluate/i);

  const latexFraction = deterministicVerify(session, "\\frac{2400}{96}");
  assertStatus(latexFraction, "correct");
  assert.equal(latexFraction.should_finish, false);
});

test("standalone numeric follow-up checks the previous accepted arithmetic expression", () => {
  const session = makeSession({
    problem:
      "Marcy bought 120 apples for $24. When she got home, she discovered that 1/5 of the apples were rotten. If she figures she spent the $24 on only the good apples how many cents did each good apple actually cost?",
    workState: {
      acceptedLines: ["good apples = (4/5) * 120 = 96", "2400/96"],
      lastValidLine: "2400/96",
      rejectedLines: [],
    },
  });

  const wrongEvaluation = deterministicVerify(session, "40");
  assertStatus(wrongEvaluation, "incorrect");
  assert.match(wrongEvaluation.local_error || "", /previous accepted expression/i);
  assert.match(wrongEvaluation.suggested_next_check || "", /Recompute/i);

  const finalValue = deterministicVerify(session, "25");
  assertStatus(finalValue, "correct");
  assert.equal(finalValue.intent, "final_answer");
  assert.equal(finalValue.should_finish, true);

  const finalAfterEquality = deterministicVerify(
    makeSession({
      ...session,
      workState: {
        acceptedLines: ["good apples = (4/5) * 120 = 96", "2400/96", "2400/96 = 25"],
        lastValidLine: "2400/96 = 25",
        rejectedLines: [],
      },
    }),
    "25"
  );
  assertStatus(finalAfterEquality, "correct");
  assert.equal(finalAfterEquality.intent, "final_answer");
  assert.equal(finalAfterEquality.should_finish, true);
});

test("decimal multiplication sequence gets local order feedback and accepts its evaluation", () => {
  const session = makeSession({
    problem:
      "If the temperature is 36 degrees and the wind speed is 18, find the adjusted value using 36 - 0.7 times the wind speed.",
    solutionGuide: {
      finalAnswer: "23.4",
      confidence: 1,
    },
    solutionGuideStatus: "ready",
    workState: {
      acceptedLines: ["36 - 0.7 * 18"],
      lastValidLine: "36 - 0.7 * 18",
      rejectedLines: [],
    },
  });

  const misplacedMultiplication = deterministicVerify(session, "35.3 * 18");
  assertStatus(misplacedMultiplication, "incorrect");
  assert.match(misplacedMultiplication.local_error || "", /subtracted 0\.7.*before multiplying/i);
  assert.match(misplacedMultiplication.suggested_next_check || "", /0\.7\\cdot 18 first/i);
  assert.doesNotMatch(misplacedMultiplication.suggested_next_check || "", /12\.6|23\.4/);

  session.workState.acceptedLines.push("36 - 12.6");
  session.workState.lastValidLine = "36 - 12.6";
  const evaluated = deterministicVerify(session, "23.4");
  assertStatus(evaluated, "correct");
  assert.equal(evaluated.intent, "final_answer");
  assert.equal(evaluated.should_finish, true);
});

test("expanded divisor without grouping gets local denominator feedback", () => {
  const session = makeSession({
    problem:
      "A spacecraft traveled 292525163 miles in 6.5 months. Find its average speed in miles per hour.",
    workState: {
      acceptedLines: ["292525163 / 6.5"],
      lastValidLine: "292525163 / 6.5",
      rejectedLines: [],
    },
  });

  const result = deterministicVerify(
    session,
    "292525163 / 6.5 * 30 * 24"
  );
  assertStatus(result, "incorrect");
  assert.match(result.local_error || "", /multiplication after the slash/i);
  assert.match(result.local_error || "", /not all in the denominator/i);
  assert.match(result.suggested_next_check || "", /group the full product/i);
  assert.doesNotMatch(
    result.suggested_next_check || "",
    /4680|292525163\s*\/\s*\(/
  );
});

test("prose remainder claims with grouped numbers are verified directly", () => {
  const correct = deterministicVerify(
    makeSession(),
    "8,514,013 leaves a remainder of 1 when divided by 6"
  );
  assertStatus(correct, "correct");
  assert.match(correct.valid_progress || "", /remainder/i);

  const incorrect = deterministicVerify(
    makeSession(),
    "8,514,013 leaves a remainder of 2 when divided by 6"
  );
  assertStatus(incorrect, "incorrect");
  assert.match(incorrect.local_error || "", /is 1, not 2/i);
});

test("changed word-problem quantity labels receive semantic review", async () => {
  const session = makeSession({
    problem:
      "Harold ate 1/4 of a pie. A moose ate 1/3 of what Harold left. A porcupine ate 1/3 of what the moose left. What fraction remains?",
    workState: {
      acceptedLines: ["fraction after Harold = 3/4"],
      lastValidLine: "fraction after Harold = 3/4",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "1/3",
      confidence: 1,
    },
  });
  let semanticChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "After moose = 1 - 1/3 * 3/4",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      semanticChecks += 1;
      return {
        intent: "submitted_work",
        status: "incorrect",
        local_error:
          "The moose eats from the 3/4 that remained, not from a whole pie.",
        valid_progress: null,
        suggested_next_check:
          "Start with 3/4 and subtract one-third of that amount.",
        should_finish: false,
        confidence: 0.98,
        source: "llm",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assert.equal(semanticChecks, 1);
  assertStatus(result, "incorrect");
  assert.match(result.local_error || "", /not from a whole pie/i);
});

test("labeled range-sum evaluation anchors standalone numeric follow-up", () => {
  const session = makeSession({
    problem: "Find the sum of the integers from 1 to 25.",
    workState: {
      acceptedLines: ["sum of 1-25 is 25 * 26 / 2"],
      lastValidLine: "sum of 1-25 is 25 * 26 / 2",
      rejectedLines: [],
    },
  });

  const labeledEvaluation = deterministicVerify(session, "sum of 1-25 is 325");
  assertStatus(labeledEvaluation, "correct");
  assert.equal(labeledEvaluation.intent, "submitted_work");
  assert.match(labeledEvaluation.valid_progress || "", /numeric rewrite|equivalence/i);

  const standaloneEvaluation = deterministicVerify(session, "325");
  assertStatus(standaloneEvaluation, "correct");
  assert.equal(standaloneEvaluation.intent, "submitted_work");
  assert.equal(standaloneEvaluation.should_finish, false);
  assert.match(standaloneEvaluation.valid_progress || "", /previous accepted/i);

  const wrongEvaluation = deterministicVerify(session, "300");
  assertStatus(wrongEvaluation, "incorrect");
  assert.match(wrongEvaluation.local_error || "", /previous accepted expression/i);
});

test("standalone numeric follow-up solves general dollar amount questions", () => {
  const session = makeSession({
    problem:
      "Bob makes $8 an hour at his job. For any work over 40 hours during a week, he makes twice that rate. How many dollars does Bob make in a week during which he works 45 hours?",
    workState: {
      acceptedLines: ["8 * 40 + 16 * 5", "8 * 50"],
      lastValidLine: "8 * 50",
      rejectedLines: [],
    },
  });

  const wrongEvaluation = deterministicVerify(session, "5400");
  assertStatus(wrongEvaluation, "incorrect");
  assert.match(wrongEvaluation.local_error || "", /previous accepted expression/i);

  const finalValue = deterministicVerify(session, "400");
  assertStatus(finalValue, "correct");
  assert.equal(finalValue.intent, "final_answer");
  assert.equal(finalValue.should_finish, true);

  const finalWithCurrency = deterministicVerify(
    makeSession({
      ...session,
      workState: {
        acceptedLines: ["8 * 40 + 16 * 5", "8 * 50", "400"],
        lastValidLine: "400",
        rejectedLines: [],
      },
    }),
    "$400"
  );
  assertStatus(finalWithCurrency, "correct");
  assert.equal(finalWithCurrency.intent, "final_answer");
  assert.equal(finalWithCurrency.should_finish, true);

  const finalWithUnit = deterministicVerify(session, "400 dollars");
  assertStatus(finalWithUnit, "correct");
  assert.equal(finalWithUnit.intent, "final_answer");
  assert.equal(finalWithUnit.should_finish, true);
});

test("standalone subtotal cannot solve when checked final answer differs", () => {
  const session = makeSession({
    problem:
      "A standard six-sided die was rolled 50 times, and the outcomes are shown in a table. What is the average of the 50 outcomes? Express your answer as a decimal to the nearest hundredth.",
    solutionGuide: {
      finalAnswer: "3.24",
      confidence: 1,
    },
    solutionGuideStatus: "ready",
    workState: {
      acceptedLines: [
        "The sum of the rolls is 1*4 + 2*5 + 3*9 + 4*7 + 5*7 + 6*8",
        "49 + 13 + 40 + 5 + 27 + 28",
      ],
      lastValidLine: "49 + 13 + 40 + 5 + 27 + 28",
      rejectedLines: [],
    },
  });

  const result = deterministicVerify(session, "162");
  assertStatus(result, "correct");
  assert.notEqual(result.intent, "final_answer");
  assert.equal(result.should_finish, false);
});

test("arithmetic equality can anchor to previous accepted expression value", () => {
  const session = makeSession({
    problem:
      "What is the value of a number with digits 12, 15, and 8 in the indicated places?",
    workState: {
      acceptedLines: ["The sum would be 100*12+10*15+1*8"],
      lastValidLine: "The sum would be 100*12+10*15+1*8",
      rejectedLines: [],
    },
  });

  const result = deterministicVerify(session, "1200 + 150 + 8 = 1358");
  assertStatus(result, "correct");
  assert.match(result.valid_progress || "", /arithmetic equality/i);
  assert.equal(result.should_finish, false);
});

test("floor equality evaluates the floor before comparing both sides", () => {
  const session = makeSession({
    problem:
      "A machine has 350 milliliters and each full mug uses 20 milliliters. How many full mugs can it fill?",
    solutionGuide: {
      finalAnswer: "17",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
    workState: {
      acceptedLines: ["\\left\\lfloor M/r\\right\\rfloor"],
      lastValidLine: "\\left\\lfloor M/r\\right\\rfloor",
      rejectedLines: [],
    },
  });

  const result = verifyCanonicalNumericClaim(
    session,
    "\\left\\lfloor\\frac{350}{20}\\right\\rfloor=17"
  );
  assert.ok(result);
  assert.notEqual(result.status, "incorrect");
  assert.match(result.valid_progress || "", /matches the checked answer/i);
});

test("chained arithmetic equality can simplify expression from previous step", () => {
  const session = makeSession({
    problem: "What is $\\frac{1}{28}$ of the number of hours in one week?",
    workState: {
      acceptedLines: ["hours in one week = 7 * 24 = 168"],
      lastValidLine: "hours in one week = 7 * 24 = 168",
      rejectedLines: [],
    },
  });

  const result = deterministicVerify(session, "\\frac{1}{28} * 168 = \\frac{168}{28} = 6");
  assertStatus(result, "correct");
  assert.match(result.valid_progress || "", /arithmetic equality/i);
  assert.equal(result.should_finish, false);
});

test("chained arithmetic equality evaluates numeric factorials", () => {
  const session = makeSession({
    problem:
      "In how many ways can 6 juniors and 6 seniors form 3 teams of 4 people with 2 juniors and 2 seniors on each team?",
    workState: {
      acceptedLines: ["90\\cdot90=8100"],
      lastValidLine: "90\\cdot90=8100",
      rejectedLines: [],
    },
  });

  const result = deterministicVerify(
    session,
    "\\frac{8100}{3!}=\\frac{8100}{6}=1350"
  );

  assertStatus(result, "correct");
  assert.match(result.valid_progress || "", /arithmetic equality/i);
  assert.equal(result.should_finish, false);
});

test("standalone number after accepted final equality solves numeric expression problem", () => {
  const session = makeSession({
    problem: "What is $\\frac{1}{28}$ of the number of hours in one week?",
    workState: {
      acceptedLines: ["hours in one week = 7 * 24 = 168", "\\frac{168}{28} = 6"],
      lastValidLine: "\\frac{168}{28} = 6",
      rejectedLines: [],
    },
  });

  const result = deterministicVerify(session, "6");
  assertStatus(result, "correct");
  assert.equal(result.intent, "final_answer");
  assert.equal(result.should_finish, true);
});

test("consecutive range sum rejects triangular formula for non-one start", () => {
  const session = makeSession({
    problem: "Find the sum of the leftover integers.",
    workState: {
      acceptedLines: ["leftovers => 101 + 102 + ... + 110"],
      lastValidLine: "leftovers => 101 + 102 + ... + 110",
      rejectedLines: [],
    },
  });

  const wrongFormula = deterministicVerify(session, "sum = 110 * 111 / 2");
  assertStatus(wrongFormula, "incorrect");
  assert.match(wrongFormula.local_error || "", /listed consecutive range/i);
  assert.match(wrongFormula.suggested_next_check || "", /first term, last term/i);

  const correctFormula = deterministicVerify(session, "sum = (101 + 110) * 10 / 2");
  assertStatus(correctFormula, "correct");
  assert.match(correctFormula.valid_progress || "", /listed consecutive range/i);
  assert.equal(correctFormula.should_finish, false);
});

test("numeric assignment rewrite gives arithmetic feedback instead of algebra feedback", () => {
  const session = makeSession({
    problem:
      "A student computes a net amount N by subtracting two costs from a product.",
    workState: {
      acceptedLines: ["N = (6 * 6.25) - (15.50 + 14.25)"],
      lastValidLine: "N = (6 * 6.25) - (15.50 + 14.25)",
      rejectedLines: [],
    },
  });

  const wrongRewrite = deterministicVerify(session, "N = (37.50) - (19.75)");
  assertStatus(wrongRewrite, "incorrect");
  assert.match(wrongRewrite.local_error || "", /numeric simplification|right side/i);
  assert.match(wrongRewrite.suggested_next_check || "", /Recompute/i);
  assert.doesNotMatch(wrongRewrite.suggested_next_check || "", /same operation|both sides/i);

  const correctRewrite = deterministicVerify(session, "N = (37.50) - (29.75)");
  assertStatus(correctRewrite, "correct");
  assert.match(correctRewrite.valid_progress || "", /previous accepted line/i);
  assert.equal(correctRewrite.should_finish, false);
});

test("compact latex fraction rewrite with trailing variable stays equivalent", async () => {
  const session = makeSession({
    problem: "Simplify the right-hand side of the equation.",
    workState: {
      acceptedLines: ["\\frac35j = \\frac23(\\frac67s)"],
      lastValidLine: "\\frac35j = \\frac23(\\frac67s)",
      rejectedLines: [],
    },
  });

  const unsimplified = deterministicVerify(session, "\\frac35j = \\frac{12}{21}s");
  assertStatus(unsimplified, "correct");
  assert.match(unsimplified.valid_progress || "", /equivalent/i);

  const simplified = await runVerifierRegistry({
    session,
    message: "\\frac35j = \\frac47s",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => ({
      intent: "submitted_work",
      status: "uncertain",
      local_error: null,
      valid_progress: null,
      suggested_next_check: null,
      should_finish: false,
      confidence: 0.2,
      source: "model",
    }),
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal,
  });
  assertStatus(simplified, "correct");
  assert.match(simplified.valid_progress || "", /equivalent|correct/i);
});

test("registry asks model for contextual numeric setup before generic equivalence rejection", async () => {
  const session = makeSession({
    problem:
      "Marcy bought 120 apples for $24. When she got home, she discovered that 1/5 of the apples were rotten. If she figures she spent the $24 on only the good apples how many dollars did each good apple actually cost?",
    workState: {
      acceptedLines: ["good apples = (4/5) * 120 = 96"],
      lastValidLine: "good apples = (4/5) * 120 = 96",
      rejectedLines: [],
    },
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "24/96",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That setup divides the total dollars by the number of good apples.",
        suggested_next_check: "Now evaluate that division.",
        should_finish: false,
        confidence: 0.93,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.source, "model");
  assert.equal(modelChecks, 1);
  assert.doesNotMatch(result.local_error || "", /not equivalent/i);
});

test("image-backed visual cell counts receive semantic verification", async () => {
  const session = makeSession({
    problem:
      "The eight-pointed star shown in the figure is a popular quilting pattern. What percent of the entire 4 x 4 grid is covered by the star?",
    problemImage: {
      imageBase64: "test-image",
      mimeType: "image/png",
    },
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "4 full squares + 8 half squares are covered",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That visual decomposition matches the star.",
        suggested_next_check: "Use those pieces to find the covered fraction of the grid.",
        should_finish: false,
        confidence: 0.96,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.source, "model");
  assert.equal(modelChecks, 1);
});

test("image-backed compact coordinate setups receive semantic verification", async () => {
  const session = makeSession({
    problem:
      "The street map is shown below. Betty starts at factory F, drives to A, then B, then C, and returns to F. What is the shortest distance?",
    problemImage: {
      imageBase64: "test-image",
      mimeType: "image/png",
    },
    solutionGuide: {
      finalAnswer: "24",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "B=(0,0); C=(2,4); F=(6,5); A=(7,3)",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "Those coordinates match the grid.",
        suggested_next_check: "Use them in the next distance calculation.",
        should_finish: false,
        confidence: 0.96,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal,
  });

  assertStatus(result, "correct");
  assert.equal(result.intent, "submitted_work");
  assert.equal(result.should_finish, false);
  assert.equal(result.source, "model");
  assert.equal(modelChecks, 1);
});

test("coordinate setup feedback does not request an assignment already supplied", async () => {
  const session = makeSession({
    problem:
      "The street map is shown below. Betty starts at factory F, drives to A, then B, then C, and returns to F. What is the shortest distance?",
    problemImage: {
      imageBase64: "test-image",
      mimeType: "image/png",
    },
  });

  const result = await runVerifierRegistry({
    session,
    message: "Assigning coordinates, B=(0,0)C=(2,4)F=(6,5)A=(7,3)",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => ({
      intent: "submitted_work",
      status: "partially_correct",
      local_error: null,
      valid_progress: "That coordinate setup is reasonable.",
      suggested_next_check: "Give the corrected coordinate for A.",
      should_finish: false,
      confidence: 0.94,
      source: "model",
    }),
    applyConservativePolicy,
    requireEvaluationForUnevaluatedFinal,
  });

  assertStatus(result, "correct");
  assert.match(result.valid_progress || "", /coordinate assignments/i);
  assert.doesNotMatch(result.suggested_next_check || "", /coordinate for A/i);
  assert.match(result.suggested_next_check || "", /distance calculation/i);
});

test("image-backed arithmetic from an accepted visual count stays semantic", async () => {
  const session = makeSession({
    problem:
      "The eight-pointed star shown in the figure is a popular quilting pattern. What percent of the entire 4 x 4 grid is covered by the star?",
    problemImage: {
      imageBase64: "test-image",
      mimeType: "image/png",
    },
    workState: {
      acceptedLines: ["4 full squares + 8 half squares are covered"],
      lastValidLine: "4 full squares + 8 half squares are covered",
      rejectedLines: [],
    },
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "((4*1)+(8*1/2))/16*100",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "partially_correct",
        local_error: null,
        valid_progress: "That expression uses your accepted visual count correctly.",
        suggested_next_check: "Evaluate the expression.",
        should_finish: false,
        confidence: 0.96,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "partially_correct");
  assert.equal(result.source, "model");
  assert.equal(modelChecks, 1);
});

test("bare value after an accepted percent expression requests percent form", () => {
  const session = makeSession({
    problem: "What percent of the entire 4 x 4 grid is covered by the star?",
    solutionGuide: {
      finalAnswer: "50%",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
    workState: {
      acceptedLines: ["((4*1)+(8*1/2))/16*100"],
      lastValidLine: "((4*1)+(8*1/2))/16*100",
      rejectedLines: [],
    },
  });

  const result = verifyCanonicalNumericClaim(session, "50");

  assertStatus(result, "partially_correct");
  assert.equal(result.should_finish, false);
  assert.match(result.suggested_next_check || "", /as a percent/i);
});

test("image-backed expression accepts OCR-near restatement without model", async () => {
  const session = makeSession({
    problem:
      "Compute and express your answer as a common fraction: 5 / (5 + 5 / (5 + 5/5))",
    problemImage: {
      imageBase64: "test-image",
      mimeType: "image/png",
    },
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "\\frac{5}{5+\\frac{5}{5+\\frac{1}{5}}}",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "partially_correct",
        local_error: null,
        valid_progress: "That matches the expression in the image.",
        suggested_next_check: "Simplify the innermost denominator first.",
        should_finish: false,
        confidence: 0.9,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assert.equal(modelChecks, 0);
  assertStatus(result, "partially_correct");
  assert.equal(result.source, "deterministic");
  assert.doesNotMatch(result.local_error || "", /not equivalent/i);
});

test("image-backed expression handles OCR-near restatement before model uncertainty", async () => {
  const session = makeSession({
    problem:
      "Compute and express your answer as a common fraction: 5 / (5 + 5 / (5 + 5/5))",
    problemImage: {
      imageBase64: "test-image",
      mimeType: "image/png",
    },
  });

  const result = await runVerifierRegistry({
    session,
    message: "\\frac{5}{5+\\frac{5}{5+\\frac{1}{5}}}",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => ({
      intent: "submitted_work",
      status: "uncertain",
      local_error: null,
      valid_progress: null,
      suggested_next_check: "I am not fully sure that follows yet. Can you show one intermediate step?",
      should_finish: false,
      confidence: 0.5,
      source: "model",
    }),
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "partially_correct");
  assert.equal(result.source, "deterministic");
  assert.doesNotMatch(result.local_error || "", /not equivalent/i);
  assert.doesNotMatch(result.suggested_next_check || "", /transformation in that fraction/i);
});

test("image-backed OCR-near expression restatement becomes a simplification anchor", () => {
  const session = makeSession({
    problem:
      "Compute and express your answer as a common fraction: 5 / (5 + 5 / (5 + 5/5))",
    problemImage: {
      imageBase64: "test-image",
      mimeType: "image/png",
    },
  });

  const restatement = "\\frac{5}{5+\\frac{5}{5+\\frac{1}{5}}}";
  const first = deterministicVerify(session, restatement);
  assertStatus(first, "partially_correct");
  assert.match(first.valid_progress || "", /expression structure from the image/i);

  const anchoredSession = makeSession({
    ...session,
    workState: {
      acceptedLines: [restatement],
      lastValidLine: restatement,
      rejectedLines: [],
    },
  });

  const next = deterministicVerify(
    anchoredSession,
    "\\frac{5}{5+\\frac{5}{\\frac{26}{5}}}"
  );
  assertStatus(next, "partially_correct");
  assert.doesNotMatch(next.suggested_next_check || "", /one intermediate|single line/i);
});

test("typo-tolerant prose normalization supports verifier vocabulary only", () => {
  const normalized = normalizeStudentProseTypos("x=4/3 and Steve rwites 50 total dgiits");
  assert.equal(normalized.text, "x=4/3 and Steve writes 50 total digits");

  const factorList = normalizeStudentProseTypos("The factors of 6 are 1, 2, 3, 6");
  assert.equal(factorList.text, "The factors of 6 are 1, 2, 3, 6");
  assert.deepEqual(factorList.corrections, []);

  const triangleClaim = normalizeStudentProseTypos(
    "There are 4 small triangles after dividing the triangle"
  );
  assert.equal(
    triangleClaim.text,
    "There are 4 small triangles after dividing the triangle"
  );
  assert.deepEqual(triangleClaim.corrections, []);

  const finalClaim = parseClaim("anwser is 42");
  assert.equal(finalClaim.kind, "final_answer");
  assert.equal(finalClaim.normalized, "42");

  const factorClaim = parseClaim("factro out 2^2008 from numrator");
  assert.equal(factorClaim.kind, "factor_claim");
  assert.equal(factorClaim.allowSymbolicFallback, false);

  const expressionClaim = parseClaim("x=4/3");
  assert.equal(expressionClaim.kind, "equation");
  assert.equal(expressionClaim.normalized, "x=4/3");
});

test("deterministic verifier accepts close typos in prose claims", () => {
  const fractionSession = makeSession({
    problem: "\\frac{1}{2}x=128",
  });
  const multiply = deterministicVerify(fractionSession, "mutliply both sides by 2");
  assertStatus(multiply, "correct");

  const factorSession = makeSession({
    problem:
      "The expression \\frac{2^{2010}+2^{2008}}{2^{2005}-2^{2003}} is equivalent to what common fraction?",
  });
  const factor = deterministicVerify(factorSession, "take out 2^2008 from numrator");
  assertStatus(factor, "correct");

  const nearestOddSession = makeSession({
    problem:
      "Given any positive even integer, x, the positive difference between the smallest odd number greater than 7x - 2 and the largest odd number less than 3x + 5 can be written in the form ax + b. What is a + b?",
  });
  const nearestOdd = deterministicVerify(
    nearestOddSession,
    "the smalest odd greater than 7x - 2 is 7x - 1 and the largets odd less than 3x + 5 is 3x + 3"
  );
  assertStatus(nearestOdd, "correct");
});

test("uncertain typoed work asks for a rewrite instead of vague next step", () => {
  const uncertain = {
    intent: "unclear",
    status: "uncertain",
    local_error: null,
    valid_progress: null,
    suggested_next_check: null,
    should_finish: false,
    confidence: 0.2,
    source: "model",
  };

  const typoResponse = composeCoachResponse(uncertain, {
    studentMessage: "mutliply by teh avrage",
  });
  assert.match(typoResponse, /misreading a typo/i);
  assert.match(typoResponse, /rewrite the step/i);

  const genericResponse = composeCoachResponse(uncertain, {
    studentMessage: "this follows from the previous line",
  });
  assert.match(genericResponse, /not sure what this line means/i);
  assert.match(genericResponse, /one intermediate equation/i);

  const proseClaimResponse = composeCoachResponse(uncertain, {
    studentMessage: "There are 4 small triangles after dividing the triangle",
  });
  assert.doesNotMatch(proseClaimResponse, /misreading a typo/i);
  assert.match(proseClaimResponse, /not sure what this line means/i);
});

test("coach anchors back to the last valid line after repeated drift", () => {
  const uncertain = {
    intent: "unclear",
    status: "uncertain",
    local_error: null,
    valid_progress: null,
    suggested_next_check: "I cannot verify that from this line alone. Can you show one intermediate line?",
    should_finish: false,
    confidence: 0.2,
    source: "model",
  };

  const response = composeCoachResponse(uncertain, {
    hintLevel: 2,
    lastValidLine: "47 = 2L + 2W",
    recentRejectedLines: ["W = 8", "W = 10"],
    studentMessage: "then I got something else",
  });

  assert.match(response, /last line we know is valid/i);
  assert.match(response, /47 = 2L \+ 2W/);
  assert.match(response, /next local step/i);
});

test("coach does not anchor over specific local feedback", () => {
  const incorrect = {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "That width does not match the perimeter relationship.",
    valid_progress: null,
    suggested_next_check: "Use one inverse operation to keep isolating the unknown, then send that line.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };

  const response = composeCoachResponse(incorrect, {
    hintLevel: 3,
    lastValidLine: "47 = 2L + 2W",
    recentRejectedLines: ["W = 8", "W = 10"],
  });

  assert.match(response, /width does not match/i);
  assert.doesNotMatch(response, /last line we know is valid/i);
});

test("coach does not anchor accepted corrections or skipped steps", () => {
  const correct = {
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: "That percent-change setup uses the correct old and new values.",
    suggested_next_check: "Now evaluate that expression to get the percent increase.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };

  const response = composeCoachResponse(correct, {
    hintLevel: 3,
    lastValidLine: "increased from 6 to 13.5",
    recentRejectedLines: ["=((13 5/6)-1)*100%", "=(((13.6)/6)-1)*100%"],
  });

  assert.match(response, /percent-change setup/i);
  assert.doesNotMatch(response, /last line we know is valid/i);
});

test("concrete prose errors keep local model correction", () => {
  const corrected = applyConservativePolicy(
    {
      intent: "submitted_work",
      status: "incorrect",
      local_error: "That count does not match the diagram.",
      valid_progress: null,
      suggested_next_check: "Recount only the small triangles shown in the divided shape.",
      should_finish: false,
      confidence: 0.88,
      source: "model",
    },
    "There are 4 triangles"
  );

  assertStatus(corrected, "incorrect");
  assert.match(corrected.local_error || "", /count does not match/i);

  const response = composeCoachResponse(corrected);
  assert.match(response, /count does not match/i);
  assert.match(response, /Recount only the small triangles/i);
  assert.doesNotMatch(response, /one intermediate/i);

  const lowerConfidenceCount = applyConservativePolicy(
    {
      intent: "submitted_work",
      status: "incorrect",
      local_error: "That count does not match the figure.",
      valid_progress: null,
      suggested_next_check: "Recount each distinct triangle once.",
      should_finish: false,
      confidence: 0.74,
      source: "model",
    },
    "there are 4 triangles"
  );

  assertStatus(lowerConfidenceCount, "incorrect");
  assert.match(lowerConfidenceCount.local_error || "", /count does not match/i);
  assert.doesNotMatch(lowerConfidenceCount.suggested_next_check || "", /intermediate/i);

  const genericModelError = applyConservativePolicy(
    {
      intent: "submitted_work",
      status: "incorrect",
      local_error: "I cannot verify the error from this line alone.",
      valid_progress: null,
      suggested_next_check: "Can you show one intermediate line?",
      should_finish: false,
      confidence: 0.72,
      source: "model",
    },
    "there are 4 triangles"
  );

  assertStatus(genericModelError, "incorrect");
  assert.match(genericModelError.local_error || "", /cannot confirm that count/i);
  assert.match(genericModelError.suggested_next_check || "", /Recheck the count/i);
  assert.doesNotMatch(genericModelError.suggested_next_check || "", /intermediate/i);
});

test("coach repeated valid progress preserves student autonomy", () => {
  const correct = {
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: "That step is correct.",
    suggested_next_check: "Continue from this form and make the next useful step.",
    should_finish: false,
    confidence: 0.99,
    source: "symbolic",
  };

  const response = composeCoachResponse(correct, {
    hintLevel: 0,
    previousAssistantMessages: [
      "That step is correct. Continue from this form and make the next useful step.",
    ],
  });

  assert.match(response, /what would you try next/i);
  assert.doesNotMatch(response, /continue from this form|next useful step/i);
  assert.doesNotMatch(response, /intermediate step/i);
});

test("coach repeated positive fallback uses an open handoff", () => {
  const correct = {
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: "That numeric rewrite matches the original expression.",
    suggested_next_check: "Write just the equation or expression you are transforming next.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };

  const response = composeCoachResponse(correct, {
    hintLevel: 0,
    previousAssistantMessages: [
      "That numeric rewrite matches the original expression. Make the next useful simplification, then send that line.",
      "That numeric rewrite matches the original expression. Write just the equation or expression you are transforming next.",
    ],
  });

  assert.match(response, /what would you try next/i);
  assert.doesNotMatch(response, /combine or simplify|write just the equation/i);
  assert.doesNotMatch(response, /line immediately before/i);
  assert.doesNotMatch(response, /line after it/i);
});

test("coach keeps specific scaffolding after a student has needed help", () => {
  const correct = {
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: "That radius is correct.",
    suggested_next_check: "Use that radius to find the central circle's area.",
    should_finish: false,
    confidence: 1,
    source: "model",
  };

  const independentResponse = composeCoachResponse(correct, { hintLevel: 0 });
  assert.match(independentResponse, /what would you try next/i);
  assert.doesNotMatch(independentResponse, /find the central circle's area/i);

  const scaffoldedResponse = composeCoachResponse(correct, { hintLevel: 2 });
  assert.match(scaffoldedResponse, /find the central circle's area/i);
});

test("last-valid-line anchor does not repeat a revealing model next step", () => {
  const uncertain = {
    intent: "submitted_work",
    status: "uncertain",
    local_error: null,
    valid_progress: null,
    suggested_next_check: "Use $L+W=23.5$ to find $W$ and write that next line.",
    should_finish: false,
    confidence: 0.4,
    source: "model",
  };

  const response = composeCoachResponse(uncertain, {
    hintLevel: 2,
    lastValidLine: "L = 16",
    recentRejectedLines: ["W = 8", "W = 10"],
  });

  assert.match(response, /last line we know is valid/i);
  assert.match(response, /L = 16/);
  assert.doesNotMatch(response, /23\.5/);
});

test("model next-check wording does not reveal the next simplification result", () => {
  const response = composeCoachResponse({
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: "That correctly substitutes the given area and diagonal.",
    suggested_next_check:
      "Simplify the right-hand side expression $(14 \\cdot d)/2$ to $7d$.",
    should_finish: false,
    confidence: 0.93,
    source: "model",
  });

  assert.match(response, /What would you try next/i);
  assert.doesNotMatch(response, /Simplify the right-hand side/i);
  assert.doesNotMatch(response, /7d/i);

  const substitutedFormulaResponse = composeCoachResponse({
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress:
      "You correctly expressed the large rectangle's area as $A_{big}=10\\times16$.",
    suggested_next_check:
      "Now compute the shaded area using $A_{shaded}=\\frac{1}{4}A_{whole}$, i.e., evaluate $A_{shaded}=\\frac{1}{4}\\cdot160$.",
    should_finish: false,
    confidence: 0.93,
    source: "model",
  });

  assert.match(substitutedFormulaResponse, /What would you try next/i);
  assert.doesNotMatch(substitutedFormulaResponse, /Use the given fraction/i);
  assert.doesNotMatch(substitutedFormulaResponse, /160/);
  assert.doesNotMatch(substitutedFormulaResponse, /A_\{shaded\}=\\frac\{1\}\{4\}\\cdot160/);

  const perimeterShortcutResponse = composeCoachResponse({
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: "That identifies the length.",
    suggested_next_check:
      "Use $L+W=23.5$ to find $W$ and write that next line.",
    should_finish: false,
    confidence: 0.93,
    source: "model",
  });

  assert.doesNotMatch(perimeterShortcutResponse, /23\.5/);
  assert.match(perimeterShortcutResponse, /What would you try next/i);

  const incorrectPerimeterResponse = composeCoachResponse({
    intent: "submitted_work",
    status: "incorrect",
    local_error: "That width does not match the perimeter relationship.",
    valid_progress: null,
    suggested_next_check:
      "Use $L+W=23.5$ to find $W$ and write that next line.",
    should_finish: false,
    confidence: 0.91,
    source: "model",
  });

  assert.match(incorrectPerimeterResponse, /width does not match/i);
  assert.doesNotMatch(incorrectPerimeterResponse, /23\.5/);
  assert.match(incorrectPerimeterResponse, /inverse operation|next local simplification|isolating/i);

  const probabilityResponse = composeCoachResponse({
    intent: "submitted_work",
    status: "partially_correct",
    local_error: null,
    valid_progress: "Your count of 44 favorable cubes is correct.",
    suggested_next_check:
      "Compute the probability by placing your 44 favorable outcomes over the total 125 cubes and give the result as a common fraction: write $\\frac{44}{125}$.",
    should_finish: false,
    confidence: 0.93,
    source: "model",
  });

  assert.match(probabilityResponse, /favorable outcomes over total outcomes/i);
  assert.doesNotMatch(probabilityResponse, /125/);
  assert.doesNotMatch(probabilityResponse, /\\frac\{44\}\{125\}|44\/125/);

  const shortProbabilityResponse = composeCoachResponse({
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: null,
    suggested_next_check:
      "Express the probability as the fraction $\\frac{44}{125}$.",
    should_finish: false,
    confidence: 0.93,
    source: "model",
  });

  assert.match(shortProbabilityResponse, /What would you try next/i);
  assert.doesNotMatch(shortProbabilityResponse, /\\frac\{44\}\{125\}|44\/125/);

  const isolateRadiusResponse = composeCoachResponse({
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress:
      "You have the correct tangency equation $10=r(1+\\sqrt2)$ relating the small radius to the big radius.",
    suggested_next_check:
      "Isolate $r$ by dividing both sides by $1+\\sqrt2$ and write the next line $r=\\frac{10}{1+\\sqrt2}$.",
    should_finish: false,
    confidence: 0.93,
    source: "model",
  });

  assert.match(isolateRadiusResponse, /What would you try next/i);
  assert.doesNotMatch(isolateRadiusResponse, /r\s*=\s*\\frac\{10\}\{1\+\\sqrt2\}/);

  const parentheticalExampleResponse = composeCoachResponse({
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: "That recognizes the right triangle relation.",
    suggested_next_check:
      "Now give one more equation relating $a$ and $b$ using $S=\\sqrt{3}$ and $s=\\sqrt{2}$ (for example, state the relation $b=\\sqrt{3}-a$ or write the contact condition $\\frac{s}{2}(\\cos\\theta+\\sin\\theta)=\\frac{S}{2}$).",
    should_finish: false,
    confidence: 0.93,
    source: "model",
  });

  assert.match(parentheticalExampleResponse, /That recognizes the right triangle relation|reasonable step/i);
  assert.doesNotMatch(parentheticalExampleResponse, /for example|contact condition|cos|sin/i);
  assert.doesNotMatch(parentheticalExampleResponse, /b\s*=\s*\\sqrt\{3\}\s*-\s*a/);
  assert.match(parentheticalExampleResponse, /What would you try next/i);

  const exponentEquationResponse = composeCoachResponse({
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: "You correctly rewrote the equation with equal bases.",
    suggested_next_check:
      "Set the exponents equal: write the equation $x^3-3x^2-28x+60=0$.",
    should_finish: false,
    confidence: 0.93,
    source: "model",
  });

  assert.match(exponentEquationResponse, /What would you try next/i);
  assert.doesNotMatch(exponentEquationResponse, /x\^3-3x\^2-28x\+60=0/);

  const divideEquationResponse = composeCoachResponse({
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: "That equation matches the problem conditions.",
    suggested_next_check: "Divide the entire equation by 10 to simplify it.",
    should_finish: false,
    confidence: 0.93,
    source: "model",
  });

  assert.match(divideEquationResponse, /What would you try next/i);
  assert.doesNotMatch(divideEquationResponse, /divide|by 10/i);

  const moduloResponse = composeCoachResponse({
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: "You correctly divided the original equation by 10.",
    suggested_next_check:
      "Use modular arithmetic to analyze the equation, for example consider the equation modulo 5.",
    should_finish: false,
    confidence: 0.93,
    source: "model",
  });

  assert.match(moduloResponse, /What would you try next/i);
  assert.doesNotMatch(moduloResponse, /modulo 5|modular arithmetic/i);

  const secondEquationResponse = composeCoachResponse({
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress:
      "You correctly wrote the first linear equation from the given data: $69=1.5a+800b$.",
    suggested_next_check:
      "Write the second linear equation from the other trail data: $69=1.2a+1100b$.",
    should_finish: false,
    confidence: 0.96,
    source: "model",
  });

  assert.match(secondEquationResponse, /What would you try next/i);
  assert.doesNotMatch(secondEquationResponse, /1\.2a|1100b/);
});

test("coach generic positive fallback is encouraging", () => {
  const response = composeCoachResponse({
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress:
      "That correctly substitutes the given area and diagonal into the equation 84=(14d)/2.",
    suggested_next_check: "Simplify the right-hand side one step, then send that line.",
    should_finish: false,
    confidence: 0.93,
    source: "model",
  });

  assert.match(response, /Nice work, that's a reasonable step/i);
  assert.doesNotMatch(response, /That looks like a reasonable step/i);
});

test("coach math rendering sanitizes word placeholder formulas", () => {
  const formula = "(new_area/original_area - 1) * 100%";
  const rendered = expressionToLatex(formula);

  assert.match(rendered, /\\frac\{\\text\{new area\}\}\{\\text\{original area\}\}/);
  assert.match(rendered, /100\\%/);
  assert.doesNotMatch(rendered, /new_area|original_area/);

  const parts = splitPlainMath(
    "Calculate the percent increase using the formula (new_area/original_area - 1) * 100%."
  );
  const mathParts = parts.filter((part) => part.math).map((part) => expressionToLatex(part.text));

  assert.ok(
    mathParts.some((part) =>
      /\\frac\{\\text\{new area\}\}\{\\text\{original area\}\}/.test(part)
    )
  );

  const explicitPlaceholder = inlineLatexForDisplay(
    "new_area/original_area",
    "coach"
  );
  assert.match(explicitPlaceholder, /\\frac\{\\text\{new area\}\}\{\\text\{original area\}\}/);

  const symbolicSubscripts = inlineLatexForDisplay(
    "P = R H_reg + R_ot H_ot",
    "coach"
  );
  assert.match(symbolicSubscripts, /H_\{reg\}/);
  assert.match(symbolicSubscripts, /R_\{ot\}/);
  assert.match(symbolicSubscripts, /H_\{ot\}/);
  assert.doesNotMatch(symbolicSubscripts, /\\text\{H reg\}|\\text\{R ot\}/);

  const repairedMalformedLatex = inlineLatexForDisplay(
    "frac{2^k cdot(textnum)}{2^m cdot(textden)}",
    "coach"
  );
  assert.match(repairedMalformedLatex, /\\frac\{2\^k \\cdot \\text\{num\}\}\{2\^m \\cdot \\text\{den\}\}/);
});

test("explicit coach arithmetic normalizes unicode multiplication", () => {
  assert.equal(
    inlineLatexForDisplay("14 \u00b7 10=140", "coach"),
    "14 \\cdot 10=140"
  );

  const parts = splitExplicitLatex(
    "Your interior area calculation $14 \u00b7 10=140$ is correct.",
    "loose"
  );
  const formula = parts.find((part) => part.math);
  assert.ok(formula);
  assert.doesNotMatch(inlineLatexForDisplay(formula.text, "coach"), /\u00b7/);
});

test("coach math rendering does not absorb prose before signed numbers", () => {
  const parts = splitPlainMath(
    "Rewrite the expression for the perpendicular slope as -1 divided by the original slope -8/3."
  );
  const mathParts = parts.filter((part) => part.math).map((part) => part.text);

  assert.ok(mathParts.includes("-1"));
  assert.ok(!mathParts.some((part) => /as\s*-/.test(part)));
});

test("plain math rendering keeps nested slash fractions as one latex expression", () => {
  const parts = splitPlainMath(
    "Compute and express your answer as a common fraction: 5/(5 + 5/(5 + 1/5))"
  );
  const mathParts = parts.filter((part) => part.math).map((part) => part.text);

  assert.ok(mathParts.includes("5/(5 + 5/(5 + 1/5))"));

  const rendered = expressionToLatex("5/(5 + 5/(5 + 1/5))");
  assert.match(rendered, /\\frac\{5\}\{5 \+ \\frac\{5\}\{5 \+ \\frac\{1\}\{5\}\}\}/);
});

test("plain math rendering handles combination notation and latex multiplication", () => {
  const combinationParts = splitPlainMath("C(8,2)* C(6,3)");
  assert.deepEqual(combinationParts, [
    { text: "C(8,2)* C(6,3)", math: true },
  ]);
  assert.match(expressionToLatex("C(8,2)* C(6,3)"), /\\binom\{8\}\{2\}\\cdot\s+\\binom\{6\}\{3\}/);

  const productParts = splitPlainMath("28\\cdot20");
  assert.deepEqual(productParts, [
    { text: "28\\cdot20", math: true },
  ]);
});

test("plain math rendering handles latex inequality operators", () => {
  const coachParts = splitPlainMath(
    "Substitute h from the constraint h + 4s \\le 108 to express L in terms of s only."
  );
  const coachMathParts = coachParts.filter((part) => part.math).map((part) => part.text);

  assert.ok(coachMathParts.includes("h + 4s \\le 108"));
  assert.equal(expressionToLatex("h + 4s \\le 108"), "h + 4s \\leq 108");

  const shortcutParts = splitExplicitLatex(
    "Use the integer lower bound $s\\ge1$ to fix $h$ and bound the diagonal.",
    "loose"
  );
  assert.deepEqual(shortcutParts, [
    { text: "Use the integer lower bound ", math: false },
    { text: "s\\ge1", math: true },
    { text: " to fix ", math: false },
    { text: "h", math: true },
    { text: " and bound the diagonal.", math: false },
  ]);
});

test("plain math rendering handles compact latex inequalities before digits", () => {
  for (const expression of ["2z\\le54", "2z\\leq54"]) {
    assert.deepEqual(splitPlainMath(expression), [
      { text: expression, math: true },
    ]);
    assert.equal(expressionToLatex(expression), "2z\\leq54");
  }
});

test("plain math rendering keeps optional-root latex together", () => {
  const first = splitPlainMath("\\sqrt[3]{216+512}");
  assert.deepEqual(first, [
    { text: "\\sqrt[3]{216+512}", math: true },
  ]);

  const second = splitPlainMath("\\sqrt[3]{728}");
  assert.deepEqual(second, [
    { text: "\\sqrt[3]{728}", math: true },
  ]);

  assert.equal(inlineLatexForDisplay("\\sqrt[3]{728}", "student"), "\\sqrt[3]{728}");
});

test("plain math rendering keeps primed variables and escaped percent together", () => {
  const primedEquationParts = splitPlainMath("h^{\\prime}=\\frac{32}{25}h");
  assert.deepEqual(primedEquationParts, [
    { text: "h^{\\prime}=\\frac{32}{25}h", math: true },
  ]);
  assert.equal(
    expressionToLatex("h^{\\prime}=\\frac{32}{25}h"),
    "h^{\\prime}=\\frac{32}{25}h"
  );

  const percentParts = splitPlainMath("\\frac{32}{25}=128\\%");
  assert.deepEqual(percentParts, [
    { text: "\\frac{32}{25}=128\\%", math: true },
  ]);
  assert.equal(expressionToLatex("\\frac{32}{25}=128\\%"), "\\frac{32}{25}=128\\%");
});

test("math rendering and submit normalization handle latex ast multiplication", () => {
  assert.equal(mathLiveLatexToSubmitText("24!=24\\ast23!"), "24!=24*23!");
  assert.equal(expressionToLatex("24\\ast23"), "24\\cdot 23");

  const parts = splitPlainMath("24\\ast23");
  assert.deepEqual(parts, [
    { text: "24\\ast23", math: true },
  ]);
});

test("plain math rendering detects latex star operation without treating it as multiplication", () => {
  const parts = splitPlainMath("(a\\star b)\\star a = b\\star a = b");

  assert.deepEqual(parts, [
    { text: "(a\\star b)\\star a = b\\star a = b", math: true },
  ]);
  assert.equal(
    inlineLatexForDisplay("(a\\star b)\\star a = b\\star a = b", "student"),
    "(a\\star b)\\star a = b\\star a = b"
  );
});

test("mixed student rendering treats an undelimited latex suit command as math", () => {
  const mathLiveValue =
    "\\text{\\textbackslash{}spadesuit}(2,2)=2-\\frac{1}{2}=\\frac{3}{2}";
  const display = mathLiveLatexToMixedDisplay(mathLiveValue);

  assert.equal(
    display,
    "\\(\\spadesuit\\)\\((2,2)=2-\\frac{1}{2}=\\frac{3}{2}\\)"
  );
  assert.deepEqual(splitPlainMath("\\spadesuit"), [
    { text: "\\spadesuit", math: true },
  ]);
});

test("coach math rendering repairs compact frac tokens", () => {
  const rendered = expressionToLatex("frac55 + frac55 + frac15");

  assert.match(rendered, /\\frac\{5\}\{5\}/);
  assert.match(rendered, /\\frac\{1\}\{5\}/);
  assert.doesNotMatch(rendered, /\bfrac55\b|\bfrac15\b/);

  const explicitRendered = inlineLatexForDisplay("frac15", "coach");
  assert.equal(explicitRendered, "\\frac{1}{5}");
});

test("coach math rendering repairs JSON escape damage in latex commands", () => {
  const damagedFraction = `x=\u000crac{a}{b}`;
  assert.equal(
    inlineLatexForDisplay(damagedFraction, "coach"),
    "x=\\frac{a}{b}"
  );

  const replacementDamagedFraction = `x=\uFFFDrac13`;
  assert.equal(
    inlineLatexForDisplay(replacementDamagedFraction, "coach"),
    "x=\\frac{1}{3}"
  );

  assert.equal(
    inlineLatexForDisplay("V=\\frac{1}{2}\\(\\left(\\frac{4}{3}\\pi R^3\\right)\\)", "coach"),
    "V=\\frac{1}{2}\\left(\\frac{4}{3}\\pi R^3\\right)"
  );

  const damagedText = `\text{lcm}(12,15)=60`;
  assert.equal(
    inlineLatexForDisplay(damagedText, "coach"),
    "\\text{lcm}(12,15)=60"
  );

  const damagedProduct = `2^3\times3\times5`;
  assert.equal(
    expressionToLatex(damagedProduct),
    "2^{3}\\cdot 3\\cdot 5"
  );

  const damagedSizedBar = `12,15\u0008ig|120`;
  assert.equal(
    inlineLatexForDisplay(damagedSizedBar, "coach"),
    "12,15\\mid 120"
  );

  const damagedBoldProduct = `30N=250\u0008oldsymbol{\\times}\\boxed{\\text{___}}`;
  assert.equal(
    inlineLatexForDisplay(damagedBoldProduct, "coach"),
    "30N=250\\times\\boxed{\\phantom{000}}"
  );
});

test("plain math rendering keeps implicit prime-power products together", () => {
  const parts = splitPlainMath(
    "You correctly identified that 2^2 3 5 must divide the number."
  );
  const mathParts = parts.filter((part) => part.math);

  assert.deepEqual(mathParts, [{ text: "2^2 3 5", math: true }]);
  assert.equal(expressionToLatex(mathParts[0].text), "2^{2}\\cdot 3\\cdot 5");
});

test("plain rendering separates descriptive labels from pi expressions", () => {
  assert.deepEqual(splitPlainMath("centralshadedarea=2\\pi"), [
    { text: "centralshadedarea=", math: false },
    { text: "2\\pi", math: true },
  ]);

  assert.deepEqual(
    splitPlainMath("shadedareainsidethecentralcircle=\\pi2^2-2\\pi"),
    [
      { text: "shadedareainsidethecentralcircle=", math: false },
      { text: "\\pi2^2-2\\pi", math: true },
    ]
  );
});

test("coach math rendering preserves latex ellipsis commands", () => {
  const expression = "1+2+\\cdots+9=45";

  assert.equal(expressionToLatex(expression), expression);
  assert.equal(inlineLatexForDisplay(expression, "coach"), expression);
  assert.deepEqual(splitPlainMath(expression), [{ text: expression, math: true }]);
  assert.equal(parseClaim(expression).normalized, "1+2+\\cdots+9=45");
});

test("student math rendering removes empty text artifacts", () => {
  const rendered = inlineLatexForDisplay("N=\\text{}7.75", "student");
  assert.equal(rendered, "N=7.75");
});

test("student math rendering repairs compact frac tokens", () => {
  const rendered = inlineLatexForDisplay("\\frac13", "student");
  assert.equal(rendered, "\\frac{1}{3}");
});

test("shared rendering repairs damaged degree, radical, and percent LaTeX", () => {
  assert.equal(inlineLatexForDisplay("60^\uFFFDirc", "coach"), "60^\\circ");
  assert.equal(inlineLatexForDisplay("12oot3", "coach"), "12\\sqrt{3}");
  assert.equal(inlineLatexForDisplay("59\\\\%", "student"), "59\\%");
  assert.deepEqual(splitPlainMath("59\\%"), [{ text: "59\\%", math: true }]);
});

test("grouped arithmetic followed by prose renders caret exponents", () => {
  const problem =
    "The expression (2^(2010)+2^(2008))/(2^(2005)-2^( 2003)) is equivalent to what common fraction?";
  const math = splitPlainMath(problem).filter((part) => part.math);
  assert.equal(math.length, 1);
  assert.match(expressionToLatex(math[0].text), /2\^\{2010\}/);
  assert.doesNotMatch(expressionToLatex(math[0].text), /\^\(/);
});

test("coach math rendering repairs raw modular congruence expressions", () => {
  const parts = splitPlainMath(
    "Write the relationship in symbol form, for example S_{odd}-S_{even}\\equiv 0\\pmod{11}."
  );
  const mathParts = parts.filter((part) => part.math).map((part) => part.text);

  assert.ok(mathParts.includes("S_{odd}-S_{even}\\equiv 0\\pmod{11}"));
  assert.equal(
    inlineLatexForDisplay("S_{odd}-S_{even}\\equiv 0\\pmod{11}", "coach"),
    "S_{odd}-S_{even}\\equiv 0\\pmod{11}"
  );

  assert.equal(
    inlineLatexForDisplay(
      "8,514,013\\equiv1\\pmod{placeholder}0",
      "student"
    ),
    "8,514,013\\equiv1\\pmod{0}"
  );
});

test("plain math rendering detects braced subscript variables in prose", () => {
  const parts = splitPlainMath(
    "Introduce variables h_{Joe},h_{Mary},h_{Sue},h_{Steve},h_{Lisa},h_{John} and list the constraints."
  );
  const mathParts = parts.filter((part) => part.math).map((part) => part.text);

  assert.deepEqual(mathParts, [
    "h_{Joe}",
    "h_{Mary}",
    "h_{Sue}",
    "h_{Steve}",
    "h_{Lisa}",
    "h_{John}",
  ]);
  assert.equal(inlineLatexForDisplay("h_{Joe}", "coach"), "h_{Joe}");
});

test("MathLive mixed text and math keeps mode boundaries for display", () => {
  const mathLiveValue = "\\text{I counted }8\\text{ apples}";

  assert.equal(mathLiveLatexToSubmitText(mathLiveValue), "I counted 8 apples");
  assert.equal(mathLiveLatexToMixedDisplay(mathLiveValue), "I counted \\(8\\) apples");
  assert.equal(mathLiveLatexToMixedDisplay("8\\cdot7"), null);
});

test("MathLive mixed display normalizes textasteriskcentered", () => {
  const mathLiveValue =
    "\\text{distance = rate \\textasteriskcentered time: }q=r\\textasteriskcentered\\frac{1}{8}q";

  assert.equal(
    mathLiveLatexToSubmitText(mathLiveValue),
    "distance = rate * time: q=r*\\frac{1}{8}q"
  );
  assert.equal(
    mathLiveLatexToMixedDisplay(mathLiveValue),
    "distance = rate * time: \\(q=r\\cdot \\frac{1}{8}q\\)"
  );
});

test("student math rendering normalizes textasteriskcentered multiplication", () => {
  const rendered = expressionToLatex("x=43\\textasteriskcentered5/(4\\textasteriskcentered1.075)");

  assert.equal(rendered, "x=43\\cdot \\frac{5}{4\\cdot 1.075}");
  assert.doesNotMatch(rendered, /textasteriskcentered/);

  assert.equal(
    inlineLatexForDisplay("90\\textasteriskcentered90=8100", "student"),
    "90\\cdot 90=8100"
  );
});

test("MathLive normalizes legacy choose notation for submit and display", () => {
  const value =
    "{6\\choose2}{4\\choose2}{2\\choose2}=15\\cdot6\\cdot1=90";
  const submitted = mathLiveLatexToSubmitText(value);

  assert.equal(
    submitted,
    "\\binom{6}{2}\\binom{4}{2}\\binom{2}{2}=15*6*1=90"
  );
  assert.match(expressionToLatex(submitted), /\\binom\{6\}\{2\}/);
  assert.doesNotMatch(expressionToLatex(submitted), /\\choose/);
});

test("MathLive submit strips invisible and sized fence commands", () => {
  assert.equal(
    mathLiveLatexToSubmitText(
      String.raw`A\mathopen{}\mleft(1-0.2\mright)\mathclose{}\Bigl(1+0.5\Bigr)`
    ),
    "A(1-0.2)(1+0.5)"
  );
});

test("MathLive mixed display strips boundary dollar markers", () => {
  const mathLiveValue = "\\$\\text{if }x=\\frac{-b+\\sqrt{b^2-4ac}}{2a}\\text{, then my birthday is in March}\\$";

  assert.equal(
    mathLiveLatexToMixedDisplay(mathLiveValue),
    "if \\(x=\\frac{-b+\\sqrt{b^2-4ac}}{2a}\\), then my birthday is in March"
  );
});

test("MathLive mixed display strips trailing dollar from math segment", () => {
  const mathLiveValue = "\\text{The sum would be }100\\cdot12+10\\cdot15+1\\cdot8\\$";

  assert.equal(
    mathLiveLatexToSubmitText(mathLiveValue),
    "The sum would be 100*12+10*15+1*8"
  );
  assert.equal(
    mathLiveLatexToMixedDisplay(mathLiveValue),
    "The sum would be \\(100\\cdot12+10\\cdot15+1\\cdot8\\)"
  );
});

test("MathLive submit strips color wrappers from text and mixed math", () => {
  assert.equal(
    mathLiveLatexToSubmitText(
      "\\colorbox{#fbbbb6}{\\textcolor{#d7170b}{I spent half of my money on ice cream and music}}"
    ),
    "I spent half of my money on ice cream and music"
  );

  assert.equal(
    mathLiveLatexToSubmitText(
      "\\colorbox{#ffffff}{\\textcolor{#000000}{I spent }}\\frac{1}{6}\\colorbox{#ffffff}{\\textcolor{#000000}{ of my $30 on burgers}}"
    ),
    "I spent \\frac{1}{6} of my $30 on burgers"
  );
});

test("MathLive mixed display repairs escaped latex typed in text mode", () => {
  const mathLiveValue =
    "\\text{\\textbackslash{}frac\\textbraceleft{}1\\textbraceright{}\\textbraceleft{}3\\textbraceright{} + \\textbackslash{}frac\\textbraceleft{}1\\textbraceright{}\\textbraceleft{}2\\textbraceright{} = \\textbackslash{}frac\\textbraceleft{}5\\textbraceright{}\\textbraceleft{}6\\textbraceright{}}";

  assert.equal(
    mathLiveLatexToSubmitText(mathLiveValue),
    "\\frac{1}{3} + \\frac{1}{2} = \\frac{5}{6}"
  );
  assert.equal(
    mathLiveLatexToMixedDisplay(mathLiveValue),
    "\\(\\frac{1}{3} + \\frac{1}{2} = \\frac{5}{6}\\)"
  );
});

test("MathLive mixed display keeps contraction letters in text mode", () => {
  const mathLiveValue = "\\text{I'}m\\text{ Stuck}";

  assert.equal(mathLiveLatexToSubmitText(mathLiveValue), "I'm Stuck");
  assert.equal(mathLiveLatexToMixedDisplay(mathLiveValue), "I'm Stuck");
});

test("MathLive mixed display keeps curly-apostrophe contractions in text mode", () => {
  const mathLiveValue = "\\text{I’}m\\text{ stuck}";

  assert.equal(mathLiveLatexToSubmitText(mathLiveValue), "I’m stuck");
  assert.equal(mathLiveLatexToMixedDisplay(mathLiveValue), "I’m stuck");
});

test("student rendering removes orphan MathLive delimiters without removing coordinates", () => {
  const first = splitExplicitLatex(
    "C is at \\(0,0\\), A is at \\(0,x\\), and B is at \\(\\sqrt{144-x^2},0\\)\\)",
    "strict"
  );
  const second = splitExplicitLatex(
    "W\\(is at (-x,0) and Z is at (-x,x)\\)",
    "strict"
  );

  assert.doesNotMatch(first.map((part) => part.text).join(""), /\\[()]/);
  assert.match(first.map((part) => part.text).join(""), /\\sqrt\{144-x\^2\},0/);
  assert.doesNotMatch(second.map((part) => part.text).join(""), /\\[()]/);
  assert.match(second.map((part) => part.text).join(""), /W.*is at \(-x,0\).*\(-x,x\)/);
});

test("plain rendering recognizes undelimited geometry relation commands", () => {
  const similarity = splitPlainMath("AFG\\sim AJH\\sim ADC");
  const triangles = splitPlainMath("\\triangle BEP\\sim\\triangle DAE");
  const unfinishedSimilarity = splitPlainMath("\\triangle OAB\\sim");
  const correspondence = splitPlainMath(
    "You identified OA\\leftrightarrow OC and OB\\leftrightarrow OD."
  );
  const parallel = splitPlainMath(
    "Use the right angle at the intersection of BD with AP, then relate D to A using AD\\parallel BC."
  );

  assert.deepEqual(similarity, [{ text: "AFG\\sim AJH\\sim ADC", math: true }]);
  assert.deepEqual(triangles, [
    { text: "\\triangle BEP\\sim\\triangle DAE", math: true },
  ]);
  assert.deepEqual(unfinishedSimilarity, [
    { text: "\\triangle OAB\\sim", math: true },
  ]);
  assert.ok(
    correspondence.some(
      (part) => part.math && part.text === "OA\\leftrightarrow OC"
    )
  );
  assert.ok(
    correspondence.some(
      (part) => part.math && part.text === "OB\\leftrightarrow OD"
    )
  );
  assert.ok(
    parallel.some((part) => part.math && part.text === "AD\\parallel BC")
  );
});

test("plain rendering recognizes undelimited vector assignments", () => {
  const expression = "\\vec{u}=[2u,0],\\vec{v}=[0,v],\\vec{w}=[-3w,4w]";

  assert.deepEqual(splitPlainMath(expression), [{ text: expression, math: true }]);
  assert.doesNotMatch(inlineLatexForDisplay(expression, "student"), /placeholder/);
});

test("student rendering keeps a complete radical and removes its orphan delimiter", () => {
  const text = "distance from A to B is \\sqrt{\\left(x-2\\right)^2+y^2}\\)";
  const explicit = splitExplicitLatex(text, "strict");
  const plainParts = explicit.flatMap((part) =>
    part.math ? [part] : splitPlainMath(part.text)
  );

  assert.ok(
    plainParts.some(
      (part) => part.math && part.text === "\\sqrt{\\left(x-2\\right)^2+y^2}"
    )
  );
  assert.doesNotMatch(plainParts.map((part) => part.text).join(""), /\\\)/);
});

test("student rendering repairs an unfinished modular placeholder", () => {
  const expression =
    "h\\equiv L_{17}+\\frac{L_{17}}{2}+\\frac{L_{17}}{3}+\\cdots+\\frac{L_{17}}{17}(mod \\placeholder)";
  const parts = splitPlainMath(expression);
  const rendered = parts
    .map((part) => (part.math ? inlineLatexForDisplay(part.text, "student") : part.text))
    .join("");

  assert.equal(parts.length, 1);
  assert.equal(parts[0].math, true);
  assert.doesNotMatch(rendered, /\\placeholder/);
  assert.doesNotMatch(rendered, /\\(?:square|Box)/);
  assert.match(rendered, /\\phantom\{0\}/);
  assert.match(rendered, /\\pmod/);
});

test("sphere surface-area formula and radius substitution are valid progress", () => {
  const session = makeSession({
    problem:
      "Four congruent semicircles are drawn on the surface of a sphere with radius 2. Find the requested curve length.",
  });

  const formula = deterministicVerify(session, "S=4\\pi r^2");
  const proseFormula = deterministicVerify(
    session,
    "surface area of a sphere = 4\\pi r^2"
  );
  const evaluated = deterministicVerify(
    session,
    "surface area of the sphere is 16\\pi"
  );

  for (const result of [formula, proseFormula, evaluated]) {
    assertStatus(result, "correct");
    assert.equal(result.should_finish, false);
  }
});

test("image-backed structural triangle observations receive semantic verification", async () => {
  const session = makeSession({
    problem:
      "Four regular hexagons are attached to a square as shown. Find the octagon area.",
    problemImage: {
      imageBase64: "test-image",
      mimeType: "image/png",
    },
    solutionGuide: {
      finalAnswer: "6+2\\sqrt{3}",
      solutionOutline: [
        "The adjacent outer hexagons form four triangular gaps around the central square.",
      ],
      keyCheckpoints: ["Identify the 4 triangles between adjacent hexagons."],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });

  for (const message of [
    "there are 4 triangles in between the hexagons and under the octagon",
    "connecting the adjacent hexagons forms 4 triangles",
  ]) {
    let modelChecks = 0;
    const result = await runVerifierRegistry({
      session,
      message,
      modelVerifyFinalAnswer: async () => null,
      modelVerify: async () => {
        modelChecks += 1;
        return {
          intent: "submitted_work",
          status: "correct",
          local_error: null,
          valid_progress: "That structural observation matches the diagram.",
          suggested_next_check: "What would you try next?",
          should_finish: false,
          confidence: 0.96,
          source: "model",
        };
      },
      applyConservativePolicy: (verification) => verification,
      requireEvaluationForUnevaluatedFinal: (verification) => verification,
    });

    assertStatus(result, "correct");
    assert.equal(result.should_finish, false);
    assert.equal(result.source, "model");
    assert.equal(modelChecks, 1);
  }
});

test("stuck hint guard rejects malformed notation and altered radical givens", () => {
  const session = makeSession({
    problem:
      "A quadrilateral is inscribed in a circle of radius $200\\sqrt{2}$. Three sides have length 200.",
  });
  const malformed =
    "Equal chords correspond to equal central angles; let the angle be heta and use $200=2(200)?$ instead of $c=2R?$. What does the chord formula give for $R=200$??";

  assert.equal(normalizeForwardStuckHint(malformed, session), null);
  assert.match(stuckHelpPrompt(session, "I'm stuck"), /preserve.*given.*exact/i);
});

test("shared rendering repairs compact anchored equations", () => {
  const expression = "r=\\frac32S+\\frac12";
  const parts = splitPlainMath(expression);

  assert.deepEqual(parts, [{ text: expression, math: true }]);
  assert.doesNotMatch(expressionToLatex(parts[0].text), /\\frac32|\\frac12/);
});

test("shared rendering recognizes a standalone braced binomial coefficient", () => {
  const expression = "\\binom{10}{2}";

  assert.deepEqual(splitPlainMath(expression), [{ text: expression, math: true }]);
  assert.equal(inlineLatexForDisplay(expression, "student"), expression);
});

test("bounded sums use display-style limits in inline chat math", () => {
  const expression = "f(x)=\\sum_{k=2}^{10}|kt";
  const rendered = expressionToLatex(expression);

  assert.match(rendered, /^\\displaystyle\s+/);
  assert.match(rendered, /\\sum_\{k=2\}\^\{10\}/);
  assert.match(
    inlineLatexForDisplay("\\sum_{k=2}^{10}kt", "student"),
    /^\\displaystyle\s+/
  );
});

test("shared rendering recognizes perpendicular and angle relations", () => {
  const perpendicular = splitPlainMath("AF\\perp BE");
  const angleDefinition = splitPlainMath("x=\\placeholder\\angle ABF");
  const angleChain = splitPlainMath(
    "\\angle BAF=90-x,\\angle CBF=46-x,\\angle BEC=x"
  );
  const rightAngles = splitPlainMath(
    "\\angle BFA=\\angle AFE=90\\ang"
  );

  assert.deepEqual(perpendicular, [{ text: "AF\\perp BE", math: true }]);
  assert.equal(angleDefinition.length, 1);
  assert.equal(angleDefinition[0].math, true);
  assert.equal(angleDefinition[0].text, "x=\\angle ABF");
  assert.equal(angleChain.length, 1);
  assert.equal(angleChain[0].math, true);
  assert.equal(rightAngles.length, 1);
  assert.equal(rightAngles[0].math, true);
  assert.doesNotMatch(inlineLatexForDisplay(rightAngles[0].text, "student"), /\\ang\b/);
  assert.match(inlineLatexForDisplay(rightAngles[0].text, "student"), /\\circ/);
});

test("shared rendering recognizes angle equalities and scaled angle chains", () => {
  const problem =
    "Point M is chosen so that \\angle AMD = \\angle CMD. What is the degree measure of \\angle AMD?";
  const student = "\\angle AMC=2\\angle AMD=2\\angle CMD";
  const problemParts = splitPlainMath(problem);

  assert.ok(
    problemParts.some(
      (part) => part.math && part.text === "\\angle AMD = \\angle CMD"
    )
  );
  assert.ok(
    problemParts.some(
      (part) => part.math && part.text === "\\angle AMD"
    )
  );
  assert.deepEqual(splitPlainMath(student), [{ text: student, math: true }]);
});

test("shared rendering recognizes overrightarrow vectors and removes placeholders", () => {
  const coach =
    "What are the vectors \\placeholder\\overrightarrow{MC} and \\placeholder\\overrightarrow{MD} in terms of x?";
  const student =
    "\\overrightarrow{MC}=[6-x,3],\\overrightarrow{MD}=[x,3]";
  const coachParts = splitPlainMath(coach);

  assert.doesNotMatch(coachParts.map((part) => part.text).join(""), /placeholder|\\square/);
  assert.equal(
    coachParts.filter(
      (part) => part.math && /\\overrightarrow\{M[CD]\}/.test(part.text)
    ).length,
    2
  );
  assert.deepEqual(splitPlainMath(student), [{ text: student, math: true }]);
});

test("shared rendering repairs damaged divisibility bars", () => {
  const rendered = inlineLatexForDisplay(
    `x^2+x+1\uFFFDigml x^3-1`,
    "coach"
  );

  assert.doesNotMatch(rendered, /\uFFFD|igml/);
  assert.match(rendered, /\\mid/);
});

test("shared rendering repairs damaged ellipses in numeric patterns", () => {
  for (const expression of [
    "1,4,7,\\placeholder\\ldots",
    `1,4,7,\uFFFDldots`,
  ]) {
    const parts = splitPlainMath(expression);
    const rendered = parts
      .map((part) => (part.math ? expressionToLatex(part.text) : part.text))
      .join("");

    assert.equal(parts.length, 1);
    assert.equal(parts[0].math, true);
    assert.match(rendered, /1,4,7,\\ldots/);
    assert.doesNotMatch(rendered, /placeholder|\\square|\uFFFD/);
  }
});

test("shared rendering recognizes floor assignments and set membership", () => {
  const floorExpression = "a=\\lfloor x\\rfloor,b=x-a";
  const membershipExpression = "g\\isin\\lbrace1,3,7,9,21,63\\rbrace";
  const membershipParts = splitPlainMath(membershipExpression);

  assert.deepEqual(splitPlainMath(floorExpression), [
    { text: floorExpression, math: true },
  ]);
  assert.deepEqual(membershipParts, [
    {
      text: "g\\in\\lbrace1,3,7,9,21,63\\rbrace",
      math: true,
    },
  ]);
  assert.match(expressionToLatex(floorExpression), /\\lfloor x\\rfloor/);
  assert.doesNotMatch(expressionToLatex(membershipParts[0].text), /\\isin/);
});

test("shared rendering keeps multi-letter products in one math run", () => {
  const expression = "gu*gv+63=20guv+12g";
  const parts = splitPlainMath(expression);

  assert.deepEqual(parts, [{ text: expression, math: true }]);
  assert.match(expressionToLatex(expression), /gu\\cdot gv\+63=20guv\+12g/);
});

test("shared rendering keeps tuple transition chains in one math run", () => {
  const expression =
    "(1,1,1)\\rightarrow(1,1,1)=\\frac14;(2,1,0)\\rightarrow(1,1,1)=\\frac12;(1,1,1)\\rightarrow(2,1,0)=\\frac34;(2,1,0)\\rightarrow(2,1,0)=\\frac12";
  const parts = splitPlainMath(expression);
  const rendered = expressionToLatex(parts[0].text);

  assert.deepEqual(parts, [{ text: expression, math: true }]);
  assert.equal((rendered.match(/\\rightarrow/g) || []).length, 4);
  assert.doesNotMatch(rendered, /\\frac(?:14|12|34)/);
});

test("shared rendering recognizes equations with compound subscripts", () => {
  const expression = "d_{n+1}=\\frac{x_n^2+x_n-20}{x_n+6}";

  assert.deepEqual(splitPlainMath(expression), [{ text: expression, math: true }]);
  assert.match(expressionToLatex(expression), /^d_\{n\+1\}=/);
});

test("coach rendering turns text underscores into a safe math blank", () => {
  const rendered = inlineLatexForDisplay(
    "\\frac{d_{n}+9}{d_{n}+10}=1-\\frac{\\text{___}}{d_{n}+10}",
    "coach"
  );

  assert.doesNotMatch(rendered, /\\text\{___\}/);
  assert.match(rendered, /\\underline\{\\phantom\{000\}\}/);
});

test("shared rendering keeps Lipschitz inequalities in one math run", () => {
  const expression = "|f(800)-f(400)|\\le\\frac12|800-400|";
  const parts = splitPlainMath(expression);

  assert.deepEqual(parts, [
    {
      text: expression,
      math: true,
    },
  ]);
  assert.match(expressionToLatex(parts[0].text), /\\leq/);
  assert.doesNotMatch(expressionToLatex(parts[0].text), /\\frac12/);
});

test("MathLive display repairs escaped bracket and ascii-caret latex artifacts", () => {
  const escaped =
    "\\\\lbrack left( frac{48}{ sin 60\\textasciicircum circ} right)\\textasciicircum2 = boxed{ textbf{(C) 3072}}. \\\\rbrack";
  const rendered = inlineLatexForDisplay(escaped, "student");

  assert.match(rendered, /\\left\[/);
  assert.match(rendered, /\\frac\{48\}\{\s*\\sin 60\^\\circ\}/);
  assert.match(rendered, /\\right\]\s*$/);
  assert.match(rendered, /\\boxed\{\s*\\textbf\{\(C\) 3072\}\}/);
  assert.doesNotMatch(rendered, /textascii|\\\\lbrack|\\\\rbrack|(^|[^\\])\bfrac\{/);

  assert.equal(
    inlineLatexForDisplay("\\lbrack30 + 2ab + 2ac + 2bc = 0\\right]", "student"),
    "\\left[30 + 2ab + 2ac + 2bc = 0\\right]"
  );
  assert.equal(
    inlineLatexForDisplay("\\lbrack5 + 0.2x = 0.4(10+x)\\right]", "student"),
    "\\left[5 + 0.2x = 0.4(10+x)\\right]"
  );

  const mathLiveValue =
    "\\text{\\\\lbrack left( frac\\textbraceleft{}48\\textbraceright{}\\textbraceleft{} sin 60\\textasciicircum circ\\textbraceright{} right)\\textasciicircum2 = boxed\\textbraceleft{} textbf\\textbraceleft{}(C) 3072\\textbraceright{}\\textbraceright{}. \\\\rbrack}";

  assert.equal(
    mathLiveLatexToMixedDisplay(mathLiveValue),
    "\\(\\left[ \\left( \\frac{48}{ \\sin 60^\\circ} \\right)^2 = \\boxed{ \\textbf{(C) 3072}}. \\right]\\)"
  );
});

test("coach math rendering strips stray dollar before a variable in prose", () => {
  const parts = splitExplicitLatex(
    "write the structural relationship T = movies amount + music amount + ice cream amount +$B, where the first three amounts are known fractions of T.",
    "loose"
  );

  const renderedText = parts.map((part) => part.text).join("");
  assert.equal(parts.filter((part) => part.math).length, 0);
  assert.doesNotMatch(renderedText, /\$/);
  assert.match(renderedText, /\+B, where/);
});

test("problem rendering repairs undelimited align environments", () => {
  const parts = splitExplicitLatex(
    "Consider: \\begin{align*}a \\blacklozenge b &= a^2-b^2\\\\a \\bigstar b &= (a-b)^2\\end{align*} What is the output?",
    "loose"
  );
  const math = parts.filter((part) => part.math).map((part) => part.text).join(" ");
  const prose = parts.filter((part) => !part.math).map((part) => part.text).join(" ");

  assert.match(math, /\\blacklozenge/);
  assert.match(math, /\\bigstar/);
  assert.match(math, /\\qquad/);
  assert.doesNotMatch(prose, /begin|end|align/);
});

test("student rendering repairs an undelimited sized arrangement template", () => {
  const parts = splitExplicitLatex(
    "All valid arrangements must be of the form\\left[ \\textbf{E underline{hspace{3mm}} E underline{hspace{3mm}} E}.\\right]",
    "strict"
  );
  const math = parts.filter((part) => part.math).map((part) => part.text).join(" ");
  const prose = parts.filter((part) => !part.math).map((part) => part.text).join(" ");

  assert.match(prose, /All valid arrangements/);
  assert.match(math, /\\left\[/);
  assert.match(math, /\\underline\{\\hspace\{3mm\}\}/);
  assert.match(math, /\\right\]/);
  assert.doesNotMatch(prose, /\\left|underline|hspace|\\right/);
});

test("plain math rendering detects raw latex fractions inside prose", () => {
  const parts = splitPlainMath(
    'Notice "(\\frac{1}{2} meter) squared" and "\\dfrac{3}{4}" are area phrases.'
  );
  const mathParts = parts.filter((part) => part.math).map((part) => part.text);
  const proseParts = parts.filter((part) => !part.math).map((part) => part.text).join("");

  assert.ok(mathParts.includes("\\frac{1}{2}"));
  assert.ok(mathParts.includes("\\dfrac{3}{4}"));
  assert.match(expressionToLatex("\\frac{1}{2}"), /\\frac\{1\}\{2\}/);
  assert.match(proseParts, /meter\) squared/);
});

test("plain math rendering detects compact raw latex fractions", () => {
  const parts = splitPlainMath("\\frac95");

  assert.deepEqual(parts, [{ text: "\\frac95", math: true }]);
  assert.equal(inlineLatexForDisplay("\\frac95", "student"), "\\frac{9}{5}");
});

test("problem math rendering accepts dollar spans around numeric math", () => {
  const parts = splitExplicitLatex("The amount is $3 \\frac{1}{2}$ cups.", "loose");

  assert.equal(parts.filter((part) => part.math).length, 1);
  assert.doesNotMatch(parts.map((part) => part.text).join(""), /\$/);
});

test("student math rendering accepts numeric dollar spans with latex constants", () => {
  assert.deepEqual(splitExplicitLatex("$6\\pi$", "strict"), [
    { text: "6\\pi", math: true },
  ]);
});

test("plain math rendering stops before prose division instructions", () => {
  const text =
    "Solve for a by dividing both sides of the equation 4a = 100 by 4.";
  const parts = splitPlainMath(text);
  const mathParts = parts.filter((part) => part.math).map((part) => part.text);

  assert.ok(mathParts.includes("4a = 100"));
  assert.ok(!mathParts.some((part) => /\bby\b/i.test(part)));
  assert.equal(
    parts.map((part) => part.text).join(""),
    text
  );
});

test("plain math rendering keeps latex fractions with braced subscripts together", () => {
  const text =
    "Express the desired fraction as \\frac{N_{div}}{N_{total}}, where N_{total} is the total.";
  const parts = splitPlainMath(text);

  assert.ok(
    parts.some(
      (part) => part.math && part.text === "\\frac{N_{div}}{N_{total}}"
    )
  );
});

test("plain math rendering detects raw latex fractions with grouped products", () => {
  const factorialFraction = "\\frac{(8 \u00b7 7 \u00b7 6 \u00b7 5 \u00b7 4!)}{3!\\cdot4!}";
  const simplifiedFraction = "\\frac{8 \u00b7 7 \u00b7 6 \u00b7 5}{6}";

  assert.deepEqual(splitPlainMath(factorialFraction), [
    { text: factorialFraction, math: true },
  ]);
  assert.deepEqual(splitPlainMath(simplifiedFraction), [
    { text: simplifiedFraction, math: true },
  ]);
  assert.match(expressionToLatex(simplifiedFraction), /\\frac\{8 \\cdot\s+7 \\cdot\s+6 \\cdot\s+5\}\{6\}/);
});

test("plain math rendering keeps symbolic factorial fractions intact", () => {
  const expression = "\\frac{(x+2)!(x-2)!}{x!*x!}=2.5";

  assert.deepEqual(splitPlainMath(expression), [
    { text: expression, math: true },
  ]);
  assert.equal(
    inlineLatexForDisplay(expression, "student"),
    expression
  );
});

test("plain slash rendering converts grouped factorial quotient to a fraction", () => {
  const expression = "((x+2)!(x-2)!)/((x!)^2)=2.5";
  const rendered = expressionToLatex(expression);

  assert.match(
    rendered,
    /^\\frac\{\(x\+2\)!\(x-2\)!\}\{\(x!\)\^\{2\}\}=2\.5$/
  );
  assert.doesNotMatch(rendered, /\//);
});

test("coach math rendering detects escaped paren latex delimiters", () => {
  const parts = splitExplicitLatex(
    "Evaluate \\(\\binom{8}{2}\\) and \\(\\binom{6}{3}\\) separately.",
    "loose"
  );

  assert.deepEqual(parts, [
    { text: "Evaluate ", math: false },
    { text: "\\binom{8}{2}", math: true },
    { text: " and ", math: false },
    { text: "\\binom{6}{3}", math: true },
    { text: " separately.", math: false },
  ]);
});

test("coach math rendering repairs plural letters after dollar math", () => {
  const parts = splitExplicitLatex(
    "The nontrivial power uses only $2$s. With $2^0$ as the factor equal to 1.",
    "loose"
  );

  assert.deepEqual(parts, [
    { text: "The nontrivial power uses only ", math: false },
    { text: "2", math: true },
    { text: "s. With ", math: false },
    { text: "2^0", math: true },
    { text: " as the factor equal to 1.", math: false },
  ]);
});

test("competition cue rendering repairs dollar-delimited exponents attached to words", () => {
  const parts = splitExplicitLatex(
    "Think in terms of how base area (proportional to diameter$^2$) and height scale.",
    "loose"
  );

  assert.deepEqual(parts, [
    { text: "Think in terms of how base area (proportional to diameter", math: false },
    { text: "^2", math: true },
    { text: ") and height scale.", math: false },
  ]);
  assert.doesNotMatch(parts.map((part) => part.text).join(""), /\$/);
});

test("problem math rendering detects escaped bracket delimiters with grouped digits", () => {
  const expression = "222{,}222-22{,}222-2{,}222-222-22-2";
  const parts = splitExplicitLatex(
    `What is the unit digit of: \\[${expression}?\\]`,
    "loose"
  );

  assert.deepEqual(parts, [
    { text: "What is the unit digit of: ", math: false },
    { text: `${expression}?`, math: true },
  ]);
  assert.doesNotMatch(parts.map((part) => part.text).join(""), /\\\[|\\\]/);
});

test("coach math rendering detects spaced dollar latex with star operation", () => {
  const parts = splitExplicitLatex(
    "Evaluate the compound expression $ (a \\star b)\\star a $ by doing the inner operation first.",
    "loose"
  );

  assert.deepEqual(parts, [
    { text: "Evaluate the compound expression ", math: false },
    { text: "(a \\star b)\\star a", math: true },
    { text: " by doing the inner operation first.", math: false },
  ]);
});

test("coach math rendering removes latex spacing commands between spans", () => {
  const parts = splitExplicitLatex(
    "Introduce $h_{Joe}$,\\;$h_{Mary}$,\\;$h_{Sue}$ in a column.",
    "loose"
  );

  assert.deepEqual(parts, [
    { text: "Introduce ", math: false },
    { text: "h_{Joe}", math: true },
    { text: ",", math: false },
    { text: "h_{Mary}", math: true },
    { text: ",", math: false },
    { text: "h_{Sue}", math: true },
    { text: " in a column.", math: false },
  ]);
});

test("coach math rendering ignores malformed dollar spans around prose", () => {
  const parts = splitExplicitLatex(
    "write the next-level denominator as 5+($that inner piece), and indicate the whole expression as $5 divided by that denominator.",
    "loose"
  );

  assert.equal(parts.filter((part) => part.math).length, 0);
  assert.doesNotMatch(parts.map((part) => part.text).join(""), /\$/);
  assert.match(parts.map((part) => part.text).join(""), /that inner piece/);
});

test("student math rendering ignores malformed dollar spans around prose", () => {
  const parts = splitExplicitLatex("$ \\frac{1}{5} year= 73 days$", "strict");

  assert.equal(parts.filter((part) => part.math).length, 0);
  assert.doesNotMatch(parts.map((part) => part.text).join(""), /\$/);
  assert.match(parts.map((part) => part.text).join(""), /\\frac\{1\}\{5\}/);
});

test("plain math rendering does not absorb long prose after a leading number", () => {
  const parts = splitPlainMath(
    "Notice the repeated 5sandtheinnermostsub-expression 5 + 1/5 as the first piece."
  );
  const mathParts = parts.filter((part) => part.math).map((part) => part.text);

  assert.ok(!mathParts.some((part) => /sandtheinnermostsub/i.test(part)));
  assert.ok(mathParts.some((part) => /1\/5|5 \+ 1\/5/.test(part)));
});

test("claim classifier routes operation prose away from symbolic comparison", () => {
  const factorClaim = parseClaim("take out 2^2008 from numerator");
  assert.equal(factorClaim.kind, "factor_claim");
  assert.equal(factorClaim.allowSymbolicFallback, false);
  assert.ok(factorClaim.candidates.includes("operation_claim"));

  const numericClaim = parseClaim("1 + 10/19");
  assert.equal(numericClaim.kind, "numeric_expression");
  assert.equal(numericClaim.allowSymbolicFallback, true);

  const displayFractionClaim = parseClaim("\\dfrac{1}{2}");
  assert.equal(displayFractionClaim.kind, "numeric_expression");
  assert.equal(displayFractionClaim.normalized, "((1)/(2))");
  assert.equal(displayFractionClaim.allowSymbolicFallback, true);

  const equationClaim = parseClaim("4^{3x}=4^4");
  assert.equal(equationClaim.kind, "equation");
  assert.equal(equationClaim.allowSymbolicFallback, true);
});

test("registry treats unresolved operation prose as a move, not final answer or SymPy work", async () => {
  const session = makeSession({
    problem:
      "The expression \\frac{2^{2010}+2^{2008}}{2^{2005}-2^{2003}} is equivalent to what common fraction?",
  });
  let finalAnswerChecks = 0;
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "cancel the common factor",
    modelVerifyFinalAnswer: async () => {
      finalAnswerChecks += 1;
      return null;
    },
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "uncertain",
        local_error: null,
        valid_progress: null,
        suggested_next_check: null,
        should_finish: false,
        confidence: 0.2,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "uncertain");
  assert.equal(finalAnswerChecks, 0);
  assert.equal(modelChecks, 0);
  assert.match(result.suggested_next_check || "", /resulting expression/i);
});

test("registry semantically reviews a latex fraction derived from an accepted custom-operation line", async () => {
  const session = makeSession({
    problem:
      "For a custom operation defined by \\spadesuit(a,b)=a-1/b, evaluate \\spadesuit(2,\\spadesuit(2,2)).",
    solutionGuide: {
      finalAnswer: "3/2",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
    solutionGuideStatus: "ready",
    workState: {
      acceptedLines: [
        "\\spadesuit(2,2)=2-\\frac{1}{2}=\\frac{3}{2}",
        "\\spadesuit(2,\\frac{3}{2})=2-\\frac{2}{3}",
      ],
      lastValidLine: "\\spadesuit(2,\\frac{3}{2})=2-\\frac{2}{3}",
      rejectedLines: [],
    },
  });
  const modelFinal = {
    intent: "final_answer",
    status: "correct",
    local_error: null,
    valid_progress: "That completes the requested nested operation.",
    suggested_next_check: null,
    should_finish: true,
    confidence: 0.98,
    source: "model",
  };
  let semanticChecks = 0;
  let finalAnswerChecks = 0;

  assert.equal(
    isSupportedDerivedFinalCandidate(session, "\\frac{4}{3}"),
    true
  );

  const result = await runVerifierRegistry({
    session,
    message: "\\frac{4}{3}",
    modelVerifyFinalAnswer: async () => {
      finalAnswerChecks += 1;
      return modelFinal;
    },
    modelVerify: async () => {
      semanticChecks += 1;
      return modelFinal;
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.intent, "final_answer");
  assert.equal(result.should_finish, true);
  assert.equal(result.source, "model");
  assert.equal(semanticChecks, 1);
  assert.equal(finalAnswerChecks, 1);
});

test("ambiguous algebraic rejections get a semantic model check", async () => {
  const session = makeSession({
    problem:
      "A box contains some green marbles and exactly four red marbles. The probability of selecting a red marble is 2%. If the number of green marbles is doubled, the probability of selecting one of the four red marbles from the box is 1/5%. How many green marbles are in the box before the number of green marbles is doubled?",
    workState: {
      acceptedLines: [
        "1/(g+4) - 1/100 = 2/(g+4) - (z-15)/100",
      ],
      lastValidLine: "1/(g+4) - 1/100 = 2/(g+4) - (z-15)/100",
      rejectedLines: [],
    },
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message:
      "clearing fractions yields: z(g + 4) - 400 = -400 - (z - 15)(2g + 4)",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That is a reasonable clearing-fractions setup from your equation.",
        suggested_next_check: "Check the signs in the resulting equation before simplifying.",
        should_finish: false,
        confidence: 0.88,
        source: "model",
      };
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "correct");
  assert.equal(result.source, "model");
  assert.equal(modelChecks, 1);
});

test("clear local arithmetic errors do not get semantic model rescue", async () => {
  const session = makeSession({
    problem: "What is 4 + 4?",
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "4 + 4 = 4",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      throw new Error("model should not be used for a clear arithmetic error");
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });

  assertStatus(result, "incorrect");
  assert.equal(result.source, "deterministic");
  assert.match(result.local_error || "", /not the same value/i);
  assert.equal(modelChecks, 0);
});

test("model cannot mark an algebraic intermediate equation solved during review", async () => {
  const session = makeSession({
    problem:
      "A box contains some green marbles and exactly four red marbles. The probability of selecting a red marble is 2%. If the number of green marbles is doubled, the probability is 1/5%. How many green marbles are in the box before doubling?",
    workState: {
      acceptedLines: ["x/(g+4)=2/100"],
      lastValidLine: "x/(g+4)=2/100",
      rejectedLines: [],
    },
    solutionGuide: {
      finalAnswer: "6",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });
  let modelChecks = 0;

  const result = await runVerifierRegistry({
    session,
    message: "gx+4x = 2gx - 30g + 4x - 60",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      modelChecks += 1;
      return {
        intent: "final_answer",
        status: "correct",
        local_error: null,
        valid_progress: "That solves the problem.",
        suggested_next_check: null,
        should_finish: true,
        confidence: 0.94,
        source: "model",
      };
    },
    applyConservativePolicy,
    requireEvaluationForUnevaluatedFinal,
  });

  assertStatus(result, "correct");
  assert.equal(result.intent, "submitted_work");
  assert.equal(result.should_finish, false);
  assert.equal(result.source, "model");
  assert.equal(modelChecks, 1);
  assert.match(result.suggested_next_check || "", /solve for the final value/i);
});

test("coach-requested difference-of-squares factorization stays relevant", () => {
  const session = makeSession({
    problem:
      "Positive integer N makes 4N+400 and 4N+529 perfect squares. Find the sum of the digits of N.",
    history: [
      {
        role: "assistant",
        content:
          "Subtract these squares and factor their difference: $129=(\\text{larger square root}-\\text{smaller square root})(\\text{sum})$.",
      },
    ],
    workState: {
      acceptedLines: ["4N+400 and 4N+529 are both perfect squares"],
      lastValidLine: "4N+400 and 4N+529 are both perfect squares",
      rejectedLines: [],
    },
  });

  assert.equal(verifyProblemRelevance(session, "129=(65-64)(65+64)"), null);
  assertStatus(deterministicVerify(session, "129=(65-64)(65+64)"), "correct");
});

test("the number whose digits are requested remains intermediate", () => {
  const session = makeSession({
    problem:
      "Positive integer N makes 4N+400 and 4N+529 perfect squares. What is the sum of the digits of N?",
    solutionGuide: {
      finalAnswer: "15",
      solutionOutline: [],
      keyCheckpoints: [],
      alternateMethods: [],
      commonWrongPaths: [],
      confidence: 1,
      caution: null,
    },
  });
  const incorrectlySolved = {
    intent: "final_answer",
    status: "correct",
    local_error: null,
    valid_progress: "That value of N is correct.",
    suggested_next_check: null,
    should_finish: true,
    confidence: 0.96,
    source: "model",
  };

  const result = requireEvaluationForUnevaluatedFinal(
    incorrectlySolved,
    "N=924",
    session
  );

  assertStatus(result, "correct");
  assert.equal(result.intent, "submitted_work");
  assert.equal(result.should_finish, false);
  assert.match(result.suggested_next_check || "", /sum of.*digits/i);
});

test("anchored radical product simplification is accepted symbolically", async () => {
  const session = makeSession({
    problem:
      "Six congruent regular hexagonal blocks fill part of a frame. Find the area occupied by all six blocks.",
    workState: {
      acceptedLines: ["Area of each block is $\\frac{3\\sqrt{3}}{2}$"],
      lastValidLine: "Area of each block is $\\frac{3\\sqrt{3}}{2}$",
      rejectedLines: [],
    },
  });

  const result = await canonicalSympyVerify(
    session,
    "6\\cdot\\frac{3\\sqrt{3}}{2}=9\\sqrt{3}"
  );

  assertStatus(result, "correct");
  assert.equal(result.should_finish, false);
  assert.equal(result.source, "symbolic");

  const routed = await runVerifierRegistry({
    session,
    message: "6\\cdot\\frac{3\\sqrt{3}}{2}=9\\sqrt{3}",
    modelVerifyFinalAnswer: async () => null,
    modelVerify: async () => {
      throw new Error("anchored radical simplification should be symbolic");
    },
    applyConservativePolicy: (verification) => verification,
    requireEvaluationForUnevaluatedFinal: (verification) => verification,
  });
  assertStatus(routed, "correct");
  assert.equal(routed.source, "symbolic");
});

test("coach does not introduce an unestablished substitution value", () => {
  const response = composeCoachResponse(
    {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That is the correct regular-hexagon area formula.",
      suggested_next_check:
        "Use $s=3$ for the outer frame and write its area expression.",
      should_finish: false,
      confidence: 0.94,
      source: "model",
    },
    {
      hintLevel: 2,
      problem: "Find the area of the outer regular hexagonal frame.",
      acceptedLines: ["A=\\frac{3\\sqrt{3}}{2}s^2"],
      lastValidLine: "A=\\frac{3\\sqrt{3}}{2}s^2",
      studentMessage: "A=\\frac{3\\sqrt{3}}{2}s^2",
    }
  );

  assert.doesNotMatch(response, /s\s*=\s*3/);
  assert.match(response, /determine|relationship|next|try/i);
});

test("a substitution value already stated by the coach remains usable", async () => {
  const session = makeSession({
    problem: "Find the area of the outer regular hexagonal frame.",
    history: [
      {
        role: "assistant",
        content: "Use $s=3$ for the outer frame and write its area expression.",
      },
    ],
    workState: {
      acceptedLines: ["A=\\frac{3\\sqrt{3}}{2}s^2"],
      lastValidLine: "A=\\frac{3\\sqrt{3}}{2}s^2",
      rejectedLines: [],
    },
  });

  const result = await canonicalSympyVerify(
    session,
    "A=\\frac{27\\sqrt{3}}{2}"
  );

  assertStatus(result, "correct");
  assert.equal(result.should_finish, false);
  assert.equal(result.source, "symbolic");
});

test("public About page includes required identity, instructions, access details, and video state", () => {
  const fs = require("node:fs");
  const aboutSource = fs.readFileSync(
    path.join(rootDir, "app", "about", "page.tsx"),
    "utf8"
  );
  const homeSource = fs.readFileSync(
    path.join(rootDir, "app", "page.tsx"),
    "utf8"
  );
  const layoutSource = fs.readFileSync(
    path.join(rootDir, "app", "layout.tsx"),
    "utf8"
  );

  assert.match(aboutSource, /About \| Math Coach/);
  assert.match(aboutSource, /How to use Math Coach/);
  assert.match(aboutSource, /helps students reason[\s\S]*challenging math problems/);
  assert.match(aboutSource, /develop problem-solving skills/);
  assert.match(aboutSource, /Review Step/);
  assert.match(aboutSource, /Check Answer/);
  assert.match(aboutSource, /final answer the problem asks for/);
  assert.match(aboutSource, /Competition Mode will show/);
  assert.match(aboutSource, /No account or login is required/);
  assert.match(aboutSource, /References and technology/);
  assert.match(aboutSource, /NEXT_PUBLIC_PRESENTATION_VIDEO_URL/);
  assert.match(aboutSource, /Watch the video presentation/);
  assert.match(aboutSource, /Video presentation coming soon/);
  assert.match(homeSource, /href="\/about"/);
  assert.doesNotMatch(
    homeSource,
    /<h1 className="[^"]*\bml-[^"]*"[^>]*>Math Coach<\/h1>/
  );
  assert.doesNotMatch(homeSource, /showPrivacy|setShowPrivacy|Privacy-first/);
  assert.doesNotMatch(homeSource, /showHowToUse|setShowHowToUse|How to use the coach\?/);
  assert.match(layoutSource, /title:\s*"Math Coach"/);
});

async function main() {
  let failures = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    }
  }

  if (failures > 0) {
    console.error(`${failures} verifier regression test(s) failed.`);
    process.exit(1);
  }

  console.log(`${tests.length} verifier regression tests passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
