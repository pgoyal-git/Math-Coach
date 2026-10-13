import {
  canonicalFinalAnswerMatches,
  canonicalSympyVerify,
} from "@/lib/canonicalSympyVerifier";
import {
  verifyBorrowedConsecutiveSheetsSetup,
  verifyMissingConsecutivePagesFinalAnswer,
  verifyMissingConsecutivePagesSetup,
} from "@/lib/coach-verifier/pageNumbers";
import {
  equalRational,
  parseSingleArithmeticCandidate,
} from "@/lib/coach-verifier/math";
import {
  shouldDeferRelevanceToSemanticArithmetic,
  verifyProblemRelevance,
} from "@/lib/coach-verifier/relevance";
import { parseClaim, type Claim } from "@/lib/claimNormalizer";
import {
  deterministicVerify,
  type VerificationResult,
} from "@/lib/coachVerifier";
import type { CoachSession } from "@/lib/sessionStore";
import { symbolicVerify } from "@/lib/symbolicVerifier";

type VerifyState = {
  claim: Claim;
  fallbackResult: VerificationResult | null;
  finalAnswerVerification: VerificationResult | null;
};

export type VerifyContext = {
  session: CoachSession;
  message: string;
  state: VerifyState;
  modelVerifyFinalAnswer: (
    session: CoachSession,
    message: string
  ) => Promise<VerificationResult | null>;
  modelVerify: (
    session: CoachSession,
    message: string
  ) => Promise<VerificationResult>;
  applyConservativePolicy: (result: VerificationResult, studentMessage?: string) => VerificationResult;
  requireEvaluationForUnevaluatedFinal: (
    result: VerificationResult,
    message: string,
    session?: CoachSession
  ) => VerificationResult;
};

export type Verifier = {
  id: string;
  priority: number;
  verify: (context: VerifyContext) => Promise<VerificationResult | null> | VerificationResult | null;
};

function finalAnswerMismatchResult(): VerificationResult {
  return {
    intent: "final_answer",
    status: "incorrect",
    local_error: "That final answer does not match the checked answer.",
    valid_progress: null,
    suggested_next_check: "Recheck the last equation before choosing the final value.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function finalAnswerNeedsCheckableLineResult(): VerificationResult {
  return {
    intent: "final_answer",
    status: "uncertain",
    local_error: null,
    valid_progress: null,
    suggested_next_check:
      "I need one checkable line before I can mark that final answer solved.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function looksLikeSimpleVariableAssignment(message: string) {
  return /^\s*[A-Za-z]\s*=\s*-?\d+(?:\.\d+)?(?:\s*\/\s*\d+)?\s*[\s.!?]*$/i.test(message.trim());
}

function looksLikeSimpleFinalValue(message: string) {
  const trimmed = message
    .replace(/^\s*(?:final\s+answer|answer|final|the\s+answer)\s*(?:is|=|:)?\s*/i, "")
    .trim();
  const withoutLatexCommands = trimmed.replace(/\\(?:sqrt|frac|cdot|times|left|right)/gi, "");
  const hasRadicalScalar =
    /\\sqrt|\bsqrt\b|\u221a/.test(trimmed) &&
    !/[=,;]/.test(trimmed) &&
    !/[a-zA-Z]/.test(withoutLatexCommands) &&
    /^[0-9+\-*/().{}\s\\a-zA-Z\u221a]+$/.test(trimmed);

  return (
    looksLikeSimpleVariableAssignment(trimmed) ||
    /^\s*-?\d+(?:\.\d+)?(?:\s*\/\s*-?\d+)?\s*[\s.!?]*$/i.test(trimmed) ||
    /^\s*\\[dt]?frac\s*\{\s*-?\d+\s*\}\s*\{\s*-?\d+\s*\}\s*[\s.!?]*$/i.test(trimmed) ||
    /^\s*\\[dt]?frac\s*-?\d\s*-?\d\s*[\s.!?]*$/i.test(trimmed) ||
    hasRadicalScalar
  );
}

function scalarSideOfSymbolicEquality(message: string) {
  const equality = message.match(/^\s*(.+?)\s*=\s*(.+?)\s*[.!?]*\s*$/);
  if (!equality) return null;

  const isScalar = (value: string) => looksLikeSimpleFinalValue(value);
  const hasSymbolicQuantity = (value: string) =>
    /[a-zA-Z]/.test(value.replace(/\\(?:frac|sqrt|cdot|times|left|right)/gi, ""));

  if (isScalar(equality[1]) && hasSymbolicQuantity(equality[2])) return equality[1].trim();
  if (isScalar(equality[2]) && hasSymbolicQuantity(equality[1])) return equality[2].trim();
  return null;
}

function isTrueNumericEquality(message: string) {
  const equality = message.match(/^\s*(.+?)\s*=\s*(.+?)\s*[.!?]*\s*$/);
  if (!equality || /[a-zA-Z]/.test(equality[1] + equality[2])) return false;
  const left = parseSingleArithmeticCandidate(equality[1]);
  const right = parseSingleArithmeticCandidate(equality[2]);
  return Boolean(left && right && equalRational(left, right));
}

function simpleFinalValueCandidate(message: string) {
  const equalityScalar = scalarSideOfSymbolicEquality(message);
  const candidateWithPossibleUnits = (equalityScalar || message)
    .replace(/^\s*(?:final\s+answer|answer|final|the\s+answer)\s*(?:is|=|:)?\s*/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();
  const unitBearingScalar = candidateWithPossibleUnits.match(
    /^(-?\d+(?:\.\d+)?(?:\s*\/\s*-?\d+)?|\\[dt]?frac\s*\{\s*-?\d+\s*\}\s*\{\s*-?\d+\s*\})(?:\s+[a-zA-Z]+){1,4}$/i
  )?.[1];
  const candidate = unitBearingScalar || candidateWithPossibleUnits;

  if (!looksLikeSimpleFinalValue(candidate)) return null;
  return parseSingleArithmeticCandidate(candidate);
}

export function isSupportedDerivedFinalCandidate(session: CoachSession, message: string) {
  if (isTrueNumericEquality(message)) return true;

  const submitted = simpleFinalValueCandidate(message);
  if (!submitted) return false;

  return [...(session.workState?.acceptedLines || [])]
    .reverse()
    .some((line) => {
      const equality = line.match(/^\s*(.+?)\s*=\s*(.+?)\s*$/);
      if (!equality) return false;
      const right = parseSingleArithmeticCandidate(equality[2]);
      return Boolean(right && equalRational(submitted, right));
    });
}

function requestedPercentageFromRelationship(session: CoachSession, message: string) {
  const request = session.problem.match(
    /what\s+percentage\s+of\s+([a-zA-Z])\s+is\s+([a-zA-Z])\b/i
  );
  if (!request) return null;

  const base = request[1];
  const target = request[2];
  const compact = message
    .replace(/\$/g, "")
    .replace(/\\(?:left|right)/g, "")
    .replace(/\s+/g, "");
  const percent = "(-?\\d+(?:\\.\\d+)?)%";
  const targetFromBase = compact.match(
    new RegExp(`^${target}=${percent}(?:of)?(?:\\*)?${base}$`, "i")
  );
  const baseToTarget = compact.match(
    new RegExp(`^${percent}(?:of)?(?:\\*)?${base}=${target}$`, "i")
  );
  const value = targetFromBase?.[1] || baseToTarget?.[1];

  return value ? `${value}%` : null;
}

function checkedFinalAnswerResult(): VerificationResult {
  return {
    intent: "final_answer",
    status: "correct",
    local_error: null,
    valid_progress: "That final answer is correct.",
    suggested_next_check: null,
    should_finish: true,
    confidence: 1,
    source: "symbolic",
  };
}

function isClearOperationClaim(claim: Claim) {
  return (
    !claim.allowSymbolicFallback &&
    (claim.candidates.includes("operation_claim") || claim.candidates.includes("factor_claim"))
  );
}

function hasNaturalLanguageMathContext(session: CoachSession) {
  const contextText = [
    session.problem,
    session.strategy?.game_plan || "",
    session.strategy?.what_to_look_for || "",
    session.strategy?.smart_move || "",
    session.strategy?.your_turn || "",
    ...(session.workState?.acceptedLines || []).slice(-3),
    session.workState?.lastValidLine || "",
  ].join(" ");

  return /\b(?:area|volume|perimeter|circumference|diameter|radius|diagonal|base|height|length|width|angle|degree|degrees|minute|hour|clock|hand|position|mean|average|median|slope|distance|probability|formula|theorem|identity|product|sum|difference|ratio|rate|cost|price|cents?|dollars?|each|per|fraction|numerator|denominator|equivalent|subtract(?:ed)?|add(?:ed)?|unknown|variable|total|target|digits?|arrangements?|permutations?|combinations?|ways?|count|outcomes?|left|right|invest(?:ed|ment)?|interest|percent|years?|value|round)\b/i.test(
    contextText
  );
}

function numericTokens(text: string) {
  return new Set(
    [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) =>
      match[0].replace(/^0+(?=\d)/, "")
    )
  );
}

function hasProblemNumberOverlap(session: CoachSession, message: string) {
  const problemNumbers = numericTokens(session.problem);
  if (problemNumbers.size === 0) return false;

  return [...numericTokens(message)].some((value) => problemNumbers.has(value));
}

function hasQuantitativeProseLanguage(message: string) {
  return (
    /\b(?:all|any|none|each|every|total|maximum|minimum|sum|count|ways?|cases?|outcomes?|roll(?:ed|s)?|dice|die|digits?|permutations?|arrangements?|combinations?|probability|favorable|possible|exactly|at least|at most|angle|degrees?|minute|hour|clock|hand|position|rate|distance|length|width|height|area|volume|perimeter|percent|dollars?|cents?|years?|months?|weeks?|days?|hours?|minutes?|seconds?)\b/i.test(
      message
    ) &&
    /(?:\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|half)\b)/i.test(message)
  );
}

function asksForSymbolicExpressionAnswer(problem: string) {
  const normalized = problem.replace(/\s+/g, " ");
  const hasVariable = /\b(?!a\b|i\b)[a-z]\b/.test(normalized);
  const hasConcreteSubstitution = /\bwhen\s+[a-z]\s*=/i.test(normalized);

  return (
    /\b(?:in terms of|expression|formula)\b/i.test(normalized) ||
    (
      /\b(?:how many|how much|what|find|determine)\b/i.test(normalized) &&
      hasVariable &&
      !hasConcreteSubstitution
    )
  );
}

function isSymbolicExpressionFinalSubmission(message: string) {
  return /[a-zA-Z]/.test(message.replace(/\\[a-zA-Z]+/g, "")) && !message.includes("=");
}

function isContextualVariableEquation(claim: Claim, session: CoachSession) {
  return (
    claim.kind === "equation" &&
    /[a-zA-Z]/.test(stripLatexCommandNames(claim.raw)) &&
    hasNaturalLanguageMathContext(session)
  );
}

function isSuccessivePercentModelingExpression(claim: Claim, session: CoachSession) {
  if (claim.kind !== "numeric_expression" && claim.kind !== "expression") return false;

  const percentChanges = session.problem.match(
    /\b(?:increase|increased|decrease|decreased|raise|raised|lower|lowered|discount|discounted)\b[\s\S]{0,35}?\d+(?:\.\d+)?\s*%/gi
  );
  if (!percentChanges || percentChanges.length < 2) return false;

  return (
    /\d/.test(claim.raw) &&
    /[()]/.test(claim.raw) &&
    /[+\-]/.test(claim.raw)
  );
}

function isImageBackedVisualQuantitativeStep(claim: Claim, session: CoachSession) {
  if (!session.problemImage) return false;
  if (
    !["equation", "numeric_expression", "expression", "prose_math", "unknown"].includes(
      claim.kind
    )
  ) {
    return false;
  }

  const visualContext = [session.problem, claim.raw].join(" ");
  return /\b(?:figure|diagram|grid|shaded|covered|tiling|pattern|shown|pictured|image|percent|area|shapes?|squares?|triangles?|polygons?|hexagons?|octagons?|between|adjacent|connecting|forms?)\b/i.test(
    visualContext
  );
}

function shouldAskModelForSemanticStep(claim: Claim, session: CoachSession) {
  if (claim.kind === "final_answer" || claim.kind === "question") return false;
  if (isClearOperationClaim(claim)) return false;
  if (
    asksForSymbolicExpressionAnswer(session.problem) &&
    claim.allowSymbolicFallback &&
    claim.kind === "expression"
  ) {
    return false;
  }

  const text = claim.raw.toLowerCase();
  const hasFormulaLanguage =
    /\b(?:formula|theorem|identity|property|area|volume|perimeter|circumference|diameter|radius|diagonal|base|height|length|width|mean|average|median|slope|distance|probability|product|sum)\b/i.test(
      text
    );
  const hasSetupLanguage =
    /\b(?:set\s*up|use|using|let|define|equals?|is|yields?|gives?)\b/i.test(text) &&
    /\b(?:area|volume|perimeter|circumference|probability|mean|slope|distance|formula|theorem|identity|diagonal|product|sum)\b/i.test(
      text
    );

  return (
    claim.kind === "prose_math" ||
    (
      claim.kind === "unknown" &&
      hasNaturalLanguageMathContext(session) &&
      hasQuantitativeProseLanguage(claim.raw)
    ) ||
    (
      (claim.kind === "numeric_expression" || claim.kind === "expression") &&
      hasNaturalLanguageMathContext(session) &&
      hasProblemNumberOverlap(session, claim.raw)
    ) ||
    shouldDeferRelevanceToSemanticArithmetic(session, claim.raw) ||
    isSuccessivePercentModelingExpression(claim, session) ||
    isImageBackedVisualQuantitativeStep(claim, session) ||
    hasFormulaLanguage ||
    hasSetupLanguage ||
    isContextualVariableEquation(claim, session)
  );
}

function shouldKeepSemanticUncertaintyAwayFromSymbolic(claim: Claim) {
  return claim.kind === "prose_math" || claim.kind === "expression";
}

function isGenericLocalRejection(result: VerificationResult | null) {
  const text = [result?.local_error, result?.suggested_next_check].filter(Boolean).join(" ");

  return (
    result?.status === "incorrect" &&
    /\b(?:symbolic equality|not equivalent|equivalent to the original|does not check out)\b/i.test(text)
  );
}

function isContextualLocalRejection(result: VerificationResult | null) {
  const text = [result?.local_error, result?.suggested_next_check].filter(Boolean).join(" ");

  return (
    result?.status === "incorrect" &&
    /\b(?:not connected|cannot verify|one intermediate|one checkable|last line we know is valid|send just the next local step|not relevant)\b/i.test(
      text
    )
  );
}

function stripLatexCommandNames(message: string) {
  return message.replace(/\\[a-zA-Z]+/g, "");
}

function isLikelyPureArithmetic(message: string) {
  const withoutCommands = stripLatexCommandNames(message);

  return (
    /[0-9]/.test(message) &&
    /[=+\-*/^]|\b(?:plus|minus|times|divided|equals?)\b/i.test(message) &&
    !/[a-zA-Z]/.test(withoutCommands)
  );
}

function hasAlgebraicStructure(message: string) {
  const withoutCommands = stripLatexCommandNames(message);

  return (
    /[a-zA-Z]/.test(withoutCommands) &&
    /[=+\-*/^()]|\\(?:frac|sqrt|cdot|times|div)|\b(?:equals?|is|are|yields?|gives?)\b/i.test(
      message
    )
  );
}

function hasMultiEquationStructure(message: string) {
  const equalSigns = (message.match(/=/g) || []).length;

  return equalSigns >= 2 || (equalSigns >= 1 && /[,;]/.test(message));
}

function hasAlgebraOperationLanguage(message: string) {
  return /\b(?:clear(?:ing)?|substitut(?:e|ing|ed)|expand(?:ing|ed)?|factor(?:ing|ed)?|rearrang(?:e|ing|ed)|solve|isolat(?:e|ing|ed)|simplif(?:y|ying|ied)|reduce|cancel(?:ing|led)?|multiply(?:ing|ied)?|divid(?:e|ing|ed)|combine(?:d|ing)?|distribut(?:e|ing|ed)|square(?:d|ing)?|root)\b/i.test(
    message
  );
}

function hasRecentAcceptedMathContext(session: CoachSession) {
  return Boolean(
    session.workState?.lastValidLine ||
      (session.workState?.acceptedLines && session.workState.acceptedLines.length > 0)
  );
}

function coachRequestedIndependentSetupEquation(session: CoachSession) {
  const latestCoachMessage = [...(session.history || [])]
    .reverse()
    .find((entry) => entry.role === "assistant")?.content;

  if (!latestCoachMessage) return false;

  const normalized = latestCoachMessage.replace(/\s+/g, " ");
  const requestsEquation =
    /\b(?:write|set\s*up|form|give|provide|send)\b.{0,100}\b(?:equation|relationship|relation|constraint)\b/i.test(
      normalized
    );
  const requestsIndependentInformation =
    /\b(?:second|another|additional|other|remaining|next)\b/i.test(normalized) ||
    /\b(?:second|another|other)\b.{0,80}\b(?:data|clue|condition|case|point|trail|observation)\b/i.test(
      normalized
    );

  return requestsEquation && requestsIndependentInformation;
}

function shouldAskModelAfterCodeRejection(
  claim: Claim,
  session: CoachSession,
  message: string,
  deterministicVerification: VerificationResult | null
) {
  if (deterministicVerification?.status !== "incorrect") return false;
  if (!hasRecentAcceptedMathContext(session)) return false;
  if (isLikelyPureArithmetic(message)) return false;

  const isAmbiguousRejection =
    isGenericLocalRejection(deterministicVerification) ||
    isContextualLocalRejection(deterministicVerification);
  if (!isAmbiguousRejection) return false;

  return (
    hasAlgebraicStructure(message) ||
    hasMultiEquationStructure(message) ||
    hasAlgebraOperationLanguage(message) ||
    isContextualVariableEquation(claim, session) ||
    claim.kind === "prose_math"
  );
}

function shouldUseImageForGenericExpressionRejection(
  session: CoachSession,
  claim: Claim,
  deterministicVerification: VerificationResult | null
) {
  return (
    Boolean(session.problemImage) &&
    isGenericLocalRejection(deterministicVerification) &&
    (claim.kind === "numeric_expression" || claim.kind === "expression") &&
    /\b(?:compute|evaluate|simplify|express|fraction|expression)\b/i.test(session.problem)
  );
}

export function shouldCanonicalOverrideLocalRejection(
  deterministicVerification: VerificationResult | null,
  canonicalVerification: VerificationResult | null
) {
  return (
    isGenericLocalRejection(deterministicVerification) &&
    Boolean(canonicalVerification) &&
    (
      canonicalVerification?.status === "correct" ||
      canonicalVerification?.status === "partially_correct" ||
      canonicalVerification?.should_finish
    )
  );
}

export const defaultVerifierRegistry: Verifier[] = [
  {
    id: "problem-family:page-number-final",
    priority: 10,
    verify: ({ session, message }) =>
      verifyMissingConsecutivePagesFinalAnswer(session, message),
  },
  {
    id: "problem-family:page-number-setup",
    priority: 20,
    verify: ({ session, message }) => verifyMissingConsecutivePagesSetup(session, message),
  },
  {
    id: "problem-family:borrowed-consecutive-sheets-setup",
    priority: 25,
    verify: ({ session, message }) =>
      verifyBorrowedConsecutiveSheetsSetup(session, message),
  },
  {
    id: "relevance",
    priority: 30,
    verify: ({ session, message }) => verifyProblemRelevance(session, message),
  },
  {
    id: "code:deterministic-canonical-symbolic",
    priority: 40,
    async verify(context) {
      const { session, message } = context;
      const deterministicVerification = deterministicVerify(session, message);
      const symbolicFallbackAllowed = context.state.claim.allowSymbolicFallback;
      const semanticArithmeticStep = shouldDeferRelevanceToSemanticArithmetic(
        session,
        message
      );
      const semanticModelingStep = isSuccessivePercentModelingExpression(
        context.state.claim,
        session
      );
      const imageBackedVisualStep = isImageBackedVisualQuantitativeStep(
        context.state.claim,
        session
      );
      const imageBackedExpressionRejection = shouldUseImageForGenericExpressionRejection(
        session,
        context.state.claim,
        deterministicVerification
      );
      const requestedIndependentSetupEquation =
        context.state.claim.kind === "equation" &&
        coachRequestedIndependentSetupEquation(session);
      const symbolicEqualityFinalSide = scalarSideOfSymbolicEquality(message);
      const symbolicEqualitySideMatchesFinal = symbolicEqualityFinalSide
        ? await canonicalFinalAnswerMatches(session, symbolicEqualityFinalSide)
        : null;
      const simpleSubmissionMatchesFinal = looksLikeSimpleFinalValue(message)
        ? await canonicalFinalAnswerMatches(session, message)
        : null;
      const requestedPercentage = requestedPercentageFromRelationship(session, message);
      const requestedPercentageMatchesFinal = requestedPercentage
        ? await canonicalFinalAnswerMatches(session, requestedPercentage)
        : null;
      const numericEquality = message.match(/^\s*(.+?)\s*=\s*(-?\d+(?:\.\d+)?(?:\s*\/\s*\d+)?)\s*[.!?]*\s*$/);
      const numericEqualityMatchesFinal = numericEquality
        ? await canonicalFinalAnswerMatches(session, numericEquality[2])
        : null;
      const supportedDerivedFinal = isSupportedDerivedFinalCandidate(session, message);
      const derivedFinalMatchesCheckedAnswer = supportedDerivedFinal
        ? await canonicalFinalAnswerMatches(session, message)
        : null;
      const needsSemanticGuideConflictReview =
        supportedDerivedFinal && derivedFinalMatchesCheckedAnswer === false;

      if (simpleSubmissionMatchesFinal === true) {
        return context.requireEvaluationForUnevaluatedFinal(
          checkedFinalAnswerResult(),
          message,
          session
        );
      }

      if (requestedPercentageMatchesFinal === true) {
        return context.requireEvaluationForUnevaluatedFinal(
          checkedFinalAnswerResult(),
          message,
          session
        );
      }

      if (
        numericEqualityMatchesFinal === true &&
        isTrueNumericEquality(message)
      ) {
        return context.requireEvaluationForUnevaluatedFinal(
          checkedFinalAnswerResult(),
          message,
          session
        );
      }

      if (
        deterministicVerification &&
        deterministicVerification.status !== "incorrect" &&
        deterministicVerification.suggested_next_check &&
        !needsSemanticGuideConflictReview &&
        symbolicEqualitySideMatchesFinal !== true &&
        !semanticArithmeticStep &&
        !imageBackedVisualStep &&
        (!semanticModelingStep || deterministicVerification.source === "deterministic")
      ) {
        return deterministicVerification;
      }

      if (
        (
          shouldAskModelForSemanticStep(context.state.claim, session) ||
          semanticArithmeticStep ||
          imageBackedVisualStep ||
          imageBackedExpressionRejection ||
          requestedIndependentSetupEquation ||
          needsSemanticGuideConflictReview
        ) &&
        (
          semanticArithmeticStep ||
          semanticModelingStep ||
          imageBackedVisualStep ||
          imageBackedExpressionRejection ||
          requestedIndependentSetupEquation ||
          needsSemanticGuideConflictReview ||
          !deterministicVerification ||
          (
            isGenericLocalRejection(deterministicVerification) &&
            !(
              context.state.claim.kind === "equation" &&
              hasRecentAcceptedMathContext(session)
            )
          )
        )
      ) {
        const semanticVerification = context.applyConservativePolicy(
          context.requireEvaluationForUnevaluatedFinal(
            await context.modelVerify(session, message),
            message,
            session
          ),
          message
        );

        if (semanticVerification.should_finish || semanticVerification.intent === "final_answer") {
          context.state.fallbackResult = semanticVerification;
          return null;
        }

        if (semanticVerification.status !== "uncertain") {
          return semanticVerification;
        }

        context.state.fallbackResult = semanticVerification;

        if (imageBackedExpressionRejection) {
          return semanticVerification;
        }

        if (shouldKeepSemanticUncertaintyAwayFromSymbolic(context.state.claim)) {
          return deterministicVerification || null;
        }
      }

      const canonicalVerification = symbolicFallbackAllowed
        ? await canonicalSympyVerify(session, message)
        : null;
      const evaluatedCanonicalVerification = canonicalVerification
        ? context.requireEvaluationForUnevaluatedFinal(canonicalVerification, message, session)
        : null;

      if (
        shouldCanonicalOverrideLocalRejection(
          deterministicVerification,
          evaluatedCanonicalVerification
        )
      ) {
        return evaluatedCanonicalVerification;
      }

      if (deterministicVerification?.status === "incorrect" && !evaluatedCanonicalVerification?.should_finish) {
        if (
          shouldAskModelAfterCodeRejection(
            context.state.claim,
            session,
            message,
            deterministicVerification
          )
        ) {
          const semanticVerification = context.applyConservativePolicy(
            context.requireEvaluationForUnevaluatedFinal(
              await context.modelVerify(session, message),
              message,
              session
            ),
            message
          );

          if (semanticVerification.status !== "uncertain") {
            return semanticVerification;
          }

          context.state.fallbackResult = semanticVerification;
        }

        return deterministicVerification;
      }

      if (
        evaluatedCanonicalVerification?.status === "correct" &&
        evaluatedCanonicalVerification.source === "symbolic" &&
        asksForSymbolicExpressionAnswer(session.problem) &&
        isSymbolicExpressionFinalSubmission(message)
      ) {
        return {
          ...evaluatedCanonicalVerification,
          intent: "final_answer",
          valid_progress: "That final answer is correct.",
          suggested_next_check: null,
          should_finish: true,
        };
      }

      if (evaluatedCanonicalVerification) return evaluatedCanonicalVerification;

      const rawSymbolicVerification =
        symbolicFallbackAllowed &&
        (!deterministicVerification || deterministicVerification.status === "incorrect")
          ? await symbolicVerify(session, message)
          : null;
      const symbolicVerification = rawSymbolicVerification
        ? context.requireEvaluationForUnevaluatedFinal(rawSymbolicVerification, message, session)
        : null;

      const codeVerification =
        deterministicVerification?.status === "incorrect" &&
        symbolicVerification &&
        (symbolicVerification.status === "correct" || symbolicVerification.should_finish)
          ? symbolicVerification
          : deterministicVerification || symbolicVerification;
      const evaluatedCodeVerification = codeVerification
        ? context.requireEvaluationForUnevaluatedFinal(codeVerification, message, session)
        : null;

      if (evaluatedCodeVerification?.should_finish) return evaluatedCodeVerification;

      if (isClearOperationClaim(context.state.claim) && !evaluatedCodeVerification) {
        context.state.fallbackResult = {
          intent: "submitted_work",
          status: "uncertain",
          local_error: null,
          valid_progress: null,
          suggested_next_check:
            "That sounds like an algebra move. Write the resulting expression so I can check it.",
          should_finish: false,
          confidence: 0.85,
          source: "deterministic",
        };
        return null;
      }

      context.state.fallbackResult = evaluatedCodeVerification || null;
      return null;
    },
  },
  {
    id: "final-answer",
    priority: 50,
    async verify(context) {
      if (isClearOperationClaim(context.state.claim)) return null;

      const { session, message } = context;
      const rawFinalAnswerVerification = await context.modelVerifyFinalAnswer(session, message);
      const finalAnswerVerification = rawFinalAnswerVerification
        ? context.requireEvaluationForUnevaluatedFinal(rawFinalAnswerVerification, message, session)
        : null;
      context.state.finalAnswerVerification = finalAnswerVerification;

      const finalAnswerMatches =
        finalAnswerVerification?.should_finish
          ? await canonicalFinalAnswerMatches(
              session,
              scalarSideOfSymbolicEquality(message) || message
            )
          : null;

      if (finalAnswerVerification?.should_finish && finalAnswerMatches === false) {
        const supportedSemanticFinal =
          context.state.fallbackResult?.source === "model" &&
          context.state.fallbackResult.should_finish &&
          context.state.fallbackResult.status === "correct" &&
          context.state.fallbackResult.confidence >= 0.9 &&
          isSupportedDerivedFinalCandidate(session, message);
        if (supportedSemanticFinal) return context.state.fallbackResult;
        return finalAnswerMismatchResult();
      }

      if (
        finalAnswerVerification?.should_finish &&
        finalAnswerMatches === null &&
        session.solutionGuide?.finalAnswer
      ) {
        return finalAnswerNeedsCheckableLineResult();
      }

      if (finalAnswerVerification?.should_finish) return finalAnswerVerification;

      if (
        finalAnswerVerification &&
        !looksLikeSimpleVariableAssignment(message) &&
        (!context.state.fallbackResult || context.state.fallbackResult.should_finish)
      ) {
        context.state.fallbackResult = finalAnswerVerification;
      }

      return null;
    },
  },
  {
    id: "model-fallback",
    priority: 100,
    async verify(context) {
      const selectedVerification =
        context.state.fallbackResult ||
        (looksLikeSimpleVariableAssignment(context.message)
          ? null
          : context.state.finalAnswerVerification) ||
        (await context.modelVerify(context.session, context.message));

      return context.applyConservativePolicy(
        context.requireEvaluationForUnevaluatedFinal(
          selectedVerification,
          context.message,
          context.session
        ),
        context.message
      );
    },
  },
];

export async function runVerifierRegistry(
  context: Omit<VerifyContext, "state">,
  registry: Verifier[] = defaultVerifierRegistry
) {
  const state: VerifyState = {
    claim: parseClaim(context.message),
    fallbackResult: null,
    finalAnswerVerification: null,
  };
  const fullContext: VerifyContext = { ...context, state };
  const orderedRegistry = [...registry].sort((left, right) => left.priority - right.priority);

  for (const verifier of orderedRegistry) {
    const result = await verifier.verify(fullContext);
    if (result) return result;
  }

  return fullContext.applyConservativePolicy(
    fullContext.requireEvaluationForUnevaluatedFinal(
      await fullContext.modelVerify(fullContext.session, fullContext.message),
      fullContext.message,
      fullContext.session
    )
  );
}
