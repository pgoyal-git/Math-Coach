import type { CoachSession } from "@/lib/sessionStore";
import type { VerificationResult } from "@/lib/coach-verifier/types";
import {
  MAX_EXPONENT,
  NEGATIVE_ONE,
  ONE,
  ZERO,
  type Rational,
  addImplicitMultiplication,
  addRational,
  divideRational,
  equalRational,
  formatRational,
  hasArithmeticOperator,
  multiplyRational,
  normalizeRational,
  parseArithmetic,
  parseArithmeticCandidates,
  parseSingleArithmeticCandidate,
  replaceLatexFractions,
  sanitizeArithmeticExpression,
  splitSingleEquals,
} from "@/lib/coach-verifier/math";
import { lastAssistantMessage, normalizeMathText } from "@/lib/coach-verifier/context";

export function wasAskedToApplyMove(session: CoachSession) {
  return /after you (do|apply|carry out) this|after you do that|equation look/i.test(
    lastAssistantMessage(session)
  );
}

function wasAskedToDivideByTen(session: CoachSession) {
  return /divid(e|ing) both sides by 10|after you do that|after you apply it/i.test(
    lastAssistantMessage(session)
  );
}

export function repeatsOriginalProblem(session: CoachSession, message: string) {
  const normalizedProblem = normalizeMathText(session.problem);
  const normalizedMessage = normalizeMathText(message);

  return (
    normalizedMessage.length > 0 &&
    (normalizedProblem.includes(normalizedMessage) || normalizedMessage.includes(normalizedProblem))
  );
}

export function isPowerOfTenSquareRootShortcut(session: CoachSession, message: string) {
  const recentText = session.history
    .slice(-6)
    .map((entry) => entry.content)
    .join(" ");
  const normalizedProblem = normalizeMathText(session.problem);
  const normalizedRecent = normalizeMathText(recentText);
  const normalizedMessage = normalizeMathText(message);

  return (
    (normalizedProblem.includes("1010^x^2=100000") ||
      normalizedRecent.includes("10^x^2=10000") ||
      (wasAskedToDivideByTen(session) && normalizedProblem.includes("1010^x^2=100000"))) &&
    normalizedMessage === "10^x=100"
  );
}

export function isBadDivideByTenResult(session: CoachSession, message: string) {
  const normalizedProblem = normalizeMathText(session.problem);
  const normalizedMessage = normalizeMathText(message);

  return (
    wasAskedToDivideByTen(session) &&
    normalizedProblem.includes("1010^x^2=100000") &&
    normalizedMessage === "10^x^2=100000"
  );
}

export function isCorrectDivideByTenResult(session: CoachSession, message: string) {
  const normalizedProblem = normalizeMathText(session.problem);
  const normalizedMessage = normalizeMathText(message);

  return (
    wasAskedToDivideByTen(session) &&
    normalizedProblem.includes("1010^x^2=100000") &&
    normalizedMessage === "10^x^2=10000"
  );
}

export function verifySquareRootBothSidesQuestion(session: CoachSession, message: string): VerificationResult | null {
  if (!/square\s*root|sqrt/i.test(message) || !/both\s+sides/i.test(message)) {
    return null;
  }

  const recentText = session.history
    .slice(-6)
    .map((entry) => entry.content)
    .join(" ");
  const normalizedRecent = normalizeMathText(recentText);

  if (normalizedRecent.includes("10^x^2=10000")) {
    return {
      intent: "question",
      status: "correct",
      local_error: null,
      valid_progress: "Taking the square root of both sides is valid here because $10^x$ is positive.",
      suggested_next_check: "Write the equation you get after taking the square root.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return null;
}

function leadingCoefficient(problem: string) {
  const leftSide = problem.split("=")[0] || "";
  const matches = [...leftSide.matchAll(/(\d+)\s*(?=\(|[a-z]|\\)/gi)];
  const match = matches.at(-1);

  return match ? Number(match[1]) : null;
}

function leadingUnitFractionDenominator(problem: string) {
  const leftSide = problem.split("=")[0] || "";
  const latexMatch = leftSide.match(/\\frac\s*\{\s*1\s*\}\s*\{\s*(-?\d+)\s*\}\s*(?=\(|[a-z]|\\)/i);
  const plainMatch = leftSide.match(/(?:^|[^\d])1\s*\/\s*(-?\d+)\s*(?=\(|[a-z]|\\)/i);
  const denominator = Number(latexMatch?.[1] ?? plainMatch?.[1]);

  return Number.isInteger(denominator) && denominator !== 0 ? denominator : null;
}

function normalizeSymbolicSide(text: string) {
  return text
    .toLowerCase()
    .replace(/\\left|\\right/g, "")
    .replace(/\\cdot|\\times|[×·]/g, "*")
    .replace(/\s+/g, "")
    .replace(/[{}[\]()]/g, "")
    .replace(/\*/g, "");
}

function extractLeadingUnitFractionEquation(problem: string) {
  const equality = splitSingleEquals(problem);
  if (!equality) return null;

  const latexMatch = equality.left.match(
    /\\frac\s*\{\s*1\s*\}\s*\{\s*(-?\d+)\s*\}\s*\*?\s*(.+)$/i
  );
  const plainMatch = equality.left.match(
    /(?:^|[^0-9])\(?\s*1\s*\/\s*(-?\d+)\s*\)?\s*\*?\s*(.+)$/i
  );
  const match = latexMatch || plainMatch;
  if (!match) return null;

  const denominator = Number(match[1]);
  if (!Number.isInteger(denominator) || denominator === 0) return null;

  return {
    denominator,
    expression: match[2],
    right: equality.right,
  };
}

export function verifyClearedLeadingFractionEquation(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const original = extractLeadingUnitFractionEquation(session.problem);
  const submitted = splitSingleEquals(message);
  if (!original || !submitted) return null;

  if (normalizeSymbolicSide(original.expression) !== normalizeSymbolicSide(submitted.left)) {
    return null;
  }

  const originalRight = parseArithmetic(original.right);
  const submittedRightCandidates = parseArithmeticCandidates(submitted.right);
  if (!originalRight || submittedRightCandidates.length === 0) return null;

  const expectedRight = multiplyRational(originalRight, {
    numerator: BigInt(original.denominator),
    denominator: ONE,
  });

  if (!submittedRightCandidates.some((candidate) => equalRational(candidate, expectedRight))) {
    return null;
  }

  return {
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: "That equation correctly clears the leading fraction.",
    suggested_next_check: "Simplify the right side, then compare both sides as powers if possible.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyMultiplyBothSidesQuestion(session: CoachSession, message: string): VerificationResult | null {
  const match = message.match(/multiply(?:ing)?(?:\s+both\s+sides)?\s+by\s+(-?\d+)/i);
  if (!match) return null;

  const multiplier = Number(match[1]);

  if (multiplier === 0) {
    return {
      intent: "question",
      status: "incorrect",
      local_error: "Multiplying both sides by 0 would erase the information in the equation.",
      valid_progress: null,
      suggested_next_check: "What nonzero factor are you trying to clear?",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const denominator = leadingUnitFractionDenominator(session.problem);

  if (denominator && Math.abs(multiplier) === Math.abs(denominator)) {
    return {
      intent: "question",
      status: "correct",
      local_error: null,
      valid_progress: `Multiplying both sides by ${multiplier} is valid and clears the leading fraction.`,
      suggested_next_check: "What equation do you get after applying that multiplication to both sides?",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "question",
    status: "partially_correct",
    local_error: null,
    valid_progress: `Multiplying both sides by ${multiplier} is algebraically allowed, but check whether it clears the fraction you are targeting.`,
    suggested_next_check: denominator
      ? `Which number would clear the leading fraction with denominator ${denominator}?`
      : "What factor are you trying to clear?",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyDivideBothSidesQuestion(session: CoachSession, message: string): VerificationResult | null {
  const match = message.match(/divid(?:e|ing)\s+both\s+sides\s+by\s+(-?\d+)/i);
  if (!match) return null;

  const divisor = Number(match[1]);

  if (divisor === 0) {
    return {
      intent: "question",
      status: "incorrect",
      local_error: "You cannot divide both sides by 0.",
      valid_progress: null,
      suggested_next_check: "What nonzero factor are you trying to remove?",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const coefficient = leadingCoefficient(session.problem);

  if (coefficient && Math.abs(divisor) === coefficient) {
    return {
      intent: "question",
      status: "correct",
      local_error: null,
      valid_progress: `Dividing both sides by ${divisor} is valid and removes the leading factor.`,
      suggested_next_check: "What equation do you get after applying that division to both sides?",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "question",
    status: "partially_correct",
    local_error: null,
    valid_progress: `Dividing both sides by ${divisor} is algebraically allowed, but it may not be the most useful move.`,
    suggested_next_check: coefficient
      ? `Which number would cancel the leading factor ${coefficient}?`
      : "What factor are you trying to remove?",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyCommonPowerFactorMove(session: CoachSession, message: string): VerificationResult | null {
  const move = message.match(
    /\b(?:factor(?:\s+out)?|take\s+out|pull\s+out)\s+(\d+)\s*(?:\^|\*\*)\s*\{?(\d+)\}?\s+from\s+(?:the\s+)?(top\s+and\s+bottom|numerator\s+and\s+denominator|top|bottom|numerator|denominator)\b/i
  );
  if (!move) return null;

  const base = Number(move[1]);
  const exponent = Number(move[2]);
  const target = move[3].toLowerCase();
  if (!Number.isInteger(base) || !Number.isInteger(exponent)) return null;

  const fractionParts = extractFirstLatexFractionParts(session.problem);
  const normalizedProblem = normalizeMathText(session.problem)
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "$1/$2")
    .replace(/[{}]/g, "");
  const parts = fractionParts || splitProblemFraction(normalizedProblem);
  const numeratorPowers = extractBasePowerExponents(parts?.numerator || normalizedProblem, base);
  const denominatorPowers = extractBasePowerExponents(parts?.denominator || "", base);
  const targetPowers =
    target === "top" || target === "numerator"
      ? numeratorPowers
      : target === "bottom" || target === "denominator"
        ? denominatorPowers
        : [...numeratorPowers, ...denominatorPowers];

  if (targetPowers.length < 1) return null;
  const targetLabel =
    target === "top" || target === "numerator"
      ? "numerator"
      : target === "bottom" || target === "denominator"
        ? "denominator"
        : "numerator and denominator";

  if (targetPowers.every((power) => power >= exponent)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: `That is a valid factor to pull from the ${targetLabel}.`,
      suggested_next_check: "Write the expression after pulling out that factor, keeping the remaining powers in place.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: `That power is not a factor of every term in the ${targetLabel}.`,
    valid_progress: null,
    suggested_next_check: "Compare the exponent you chose with the smallest exponent in that part.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function readBalancedLatexGroup(text: string, start: number) {
  let index = start;
  while (/\s/.test(text[index] || "")) index += 1;
  if (text[index] !== "{") return null;

  let depth = 0;
  const contentStart = index + 1;

  while (index < text.length) {
    const char = text[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) {
      return {
        content: text.slice(contentStart, index),
        end: index + 1,
      };
    }
    index += 1;
  }

  return null;
}

function extractFirstLatexFractionParts(text: string) {
  const start = text.indexOf("\\frac");
  if (start === -1) return null;

  const numerator = readBalancedLatexGroup(text, start + "\\frac".length);
  const denominator = numerator ? readBalancedLatexGroup(text, numerator.end) : null;
  if (!numerator || !denominator) return null;

  return {
    numerator: numerator.content,
    denominator: denominator.content,
  };
}

function splitProblemFraction(text: string) {
  const slashIndex = text.indexOf("/");
  if (slashIndex === -1) return null;

  return {
    numerator: text.slice(0, slashIndex),
    denominator: text.slice(slashIndex + 1),
  };
}

function extractBasePowerExponents(text: string, base: number) {
  return [
    ...text.matchAll(new RegExp(`${base}\\s*(?:\\^|\\*\\*)\\s*(?:\\{\\s*)?(\\d+)(?:\\s*\\})?`, "g")),
  ].map((match) => Number(match[1]));
}

function extractOriginalSimplificationExpression(problem: string) {
  if (/[a-z]/i.test(sanitizeArithmeticExpression(problem).replace(/[e]/gi, ""))) return null;

  const parenthesizedFraction = problem.match(/\([^()]+\)\s*\/\s*\([^()]+\)/);
  if (parenthesizedFraction) {
    return parenthesizedFraction[0];
  }

  const compact = sanitizeArithmeticExpression(problem);
  return hasArithmeticOperator(compact) ? compact : null;
}

function asksToSimplifyOriginalExpression(problem: string) {
  if (/\b(?:how many|probability|outcomes?|ways?|arrangements?|permutations?|combinations?)\b/i.test(problem)) {
    return false;
  }

  return /\b(?:expression|equivalent|simplif(?:y|ied)|evaluate|compute|value of|express)\b/i.test(problem);
}

function isFinalAnswerSubmission(message: string, value: Rational) {
  const sanitized = addImplicitMultiplication(sanitizeArithmeticExpression(message));
  return (
    /final\s+answer|answer\s*:/i.test(message) ||
    sanitized === formatRational(value) ||
    sanitized === `(${formatRational(value)})`
  );
}

function nextSimplificationCheck(message: string) {
  const sanitized = addImplicitMultiplication(sanitizeArithmeticExpression(message));

  if (/^\(?\d+\)?\+\(?\d+\/\d+\)?$/.test(sanitized)) {
    return "Combine the whole number and fraction by giving the whole number the same denominator.";
  }

  if (/\/\([^()]+\/[^()]+\)/.test(sanitized)) {
    return "Simplify the division by the fraction first.";
  }

  return "Simplify your current expression one small step at a time.";
}

function hasProseAroundArithmetic(message: string) {
  const words = [...message.matchAll(/[A-Za-z]{2,}/g)]
    .map((match) => match[0].toLowerCase())
    .filter((word) => !["answer", "final", "sqrt", "frac"].includes(word));

  return words.length >= 2;
}

function arithmeticSkeleton(text: string) {
  const compact = addImplicitMultiplication(sanitizeArithmeticExpression(text));
  if (!compact || !hasArithmeticOperator(compact)) return null;

  return {
    numbers: [...compact.matchAll(/\d+/g)].map((match) => match[0]),
    operators: [...compact.matchAll(/[+\-*/^]/g)].map((match) => match[0]).join(""),
  };
}

function nearOcrExpressionRestatement(session: CoachSession, originalExpression: string, message: string) {
  if (!session.problemImage) return false;
  if (session.workState?.lastValidLine || session.workState?.acceptedLines?.length) return false;
  if (!/\b(?:compute|evaluate|simplify|express|fraction|expression)\b/i.test(session.problem)) return false;

  const original = arithmeticSkeleton(originalExpression);
  const submitted = arithmeticSkeleton(message);
  if (!original || !submitted) return false;
  if (original.operators !== submitted.operators) return false;
  if (original.numbers.length === 0 || original.numbers.length !== submitted.numbers.length) return false;

  const mismatches = original.numbers.filter((value, index) => value !== submitted.numbers[index]).length;
  return mismatches <= 1;
}

function hasSymbolicOrRadicalContent(text: string) {
  const withoutLatexCommands = text
    .replace(/\\(?:[dt]?frac|cdot|times|ast|div|left|right)\b/gi, "")
    .replace(/\\[a-z]+\b/gi, "");

  return /[a-zA-Z\u221a]/.test(withoutLatexCommands) || /\\sqrt\b|\bradical\b/i.test(text);
}

function misplacedSubtractionBeforeMultiplicationFeedback(
  originalExpression: string,
  message: string
) {
  const compactMath = (text: string) =>
    text
      .replace(/^\s*(?:\$|\\\()\s*/, "")
      .replace(/\s*(?:\$|\\\))\s*$/, "")
      .replace(/\\(?:cdot|times|ast)(?![a-zA-Z])|[\u00d7\u00b7]/g, "*")
      .replace(/\s+/g, "");
  const original = compactMath(originalExpression).match(/^(.+?)-(.+)\*(.+)$/);
  const submitted = compactMath(message).match(/^(.+)\*(.+)$/);
  if (!original || !submitted) return null;

  const minuend = parseSingleArithmeticCandidate(original[1]);
  const subtrahend = parseSingleArithmeticCandidate(original[2]);
  const multiplier = parseSingleArithmeticCandidate(original[3]);
  const submittedFirstFactor = parseSingleArithmeticCandidate(submitted[1]);
  const submittedMultiplier = parseSingleArithmeticCandidate(submitted[2]);
  if (
    !minuend ||
    !subtrahend ||
    !multiplier ||
    !submittedFirstFactor ||
    !submittedMultiplier ||
    !equalRational(multiplier, submittedMultiplier) ||
    !equalRational(
      addRational(
        minuend,
        multiplyRational(
          { numerator: NEGATIVE_ONE, denominator: ONE },
          subtrahend
        )
      ),
      submittedFirstFactor
    )
  ) {
    return null;
  }

  return {
    local_error: `You subtracted ${original[2]} from ${original[1]} before multiplying by ${original[3]}, which changes the order of operations.`,
    suggested_next_check: `Evaluate ${original[2]}\\cdot ${original[3]} first, then subtract that product from ${original[1]}.`,
  };
}

function ungroupedExpandedDenominatorFeedback(
  originalExpression: string,
  message: string
) {
  const compactMath = (text: string) =>
    text
      .replace(/^\s*(?:\$|\\\()\s*/, "")
      .replace(/\s*(?:\$|\\\))\s*$/, "")
      .replace(/\\(?:cdot|times|ast)(?![a-zA-Z])|[\u00d7\u00b7]/g, "*")
      .replace(/\s+/g, "");
  const original = compactMath(originalExpression).match(/^(.+?)\/(.+)$/);
  const submitted = compactMath(message).match(/^(.+?)\/([^*]+)\*(.+)$/);
  if (!original || !submitted) return null;

  const originalNumerator = parseSingleArithmeticCandidate(original[1]);
  const originalDenominator = parseSingleArithmeticCandidate(original[2]);
  const submittedNumerator = parseSingleArithmeticCandidate(submitted[1]);
  const submittedFirstDivisor = parseSingleArithmeticCandidate(submitted[2]);
  if (
    !originalNumerator ||
    !originalDenominator ||
    !submittedNumerator ||
    !submittedFirstDivisor ||
    !equalRational(originalNumerator, submittedNumerator) ||
    !equalRational(originalDenominator, submittedFirstDivisor)
  ) {
    return null;
  }

  return {
    local_error:
      "As written, the multiplication after the slash happens after the division, so those factors are not all in the denominator.",
    suggested_next_check:
      "Group the full product you intend to divide by so every conversion factor stays in the denominator.",
  };
}

export function verifyEquivalentSimplification(session: CoachSession, message: string): VerificationResult | null {
  const lastValidLine = session.workState?.lastValidLine;
  const originalExpression =
    lastValidLine ||
    (asksToSimplifyOriginalExpression(session.problem)
      ? extractOriginalSimplificationExpression(session.problem)
      : null);
  if (!originalExpression) return null;
  if (splitSingleEquals(originalExpression)) return null;
  if (/\bfactor(?:\s+out)?\b|\bcancel\b|\bdivide\s+(?:the\s+)?(?:top|bottom|numerator|denominator)\b/i.test(message)) {
    return null;
  }
  if (message.includes("=")) return null;
  if (!hasArithmeticOperator(message) && !/final\s+answer|answer\s*:/i.test(message)) return null;
  if (hasProseAroundArithmetic(message) && !/final\s+answer|answer\s*:/i.test(message)) return null;
  if (hasSymbolicOrRadicalContent(originalExpression) || hasSymbolicOrRadicalContent(message)) {
    return null;
  }

  const target = parseArithmetic(originalExpression);
  const submittedCandidates = parseArithmeticCandidates(message);
  if (!target || submittedCandidates.length === 0) return null;

  if (!submittedCandidates.some((submitted) => equalRational(target, submitted))) {
    const orderFeedback = misplacedSubtractionBeforeMultiplicationFeedback(
      originalExpression,
      message
    );
    if (orderFeedback) {
      return {
        intent: "submitted_work",
        status: "incorrect",
        local_error: orderFeedback.local_error,
        valid_progress: null,
        suggested_next_check: orderFeedback.suggested_next_check,
        should_finish: false,
        confidence: 1,
        source: "deterministic",
      };
    }

    const denominatorFeedback = ungroupedExpandedDenominatorFeedback(
      originalExpression,
      message
    );
    if (denominatorFeedback) {
      return {
        intent: "submitted_work",
        status: "incorrect",
        local_error: denominatorFeedback.local_error,
        valid_progress: null,
        suggested_next_check: denominatorFeedback.suggested_next_check,
        should_finish: false,
        confidence: 1,
        source: "deterministic",
      };
    }

    if (nearOcrExpressionRestatement(session, originalExpression, message)) {
      return {
        intent: "submitted_work",
        status: "partially_correct",
        local_error: null,
        valid_progress: "That matches the expression structure from the image.",
        suggested_next_check: "Simplify one innermost arithmetic part next.",
        should_finish: false,
        confidence: 1,
        source: "deterministic",
      };
    }

    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: "That line is not equivalent to the original expression.",
      valid_progress: null,
      suggested_next_check: "Check the arithmetic or transformation in that fraction before continuing.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (isFinalAnswerSubmission(message, target)) {
    return {
      intent: "final_answer",
      status: "correct",
      local_error: null,
      valid_progress: "That final answer is equivalent to the original expression.",
      suggested_next_check: null,
      should_finish: true,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "partially_correct",
    local_error: null,
    valid_progress: "That line is equivalent to the original expression.",
    suggested_next_check: nextSimplificationCheck(message),
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

type PowerEquation = {
  base: bigint;
  variable: string;
  value: Rational;
};

function stripOuterParens(text: string) {
  let current = text.trim();

  while (current.startsWith("(") && current.endsWith(")")) {
    let depth = 0;
    let wrapsWholeText = true;

    for (let index = 0; index < current.length; index += 1) {
      const char = current[index];
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (depth === 0 && index < current.length - 1) {
        wrapsWholeText = false;
        break;
      }
    }

    if (!wrapsWholeText) break;
    current = current.slice(1, -1).trim();
  }

  return current;
}

function sanitizePowerSide(text: string) {
  return text
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[{}]/g, "")
    .replace(/\*\*/g, "^");
}

function parsePowerEquation(text: string): PowerEquation | null {
  const equality = splitSingleEquals(text);
  if (!equality) return null;

  const left = stripOuterParens(sanitizePowerSide(equality.left));
  const match = left.match(/^\(?(\d+)\)?\^([a-z])$/);
  if (!match) return null;

  const base = BigInt(match[1]);
  if (base <= ZERO) return null;

  const value = parseSingleArithmeticCandidate(equality.right);
  if (!value) return null;

  return {
    base,
    variable: match[2],
    value,
  };
}

function parseVariableAssignment(text: string) {
  const equality = splitSingleEquals(text.replace(/final\s+answer\s*:/i, "").replace(/\banswer\s*:/i, ""));
  if (!equality) return null;

  const left = sanitizePowerSide(equality.left);
  const right = sanitizePowerSide(equality.right);
  const normal = left.match(/^([a-z])$/) ? { variable: left, valueText: right } : null;
  const reversed = right.match(/^([a-z])$/) ? { variable: right, valueText: left } : null;
  const assignment = normal || reversed;
  if (!assignment) return null;

  const value = parseSingleArithmeticCandidate(assignment.valueText);
  if (!value || value.denominator !== ONE) return null;

  return {
    variable: assignment.variable,
    exponent: value.numerator,
  };
}

function parsePowerExpression(text: string) {
  const sanitized = stripOuterParens(sanitizePowerSide(text));
  const match = sanitized.match(/^(\d+)\^(.+)$/);
  if (!match) return null;

  const base = BigInt(match[1]);
  if (base <= ZERO || base === ONE) return null;

  return {
    base,
    exponent: stripOuterParens(match[2]),
  };
}

function parseSameBasePowerEquation(text: string) {
  const equality = splitSingleEquals(text);
  if (!equality) return null;

  const left = parsePowerExpression(equality.left);
  const right = parsePowerExpression(equality.right);
  if (!left || !right || left.base !== right.base) return null;

  return {
    base: left.base,
    leftExponent: left.exponent,
    rightExponent: right.exponent,
  };
}

function integerPowerExponent(value: bigint, base: bigint) {
  if (value <= ZERO || base <= ONE) return null;

  let current = value;
  let exponent = 0;

  while (current > ONE && current % base === ZERO) {
    current /= base;
    exponent += 1;
  }

  return current === ONE ? exponent : null;
}

function parsePowerOfPowerSide(text: string) {
  const sanitized = stripOuterParens(sanitizePowerSide(text));
  const match = sanitized.match(/^(\d+)?\*?\(?(\d+)\^([a-z])\)?\^(\d+)$/);
  if (!match) return null;

  const coefficient = BigInt(match[1] || "1");
  const base = BigInt(match[2]);
  if (coefficient <= ZERO || base <= ONE) return null;

  return {
    coefficient,
    base,
    variable: match[3],
    outerExponent: Number(match[4]),
  };
}

function parseSameBaseNumericPower(text: string, base: bigint) {
  const power = parsePowerExpression(text);
  if (power && power.base === base && /^\d+$/.test(power.exponent)) {
    return Number(power.exponent);
  }

  const value = parseSingleArithmeticCandidate(text);
  if (!value || value.denominator !== ONE) return null;

  return integerPowerExponent(value.numerator, base);
}

function parseVariablePowerSide(text: string) {
  const sanitized = stripOuterParens(sanitizePowerSide(text));
  const match = sanitized.match(/^([a-z])\^(\d+)$/);
  if (!match) return null;

  return {
    variable: match[1],
    exponent: Number(match[2]),
  };
}

export function verifyCoefficientRemovedFromPowerEquation(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const priorEquality = splitSingleEquals(session.workState?.lastValidLine || session.problem);
  const submittedEquality = splitSingleEquals(message);
  if (!priorEquality || !submittedEquality) return null;

  const priorLeft = parsePowerOfPowerSide(priorEquality.left);
  const submittedLeft = parsePowerOfPowerSide(submittedEquality.left);
  if (!priorLeft || !submittedLeft) return null;
  if (
    priorLeft.coefficient === ONE ||
    submittedLeft.coefficient !== ONE ||
    priorLeft.base !== submittedLeft.base ||
    priorLeft.variable !== submittedLeft.variable ||
    priorLeft.outerExponent !== submittedLeft.outerExponent
  ) {
    return null;
  }

  const coefficientExponent = integerPowerExponent(priorLeft.coefficient, priorLeft.base);
  const priorRightExponent = parseSameBaseNumericPower(priorEquality.right, priorLeft.base);
  const submittedRightExponent = parseSameBaseNumericPower(submittedEquality.right, priorLeft.base);
  if (
    coefficientExponent === null ||
    priorRightExponent === null ||
    submittedRightExponent === null
  ) {
    return null;
  }

  if (submittedRightExponent === priorRightExponent - coefficientExponent) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That equation correctly divides both sides by the coefficient.",
      suggested_next_check: "Now use the power-of-a-power rule on the left side.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "The coefficient was removed from the left, so the right side must be divided by the same coefficient.",
    valid_progress: null,
    suggested_next_check: "Rewrite the right side after dividing by that coefficient.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyPowerOfPowerEquationReduction(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const priorEquality = splitSingleEquals(session.workState?.lastValidLine || session.problem);
  const submittedEquality = splitSingleEquals(message);
  if (!priorEquality || !submittedEquality) return null;

  const priorLeft = parsePowerOfPowerSide(priorEquality.left);
  if (!priorLeft) return null;

  const mistakenVariablePower = parseVariablePowerSide(submittedEquality.left);
  const priorRightExponent = parseSameBaseNumericPower(priorEquality.right, priorLeft.base);
  if (mistakenVariablePower && priorRightExponent !== null) {
    const submittedRight = parseSingleArithmeticCandidate(submittedEquality.right);
    const submittedRightMatchesPriorExponent =
      submittedRight?.denominator === ONE &&
      submittedRight.numerator === BigInt(priorRightExponent);

    if (
      mistakenVariablePower.variable === priorLeft.variable &&
      mistakenVariablePower.exponent === priorLeft.outerExponent &&
      submittedRightMatchesPriorExponent
    ) {
      return {
        intent: "submitted_work",
        status: "incorrect",
        local_error: "The power-of-a-power rule multiplies exponents, so the left side becomes $10^{2x}$, not $x^2$.",
        valid_progress: null,
        suggested_next_check: "Rewrite the left side by multiplying the outside exponent by $x$.",
        should_finish: false,
        confidence: 1,
        source: "deterministic",
      };
    }
  }

  const submittedLeft = parsePowerExpression(submittedEquality.left);
  if (!submittedLeft) return null;
  if (
    priorLeft.coefficient !== ONE ||
    priorLeft.base !== submittedLeft.base ||
    priorLeft.variable !== submittedLeft.exponent
  ) {
    return null;
  }

  const submittedRightExponent = parseSameBaseNumericPower(submittedEquality.right, priorLeft.base);
  if (priorRightExponent === null || submittedRightExponent === null) return null;

  if (
    priorLeft.outerExponent > 0 &&
    priorRightExponent % priorLeft.outerExponent === 0 &&
    submittedRightExponent === priorRightExponent / priorLeft.outerExponent
  ) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That correctly applies the power-of-a-power rule.",
      suggested_next_check: "Now compare the exponents.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "When you simplify the power of a power, divide the right-side exponent by the outside exponent.",
    valid_progress: null,
    suggested_next_check: "Recompute the exponent on the right side, then write that equation again.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyPowerEquationSolution(session: CoachSession, message: string): VerificationResult | null {
  const priorLine = session.workState?.lastValidLine || session.problem;
  const prior = parsePowerEquation(priorLine);
  const submitted = parseVariableAssignment(message);
  if (!prior || !submitted || prior.variable !== submitted.variable) return null;
  if (submitted.exponent < ZERO || submitted.exponent > MAX_EXPONENT) return null;

  const actual = normalizeRational({
    numerator: prior.base ** submitted.exponent,
    denominator: ONE,
  });

  if (equalRational(actual, prior.value)) {
    return {
      intent: "final_answer",
      status: "correct",
      local_error: null,
      valid_progress: "That exponent matches the power equation.",
      suggested_next_check: null,
      should_finish: true,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "That exponent does not match the power equation.",
    valid_progress: null,
    suggested_next_check: "Compare the right side with powers of the same base.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

type LinearExpression = {
  coefficient: Rational;
  constant: Rational;
  variable: string | null;
};

type LinearEquation = {
  coefficient: Rational;
  constant: Rational;
  variable: string;
};

const ZERO_RATIONAL = normalizeRational({ numerator: ZERO, denominator: ONE });
const ONE_RATIONAL = normalizeRational({ numerator: ONE, denominator: ONE });

class LinearParser {
  private index = 0;

  constructor(private readonly text: string) {}

  parse() {
    const value = this.parseExpression();
    if (!value || this.index !== this.text.length) return null;
    return value;
  }

  private parseExpression(): LinearExpression | null {
    let value = this.parseTerm();
    if (!value) return null;

    while (this.peek() === "+" || this.peek() === "-") {
      const operator = this.next();
      const right = this.parseTerm();
      if (!right) return null;
      const next: LinearExpression | null = combineLinear(
        value,
        right,
        operator === "+" ? ONE : NEGATIVE_ONE
      );
      if (!next) return null;
      value = next;
    }

    return value;
  }

  private parseTerm(): LinearExpression | null {
    let value = this.parsePrimary();
    if (!value) return null;

    while (this.peek() === "*" || this.peek() === "/") {
      const operator = this.next();
      const right = this.parsePrimary();
      if (!right) return null;
      const next: LinearExpression | null =
        operator === "*" ? multiplyLinear(value, right) : divideLinear(value, right);
      if (!next) return null;
      value = next;
    }

    return value;
  }

  private parsePrimary(): LinearExpression | null {
    if (this.peek() === "-") {
      this.next();
      const value = this.parsePrimary();
      return value ? scaleLinear(value, NEGATIVE_ONE) : null;
    }

    if (this.peek() === "(") {
      this.next();
      const value = this.parseExpression();
      if (!value || this.next() !== ")") return null;
      return value;
    }

    const number = this.parseInteger();
    if (number) {
      const variable = this.parseVariable();
      return variable
        ? { coefficient: number, constant: ZERO_RATIONAL, variable }
        : { coefficient: ZERO_RATIONAL, constant: number, variable: null };
    }

    const variable = this.parseVariable();
    if (variable) {
      return { coefficient: ONE_RATIONAL, constant: ZERO_RATIONAL, variable };
    }

    return null;
  }

  private parseInteger(): Rational | null {
    const start = this.index;
    while (/\d/.test(this.peek())) {
      this.index += 1;
    }

    if (start === this.index) return null;

    return normalizeRational({
      numerator: BigInt(this.text.slice(start, this.index)),
      denominator: ONE,
    });
  }

  private parseVariable() {
    if (!/[a-z]/.test(this.peek())) return null;
    const variable = this.peek();
    this.index += 1;
    return variable;
  }

  private peek() {
    return this.text[this.index] || "";
  }

  private next() {
    const char = this.peek();
    this.index += 1;
    return char;
  }
}

function scaleRational(value: Rational, factor: bigint) {
  return normalizeRational({
    numerator: value.numerator * factor,
    denominator: value.denominator,
  });
}

function sameVariable(left: string | null, right: string | null) {
  if (!left) return right;
  if (!right || left === right) return left;
  return null;
}

function combineLinear(
  left: LinearExpression,
  right: LinearExpression,
  sign: bigint
): LinearExpression | null {
  const variable = sameVariable(left.variable, right.variable);
  if (left.variable && right.variable && !variable) return null;

  return {
    coefficient: addRational(left.coefficient, scaleRational(right.coefficient, sign)),
    constant: addRational(left.constant, scaleRational(right.constant, sign)),
    variable,
  };
}

function scaleLinear(value: LinearExpression, factor: bigint): LinearExpression {
  return {
    coefficient: scaleRational(value.coefficient, factor),
    constant: scaleRational(value.constant, factor),
    variable: value.variable,
  };
}

function multiplyLinear(left: LinearExpression, right: LinearExpression): LinearExpression | null {
  if (left.variable && right.variable) return null;

  if (left.variable) {
    return {
      coefficient: multiplyRational(left.coefficient, right.constant),
      constant: multiplyRational(left.constant, right.constant),
      variable: left.variable,
    };
  }

  if (right.variable) {
    return {
      coefficient: multiplyRational(right.coefficient, left.constant),
      constant: multiplyRational(right.constant, left.constant),
      variable: right.variable,
    };
  }

  return {
    coefficient: ZERO_RATIONAL,
    constant: multiplyRational(left.constant, right.constant),
    variable: null,
  };
}

function divideLinear(left: LinearExpression, right: LinearExpression): LinearExpression | null {
  if (right.variable || right.constant.numerator === ZERO) return null;

  return {
    coefficient: divideRational(left.coefficient, right.constant) || ZERO_RATIONAL,
    constant: divideRational(left.constant, right.constant) || ZERO_RATIONAL,
    variable: left.variable,
  };
}

function sanitizeLinearExpression(text: string) {
  return replaceLatexFractions(text)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\*\*/g, "^")
    .replace(/[{}[\]]/g, (char) => (char === "{" || char === "[" ? "(" : ")"))
    .replace(/[^0-9a-z+\-*/()]/g, "");
}

function parseLinearExpression(text: string) {
  const sanitized = addImplicitMultiplication(sanitizeLinearExpression(text));
  if (!sanitized || /\^/.test(sanitized)) return null;

  try {
    return new LinearParser(sanitized).parse();
  } catch {
    return null;
  }
}

function parseLinearEquation(text: string): LinearEquation | null {
  const equality = splitSingleEquals(text);
  if (!equality) return null;

  const left = parseLinearExpression(equality.left);
  const right = parseLinearExpression(equality.right);
  if (!left || !right) return null;

  const difference = combineLinear(left, right, NEGATIVE_ONE);
  if (!difference?.variable || difference.coefficient.numerator === ZERO) return null;

  return {
    coefficient: difference.coefficient,
    constant: difference.constant,
    variable: difference.variable,
  };
}

function equalLinearEquation(left: LinearEquation, right: LinearEquation) {
  if (left.variable !== right.variable) return false;

  if (left.constant.numerator === ZERO && right.constant.numerator === ZERO) {
    return true;
  }

  const coefficientRatio = divideRational(left.coefficient, right.coefficient);
  const constantRatio = divideRational(left.constant, right.constant);
  if (!coefficientRatio || !constantRatio) return false;

  return equalRational(coefficientRatio, constantRatio);
}

function solveLinearEquation(equation: LinearEquation) {
  return divideRational(scaleRational(equation.constant, NEGATIVE_ONE), equation.coefficient);
}

function parseIsolatedLinearSolution(text: string) {
  const equality = splitSingleEquals(text);
  if (!equality) return null;

  const left = parseLinearExpression(equality.left);
  const right = parseLinearExpression(equality.right);
  if (!left || !right) return null;

  const isLeftVariable =
    left.variable &&
    equalRational(left.coefficient, ONE_RATIONAL) &&
    left.constant.numerator === ZERO &&
    !right.variable;
  const isRightVariable =
    right.variable &&
    equalRational(right.coefficient, ONE_RATIONAL) &&
    right.constant.numerator === ZERO &&
    !left.variable;

  if (isLeftVariable) {
    return {
      variable: left.variable,
      value: right.constant,
    };
  }

  if (isRightVariable) {
    return {
      variable: right.variable,
      value: left.constant,
    };
  }

  return null;
}

function assignmentSnippets(text: string) {
  const normalized = replaceLatexFractions(text);
  const snippets = [
    ...normalized.matchAll(
      /\b[a-zA-Z]\s*=\s*-?\s*(?:\d+(?:\s*\/\s*\d+)?|\(\s*\d+\s*\)\s*\/\s*\(\s*\d+\s*\))/g
    ),
    ...normalized.matchAll(
      /-?\s*(?:\d+(?:\s*\/\s*\d+)?|\(\s*\d+\s*\)\s*\/\s*\(\s*\d+\s*\))\s*=\s*[a-zA-Z]\b/g
    ),
  ];

  return snippets.map((match) => match[0]);
}

function knownLinearAssignments(session: CoachSession) {
  const assignments = new Map<string, Rational>();
  const sources = [
    session.problem,
    ...(session.workState?.acceptedLines || []),
    session.workState?.lastValidLine || "",
    lastAssistantMessage(session),
  ];

  for (const source of sources) {
    for (const snippet of assignmentSnippets(source)) {
      const solution = parseIsolatedLinearSolution(snippet);
      if (solution?.variable) assignments.set(solution.variable, solution.value);
    }
  }

  return assignments;
}

function substituteKnownLinearAssignments(
  text: string,
  targetVariable: string,
  assignments: Map<string, Rational>
) {
  let substituted = text;

  for (const [variable, value] of assignments.entries()) {
    if (variable === targetVariable) continue;
    substituted = substituted.replace(
      new RegExp(`(?<![A-Za-z])${variable}(?![A-Za-z])`, "gi"),
      `(${formatRational(value)})`
    );
  }

  return substituted;
}

function solvesAfterKnownSubstitutions(
  session: CoachSession,
  message: string
) {
  const isolatedSolution = parseIsolatedLinearSolution(message);
  if (!isolatedSolution?.variable) return null;

  const assignments = knownLinearAssignments(session);
  if (assignments.size === 0) return null;

  const candidates = [
    session.workState?.lastValidLine || "",
    ...(session.workState?.acceptedLines || []).slice().reverse(),
    session.problem,
  ];

  for (const candidate of candidates) {
    if (!candidate || !candidate.includes("=")) continue;

    const substituted = substituteKnownLinearAssignments(
      candidate,
      isolatedSolution.variable,
      assignments
    );
    const equation = parseLinearEquation(substituted);
    if (!equation || equation.variable !== isolatedSolution.variable) continue;

    const expectedSolution = solveLinearEquation(equation);
    if (!expectedSolution) continue;

    return {
      isolatedSolution,
      expectedSolution,
      correct: equalRational(isolatedSolution.value, expectedSolution),
    };
  }

  return null;
}

export function verifySameBaseExponentEquation(session: CoachSession, message: string): VerificationResult | null {
  const priorLine = session.workState?.lastValidLine || session.problem;
  const prior = parseSameBasePowerEquation(priorLine);
  const expectedExponentEquation = prior
    ? parseLinearEquation(`${prior.leftExponent}=${prior.rightExponent}`)
    : null;
  const submitted = parseLinearEquation(message);

  if (!prior || !expectedExponentEquation || !submitted) return null;

  if (equalLinearEquation(expectedExponentEquation, submitted)) {
    const isolatedSolution = parseIsolatedLinearSolution(message);
    const expectedSolution = solveLinearEquation(expectedExponentEquation);

    if (
      isolatedSolution &&
      expectedSolution &&
      isolatedSolution.variable === expectedExponentEquation.variable &&
      equalRational(isolatedSolution.value, expectedSolution)
    ) {
      return {
        intent: "final_answer",
        status: "correct",
        local_error: null,
        valid_progress: "That value solves the exponent equation.",
        suggested_next_check: null,
        should_finish: true,
        confidence: 1,
        source: "deterministic",
      };
    }

    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That correctly compares the exponents because the bases match.",
      suggested_next_check: "Solve that linear equation for the variable.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "When the bases match, the exponents should be equal.",
    valid_progress: null,
    suggested_next_check: "Set the left exponent equal to the right exponent.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyEquivalentLinearEquation(session: CoachSession, message: string): VerificationResult | null {
  const substitutedSolution = solvesAfterKnownSubstitutions(session, message);
  if (substitutedSolution) {
    if (substitutedSolution.correct) {
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That value solves the equation after substituting the known value.",
        suggested_next_check: "Use that value in the next relationship, or state the requested final answer.",
        should_finish: false,
        confidence: 1,
        source: "deterministic",
      };
    }

    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: "That value does not solve the equation after substituting the known value.",
      valid_progress: null,
      suggested_next_check: "Substitute the known value first, then isolate the remaining variable.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const priorLine = session.workState?.lastValidLine || session.problem;
  const prior = parseLinearEquation(priorLine);
  const submitted = parseLinearEquation(message);
  if (!prior || !submitted) return null;

  if (equalLinearEquation(prior, submitted)) {
    const isolatedSolution = parseIsolatedLinearSolution(message);
    const expectedSolution = solveLinearEquation(prior);

    if (
      isolatedSolution &&
      expectedSolution &&
      isolatedSolution.variable === prior.variable &&
      equalRational(isolatedSolution.value, expectedSolution)
    ) {
      return {
        intent: "final_answer",
        status: "correct",
        local_error: null,
        valid_progress: "That value solves the linear equation.",
        suggested_next_check: null,
        should_finish: true,
        confidence: 1,
        source: "deterministic",
      };
    }

    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "Your equation is equivalent to the previous one.",
      suggested_next_check: "Keep isolating the variable one operation at a time.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "That equation is not equivalent to the previous one.",
    valid_progress: null,
    suggested_next_check: "Check that you applied the same operation to both sides.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function normalizeInequalityText(text: string) {
  return text
    .toLowerCase()
    .replace(/\\leq|≤/g, "<=")
    .replace(/\\geq|≥/g, ">=")
    .replace(/[{}[\]]/g, (char) => (char === "{" || char === "[" ? "(" : ")"))
    .replace(/\*\*/g, "^")
    .replace(/\s+/g, "");
}

function splitSingleInequality(text: string) {
  const normalized = normalizeInequalityText(text);
  const match = normalized.match(/^(.+?)(<=|>=|<|>)(.+)$/);
  if (!match) return null;

  return {
    left: match[1],
    operator: match[2],
    right: match[3],
  };
}

function parseSimpleQuadraticInequality(text: string) {
  const inequality = splitSingleInequality(text);
  if (!inequality || inequality.right !== "0") return null;
  const left = inequality.left.replace(/\*/g, "");
  const match = left.match(/^([a-z])\^2([+-])\1$/);
  if (!match) return null;

  return {
    variable: match[1],
    rootConstant: match[2] === "-" ? 1 : -1,
    operator: inequality.operator,
  };
}

function parseFactoredLinearInequality(text: string) {
  const inequality = splitSingleInequality(text);
  if (!inequality || inequality.right !== "0") return null;

  const variableFirst = inequality.left.match(/^([a-z])\*?\(\s*\1\s*([+-])\s*(\d+)\s*\)$/);
  const shiftedFirst = inequality.left.match(/^\(\s*([a-z])\s*([+-])\s*(\d+)\s*\)\*?\1$/);
  const match = variableFirst || shiftedFirst;
  if (!match) return null;

  const variable = match[1];
  const sign = match[2];
  const value = Number(match[3]);
  if (!variable || !Number.isInteger(value)) return null;

  return {
    variable,
    rootConstant: sign === "-" ? value : -value,
    operator: inequality.operator,
  };
}

export function verifyFactoredQuadraticInequality(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const priorLine = session.workState?.lastValidLine || session.problem;
  const prior = parseSimpleQuadraticInequality(priorLine);
  const submitted = parseFactoredLinearInequality(message);
  if (!prior || !submitted) return null;

  const sameInequality =
    prior.variable === submitted.variable &&
    prior.operator === submitted.operator &&
    prior.rootConstant === submitted.rootConstant;

  if (sameInequality) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That is the correct factorization of the quadratic inequality.",
      suggested_next_check:
        "Now find where each factor is zero, then decide where the product is nonpositive.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "That factorization does not match the quadratic expression.",
    valid_progress: null,
    suggested_next_check:
      "Factor out the common $x$ and keep the inequality direction unchanged.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}
