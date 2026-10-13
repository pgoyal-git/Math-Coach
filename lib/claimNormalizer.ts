import { normalizeStudentProseTypos } from "@/lib/coach-verifier/typos";
import { canonicalizeNumericTokens } from "@/lib/numericText";

export type ClaimKind =
  | "final_answer"
  | "equation"
  | "numeric_expression"
  | "expression"
  | "operation_claim"
  | "factor_claim"
  | "question"
  | "prose_math"
  | "unknown";

export type Claim = {
  kind: ClaimKind;
  candidates: ClaimKind[];
  raw: string;
  normalized: string | null;
  confidence: number;
  allowSymbolicFallback: boolean;
};

function replaceLatexFractions(text: string) {
  let result = text;
  const fractionPattern = /\\[dt]?frac\s*\{\s*([^{}]+)\s*\}\s*\{\s*([^{}]+)\s*\}/g;

  for (let index = 0; index < 8 && fractionPattern.test(result); index += 1) {
    result = result.replace(fractionPattern, "(($1)/($2))");
    fractionPattern.lastIndex = 0;
  }

  return result;
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

function normalizeMixedNumbers(text: string) {
  return text.replace(
    /(-?\d+)\s+(\d+)\s*\/\s*(\d+)/g,
    (_match, wholeText: string, numeratorText: string, denominatorText: string) => {
      const whole = BigInt(wholeText);
      const numerator = BigInt(numeratorText);
      const denominator = BigInt(denominatorText);
      if (denominator === BigInt(0)) return _match;

      const sign = whole < BigInt(0) ? BigInt(-1) : BigInt(1);
      return `((${whole * denominator + sign * numerator})/${denominator})`;
    }
  );
}

function normalizePercentTokens(text: string) {
  return text
    .replace(/(-?\d+\s+\d+\s*\/\s*\d+)\s*%/g, "(($1)/100)")
    .replace(/(-?\d+\s*\/\s*\d+)\s*%/g, "(($1)/100)")
    .replace(/(-?\d*\.\d+)\s*%/g, "(($1)/100)")
    .replace(/(-?\d+)\s*%/g, "(($1)/100)");
}

function repeatingDecimalToFraction(
  signText: string | undefined,
  wholeText: string | undefined,
  repeatingText: string | undefined
) {
  const repeatingDigits = repeatingText || "";
  if (!repeatingDigits) return null;

  const sign = signText === "-" ? BigInt(-1) : BigInt(1);
  const whole = BigInt(wholeText || "0");
  const repetend = BigInt(repeatingDigits);
  const repetendDenominator = BigInt(10) ** BigInt(repeatingDigits.length) - BigInt(1);
  if (repetendDenominator === BigInt(0)) return null;

  return {
    numerator: sign * (whole * repetendDenominator + repetend),
    denominator: repetendDenominator,
  };
}

function normalizeRepeatingDecimals(text: string) {
  return text.replace(
    /(-?)(\d*)\.(?:\\overline|\\bar)\s*(?:\{\s*(\d+)\s*\}|(\d+))/gi,
    (match, signText: string, wholeText: string, braced: string | undefined, bare: string | undefined) => {
      const fraction = repeatingDecimalToFraction(signText, wholeText, braced || bare);
      return fraction ? `((${fraction.numerator})/(${fraction.denominator}))` : match;
    }
  );
}

function normalizeAbsoluteValue(text: string) {
  return text.replace(/\|([^|]+)\|/g, "Abs($1)");
}

function addImplicitMultiplication(text: string) {
  return text
    .replace(/(\d)(?=[a-zA-Z(])/g, "$1*")
    .replace(/([a-zA-Z])(?=\d)/g, "$1*")
    .replace(/\)(?=[a-zA-Z0-9(])/g, ")*")
    .replace(/([a-zA-Z])(?=\()/g, "$1*");
}

export function normalizeClaimMath(text: string) {
  text = canonicalizeNumericTokens(text);

  return addImplicitMultiplication(
    normalizeAbsoluteValue(
      normalizeMixedNumbers(
        normalizePercentTokens(
          replaceLatexFractions(normalizeRepeatingDecimals(normalizeVulgarFractions(text)))
            .replace(/\$/g, "")
            .replace(/\\left|\\right/g, "")
            .replace(/\\(?:cdot|times|ast)(?![a-zA-Z])|[\u00d7\u00b7]/g, "*")
            .replace(/\\div|\u00f7/g, "/")
            .replace(/\\sqrt\s*\{\s*([^{}]+)\s*\}/g, "sqrt($1)")
            .replace(/\u221a\s*\{\s*([^{}]+)\s*\}/g, "sqrt($1)")
            .replace(/\u221a\s*\(\s*([^()]+)\s*\)/g, "sqrt($1)")
            .replace(/\bis equal to\b/gi, "=")
            .replace(/\bpercent\b/gi, "%")
            .replace(/[{}[\]]/g, (char) => (char === "{" || char === "[" ? "(" : ")"))
            .replace(/[−–—]/g, "-")
            .replace(/\^/g, "**")
        )
      )
    )
  )
    .replace(/\bsqrt\s*\*/gi, "sqrt")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeMath(text: string) {
  return /[0-9a-zA-Z]/.test(text) && /[=+\-*/^%]|\\[dt]?frac|\||\u221a|\b(?:sqrt|abs)\b/i.test(text);
}

function uniqueCandidates(candidates: ClaimKind[]) {
  return candidates.filter((candidate, index) => candidates.indexOf(candidate) === index);
}

function operationCandidates(text: string): ClaimKind[] {
  const candidates: ClaimKind[] = [];

  if (/\b(?:factor\s+out|take\s+out|pull\s+out|common\s+factor)\b/i.test(text)) {
    candidates.push("factor_claim", "operation_claim");
  } else if (
    /\b(?:cancel|divide(?:\s+both\s+sides)?\s+by|multiply(?:\s+both\s+sides)?\s+by|clear|reduce|simplify)\b/i.test(
      text
    )
  ) {
    candidates.push("operation_claim");
  }

  return candidates;
}

function baseClaim(
  kind: ClaimKind,
  raw: string,
  normalized: string | null,
  candidates: ClaimKind[],
  confidence: number,
  allowSymbolicFallback: boolean
): Claim {
  return {
    kind,
    candidates: uniqueCandidates([kind, ...candidates]),
    raw,
    normalized,
    confidence,
    allowSymbolicFallback,
  };
}

export function parseClaim(raw: string): Claim {
  const trimmed = raw.trim();
  const typoNormalized = normalizeStudentProseTypos(trimmed).text;
  const operations = operationCandidates(typoNormalized);
  if (!trimmed) {
    return baseClaim("unknown", raw, null, [], 0.1, false);
  }

  if (/[?]$|^(?:can|should|do|does|is|are|what|why|how)\b/i.test(typoNormalized)) {
    return baseClaim("question", raw, null, operations, 0.9, false);
  }

  const finalAnswerMatch = typoNormalized.match(
    /\b(?:(?:answer|final answer|final)(?:\s+is)?|equals?)\b[\s:=-]*([a-zA-Z]?\s*=?\s*-?\d+(?:\s*\/\s*\d+)?|-?\d+(?:\s*\/\s*\d+)?)\s*$/i
  );
  if (finalAnswerMatch) {
    return baseClaim("final_answer", raw, normalizeClaimMath(finalAnswerMatch[1]), operations, 0.95, true);
  }

  if (operations.length > 0 && !typoNormalized.includes("=")) {
    return baseClaim(operations[0], raw, normalizeClaimMath(typoNormalized), operations.slice(1), 0.9, false);
  }

  if (typoNormalized.includes("=")) {
    return baseClaim("equation", raw, normalizeClaimMath(typoNormalized), operations, 0.9, true);
  }

  const normalizedMath = normalizeClaimMath(typoNormalized);
  if (/^[0-9_+\-*/().\s%|]+$/.test(normalizedMath) && looksLikeMath(typoNormalized)) {
    return baseClaim("numeric_expression", raw, normalizedMath, operations, 0.9, true);
  }

  if (/^[0-9a-zA-Z_+\-*/^().\s%|\\{}]+$/.test(typoNormalized) && looksLikeMath(typoNormalized)) {
    return baseClaim("expression", raw, normalizedMath, operations, 0.85, true);
  }

  if (looksLikeMath(typoNormalized)) {
    return baseClaim("prose_math", raw, normalizedMath, operations, 0.65, false);
  }

  return baseClaim("unknown", raw, null, operations, 0.2, false);
}
