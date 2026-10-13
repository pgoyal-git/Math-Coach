import type { CoachSession } from "@/lib/sessionStore";
import type { VerificationResult } from "@/lib/coach-verifier/types";
import {
  equalRational,
  normalizeRational,
  parseSingleArithmeticCandidate,
  splitSingleEquals,
  type Rational,
} from "@/lib/coach-verifier/math";

function parseNumber(text: string) {
  return Number(text.replace(/\s+/g, ""));
}

function parseConsecutiveEllipsisRange(text: string) {
  const match = text.match(
    /(-?\d+)\s*\+\s*(-?\d+)\s*\+\s*(?:\.{3}|…|\\(?:cdots|ldots))\s*\+\s*(-?\d+)/i
  );
  if (!match) return null;

  const first = Number(match[1]);
  const second = Number(match[2]);
  const last = Number(match[3]);
  const step = second - first;
  if (!Number.isInteger(first) || !Number.isInteger(second) || !Number.isInteger(last)) return null;
  if (step === 0) return null;
  if ((last - first) % step !== 0) return null;

  const count = (last - first) / step + 1;
  if (!Number.isInteger(count) || count <= 0) return null;

  return { first, second, last, step, count };
}

function rangeSum({ first, last, count }: { first: number; last: number; count: number }): Rational {
  return normalizeRational({
    numerator: BigInt(first + last) * BigInt(count),
    denominator: BigInt(2),
  });
}

function numericClaimFromMessage(message: string) {
  const equality = splitSingleEquals(message);
  return parseSingleArithmeticCandidate(equality?.right || message);
}

export function verifyConsecutiveRangeSumRewrite(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const priorRange = parseConsecutiveEllipsisRange(session.workState?.lastValidLine || "");
  if (!priorRange) return null;
  if (!/\b(?:sum|total|leftovers?|remaining)\b/i.test(message)) return null;

  const submitted = numericClaimFromMessage(message);
  if (!submitted) return null;

  const expected = rangeSum(priorRange);
  if (equalRational(submitted, expected)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That sum formula matches the listed consecutive range.",
      suggested_next_check: "Now evaluate that expression.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "That sum formula does not match the listed consecutive range.",
    valid_progress: null,
    suggested_next_check:
      "Use the first term, last term, and the number of listed terms in the arithmetic-series sum formula.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyArithmeticSequenceTermClaim(message: string): VerificationResult | null {
  const formula = message.match(/\ba_?n\s*(?:is|=|equals?)\s*(-?\d+)\s*\+\s*\(?\s*n\s*-\s*1\s*\)?\s*\*?\s*(-?\d+)\b/i);
  if (formula) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That matches the arithmetic-sequence form $a_n=a_1+(n-1)d$.",
      suggested_next_check: "Substitute the needed value of $n$ into that formula.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const evaluated = message.match(/\ba_?(\d+)\s*(?:is|=|equals?)\s*(-?\d+)\s*\+\s*\(?\s*(\d+)\s*-\s*1\s*\)?\s*\*?\s*(-?\d+)\s*(?:=|is|equals?)\s*(-?\d+)\b/i);
  if (!evaluated) return null;

  const n = Number(evaluated[1]);
  const first = Number(evaluated[2]);
  const substitutedN = Number(evaluated[3]);
  const difference = Number(evaluated[4]);
  const asserted = Number(evaluated[5]);
  if (n !== substitutedN) return null;

  const actual = first + (n - 1) * difference;

  if (asserted === actual) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: `The arithmetic-sequence value $a_${n}=${actual}$ is correct.`,
      suggested_next_check: "Use that term in the requested condition.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: `$a_${n}$ should be ${actual}, not ${asserted}.`,
    valid_progress: null,
    suggested_next_check: "Check the multiplier $n-1$ in the arithmetic-sequence formula.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyGeometricSequenceClaim(message: string): VerificationResult | null {
  const ratio = message.match(/\b(?:common\s+)?ratio\s*(?:is|=|equals?)\s*(-?\d+(?:\.\d+)?)\b/i);
  if (ratio) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: `Using common ratio ${parseNumber(ratio[1])} is a valid checkpoint if consecutive terms match it.`,
      suggested_next_check: "Now apply the geometric term or sum formula with that ratio.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const sum = message.match(/\b(?:geometric\s+)?sum\s*(?:is|=|equals?)\s*(.+?)\s*(?:=|is|equals?)\s*(-?\d+)\b/i);
  if (!sum) return null;

  const left = parseSingleArithmeticCandidate(sum[1]);
  const right = parseSingleArithmeticCandidate(sum[2]);
  if (!left || !right) return null;

  if (equalRational(left, right)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That geometric sum arithmetic checks out.",
      suggested_next_check: "Use that sum in the problem context.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "That geometric sum arithmetic does not match the expression.",
    valid_progress: null,
    suggested_next_check: "Add the listed geometric terms again.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyFunctionEvaluationClaim(message: string): VerificationResult | null {
  const match = message.match(/\bf\((-?\d+)\)\s*(?:is|=|equals?)\s*(-?\d+)\b/i);
  if (!match || !/\bf\(x\)\s*=/.test(message)) return null;

  const definition = message.match(/\bf\(x\)\s*=\s*([^,;.]+)/i);
  if (!definition) return null;

  const x = Number(match[1]);
  const asserted = Number(match[2]);
  const expression = definition[1]
    .replace(/\bx\b/gi, `(${x})`)
    .replace(/\^/g, "^");
  const actual = parseSingleArithmeticCandidate(expression);
  if (!actual || actual.denominator !== BigInt(1)) return null;

  const actualNumber = Number(actual.numerator);
  if (actualNumber === asserted) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: `The function evaluation $f(${x})=${asserted}$ is correct.`,
      suggested_next_check: "Use that value in the next substitution or comparison.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: `$f(${x})$ evaluates to ${actualNumber}, not ${asserted}.`,
    valid_progress: null,
    suggested_next_check: "Substitute the input into the function rule again.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}
