import type { CoachSession } from "@/lib/sessionStore";
import { canonicalizeNumericTokens } from "@/lib/numericText";
import type { VerificationResult } from "@/lib/coach-verifier/types";
import {
  ONE,
  equalRational,
  divideRational,
  normalizeRational,
  parseSingleArithmeticCandidate,
  hasArithmeticOperator,
  replaceLatexFractions,
  splitSingleEquals,
  type Rational,
} from "@/lib/coach-verifier/math";

const HUNDRED = normalizeRational({
  numerator: BigInt(100),
  denominator: ONE,
});

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

function uniqueRationals(values: Rational[]) {
  return values.filter((value, index) =>
    values.findIndex((candidate) => equalRational(candidate, value)) === index
  );
}

function decimalToRational(text: string) {
  const match = text.match(/^(-?)(\d*)\.(\d+)$/);
  if (!match) return null;

  const wholeDigits = match[2] || "0";
  const fractionalDigits = match[3];
  const numerator = BigInt(`${match[1]}${wholeDigits}${fractionalDigits}`);
  const denominator = BigInt(10) ** BigInt(fractionalDigits.length);

  return normalizeRational({ numerator, denominator });
}

function repeatingDecimalToRational(text: string) {
  const match = text.match(
    /^(-?)(\d*)\.(?:\\overline|\\bar)\s*(?:\{\s*(\d+)\s*\}|(\d+))$/i
  );
  if (!match) return null;

  const wholeDigits = match[2] || "0";
  const repeatingDigits = match[3] || match[4];
  if (!repeatingDigits || /^0+$/.test(repeatingDigits)) {
    return decimalToRational(`${match[1]}${wholeDigits}.0`);
  }

  const sign = match[1] === "-" ? BigInt(-1) : BigInt(1);
  const whole = BigInt(wholeDigits);
  const repetend = BigInt(repeatingDigits);
  const repetendDenominator = BigInt(10) ** BigInt(repeatingDigits.length) - BigInt(1);

  return normalizeRational({
    numerator: sign * (whole * repetendDenominator + repetend),
    denominator: repetendDenominator,
  });
}

function normalizeRepeatingDecimals(text: string) {
  return text.replace(
    /(-?\d*)\.(?:\\overline|\\bar)\s*(?:\{\s*(\d+)\s*\}|(\d+))/gi,
    (match) => {
      const rational = repeatingDecimalToRational(match);
      return rational ? `(${rational.numerator.toString()}/${rational.denominator.toString()})` : match;
    }
  );
}

function parseMixedNumber(text: string) {
  const latexMixed = text.match(
    /^(-?\d+)\s*\\[dt]?frac\s*\{\s*(\d+)\s*\}\s*\{\s*(\d+)\s*\}$/i
  );
  const plainMixed = replaceLatexFractions(text).match(
    /^(-?\d+)\s+(?:\(\()?(\d+)(?:\)\))?\s*\/\s*(?:\(?)(\d+)(?:\)?)$/
  );
  const mixed = latexMixed || plainMixed;

  if (!mixed) return null;

  const whole = BigInt(mixed[1]);
  const numerator = BigInt(mixed[2]);
  const denominator = BigInt(mixed[3]);
  if (denominator === BigInt(0)) return null;

  const sign = whole < BigInt(0) ? BigInt(-1) : BigInt(1);
  return normalizeRational({
    numerator: whole * denominator + sign * numerator,
    denominator,
  });
}

function normalizeVulgarFractions(text: string) {
  const fractions: Record<string, string> = {
    "\u00bc": "1/4",
    "\u00bd": "1/2",
    "\u00be": "3/4",
    "\u2153": "1/3",
    "\u2154": "2/3",
    "\u2155": "1/5",
    "\u2156": "2/5",
    "\u2157": "3/5",
    "\u2158": "4/5",
    "\u2159": "1/6",
    "\u215a": "5/6",
    "\u215b": "1/8",
    "\u215c": "3/8",
    "\u215d": "5/8",
    "\u215e": "7/8",
  };

  return text.replace(
    /(\d+)?\s*([\u00bc\u00bd\u00be\u2153-\u215e])/g,
    (_match, whole: string | undefined, fraction: string) =>
      whole ? `${whole} ${fractions[fraction]}` : fractions[fraction]
  );
}

function stripTrailingAnswerUnit(text: string) {
  return text.replace(
    /\s+(?:square\s+(?:inches?|feet|ft\.?|units?)|sq\.?\s*(?:inches?|feet|ft\.?|units?)|feet|foot|ft\.?|inches?|in\.?|units?|items?|products?|pages?|tons?|degrees?|dollars?|cents?)\.?$/i,
    ""
  );
}

function parseCanonicalNumericValue(text: string) {
  const hasPercent = /%|\bpercent\b/i.test(text);
  const withoutLabels = normalizeRepeatingDecimals(
    normalizeSimpleFractionText(canonicalizeNumericTokens(text))
  )
    .replace(/\$/g, "")
    .replace(/\b(?:final\s+answer|answer)\s*(?:is|=|:)?/gi, "")
    .replace(/\bpercent\b/gi, "%")
    .replace(/[−–—]/g, "-")
    .trim();
  const withoutPercent = stripWrappingParens(
    stripTrailingAnswerUnit(withoutLabels).replace(/%/g, "").trim()
  );

  if (!withoutPercent || /[a-z]/i.test(withoutPercent.replace(/\\[dt]?frac/gi, ""))) {
    return null;
  }

  const parsed =
    parseMixedNumber(withoutPercent) ||
    repeatingDecimalToRational(withoutPercent) ||
    decimalToRational(withoutPercent) ||
    parseSingleArithmeticCandidate(withoutPercent);
  if (!parsed) return null;

  return hasPercent ? divideRational(parsed, HUNDRED) : parsed;
}

function hasDescriptiveLabel(text: string) {
  return /\b[a-zA-Z]{2,}\b/.test(text.replace(/\\[dt]?frac|sqrt/gi, ""));
}

function splitLabeledNumericClaim(text: string) {
  const match = text.match(/^(.+?)\b(?:is|are|equals?)\b\s*(.+)$/i);
  if (!match) return null;

  const left = match[1].trim();
  const right = match[2].trim();
  return left && right && hasDescriptiveLabel(left) ? { left, right } : null;
}

function canonicalValuesFromLine(text: string) {
  const equalityParts = text.split("=").map((part) => part.trim()).filter(Boolean);
  if (equalityParts.length > 2) {
    const values = equalityParts
      .map(parseCanonicalNumericValue)
      .filter((value): value is Rational => Boolean(value));

    if (values.length > 0 && values.every((value) => equalRational(value, values[0]))) {
      return [values[0]];
    }

    return [];
  }

  const equality = splitSingleEquals(text);

  if (equality) {
    const left = parseCanonicalNumericValue(equality.left);
    const right = parseCanonicalNumericValue(equality.right);

    if (left && !right && hasDescriptiveLabel(equality.right)) return [left];
    if (right && !left && hasDescriptiveLabel(equality.left)) return [right];
    if (!left || !right || !equalRational(left, right)) return [];
    return [left];
  }

  const labeledClaim = splitLabeledNumericClaim(text);
  if (labeledClaim) {
    const value = parseCanonicalNumericValue(labeledClaim.right);
    if (value) return [value];
  }

  const value = parseCanonicalNumericValue(text);
  return value ? [value] : [];
}

function valuesMatch(leftValues: Rational[], rightValues: Rational[]) {
  return leftValues.some((left) => rightValues.some((right) => equalRational(left, right)));
}

function hasFinalAnswerLabel(text: string) {
  return /\b(?:final\s+answer|answer)\b/i.test(text);
}

function hasDescriptiveNumericLabel(text: string) {
  const equality = splitSingleEquals(text);
  if (equality) {
    return (
      (hasDescriptiveLabel(equality.left) &&
        Boolean(parseCanonicalNumericValue(equality.right))) ||
      (hasDescriptiveLabel(equality.right) &&
        Boolean(parseCanonicalNumericValue(equality.left)))
    );
  }

  return Boolean(splitLabeledNumericClaim(text));
}

function descriptiveEqualityLabel(text: string) {
  const equality = splitSingleEquals(text);
  if (!equality) return null;

  const left = equality.left.trim();
  if (!hasDescriptiveLabel(left) || parseCanonicalNumericValue(left)) return null;

  return left
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function changesDescriptiveQuantity(session: CoachSession, message: string) {
  const submittedLabel = descriptiveEqualityLabel(message);
  if (!submittedLabel) return false;

  const previousLabel = descriptiveEqualityLabel(
    session.workState?.lastValidLine || ""
  );
  return Boolean(previousLabel && previousLabel !== submittedLabel);
}

function looksLikeStandaloneNumericAnswer(text: string) {
  const normalized = normalizeSimpleFractionText(text)
    .replace(/\b(?:feet|units|items|products|pages|tons|dollars?|cents?|square\s+units?)\b/gi, "")
    .replace(/[âˆ’â€“â€”]/g, "-")
    .trim();

  return (
    /^-?\d+(?:\.\d+)?%?$/.test(normalized) ||
    /^-?\d+\s*\/\s*\d+$/.test(normalized) ||
    /^\\[dt]?frac\s*\{\s*-?\d+\s*\}\s*\{\s*\d+\s*\}$/i.test(normalized)
  );
}

function numericFragmentsFromText(text: string) {
  const normalized = normalizeVulgarFractions(text).replace(/\bpercent\b/gi, "%");
  const patterns = [
    /-?\d*\.(?:\\overline|\\bar)\s*(?:\{\s*\d+\s*\}|\d+)\s*%?/gi,
    /-?\d+\s*\\[dt]?frac\s*\{\s*\d+\s*\}\s*\{\s*\d+\s*\}\s*%?/gi,
    /-?\d+\s+\d+\s*\/\s*\d+\s*%?/g,
    /\\[dt]?frac\s*\{\s*-?\d+\s*\}\s*\{\s*\d+\s*\}\s*%?/gi,
    /-?\d+\s*\/\s*\d+\s*%?/g,
    /-?\d*\.\d+\s*%?/g,
    /-?\d+\s*%/g,
  ];

  return patterns.flatMap((pattern) =>
    [...normalized.matchAll(pattern)].map((match) => match[0])
  );
}

function canonicalValuesFromText(text: string) {
  const expressMatch = text.match(
    /\b(?:express|write|convert|give)\s+(.+?)\s+as\s+(?:a\s+)?(?:common\s+)?fraction\b/i
  );
  const expressedValue = expressMatch ? canonicalValuesFromLine(expressMatch[1]) : [];

  return uniqueRationals([
    ...expressedValue,
    ...numericFragmentsFromText(text).flatMap(canonicalValuesFromLine),
  ]);
}

function ocrOverlineRecoveryValuesFromText(text: string) {
  const expressMatch = text.match(
    /\b(?:express|write|convert|give)\s+(.+?)\s+as\s+(?:a\s+)?(?:common\s+)?fraction\b/i
  );
  if (!expressMatch) return [];

  const recoveredExpression = expressMatch[1].replace(
    /(-?)(\d*)\.(\d{2,})(?!\d)/g,
    (_match, signText: string, wholeText: string, repeatingDigits: string) => {
      const sign = signText === "-" ? BigInt(-1) : BigInt(1);
      const whole = BigInt(wholeText || "0");
      const repetend = BigInt(repeatingDigits);
      const denominator = BigInt(10) ** BigInt(repeatingDigits.length) - BigInt(1);
      const numerator = sign * (whole * denominator + repetend);

      return `(${numerator.toString()}/${denominator.toString()})`;
    }
  );

  return canonicalValuesFromLine(recoveredExpression);
}

function asksForCommonFraction(problem: string) {
  return (
    /\b(?:express|write|convert|give)\b[\s\S]*\b(?:common fraction|fraction)\b/i.test(problem) ||
    /\b(?:what|which)\s+(?:common\s+)?fraction\b/i.test(problem) ||
    /\bequivalent\s+to\s+(?:what|which)\s+(?:common\s+)?fraction\b/i.test(problem) ||
    /\bas\s+(?:a\s+)?(?:common\s+)?fraction\b/i.test(problem)
  );
}

function normalizeSimpleFractionText(text: string) {
  return normalizeVulgarFractions(text)
    .replace(/\$/g, "")
    .replace(/\\(?:\(|\)|\[|\])/g, "")
    .replace(/\b(?:final\s+answer|answer)\s*(?:is|=|:)?/gi, "")
    .replace(/\\(?:displaystyle|textstyle|scriptstyle|scriptscriptstyle|mathstrut)\b/gi, "")
    .replace(/\\(?:left|right|mleft|mright)\b/gi, "")
    .replace(/\\(?:mathopen|mathclose)\s*\{\s*\}/gi, "")
    .replace(/\\(?:quad|qquad|enspace|thinspace|medspace|thickspace)\b/gi, "")
    .replace(/\\(?:[,;:!]|\s)/g, "")
    .replace(/[−–—]/g, "-")
    .replace(/[.!?]+$/g, "")
    .trim();
}

function gcdBigInt(left: bigint, right: bigint): bigint {
  let a = left < BigInt(0) ? -left : left;
  let b = right < BigInt(0) ? -right : right;

  while (b !== BigInt(0)) {
    const next = a % b;
    a = b;
    b = next;
  }

  return a || BigInt(1);
}

function submittedSimpleFraction(text: string) {
  const normalized = normalizeSimpleFractionText(text);
  const assignment = normalized.match(/^(?:[a-zA-Z]\s*=\s*(.+)|(.+)\s*=\s*[a-zA-Z])$/);
  const candidate = (assignment?.[1] || assignment?.[2] || normalized).trim();
  const latexFraction = candidate.match(
    /^\\[dt]?frac\s*\{\s*(-?\d+)\s*\}\s*\{\s*(\d+)\s*\}$/i
  );
  const compactLatexFraction = candidate.match(
    /^\\[dt]?frac\s*(-?\d)\s*(\d)$/i
  );
  const plainFraction = candidate.match(/^\s*(-?\d+)\s*\/\s*(\d+)\s*$/);
  const fraction = latexFraction || compactLatexFraction || plainFraction;

  if (!fraction) return null;

  return {
    numerator: BigInt(fraction[1]),
    denominator: BigInt(fraction[2]),
  };
}

function isReducedCommonFraction(text: string) {
  const fraction = submittedSimpleFraction(text);
  if (!fraction || fraction.denominator === BigInt(0)) return false;

  return gcdBigInt(fraction.numerator, fraction.denominator) === BigInt(1);
}

function solutionGuideValues(session: CoachSession) {
  if (!session.solutionGuide?.finalAnswer || session.solutionGuide.confidence < 0.55) {
    return [];
  }

  return canonicalValuesFromLine(session.solutionGuide.finalAnswer);
}

function looksLikeNumericWorkTowardCommonFraction(message: string) {
  return (
    /[+\-*/]|\\[dt]?frac|\d+\s*\/\s*\d+/i.test(message) &&
    !/%|\bpercent\b/i.test(message)
  );
}

function perpendicularSlopeNextCheck(session: CoachSession) {
  const context = [
    session.problem,
    session.workState?.lastValidLine || "",
    ...(session.workState?.acceptedLines || []).slice(-3),
  ].join(" ");

  return /\bperpendicular\b/i.test(context) && /\bslope\b/i.test(context)
    ? "Now calculate the slope of the perpendicular line."
    : null;
}

function asksForStandaloneNumericFinal(problem: string) {
  return (
    /\b(?:how many|how much|what|find|determine)\b[\s\S]{0,140}\b(?:dollars?|cents?|cost|price|amount|total|value|number|units?|items?|pages?|tons?|degrees?|area|perimeter|length|measure)\b/i.test(problem) ||
    /\bwhat\s+is\s+[a-z]\b/i.test(problem) ||
    /\bwhat\s+is\b[\s\S]{0,80}\bof\b/i.test(problem) ||
    /\b(?:dollars?|cents?|cost|price)\b[\s\S]{0,80}\b(?:each|per)\b/i.test(problem)
  );
}

function asksForPercentAnswer(problem: string) {
  return /\b(?:what|which)\s+percent\b|\bas\s+(?:a\s+)?percent(?:age)?\b|\bpercent(?:age)?\s+(?:of|increase|decrease|change)\b/i.test(
    problem
  );
}

function hasAnswerUnitOrCurrency(text: string) {
  return /\$|\b(?:dollars?|cents?|feet|units|items|products|pages|tons|degrees?|square\s+units?)\b/i.test(text);
}

function canFinishStandaloneNumericAnswer(
  submittedValues: Rational[],
  guideValuesForFinal: Rational[]
) {
  return guideValuesForFinal.length === 0 || valuesMatch(submittedValues, guideValuesForFinal);
}

function acceptedArithmeticExpressionValues(session: CoachSession) {
  const lastLine = session.workState?.lastValidLine?.trim();
  if (!lastLine) return [];

  const equality = splitSingleEquals(lastLine);
  const labeledClaim = !equality ? splitLabeledNumericClaim(lastLine) : null;
  const arithmeticText = equality
    ? `${equality.left} ${equality.right}`
    : labeledClaim?.right || lastLine;
  if (!hasArithmeticOperator(arithmeticText)) return [];
  if (/[a-z]/i.test(arithmeticText.replace(/\\[dt]?frac/gi, ""))) return [];

  return canonicalValuesFromLine(lastLine);
}

function lastAcceptedEqualityFinalValue(session: CoachSession) {
  const lastLine = session.workState?.lastValidLine?.trim();
  if (!lastLine || !lastLine.includes("=")) return null;

  const finalPart = lastLine.split("=").pop()?.trim();
  return finalPart ? parseSingleArithmeticCandidate(finalPart) : null;
}

function parseSingleVariableAssignmentValue(text: string) {
  const equality = splitSingleEquals(text);
  if (!equality) return null;

  const leftVariable = equality.left.trim().match(/^[a-z]$/i);
  const rightVariable = equality.right.trim().match(/^[a-z]$/i);
  const variable = leftVariable?.[0] || rightVariable?.[0];
  if (!variable) return null;

  const valueSide = leftVariable ? equality.right : equality.left;
  const value = parseCanonicalNumericValue(valueSide);
  if (!value) return null;

  return {
    variable: variable.toLowerCase(),
    value,
  };
}

function asksForVariableValue(problem: string, variable: string) {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return new RegExp(
    String.raw`\b(?:solve\s+for|find|determine|what\s+is|value\s+of)\b[\s\S]{0,40}\b${escaped}\b|\b${escaped}\b[\s\S]{0,25}\b(?:equals?|is|value)\b`,
    "i"
  ).test(problem);
}

function coachDefinedVariableAsRequestedQuantity(
  session: CoachSession,
  variable: string
) {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const coachContext = [
    ...session.history
      .filter((entry) => entry.role === "assistant")
      .slice(-8)
      .map((entry) => entry.content),
    session.coachingState?.lastCoachQuestion || "",
    session.coachingState?.currentGoal || "",
    session.coachingState?.currentSubgoal || "",
  ].join(" ");

  return new RegExp(
    String.raw`\blet\s+${escaped}\s+be\b|\bdefine\s+${escaped}\s+as\b|\b${escaped}\s+(?:is|represents?|denotes?)\s+(?:the\s+)?(?:total|number|amount|quantity|answer)\b`,
    "i"
  ).test(coachContext);
}

export function verifyCanonicalNumericClaim(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const submittedValues = canonicalValuesFromLine(message);
  const guideValuesForFinal = solutionGuideValues(session);
  const percentAnswerExpected = asksForPercentAnswer(session.problem);
  const submittedUsesPercent = /%|\bpercent\b/i.test(message);
  const variableAssignment = parseSingleVariableAssignmentValue(message);
  const arithmeticExpressionValue = hasArithmeticOperator(message)
    ? parseSingleArithmeticCandidate(message)
    : null;

  if (
    variableAssignment &&
    guideValuesForFinal.length > 0 &&
    (
      asksForVariableValue(session.problem, variableAssignment.variable) ||
      coachDefinedVariableAsRequestedQuantity(session, variableAssignment.variable)
    ) &&
    valuesMatch([variableAssignment.value], guideValuesForFinal)
  ) {
    return {
      intent: "final_answer",
      status: "correct",
      local_error: null,
      valid_progress: "That value answers the question.",
      suggested_next_check: null,
      should_finish: true,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (
    guideValuesForFinal.length > 0 &&
    submittedSimpleFraction(message) &&
    !isReducedCommonFraction(message) &&
    valuesMatch(submittedValues, guideValuesForFinal)
  ) {
    return {
      intent: "submitted_work",
      status: "partially_correct",
      local_error: null,
      valid_progress: "That fraction has the correct value.",
      suggested_next_check: "Reduce the fraction to lowest terms.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (
    guideValuesForFinal.length > 0 &&
    arithmeticExpressionValue &&
    !submittedSimpleFraction(message) &&
    !asksForCommonFraction(session.problem) &&
    valuesMatch([arithmeticExpressionValue], guideValuesForFinal)
  ) {
    return {
      intent: "submitted_work",
      status: "partially_correct",
      local_error: null,
      valid_progress: "That expression has the right value.",
      suggested_next_check: "Evaluate it to a simplified final answer.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (submittedValues.length === 0) return null;

  if (
    guideValuesForFinal.length > 0 &&
    valuesMatch(submittedValues, guideValuesForFinal) &&
    percentAnswerExpected &&
    !submittedUsesPercent
  ) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That multiplier has the correct value.",
      suggested_next_check: hasArithmeticOperator(message)
        ? "Evaluate the multiplier, then express it as a percent."
        : "Convert this multiplier to a percent.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (
    guideValuesForFinal.length > 0 &&
    valuesMatch(submittedValues, guideValuesForFinal) &&
    (
      hasFinalAnswerLabel(message) ||
      hasDescriptiveNumericLabel(message) ||
      looksLikeStandaloneNumericAnswer(message)
    ) &&
    (!submittedSimpleFraction(message) || isReducedCommonFraction(message)) &&
    (
      (
        (!percentAnswerExpected || submittedUsesPercent) &&
        !asksForCommonFraction(session.problem)
      ) ||
      (!/%|\bpercent\b/i.test(message) && isReducedCommonFraction(message))
    )
  ) {
    return {
      intent: "final_answer",
      status: "correct",
      local_error: null,
      valid_progress: "That final answer matches the checked answer.",
      suggested_next_check: null,
      should_finish: true,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (
    percentAnswerExpected &&
    submittedUsesPercent &&
    looksLikeStandaloneNumericAnswer(message) &&
    guideValuesForFinal.length > 0 &&
    !valuesMatch(submittedValues, guideValuesForFinal)
  ) {
    return {
      intent: "final_answer",
      status: "incorrect",
      local_error: "That percentage does not match the checked answer.",
      valid_progress: null,
      suggested_next_check:
        "Recheck the conversion from your multiplier to a percent.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (
    guideValuesForFinal.length > 0 &&
    hasFinalAnswerLabel(message) &&
    looksLikeStandaloneNumericAnswer(message) &&
    !valuesMatch(submittedValues, guideValuesForFinal)
  ) {
    return {
      intent: "final_answer",
      status: "incorrect",
      local_error: "That final answer does not match the checked answer.",
      valid_progress: null,
      suggested_next_check: "Recheck which quantity the problem asks for before choosing the final value.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (
    guideValuesForFinal.length > 0 &&
    hasArithmeticOperator(message) &&
    !asksForCommonFraction(session.problem) &&
    valuesMatch(submittedValues, guideValuesForFinal)
  ) {
    return {
      intent: "submitted_work",
      status: "partially_correct",
      local_error: null,
      valid_progress: "That expression has the right value.",
      suggested_next_check: "Evaluate it to a simplified final answer.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  // Equal numeric values do not establish that two differently labeled,
  // context-dependent quantities are the same. Let semantic verification
  // review the transition between those quantities.
  if (changesDescriptiveQuantity(session, message)) return null;

  const priorLines = [
    session.workState?.lastValidLine,
    ...(session.workState?.acceptedLines || []).slice(-3).reverse(),
  ].filter((line): line is string => Boolean(line?.trim()));
  const priorValues = uniqueRationals(priorLines.flatMap(canonicalValuesFromLine));
  const acceptedArithmeticValues = acceptedArithmeticExpressionValues(session);
  const lastEqualityFinalValue = lastAcceptedEqualityFinalValue(session);
  const problemValues = canonicalValuesFromText(session.problem);
  const ocrOverlineRecoveryValues =
    session.problemImage && asksForCommonFraction(session.problem)
      ? ocrOverlineRecoveryValuesFromText(session.problem)
      : [];
  const guideValues = asksForCommonFraction(session.problem)
    ? guideValuesForFinal
    : [];
  const anchoredValues = uniqueRationals([
    ...priorValues,
    ...problemValues,
    ...ocrOverlineRecoveryValues,
    ...guideValues,
  ]);

  if (splitSingleEquals(message) && valuesMatch(submittedValues, anchoredValues)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That numeric equivalence checks out.",
      suggested_next_check: "Use this cleaner form in the next step.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (
    (problemValues.length > 0 && valuesMatch(submittedValues, problemValues)) ||
    (ocrOverlineRecoveryValues.length > 0 && valuesMatch(submittedValues, ocrOverlineRecoveryValues)) ||
    (
      guideValues.length > 0 &&
      valuesMatch(submittedValues, guideValues) &&
      looksLikeNumericWorkTowardCommonFraction(message)
    )
  ) {
    const isPercentRewrite = /%|\bpercent\b/i.test(message);
    const commonFractionAnswerExpected = asksForCommonFraction(session.problem);
    const shouldFinish = commonFractionAnswerExpected && !isPercentRewrite && isReducedCommonFraction(message);
    const problemMentionsPercent = /%|\bpercent\b/i.test(session.problem);
    const submittedIsSingleFraction = Boolean(submittedSimpleFraction(message));

    return {
      intent: shouldFinish ? "final_answer" : "submitted_work",
      status: shouldFinish
        ? "correct"
        : commonFractionAnswerExpected && !isPercentRewrite
          ? "partially_correct"
          : "correct",
      local_error: null,
      valid_progress: shouldFinish
        ? "That common fraction matches the original expression."
        : "That numeric rewrite matches the original expression.",
      suggested_next_check: shouldFinish
        ? null
        : commonFractionAnswerExpected && !isPercentRewrite
          ? submittedIsSingleFraction
            ? "Reduce the fraction to lowest terms."
            : "Write the value as one reduced common fraction."
          : problemMentionsPercent
            ? "Now convert the percent form into a common fraction."
            : "Now combine the fractions and reduce to lowest terms.",
      should_finish: shouldFinish,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (
    looksLikeStandaloneNumericAnswer(message) &&
    acceptedArithmeticValues.length > 0
  ) {
    const matchesAcceptedArithmetic = valuesMatch(submittedValues, acceptedArithmeticValues);

    if (!matchesAcceptedArithmetic) {
      return {
        intent: "submitted_work",
        status: "incorrect",
        local_error: "That number does not evaluate your previous accepted expression.",
        valid_progress: null,
        suggested_next_check: "Recompute the arithmetic in your previous line before continuing.",
        should_finish: false,
        confidence: 1,
        source: "deterministic",
      };
    }

    if (
      asksForStandaloneNumericFinal(session.problem) &&
      !asksForCommonFraction(session.problem) &&
      canFinishStandaloneNumericAnswer(submittedValues, guideValuesForFinal)
    ) {
      return {
        intent: "final_answer",
        status: "correct",
        local_error: null,
        valid_progress: "That value answers the question.",
        suggested_next_check: null,
        should_finish: true,
        confidence: 1,
        source: "deterministic",
      };
    }
  }

  if (priorValues.length === 0 || !valuesMatch(submittedValues, priorValues)) return null;

  const commonFractionAnswerExpected = asksForCommonFraction(session.problem);
  const contextualNextCheck = perpendicularSlopeNextCheck(session);
  const shouldFinishNumericFinal =
    looksLikeStandaloneNumericAnswer(message) &&
    (
      hasAnswerUnitOrCurrency(message) ||
      Boolean(
        lastEqualityFinalValue &&
        valuesMatch(submittedValues, [lastEqualityFinalValue])
      )
    ) &&
    asksForStandaloneNumericFinal(session.problem) &&
    canFinishStandaloneNumericAnswer(submittedValues, guideValuesForFinal) &&
    !commonFractionAnswerExpected &&
    !contextualNextCheck;
  const shouldFinish =
    shouldFinishNumericFinal ||
    (
      commonFractionAnswerExpected &&
      !/%|\bpercent\b/i.test(message) &&
      isReducedCommonFraction(message) &&
      !contextualNextCheck
    );
  const status = shouldFinish || contextualNextCheck
    ? "correct"
    : percentAnswerExpected && !submittedUsesPercent
      ? "partially_correct"
    : commonFractionAnswerExpected && !/%|\bpercent\b/i.test(message)
      ? "partially_correct"
      : "correct";
  const suggestedNextCheck = shouldFinish
    ? null
    : contextualNextCheck ||
      (
        percentAnswerExpected && !submittedUsesPercent
          ? "Express this value as a percent."
          : commonFractionAnswerExpected && !/%|\bpercent\b/i.test(message)
          ? "Write the value as one reduced common fraction."
          : "Use this cleaner form in the next step."
      );

  return {
    intent: shouldFinish ? "final_answer" : "submitted_work",
    status,
    local_error: null,
    valid_progress: shouldFinish
      ? shouldFinishNumericFinal
        ? "That value answers the question."
        : "That common fraction matches your previous line."
      : "That numeric rewrite is equivalent to your previous accepted line.",
    suggested_next_check: suggestedNextCheck,
    should_finish: shouldFinish,
    confidence: 1,
    source: "deterministic",
  };
}
