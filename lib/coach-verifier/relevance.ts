import type { CoachSession } from "@/lib/sessionStore";
import type { VerificationResult } from "@/lib/coach-verifier/types";
import { canonicalizeNumericTokens } from "@/lib/numericText";
import {
  equalRational,
  parseSingleArithmeticCandidate,
  splitSingleEquals,
  type Rational,
} from "@/lib/coach-verifier/math";

function normalizeArithmeticAnchor(text: string) {
  return canonicalizeNumericTokens(text)
    .replace(/\bis equal to\b/gi, "=")
    .replace(/\s+/g, "")
    .replace(/[−–—]/g, "-")
    .replace(/[×·]/g, "*")
    .replace(/÷/g, "/")
    .replace(/\*\*/g, "^")
    .replace(/[{}[\]]/g, (char) => (char === "{" || char === "[" ? "(" : ")"))
    .replace(/[^0-9+\-*/^().=]/g, "");
}

function hasArithmeticOperator(text: string) {
  return /[+\-*/^]/.test(text);
}

function decimalExpressionToFractions(text: string) {
  return text.replace(/(-?)(\d*)\.(\d+)/g, (_match, sign: string, whole: string, fraction: string) => {
    const digits = `${whole || "0"}${fraction}`;
    const denominator = BigInt(10) ** BigInt(fraction.length);
    const numerator = BigInt(`${sign}${digits}`);

    return `(${numerator.toString()}/${denominator.toString()})`;
  });
}

function normalizeArithmeticForParsing(text: string) {
  return decimalExpressionToFractions(
    canonicalizeNumericTokens(text)
      .replace(/(-?\d+(?:\.\d+)?)\s*%/g, "($1/100)")
      .replace(/\$/g, "")
  );
}

function parseArithmeticValue(text: string) {
  return parseSingleArithmeticCandidate(normalizeArithmeticForParsing(text));
}

function hasExpressionAnchor(session: CoachSession, expressions: string[]) {
  const context = normalizeArithmeticAnchor(
    [
      session.problem,
      session.workState?.lastValidLine,
      ...(session.workState?.acceptedLines || []).slice(-5),
    ]
      .filter(Boolean)
      .join(" ")
  );

  return expressions
    .map(normalizeArithmeticAnchor)
    .filter((expression) => expression && hasArithmeticOperator(expression))
    .some((expression) => context.includes(expression));
}

function isStandaloneNumericEquality(message: string) {
  const equality = splitSingleEquals(message);
  if (!equality) return false;
  if (/!/.test(equality.left + equality.right)) return false;
  if (/[a-z]/i.test(equality.left + equality.right)) return null;
  if (/[/%]|\\frac/i.test(equality.left + equality.right)) return null;

  const left = parseArithmeticValue(equality.left);
  const right = parseArithmeticValue(equality.right);
  if (!left || !right) return false;

  return true;
}

function standaloneArithmeticEquality(message: string) {
  const equality = splitSingleEquals(message);
  if (!equality) return null;
  if (/[a-z]/i.test(equality.left + equality.right)) return null;

  const left = parseArithmeticValue(equality.left);
  const right = parseArithmeticValue(equality.right);
  if (!left || !right) return null;

  return {
    left,
    right,
    isTrue: equalRational(left, right),
  };
}

function uniqueRationals(values: Rational[]) {
  return values.filter((value, index) =>
    values.findIndex((candidate) => equalRational(candidate, value)) === index
  );
}

function numberValuesFromText(text: string) {
  const values = [...canonicalizeNumericTokens(text).matchAll(/-?\d(?:[\d,\s]*\d)?(?:\.\d+)?\s*%?/g)]
    .map((match) => {
      const token = match[0].trim();
      if (token.endsWith("%")) {
        return parseArithmeticValue(token);
      }

      return parseArithmeticValue(token.replace(/\s+/g, ""));
    })
    .filter((value): value is Rational => Boolean(value));

  return uniqueRationals(values);
}

function numericTokenValuesFromText(text: string) {
  const values = [...text.matchAll(/-?\d+(?:\.\d+)?%?/g)]
    .map((match) => parseArithmeticValue(match[0]))
    .filter((value): value is Rational => Boolean(value));

  return uniqueRationals(values);
}

function numericOperandValuesFromExpression(text: string) {
  const binarySubtractionAsSeparator = text.replace(
    /(\d|\))\s*-\s*(?=\d)/g,
    "$1+"
  );

  return numericTokenValuesFromText(binarySubtractionAsSeparator);
}

function valuesSubsetOf(leftValues: Rational[], rightValues: Rational[]) {
  return leftValues.every((left) =>
    rightValues.some((right) => equalRational(left, right))
  );
}

function hasProblemNumberOverlap(session: CoachSession, message: string) {
  const problemValues = numberValuesFromText(session.problem);
  const messageValues = numberValuesFromText(message);

  return messageValues.some((messageValue) =>
    problemValues.some((problemValue) => equalRational(messageValue, problemValue))
  );
}

function hasRecentAcceptedNumberAnchor(session: CoachSession, expression: string) {
  const expressionValues = numericOperandValuesFromExpression(expression);
  if (expressionValues.length < 2) return false;

  const recentContext = [
    session.workState?.lastValidLine,
    ...(session.workState?.acceptedLines || []).slice(-5),
  ]
    .filter(Boolean)
    .join(" ");
  const additiveComponentValues = recentContext
    .split(/\r?\n/)
    .flatMap((line) => {
      const normalized = line.trim();
      const components: string[] = [];
      let depth = 0;
      let start = 0;

      for (let index = 0; index < normalized.length; index += 1) {
        if (normalized[index] === "(") depth += 1;
        if (normalized[index] === ")") depth -= 1;
        if (depth === 0 && /[+\-]/.test(normalized[index]) && index > start) {
          components.push(normalized.slice(start, index));
          start = index + 1;
        }
      }
      components.push(normalized.slice(start));
      return components
        .map(parseArithmeticValue)
        .filter((value): value is Rational => Boolean(value));
    });
  const recentValues = uniqueRationals([
    ...numericTokenValuesFromText(recentContext),
    ...additiveComponentValues,
  ]);

  return recentValues.length > 0 && valuesSubsetOf(expressionValues, recentValues);
}

function hasRecentAcceptedOperandOverlap(
  session: CoachSession,
  expression: string
) {
  const expressionValues = numericOperandValuesFromExpression(expression);
  if (expressionValues.length < 2) return false;

  const recentContext = [
    session.workState?.lastValidLine,
    ...(session.workState?.acceptedLines || []).slice(-5),
  ]
    .filter(Boolean)
    .join(" ");
  const recentValues = numericTokenValuesFromText(recentContext);

  return (
    !valuesSubsetOf(expressionValues, recentValues) &&
    expressionValues.some((expressionValue) =>
      recentValues.some((recentValue) =>
        equalRational(expressionValue, recentValue)
      )
    )
  );
}

function hasRequestedDigitSumAnchor(session: CoachSession, expression: string) {
  const latestCoachMessage = [...(session.history || [])]
    .reverse()
    .find((entry) => entry.role === "assistant")?.content;
  const requestedNumber = latestCoachMessage?.match(
    /(?:compute|find|calculate)\s+the\s+sum\s+of\s+the\s+digits\s+of\s+([0-9][0-9,]*)/i
  )?.[1]?.replace(/,/g, "");
  if (!requestedNumber) return false;

  const acceptedContext = [
    session.workState?.lastValidLine,
    ...(session.workState?.acceptedLines || []).slice(-5),
  ]
    .filter(Boolean)
    .join(" ");
  if (!acceptedContext.replace(/,/g, "").includes(requestedNumber)) return false;

  const submittedDigits = expression
    .replace(/[()\s]/g, "")
    .split("+");

  return (
    submittedDigits.every((digit) => /^\d$/.test(digit)) &&
    submittedDigits.join("") === requestedNumber
  );
}

function hasCoachRequestedNumericAnchor(session: CoachSession, message: string) {
  const latestCoachMessage = [...(session.history || [])]
    .reverse()
    .find((entry) => entry.role === "assistant")?.content;
  if (
    !latestCoachMessage ||
    !/\b(?:add|calculate|compute|evaluate|factor|multiply|simplify|subtract|use|write)\b/i.test(
      latestCoachMessage
    )
  ) {
    return false;
  }

  const equality = standaloneArithmeticEquality(message);
  if (!equality?.isTrue) return false;

  const coachValues = numberValuesFromText(latestCoachMessage);
  return coachValues.some(
    (value) => equalRational(value, equality.left) || equalRational(value, equality.right)
  );
}

function hasWordProblemContext(problem: string) {
  return (
    /\b(?:how many|how much|what|which|find|determine|count|ways?|combinations?|selections?|in dollars|sales|rent|cost|price|rate|hours?|weeks?|months?|merchandise|apples?|items?|area|perimeter|length|distance|mean|average|probability|ratio)\b/i.test(
      problem
    ) &&
    /\b[a-zA-Z]{3,}\b/.test(problem)
  );
}

export function shouldDeferRelevanceToSemanticArithmetic(
  session: CoachSession,
  message: string
) {
  const equality = standaloneArithmeticEquality(message);
  const rawEquality = splitSingleEquals(message);

  return Boolean(
    equality?.isTrue &&
    hasWordProblemContext(session.problem) &&
    (
      hasProblemNumberOverlap(session, message) ||
      (
        rawEquality &&
        hasRecentAcceptedOperandOverlap(session, rawEquality.left)
      )
    )
  );
}

export function verifyProblemRelevance(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const isNumericEquality = isStandaloneNumericEquality(message);
  if (!isNumericEquality) return null;
  if (shouldDeferRelevanceToSemanticArithmetic(session, message)) return null;
  const equality = splitSingleEquals(message);
  if (equality && hasExpressionAnchor(session, [equality.left, equality.right])) return null;
  if (equality && hasRecentAcceptedNumberAnchor(session, equality.left)) return null;
  if (equality && hasRequestedDigitSumAnchor(session, equality.left)) return null;
  if (hasCoachRequestedNumericAnchor(session, message)) return null;

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error:
      "That statement is not connected to this problem.",
    valid_progress: null,
    suggested_next_check:
      "Use a number, variable, or equation from the original problem or from your last valid line.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}
