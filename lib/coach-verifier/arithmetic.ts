import type { CoachSession } from "@/lib/sessionStore";
import { canonicalizeNumericTokens } from "@/lib/numericText";
import type { VerificationResult } from "@/lib/coach-verifier/types";
import {
  ONE,
  addRational,
  equalRational,
  normalizeRational,
  parseArithmetic,
  parseArithmeticCandidates,
  parseSingleArithmeticCandidate,
  hasArithmeticOperator,
  multiplyRational,
  replaceLatexFractions,
  splitSingleEquals,
  type Rational,
} from "@/lib/coach-verifier/math";

const SUPERSCRIPT_DIGITS: Record<string, string> = {
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
  "⁴": "4",
  "⁵": "5",
  "⁶": "6",
  "⁷": "7",
  "⁸": "8",
  "⁹": "9",
};

const PERCENT_CHANGE_NUMBER = String.raw`-?\d+(?:\.\d+)?(?:\s+\d+\s*\/\s*\d+)?|-?\d+\s*\/\s*\d+`;

function normalizeSuperscripts(text: string) {
  return text.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (value) =>
    `^${[...value].map((char) => SUPERSCRIPT_DIGITS[char]).join("")}`
  );
}

function smallPower(base: number, exponent: number) {
  if (!Number.isInteger(base) || !Number.isInteger(exponent)) return null;
  if (base < 0 || exponent < 0 || exponent > 20) return null;
  return BigInt(base) ** BigInt(exponent);
}

function extractAbsoluteValueContent(text: string) {
  const match = text.match(/\|([^|]+)\|/);
  return match?.[1]?.trim() || null;
}

function normalizeSimpleChainedPowers(text: string) {
  return text.replace(
    /(\d+)\s*(?:\^|\*\*)\s*\{?\s*(\d+)\s*\}?\s*(?:\^|\*\*)\s*\{?\s*(\d+)\s*\}?/g,
    (match, baseText: string, firstExponentText: string, secondExponentText: string) => {
      const firstPower = smallPower(Number(baseText), Number(firstExponentText));
      if (firstPower === null || firstPower > BigInt(Number.MAX_SAFE_INTEGER)) return match;

      const secondPower = smallPower(Number(firstPower), Number(secondExponentText));
      return secondPower === null ? match : secondPower.toString();
    }
  );
}

function evaluateAbsoluteArithmetic(text: string) {
  const content = extractAbsoluteValueContent(text);
  if (!content) return null;

  const normalized = normalizeSimpleChainedPowers(content)
    .replace(/[{}[\]]/g, (char) => (char === "{" || char === "[" ? "(" : ")"))
    .replace(/[−–—]/g, "-");
  const value = parseArithmetic(normalized);
  if (!value) return null;

  return normalizeRational({
    numerator: value.numerator < BigInt(0) ? -value.numerator : value.numerator,
    denominator: value.denominator,
  });
}

function percentChangeContext(session: CoachSession) {
  const context = [
    session.problem,
    ...(session.workState?.acceptedLines || []).slice(-3),
    session.workState?.lastValidLine || "",
    ...session.history.slice(-4).map((entry) => entry.content),
  ].join(" ");
  const percentContext = /\bpercent(?:age)?\s+(?:increase|decrease|change)|\b(?:increase|decrease|change)\s+in\s+percent\b/i.test(
    context
  );
  const explicitIncrease = context.match(
    new RegExp(`\\b(?:increase(?:d|s)?|grew|rose)\\s+from\\s+(${PERCENT_CHANGE_NUMBER})\\s+to\\s+(${PERCENT_CHANGE_NUMBER})\\b`, "i")
  );
  const explicitDecrease = context.match(
    new RegExp(`\\b(?:decrease(?:d|s)?|fell|dropped)\\s+from\\s+(${PERCENT_CHANGE_NUMBER})\\s+to\\s+(${PERCENT_CHANGE_NUMBER})\\b`, "i")
  );
  const neutralChange = percentContext
    ? context.match(new RegExp(`\\bfrom\\s+(${PERCENT_CHANGE_NUMBER})\\s+to\\s+(${PERCENT_CHANGE_NUMBER})\\b`, "i"))
    : null;
  const match = explicitIncrease || explicitDecrease || neutralChange;
  if (!match) return null;

  const oldValue = parseSingleArithmeticCandidate(decimalExpressionToFractions(match[1]));
  const newValue = parseSingleArithmeticCandidate(decimalExpressionToFractions(match[2]));
  if (!oldValue || !newValue || oldValue.numerator === BigInt(0)) return null;

  const oldText = match[1].trim();
  const newText = match[2].trim();
  const expected = parseArithmetic(
    decimalExpressionToFractions(`((${newText})-(${oldText}))*100/(${oldText})`)
  );
  if (!expected) return null;

  return {
    oldText,
    newText,
    expected,
  };
}

function decimalExpressionToFractions(text: string) {
  return text.replace(/(-?)(\d*)\.(\d+)/g, (_match, sign: string, whole: string, fraction: string) => {
    const digits = `${whole || "0"}${fraction}`;
    const denominator = BigInt(10) ** BigInt(fraction.length);
    const numerator = BigInt(`${sign}${digits}`);

    return `(${numerator.toString()}/${denominator.toString()})`;
  });
}

const METRIC_TO_CENTIMETERS: Record<string, Rational> = {
  millimeter: { numerator: BigInt(1), denominator: BigInt(10) },
  millimeters: { numerator: BigInt(1), denominator: BigInt(10) },
  mm: { numerator: BigInt(1), denominator: BigInt(10) },
  centimeter: { numerator: BigInt(1), denominator: BigInt(1) },
  centimeters: { numerator: BigInt(1), denominator: BigInt(1) },
  cm: { numerator: BigInt(1), denominator: BigInt(1) },
  meter: { numerator: BigInt(100), denominator: BigInt(1) },
  meters: { numerator: BigInt(100), denominator: BigInt(1) },
  m: { numerator: BigInt(100), denominator: BigInt(1) },
};

function parseMetricQuantity(valueText: string, unitText: string) {
  const value = parseSingleArithmeticCandidate(decimalExpressionToFractions(valueText));
  const factor = METRIC_TO_CENTIMETERS[unitText.toLowerCase()];
  return value && factor ? multiplyRational(value, factor) : null;
}

export function verifyMetricUnitConversion(message: string): VerificationResult | null {
  const normalized = canonicalizeNumericTokens(message)
    .replace(/\bis equal to\b/gi, "=")
    .replace(/\bequals\b/gi, "=")
    .replace(/\bis\b/gi, "=")
    .replace(/\s+/g, " ")
    .trim();
  const unit = String.raw`(?:millimeters?|mm|centimeters?|cm|meters?|m)`;
  const number = String.raw`-?\d+(?:\.\d+)?`;
  const match = normalized.match(
    new RegExp(String.raw`^\s*(${number})\s*(${unit})\s*=\s*(${number})\s*(${unit})\s*$`, "i")
  );
  if (!match) return null;

  const left = parseMetricQuantity(match[1], match[2]);
  const right = parseMetricQuantity(match[3], match[4]);
  if (!left || !right) return null;

  if (equalRational(left, right)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That unit conversion checks out.",
      suggested_next_check: "Use the converted measurement in the next relationship.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "That unit conversion changes the measurement.",
    valid_progress: null,
    suggested_next_check: "Recheck the conversion factor between the two units.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function isPercentChangeWork(message: string) {
  return (
    /%|\bpercent\b/i.test(message) &&
    /[+\-*/]|\(|\)|\\frac/.test(message) &&
    /\b100\b/.test(message)
  );
}

function isLikelyFinalPercent(message: string) {
  return /^(?:\s*(?:answer|final answer)\s*(?:is|=|:)?\s*)?-?\d+(?:\.\d+)?\s*(?:%|percent)?\s*$/i.test(
    message
  );
}

function normalizeAssignmentLabel(text: string) {
  return text
    .replace(/\\(?:text|operatorname)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function isNumericArithmeticSide(text: string) {
  if (/\\?sqrt|√|\bradical\b/i.test(text)) return false;

  const withoutLatexWords = replaceLatexFractions(text)
    .replace(/\\(?:cdot|times|ast|div|left|right)\b/g, "")
    .replace(/[a-z]/gi, "");

  return /\d/.test(withoutLatexWords) && withoutLatexWords.trim().length > 0;
}

export function verifyNumericAssignmentRewrite(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const priorLine = session.workState?.lastValidLine;
  if (!priorLine) return null;

  const prior = splitSingleEquals(priorLine);
  const submitted = splitSingleEquals(message);
  if (!prior || !submitted) return null;

  if (normalizeAssignmentLabel(prior.left) !== normalizeAssignmentLabel(submitted.left)) return null;
  if (!isNumericArithmeticSide(prior.right) || !isNumericArithmeticSide(submitted.right)) return null;
  if (!hasArithmeticOperator(prior.right)) return null;

  const priorValue = parseSingleArithmeticCandidate(prior.right);
  const submittedValue = parseSingleArithmeticCandidate(submitted.right);
  if (!priorValue || !submittedValue) return null;

  if (equalRational(priorValue, submittedValue)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That numeric rewrite is equivalent to your previous accepted line.",
      suggested_next_check: "Continue simplifying one arithmetic part at a time.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "That numeric simplification changes the value of the right side.",
    valid_progress: null,
    suggested_next_check: "Recompute each arithmetic part you simplified before rewriting the line.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyPercentChangeClaim(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const context = percentChangeContext(session);
  if (!context || !/%|\bpercent\b/i.test(message)) return null;

  const submittedValues = parseArithmeticCandidates(decimalExpressionToFractions(message));
  if (submittedValues.length === 0) return null;
  const matchesExpected = submittedValues.some((value) => equalRational(value, context.expected));

  if (!matchesExpected) {
    if (!isPercentChangeWork(message)) return null;

    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error:
        "That percent-change setup does not match the old and new values from the problem.",
      valid_progress: null,
      suggested_next_check:
        "Use the value after 'from' as the original amount and the value after 'to' as the new amount.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const shouldFinish = isLikelyFinalPercent(message);

  return {
    intent: shouldFinish ? "final_answer" : "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: shouldFinish
      ? "That percent change matches the old and new values."
      : "That percent-change setup uses the correct old and new values.",
    suggested_next_check: shouldFinish
      ? null
      : "Now evaluate that expression to get the percent increase.",
    should_finish: shouldFinish,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifySuccessivePercentFactorSetup(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const normalizedMessage = message
    .replace(/\\(?:mathopen|mathclose)\s*\{\s*\}/g, "")
    .replace(
      /\\(?:left|right|mleft|mright|bigl|bigr|Bigl|Bigr|biggl|biggr|Biggl|Biggr)\b/g,
      ""
    )
    .replace(/[−–—]/g, "-")
    .replace(/＋/g, "+");
  const changes = [
    ...session.problem.matchAll(
      /\b(increas\w*|rais\w*|decreas\w*|lower\w*|discount\w*)\b[\s\S]{0,35}?(\d+(?:\.\d+)?)\s*%/gi
    ),
  ].map((match) => {
    const rate = parseSingleArithmeticCandidate(decimalExpressionToFractions(match[2]));
    const direction = /^(?:increas|rais)/i.test(match[1]) ? "+" : "-";
    return rate
      ? {
          direction,
          rate: multiplyRational(rate, {
            numerator: ONE,
            denominator: BigInt(100),
          }),
        }
      : null;
  }).filter(
    (
      change
    ): change is {
      direction: string;
      rate: Rational;
    } => Boolean(change)
  );
  if (changes.length < 2) return null;

  const factors = [
    ...normalizedMessage.matchAll(
      /\(\s*1\s*([+-])\s*(\d+(?:\.\d+)?)\s*(%)?\s*\)/g
    ),
  ].map((match) => {
    const rawRate = parseSingleArithmeticCandidate(decimalExpressionToFractions(match[2]));
    if (!rawRate) return null;

    return {
      direction: match[1],
      rate: match[3]
        ? multiplyRational(rawRate, {
            numerator: ONE,
            denominator: BigInt(100),
          })
        : rawRate,
    };
  }).filter(
    (
      factor
    ): factor is {
      direction: string;
      rate: Rational;
    } => Boolean(factor)
  );
  if (factors.length !== changes.length) return null;

  const unmatchedFactors = [...factors];
  const allFactorsMatch = changes.every((change) => {
    const matchIndex = unmatchedFactors.findIndex(
      (factor) =>
        factor.direction === change.direction &&
        equalRational(factor.rate, change.rate)
    );
    if (matchIndex === -1) return false;
    unmatchedFactors.splice(matchIndex, 1);
    return true;
  });
  if (!allFactorsMatch) return null;

  return {
    intent: "submitted_work",
    status: normalizedMessage.includes("=") ? "correct" : "partially_correct",
    local_error: null,
    valid_progress: "Those factors correctly model the successive percent changes.",
    suggested_next_check:
      "Now evaluate the change factors one step at a time, then express the result as a percent.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyAbsoluteValueArithmeticRewrite(
  session: CoachSession,
  message: string
): VerificationResult | null {
  if (!/\|[^|]+\|/.test(message)) return null;

  const priorLine = session.workState?.lastValidLine;
  if (!priorLine || !/\|[^|]+\|/.test(priorLine)) return null;

  const priorValue = evaluateAbsoluteArithmetic(priorLine);
  const submittedValue = evaluateAbsoluteArithmetic(message);
  if (!priorValue || !submittedValue) return null;

  if (equalRational(priorValue, submittedValue)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That absolute-value rewrite is correct.",
      suggested_next_check: "Now simplify the expression inside the absolute value.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "That absolute-value rewrite changes the value.",
    valid_progress: null,
    suggested_next_check: "Evaluate each power again, then rewrite the expression inside the absolute value.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyPairedPowerObservation(message: string): VerificationResult | null {
  const normalized = normalizeSuperscripts(message);
  const matches = [...normalized.matchAll(/\b(\d+)\s*(?:\^|\*\*)\s*(\d+)\b/g)];
  if (matches.length < 2) return null;

  const [first, second] = matches;
  const firstBase = Number(first[1]);
  const firstExponent = Number(first[2]);
  const secondBase = Number(second[1]);
  const secondExponent = Number(second[2]);
  const firstValue = smallPower(firstBase, firstExponent);
  const secondValue = smallPower(secondBase, secondExponent);
  if (firstValue === null || secondValue === null) return null;

  if (firstValue === secondValue) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "Those two power forms have the same value.",
      suggested_next_check: "Use that match to make the next comparison or rewrite.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "partially_correct",
    local_error: null,
    valid_progress: "You identified two power forms to compare.",
    suggested_next_check: "Evaluate each power or rewrite them with a common base before comparing.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifySquareAssertions(message: string): VerificationResult | null {
  const matches = [...message.matchAll(/(\d+)\s*squared\s*(?:is|=)\s*(\d+)/gi)];
  if (matches.length === 0) return null;

  const errors = matches
    .map((match) => {
      const base = Number(match[1]);
      const asserted = Number(match[2]);
      const actual = base * base;
      return asserted === actual ? null : `${base} squared is ${actual}, not ${asserted}.`;
    })
    .filter((error): error is string => Boolean(error));

  if (errors.length > 0) {
    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: errors.join(" "),
      valid_progress: null,
      suggested_next_check: "Recompute the square values before checking the digit condition.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: "The square values stated are correct.",
    suggested_next_check: "Now check which of those values satisfy the requested digit or range condition.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function stripWrappingParens(text: string) {
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

function parseMixedOrPercentValue(text: string) {
  const withoutPercent = stripWrappingParens(text.replace(/%/g, "").trim());
  const latexMixed = withoutPercent.match(
    /^(-?\d+)\s*\\frac\s*\{\s*(\d+)\s*\}\s*\{\s*(\d+)\s*\}$/i
  );
  const plainMixed = replaceLatexFractions(withoutPercent).match(
    /^(-?\d+)\s+(?:\(\()?(\d+)(?:\)\))?\s*\/\s*(?:\(?)(\d+)(?:\)?)$/
  );
  const mixed = latexMixed || plainMixed;

  if (mixed) {
    const whole = BigInt(mixed[1]);
    const numerator = BigInt(mixed[2]);
    const denominator = BigInt(mixed[3]);
    if (denominator === BigInt(0)) return null;

    const fraction = normalizeRational({
      numerator: whole < BigInt(0) ? -numerator : numerator,
      denominator,
    });

    return addRational(
      normalizeRational({
        numerator: whole,
        denominator: ONE,
      }),
      fraction
    );
  }

  return parseSingleArithmeticCandidate(withoutPercent);
}

export function verifyMixedNumberEquality(message: string): VerificationResult | null {
  const equality = splitSingleEquals(message);
  const hasMixedNumberShape =
    /\d+\s+\\[dt]?frac\s*\{\s*\d+\s*\}\s*\{\s*\d+\s*\}/i.test(message) ||
    /\d+\s+\d+\s*\/\s*\d+/.test(message);
  if (!equality || !(/%/.test(message) || hasMixedNumberShape)) return null;

  const left = parseMixedOrPercentValue(equality.left);
  const right = parseMixedOrPercentValue(equality.right);
  if (!left || !right) return null;

  if (equalRational(left, right)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That conversion to an improper fraction checks out.",
      suggested_next_check: "Use that equivalent percent form in the next step.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "That mixed number is not equal to the fraction you wrote.",
    valid_progress: null,
    suggested_next_check: "Convert the whole number part to the same denominator, then add the numerator.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function parseDigitRateContext(problem: string) {
  const speedMatch = problem.match(/\bspeed\s+of\s+(\d+)\s+digits?\s+per\s+second\b/i);
  const secondsMatch = problem.match(/\bend\s+of\s+(\d+)\s+seconds?\b/i);
  if (!speedMatch || !secondsMatch) return null;

  const speed = Number(speedMatch[1]);
  const seconds = Number(secondsMatch[1]);
  if (!Number.isInteger(speed) || !Number.isInteger(seconds)) return null;

  return {
    speed,
    seconds,
    totalDigits: speed * seconds,
  };
}

function parseTargetMeanContext(problem: string) {
  const scoresMatch = problem.match(/\bscores?\s+of\s+([\d,\sand]+?)\s+on\b/i);
  const targetMatch = problem.match(/\bmean\s+(?:test\s+)?scores?\s+of\s+(-?\d+)\b/i);
  if (!scoresMatch || !targetMatch) return null;

  const scores = [...scoresMatch[1].matchAll(/-?\d+/g)].map((match) => Number(match[0]));
  const target = Number(targetMatch[1]);
  if (scores.length === 0 || !Number.isInteger(target)) return null;

  return {
    scores,
    target,
    totalScores: scores.length + 1,
  };
}

function parseDeviationList(message: string, target: number) {
  const listText =
    message.match(/(?:we\s+have|gives?|are|:)\s*([\s\S]+)$/i)?.[1] || message;
  const variableDeviationPattern = new RegExp(`\\b[a-z]\\s*-\\s*${target}\\b`, "i");
  const hasVariableDeviation = variableDeviationPattern.test(listText);
  const numberText = listText.replace(variableDeviationPattern, "");
  const deviations = [...numberText.matchAll(/(?<![a-z])-?\d+/gi)].map((match) =>
    Number(match[0])
  );

  return {
    deviations,
    hasVariableDeviation,
  };
}

type LinearSum = {
  constant: number;
  variable: string | null;
};

function parseAdditiveLinearSum(text: string): LinearSum | null {
  const terms = text
    .replace(/\s+/g, "")
    .split("+")
    .filter(Boolean);
  if (terms.length === 0) return null;

  let constant = 0;
  let variable: string | null = null;

  for (const term of terms) {
    if (/^-?\d+$/.test(term)) {
      constant += Number(term);
      continue;
    }

    if (/^[a-z]$/i.test(term)) {
      if (variable && variable !== term.toLowerCase()) return null;
      variable = term.toLowerCase();
      continue;
    }

    return null;
  }

  return { constant, variable };
}

function extractAdditiveEquation(message: string) {
  const match = message.match(
    /((?:-?\d+|[a-z])(?:\s*\+\s*(?:-?\d+|[a-z]))+)\s*=\s*((?:-?\d+|[a-z])(?:\s*\+\s*(?:-?\d+|[a-z]))*)/i
  );
  if (!match) return null;

  const left = parseAdditiveLinearSum(match[1]);
  const right = parseAdditiveLinearSum(match[2]);
  return left && right ? { left, right } : null;
}

function extractClaimedTotalExpression(message: string) {
  const match = message.match(
    /\b(?:sum|total)\s*(?:of\s+(?:the\s+)?(?:scores?)?)?\s*(?:is|=|:)\s*((?:-?\d+|[a-z])(?:\s*\+\s*(?:-?\d+|[a-z]))*)\b/i
  );
  return match ? parseAdditiveLinearSum(match[1]) : null;
}

function sameLinearSum(left: LinearSum, right: LinearSum) {
  return left.constant === right.constant && left.variable === right.variable;
}

export function verifyTargetMeanSumClaim(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const context = parseTargetMeanContext(session.problem);
  if (!context) return null;
  if (!/\b(?:sum|total|scores?)\b/i.test(message)) return null;

  const knownSum = context.scores.reduce((sum, score) => sum + score, 0);
  const expanded = {
    constant: knownSum,
    variable: "x",
  };

  const equation = message.includes("=") ? extractAdditiveEquation(message) : null;
  const claimedTotal = equation ? null : extractClaimedTotalExpression(message);
  const totalIsCorrect =
    (equation && sameLinearSum(equation.left, expanded) && sameLinearSum(equation.right, expanded)) ||
    (claimedTotal && sameLinearSum(claimedTotal, expanded));

  if (totalIsCorrect) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: `The five known scores add to $${knownSum}$, so the total is $${knownSum}+x$.`,
      suggested_next_check: `Now turn that total into a mean equation using $${context.totalScores}$ scores and target mean $${context.target}$.`,
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (!equation && !claimedTotal) return null;

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: `The five known scores add to $${knownSum}$, so the total should be $${knownSum}+x$.`,
    valid_progress: null,
    suggested_next_check: "Recheck the sum of the known scores before adding the unknown score.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function parseTargetMeanFinalAnswer(message: string) {
  const variableMatch = message.match(/^\s*[a-z]\s*=\s*(-?\d+)\s*\??\s*$/i);
  if (variableMatch) return Number(variableMatch[1]);

  const answerMatch = message.match(
    /\b(?:answer|final|score|scores?|next\s+exam|next\s+test)\s*(?:is|=|:)?\s*(-?\d+)\s*\??\s*$/i
  );
  if (answerMatch) return Number(answerMatch[1]);

  const bareMatch = message.match(/^\s*(-?\d+)\s*\??\s*$/);
  if (bareMatch) return Number(bareMatch[1]);

  return null;
}

export function verifyTargetMeanFinalAnswer(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const context = parseTargetMeanContext(session.problem);
  if (!context) return null;

  const submitted = parseTargetMeanFinalAnswer(message);
  if (!Number.isInteger(submitted)) return null;

  const knownSum = context.scores.reduce((sum, score) => sum + score, 0);
  const requiredScore = context.target * context.totalScores - knownSum;

  if (submitted === requiredScore) {
    return {
      intent: "final_answer",
      status: "correct",
      local_error: null,
      valid_progress: "That score gives the requested mean.",
      suggested_next_check: null,
      should_finish: true,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "final_answer",
    status: "incorrect",
    local_error: "That score does not give the requested mean.",
    valid_progress: null,
    suggested_next_check:
      "Set the total of all the scores equal to the target mean times the number of scores.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyTargetMeanDeviationClaim(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const context = parseTargetMeanContext(session.problem);
  if (!context) return null;

  if (
    !/\b(?:subtract|subtracting|minus)\b/i.test(message) ||
    !/\b(?:mean|average)\b/i.test(message)
  ) {
    return null;
  }

  const mentionedTarget = message.match(/\b(?:mean|average)\D{0,12}(-?\d+)\b/i);
  if (mentionedTarget && Number(mentionedTarget[1]) !== context.target) {
    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: `The target mean in the problem is $${context.target}$, not $${Number(
        mentionedTarget[1]
      )}$.`,
      valid_progress: null,
      suggested_next_check: "Subtract the target mean from each known score.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const mentionedCount = message.match(/\beach\s+of\s+the\s+(\d+)\s+scores?\b/i);
  if (mentionedCount && Number(mentionedCount[1]) !== context.totalScores) {
    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: `There should be $${context.totalScores}$ scores after including the next exam.`,
      valid_progress: null,
      suggested_next_check: "Include the five known scores and the unknown next score.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const expectedDeviations = context.scores.map((score) => score - context.target);
  const { deviations, hasVariableDeviation } = parseDeviationList(message, context.target);
  if (deviations.length < expectedDeviations.length) return null;

  const submittedKnownDeviations = deviations.slice(-expectedDeviations.length);
  const deviationsMatch = expectedDeviations.every(
    (expected, index) => submittedKnownDeviations[index] === expected
  );

  if (deviationsMatch && hasVariableDeviation) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress:
        "Those deviations from the target mean are correct for the known scores and the unknown score.",
      suggested_next_check:
        "Use the fact that the deviations must add to $0$ for the mean to be $90$.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "At least one of the deviations from the target mean is not correct.",
    valid_progress: null,
    suggested_next_check: "Subtract $90$ from each known score one at a time.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function parseCentsPerAcceptedCountContext(session: CoachSession) {
  if (!/\bcents?\b[\s\S]*\b(?:each|per)\b|\b(?:each|per)\b[\s\S]*\bcents?\b/i.test(session.problem)) {
    return null;
  }

  const dollarsMatch = session.problem.match(/\$\s*(\d+(?:\.\d+)?)/);
  if (!dollarsMatch) return null;

  const dollars = parseSingleArithmeticCandidate(dollarsMatch[1]);
  if (!dollars) return null;

  const totalCents = normalizeRational({
    numerator: dollars.numerator * BigInt(100),
    denominator: dollars.denominator,
  });
  if (totalCents.denominator !== ONE) return null;

  const priorValues = arithmeticValuesFromText(
    [
      session.workState?.lastValidLine,
      ...(session.workState?.acceptedLines || []).slice(-3),
    ]
      .filter(Boolean)
      .join(" ")
  ).filter((value) => value.denominator === ONE && value.numerator > BigInt(0));

  if (priorValues.length === 0) return null;

  return {
    totalCents: totalCents.numerator,
    acceptedCounts: priorValues.map((value) => value.numerator),
  };
}

function parseTopLevelFractionOperands(message: string) {
  const latexFraction = message
    .replace(/\$/g, "")
    .trim()
    .match(/^\\frac\s*\{\s*([^{}]+?)\s*\}\s*\{\s*([^{}]+?)\s*\}$/i);
  if (latexFraction) {
    const numerator = parseSingleArithmeticCandidate(latexFraction[1]);
    const denominator = parseSingleArithmeticCandidate(latexFraction[2]);
    return numerator && denominator ? { numerator, denominator } : null;
  }

  const normalized = replaceLatexFractions(message)
    .replace(/\$/g, "")
    .replace(/[âˆ’â€“â€”]/g, "-")
    .trim();
  const match = normalized.match(/^\(?\(?\s*([^()/]+?)\s*\)?\)?\s*\/\s*\(?\s*([^()/]+?)\s*\)?$/);
  if (!match) return null;

  const numerator = parseSingleArithmeticCandidate(match[1]);
  const denominator = parseSingleArithmeticCandidate(match[2]);
  if (!numerator || !denominator) return null;

  return {
    numerator,
    denominator,
  };
}

export function verifyCentsPerAcceptedCountSetup(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const context = parseCentsPerAcceptedCountContext(session);
  if (!context) return null;

  const fraction = parseTopLevelFractionOperands(message);
  if (!fraction) return null;

  const numeratorMatches =
    fraction.numerator.denominator === ONE &&
    fraction.numerator.numerator === context.totalCents;
  const denominatorMatches =
    fraction.denominator.denominator === ONE &&
    context.acceptedCounts.some((count) => fraction.denominator.numerator === count);

  if (!numeratorMatches || !denominatorMatches) return null;

  return {
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: "That setup uses total cents divided by the number of good items.",
    suggested_next_check: "Now evaluate that division to get cents per item.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyDigitRateTotalClaim(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const context = parseDigitRateContext(session.problem);
  if (!context) return null;

  const claim = message.match(
    /\b(?:writes?|wrote|written|total)\b[\s\S]*?\b(?:total\s+of\s+)?(\d+)(?:\s+total)?\s+digits?\b/i
  );
  if (!claim) return null;

  const asserted = Number(claim[1]);
  if (!Number.isInteger(asserted)) return null;

  if (asserted === context.totalDigits) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That total number of digits is correct.",
      suggested_next_check: "Now decide how many of those digits come from the one-digit numbers.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: `The total digits should come from $${context.speed}\\times ${context.seconds}$, not $${asserted}$.`,
    valid_progress: null,
    suggested_next_check: "Recompute just the total number of digits written.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function uniqueRationals(values: Rational[]) {
  return values.filter((value, index) =>
    values.findIndex((candidate) => equalRational(candidate, value)) === index
  );
}

function simpleNumericFragments(text: string) {
  return [
    ...text.matchAll(/-?\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?|-?\d+(?:\.\d+)?\s*\^\s*\d+|-?\d+(?:\.\d+)?/g),
  ].map((match) => match[0]);
}

function arithmeticValuesFromText(text: string) {
  text = canonicalizeNumericTokens(text);

  const percentValues = [...text.matchAll(/(-?\d+(?:\.\d+)?)\s*(?:%|\bpercent\b)/gi)]
    .flatMap((match) => {
      const value = parseSingleArithmeticCandidate(decimalExpressionToFractions(match[1]));
      return value
        ? [
            multiplyRational(value, {
              numerator: ONE,
              denominator: BigInt(100),
            }),
          ]
        : [];
    });

  return uniqueRationals(
    [
      ...percentValues,
      ...simpleNumericFragments(text)
        .map((fragment) => parseSingleArithmeticCandidate(decimalExpressionToFractions(fragment)))
        .filter((value): value is Rational => Boolean(value)),
      ...(hasArithmeticOperator(text) ? parseArithmeticCandidates(text) : []),
    ]
  );
}

function isAnchoredArithmeticEquality(session: CoachSession | undefined, value: Rational) {
  if (!session) return true;

  const latestCoachMessage = [...(session.history || [])]
    .reverse()
    .find((entry) => entry.role === "assistant")?.content;

  const contextValues = uniqueRationals(
    [
      session.problem,
      session.workState?.lastValidLine,
      ...(session.workState?.acceptedLines || []).slice(-3),
      latestCoachMessage,
    ]
      .filter((line): line is string => Boolean(line))
      .flatMap(arithmeticValuesFromText)
  );

  return contextValues.some((contextValue) => equalRational(contextValue, value));
}

function hasAnchoredArithmeticValue(session: CoachSession | undefined, message: string) {
  if (!session) return true;

  return arithmeticValuesFromText(message).some((value) =>
    isAnchoredArithmeticEquality(session, value)
  );
}

function verifyArithmeticEqualityChain(
  message: string,
  session?: CoachSession
): VerificationResult | null {
  const parts = message.split("=").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return null;

  const textWithoutArithmeticLatex = replaceLatexFractions(parts.join(""))
    .replace(/\\(?:cdot|times|ast|div|left|right)\b/gi, "")
    .replace(/[{}[\]]/g, "");
  if (/[a-z]/i.test(textWithoutArithmeticLatex)) return null;

  const values = parts.map((part) => parseSingleArithmeticCandidate(decimalExpressionToFractions(part)));
  if (values.some((value) => !value)) return null;

  const rationals = values as Rational[];
  const allEqual = rationals.every((value) => equalRational(rationals[0], value));
  if (allEqual) {
    if (!hasAnchoredArithmeticValue(session, message)) return null;

    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "Your arithmetic equality checks out.",
      suggested_next_check: "Use that result in the next step of your argument.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "Those expressions in the equality chain are not all the same value.",
    valid_progress: null,
    suggested_next_check: "Recheck one equality at a time before using this line.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyArithmeticEquality(
  message: string,
  session?: CoachSession
): VerificationResult | null {
  const chainedEquality = verifyArithmeticEqualityChain(message, session);
  if (chainedEquality) return chainedEquality;

  const equality = splitSingleEquals(message);
  if (!equality) return null;

  const textWithoutArithmeticLatex = replaceLatexFractions(equality.left + equality.right)
    .replace(/\\(?:cdot|times|ast|div|left|right|lfloor|rfloor)\b/gi, "")
    .replace(/[{}[\]]/g, "");
  if (/[a-z]/i.test(textWithoutArithmeticLatex)) return null;

  const left = parseSingleArithmeticCandidate(decimalExpressionToFractions(equality.left));
  const right = parseSingleArithmeticCandidate(decimalExpressionToFractions(equality.right));
  if (!left || !right) return null;

  if (equalRational(left, right)) {
    if (!isAnchoredArithmeticEquality(session, left) && !hasAnchoredArithmeticValue(session, message)) {
      return null;
    }

    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "Your arithmetic equality checks out.",
      suggested_next_check: "Use that result in the next step of your argument.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "The two sides of that equality are not the same value.",
    valid_progress: null,
    suggested_next_check: "Recheck the arithmetic on one side before using this line.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}
