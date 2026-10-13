import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { VerificationResult } from "@/lib/coachVerifier";
import type { CoachSession } from "@/lib/sessionStore";
import { canonicalizeNumericTokens } from "@/lib/numericText";

const execFileAsync = promisify(execFile);

type CanonicalClaim = {
  submitted: string;
  references: string[];
  finalAnswer: string | null;
};

type CanonicalSympyResult = {
  equivalentToReference?: boolean;
  equivalentAfterAcceptedSubstitution?: boolean;
  equivalentToFinal?: boolean;
  internallyTrue?: boolean;
  positiveAssignmentSatisfiesReference?: boolean;
  solutionSetMatchesReference?: boolean;
  reason?: string;
};

function pythonExecutable() {
  return process.env.SYMPY_PYTHON_PATH || process.env.PYTHON_PATH || "python";
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

function readLatexGroup(text: string, start: number) {
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

function replaceLatexFractions(text: string): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    const fractionCommand = text.slice(index).match(/^\\[dt]?frac/);
    if (fractionCommand) {
      const numerator = readLatexGroup(text, index + fractionCommand[0].length);
      const denominator = numerator ? readLatexGroup(text, numerator.end) : null;

      if (numerator && denominator) {
        result += `((${replaceLatexFractions(numerator.content)})/(${replaceLatexFractions(
          denominator.content
        )}))`;
        index = denominator.end;
        continue;
      }

      const compactFraction = text
        .slice(index)
        .match(/^\\[dt]?frac\s*([a-zA-Z0-9])\s*([a-zA-Z0-9])/);
      if (compactFraction) {
        result += `((${compactFraction[1]})/(${compactFraction[2]}))`;
        index += compactFraction[0].length;
        continue;
      }
    }

    result += text[index];
    index += 1;
  }

  return result;
}

function replaceLatexSquareRoots(text: string): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    const rootCommand = text.slice(index).match(/^\\sqrt(?![a-zA-Z])/);
    if (rootCommand) {
      const radicand = readLatexGroup(text, index + rootCommand[0].length);
      if (radicand) {
        result += `sqrt(${replaceLatexSquareRoots(radicand.content)})`;
        index = radicand.end;
        continue;
      }

      const bareRadicand = text
        .slice(index + rootCommand[0].length)
        .match(/^\s*([0-9a-zA-Z]+)/);
      if (bareRadicand) {
        result += `sqrt(${bareRadicand[1]})`;
        index += rootCommand[0].length + bareRadicand[0].length;
        continue;
      }
    }

    result += text[index];
    index += 1;
  }

  return result;
}

function normalizePercentTokens(text: string) {
  return text
    .replace(/(-?\d+\s+\d+\s*\/\s*\d+)\s*%/g, "(($1)/100)")
    .replace(/(-?\d+\s*\/\s*\d+)\s*%/g, "(($1)/100)")
    .replace(/(-?\d*\.\d+)\s*%/g, "(($1)/100)")
    .replace(/(-?\d+)\s*%/g, "(($1)/100)");
}

function normalizeMixedNumbers(text: string) {
  return text.replace(
    /(-?\d+)\s+(\d+)\s*\/\s*(\d+)/g,
    (_match, wholeText: string, numeratorText: string, denominatorText: string) => {
      const whole = BigInt(wholeText);
      const numerator = BigInt(numeratorText);
      const denominator = BigInt(denominatorText);
      const sign = whole < BigInt(0) ? BigInt(-1) : BigInt(1);

      return `((${whole * denominator + sign * numerator})/${denominator})`;
    }
  );
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

function normalizeMathText(text: string) {
  return normalizeMixedNumbers(
    normalizePercentTokens(
      replaceLatexSquareRoots(
        replaceLatexFractions(normalizeRepeatingDecimals(normalizeVulgarFractions(text)))
      )
        .replace(/(%|\bpercent\b)\s+of\s+(?=[a-zA-Z0-9(])/gi, "$1 * ")
        .replace(/\$/g, "")
        .replace(/\\left|\\right/g, "")
        .replace(/\\(?:cdot|times|ast)(?![a-zA-Z])|[\u00d7\u00b7]/g, "*")
        .replace(/\\div|\u00f7/g, "/")
        .replace(/\\sqrt\s*\{\s*([^{}]+)\s*\}/g, "sqrt($1)")
        .replace(/\\sqrt\s*([0-9a-zA-Z]+)/g, "sqrt($1)")
        .replace(/\u221a\s*\{\s*([^{}]+)\s*\}/g, "sqrt($1)")
        .replace(/\u221a\s*\(\s*([^()]+)\s*\)/g, "sqrt($1)")
        .replace(/\bsqrt\s*([0-9a-zA-Z]+)\b/gi, "sqrt($1)")
        .replace(/\\pm|\u00b1/g, "plusminus")
        .replace(/\\pi(?![a-zA-Z])|\u03c0/g, "pi")
        .replace(/pi(?=\d|\()/g, "pi*")
        .replace(/(\d|\))(?=pi)/g, "$1*")
        .replace(/\bis equal to\b/gi, "=")
        .replace(/\bpercent\b/gi, "%")
        .replace(/[{}[\]]/g, (char) => (char === "{" || char === "[" ? "(" : ")"))
        .replace(/[−–—]/g, "-")
        .replace(/\^/g, "**")
        .replace(/(\d|\))\s*(?=sqrt\s*\()/gi, "$1*")
    )
  ).trim();
}

function extractProblemMath(problem: string) {
  const normalized = normalizeMathText(problem);
  const expressMatch = normalized.match(
    /\b(?:express|write|convert|give)\s+(.+?)\s+as\s+(?:a\s+)?(?:common\s+)?fraction\b/i
  );

  if (expressMatch) return normalizeMathText(expressMatch[1]);

  const equationMatch = normalized.match(/[0-9a-z().+\-*/^=\s]+=[0-9a-z().+\-*/^=\s]+/i);
  if (equationMatch) return normalizeMathText(equationMatch[0]);

  return null;
}

function embeddedMathCandidates(text: string) {
  return [...text.matchAll(/\$([^$]+)\$/g)]
    .map((match) => normalizeMathText(match[1]))
    .filter((candidate) => isPlausibleMath(candidate));
}

function coachProvidedScalarAssignments(session: CoachSession) {
  const assignmentPattern = /(?:^|[$\s,(;:])([a-z])\s*=\s*(-?\d+(?:\.\d+)?(?:\s*\/\s*-?\d+)?)\b/gi;

  return (session.history || [])
    .filter((entry) => entry.role === "assistant")
    .slice(-8)
    .flatMap((entry) =>
      [...entry.content.matchAll(assignmentPattern)].map((match) =>
        normalizeMathText(`${match[1]}=${match[2]}`)
      )
    );
}

function candidateReferenceLines(session: CoachSession) {
  return [
    session.workState?.lastValidLine,
    ...(session.workState?.acceptedLines || []).slice(-8).reverse(),
    extractProblemMath(session.problem),
  ]
    .filter((line): line is string => Boolean(line?.trim()))
    .flatMap((line) => {
      const normalized = normalizeMathText(line);
      const labeledRight = descriptiveLabeledMathRight(line);
      return [normalized, labeledRight, ...embeddedMathCandidates(line)].filter(
        (candidate): candidate is string => Boolean(candidate)
      );
    })
    .concat(coachProvidedScalarAssignments(session));
}

function internallyTrueClaimUsesReference(
  submitted: string,
  references: string[]
) {
  const compactSubmitted = submitted.replace(/\s+/g, "");

  return references.some((reference) => {
    const compactReference = reference.replace(/\s+/g, "");
    return compactReference.length >= 3 && compactSubmitted.includes(compactReference);
  });
}

function hasNonnegativeGeometryContext(session: CoachSession) {
  const context = [
    session.problem,
    session.strategy?.game_plan || "",
    session.strategy?.what_to_look_for || "",
    session.strategy?.smart_move || "",
    session.strategy?.your_turn || "",
    ...(session.workState?.acceptedLines || []).slice(-4),
    session.workState?.lastValidLine || "",
  ].join(" ");

  return /\b(?:length|distance|radius|diameter|height|width|side|hypotenuse|leg|perimeter|area|volume)\b/i.test(
    context
  );
}

function isPlausibleMath(text: string) {
  const normalized = normalizeMathText(text);
  if (!/[0-9]/.test(normalized)) return false;
  if (/[;`]|(?:^|\W)(?:import|exec|eval|open|while|for|lambda)(?:$|\W)/i.test(normalized)) {
    return false;
  }

  return /^[0-9a-zA-Z_+\-*/().=,\s<>%]+$/.test(normalized);
}

function descriptiveLabeledMathRight(text: string) {
  const equality = text.match(/^\s*([a-zA-Z][a-zA-Z ]{3,})\s*=\s*(.+)\s*$/);
  if (!equality || !/\d|\\pi|\u03c0/i.test(equality[2])) return null;

  const right = normalizeMathText(equality[2]);
  return isPlausibleMath(right) ? right : null;
}

function submittedMathFromMessage(message: string) {
  const descriptiveRight = descriptiveLabeledMathRight(message);
  if (descriptiveRight) return descriptiveRight;

  const labeledCandidate = message
    .replace(/^\s*(?:final\s+answer|answer|final)\s*(?:is|=|:)?\s*/i, "")
    .trim();
  if (labeledCandidate !== message.trim() && isPlausibleMath(labeledCandidate)) {
    return normalizeMathText(labeledCandidate);
  }

  const bareUnitAnswerMatch = message.match(
    /^\s*(-?\d+(?:\s*\/\s*\d+)?)(?:\s+[a-zA-Z]+){0,4}[\s?.!]*$/i
  );
  const bareUnitCandidate = bareUnitAnswerMatch?.[1]?.trim();
  if (bareUnitCandidate && isPlausibleMath(bareUnitCandidate)) {
    return normalizeMathText(bareUnitCandidate);
  }

  const trailingAnswerMatch = message.match(
    /(?:^|[^0-9a-zA-Z])((?:[a-zA-Z]\s*=\s*)?(?:-?\d+(?:\.\d+)?(?:\s*\/\s*\d+)?|\\[dt]?frac\s*\{\s*-?\d+\s*\}\s*\{\s*\d+\s*\}))\s*[\s?.!]*$/i
  );
  const trailingCandidate = trailingAnswerMatch?.[1]?.trim();
  if (trailingCandidate && !isPlausibleMath(message) && isPlausibleMath(trailingCandidate)) {
    return normalizeMathText(trailingCandidate);
  }

  const finalAnswerMatch = message.match(
    /\b(?:answer|final answer|final page|last page|page number|there\s+(?:are|is)|is|are|equals?|got)\b(?:[^0-9a-zA-Z+\-*/().=]+)?([a-zA-Z]?\s*=?\s*-?\d+(?:\s*\/\s*\d+)?|-?\d+(?:\s*\/\s*\d+)?)(?:\s+[a-zA-Z]+(?:\s+[a-zA-Z]+){0,3})?[\s?.!]*$/i
  );
  const candidate = finalAnswerMatch?.[1]?.trim();
  if (candidate && isPlausibleMath(candidate)) return normalizeMathText(candidate);

  return isPlausibleMath(message) ? normalizeMathText(message) : null;
}

function normalizeShortTextAnswer(text: string) {
  const stripped = text
    .replace(/^\s*(?:final\s+answer|answer|final|the\s+answer|the\s+month)\s*(?:is|=|:)?\s*/i, "")
    .replace(/^\s*it\s+will\s+be\s+/i, "")
    .replace(/[.!?]+$/g, "")
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");

  if (!stripped || stripped.length > 60) return null;
  if (/[0-9\\{}()[\]=+*/^<>]|,|;/.test(stripped)) return null;
  if (!/[a-z]/i.test(stripped)) return null;

  return stripped;
}

function isShortTextFinalAnswer(finalAnswer: string) {
  return Boolean(normalizeShortTextAnswer(finalAnswer));
}

function asksForCommonFraction(problem: string) {
  return /\b(?:common\s+fraction|fraction)\b/i.test(problem);
}

function asksForPercentAnswer(problem: string) {
  return /\b(?:what|which)\s+percent\b|\bas\s+(?:a\s+)?percent(?:age)?\b|\bpercent(?:age)?\s+(?:of|increase|decrease|change)\b/i.test(
    problem
  );
}

function submittedUsesPercent(message: string) {
  return /%|\bpercent\b/i.test(message);
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

function isReducedCommonFractionSubmission(message: string) {
  const normalized = normalizeVulgarFractions(message)
    .replace(/\$/g, "")
    .replace(/final\s+answer\s*:/gi, "")
    .replace(/\banswer\s*:/gi, "")
    .replace(/[−–—]/g, "-")
    .trim();
  const assignment = normalized.match(/^(?:[a-zA-Z]\s*=\s*(.+)|(.+)\s*=\s*[a-zA-Z])$/);
  const candidate = (assignment?.[1] || assignment?.[2] || normalized).trim();
  const latexFraction = normalized.match(
    /^\\[dt]?frac\s*\{\s*(-?\d+)\s*\}\s*\{\s*(\d+)\s*\}$/i
  );
  const assignmentLatexFraction = candidate.match(
    /^\\[dt]?frac\s*\{\s*(-?\d+)\s*\}\s*\{\s*(\d+)\s*\}$/i
  );
  const compactLatexFraction = candidate.match(
    /^\\[dt]?frac\s*(-?\d)\s*(\d)$/i
  );
  const plainFraction = candidate.match(/^\s*(-?\d+)\s*\/\s*(\d+)\s*$/);
  const normalizedFraction = candidate.match(
    /^\s*\(?\(?\s*(-?\d+)\s*\)?\s*\/\s*\(?\s*(\d+)\s*\)?\)?\s*$/
  );
  const fraction =
    latexFraction ||
    assignmentLatexFraction ||
    compactLatexFraction ||
    plainFraction ||
    normalizedFraction;
  if (!fraction) return false;

  const numerator = BigInt(fraction[1]);
  const denominator = BigInt(fraction[2]);
  return denominator !== BigInt(0) && gcdBigInt(numerator, denominator) === BigInt(1);
}

function submittedIsReducedCommonFraction(message: string, submittedMath?: string) {
  return (
    isReducedCommonFractionSubmission(message) ||
    Boolean(submittedMath && isReducedCommonFractionSubmission(submittedMath))
  );
}

function satisfiesFinalAnswerFormat(
  session: CoachSession,
  message: string,
  submittedMath?: string
) {
  if (asksForPercentAnswer(session.problem) && !submittedUsesPercent(message)) {
    return false;
  }
  if (
    submittedMath &&
    /\//.test(submittedMath) &&
    submittedIsReducedCommonFraction(session.solutionGuide?.finalAnswer || "") &&
    !submittedIsReducedCommonFraction(message, submittedMath)
  ) {
    return false;
  }
  if (!asksForCommonFraction(session.problem)) return true;
  if (
    submittedIsIntegerScalar(message, submittedMath) &&
    session.solutionGuide?.finalAnswer &&
    isIntegerScalar(session.solutionGuide.finalAnswer)
  ) {
    return true;
  }
  return !submittedUsesPercent(message) && submittedIsReducedCommonFraction(message, submittedMath);
}

function isIntegerScalar(text: string) {
  const normalized = normalizeMathText(text).trim();
  return /^[a-zA-Z]?\s*=?\s*-?\d+$/.test(normalized);
}

function submittedIsIntegerScalar(message: string, submittedMath?: string) {
  return isIntegerScalar(message) || Boolean(submittedMath && isIntegerScalar(submittedMath));
}

function isScalarLikeFinalAnswer(finalAnswer: string) {
  const withoutThousandsSeparators = canonicalizeNumericTokens(finalAnswer);
  const normalized = normalizeMathText(withoutThousandsSeparators);
  const compact = normalized.replace(/\s+/g, "");

  if (!compact) return false;
  if (compact.includes(",") || /[{}[\]]/.test(withoutThousandsSeparators)) return false;
  if (/\b(?:and|or|to|through|between|all|values?|solutions?|ordered\s+pair|tuple|set|interval|range)\b/i.test(withoutThousandsSeparators)) {
    return false;
  }
  if (/^[[(].*[,<].*[\])]$/.test(compact)) return false;
  if (/^[[(]-?\d/.test(compact) && /[\])]$/.test(compact) && compact.includes(",")) return false;

  return /^[a-zA-Z]?\s*=?\s*-?\d+(?:\.\d+)?(?:\s*\/\s*-?\d+)?$/.test(withoutThousandsSeparators.trim()) ||
    /^[a-zA-Z]?\s*=?\s*\\[dt]?frac\s*\{\s*-?\d+\s*\}\s*\{\s*-?\d+\s*\}$/.test(withoutThousandsSeparators.trim()) ||
    /^[a-zA-Z]?\s*=?\s*[0-9a-zA-Z_+\-*/().\s^]+$/.test(normalized);
}

function scalarMathCandidatesFromFinalAnswer(finalAnswer: string) {
  const hasRatioLabel = /\bratio\b/i.test(finalAnswer);
  if (
    /\b(?:and|or|through|between|all|values?|solutions?|ordered\s+pair|tuple|set|interval|range)\b/i.test(finalAnswer) ||
    (/\bto\b/i.test(finalAnswer) && !hasRatioLabel)
  ) {
    return [];
  }

  const withoutThousandsSeparators = canonicalizeNumericTokens(finalAnswer);
  const candidates = new Set<string>();
  const directMath = submittedMathFromMessage(withoutThousandsSeparators);
  if (directMath && isScalarLikeFinalAnswer(directMath)) {
    candidates.add(directMath);
  }

  const withoutLabel = withoutThousandsSeparators
    .replace(/^\s*(?:final\s+answer|answer|final|the\s+answer)\s*(?:is|=|:)?\s*/i, "")
    .trim();

  const addScalarCandidate = (candidate: string | undefined) => {
    const trimmed = candidate?.replace(/[.!?]+$/g, "").trim();
    if (!trimmed) return;
    const normalized = normalizeMathText(trimmed);
    if (isScalarLikeFinalAnswer(normalized)) candidates.add(normalized);
  };

  const lastEquality = withoutLabel.lastIndexOf("=");
  if (lastEquality !== -1) {
    addScalarCandidate(withoutLabel.slice(lastEquality + 1));
  }
  addScalarCandidate(
    withoutLabel.match(/\b(?:is|equals?)\s+(.+)$/i)?.[1]
  );

  const leadingScalar = withoutLabel.match(
    /^\s*((?:[a-zA-Z]\s*=\s*)?-?\d+(?:\.\d+)?(?:\s*\/\s*-?\d+)?|(?:[a-zA-Z]\s*=\s*)?\\[dt]?frac\s*\{\s*-?\d+\s*\}\s*\{\s*-?\d+\s*\})(?=$|[\s,.;:)])/i
  )?.[1];
  if (leadingScalar) {
    const normalized = normalizeMathText(leadingScalar);
    if (isScalarLikeFinalAnswer(normalized)) candidates.add(normalized);
  }

  for (const match of withoutThousandsSeparators.matchAll(/\(\s*(-?\d+(?:\.\d+)?(?:\s*\/\s*-?\d+)?)\s*\)/g)) {
    const normalized = normalizeMathText(match[1]);
    if (isScalarLikeFinalAnswer(normalized)) candidates.add(normalized);
  }

  for (const match of withoutThousandsSeparators.matchAll(/\\[dt]?frac\s*\{\s*(-?\d+)\s*\}\s*\{\s*(-?\d+)\s*\}/gi)) {
    candidates.add(`${match[1]}/${match[2]}`);
  }

  return [...candidates];
}

async function runCanonicalSympy(claim: CanonicalClaim): Promise<CanonicalSympyResult | null> {
  const payload = JSON.stringify(claim);
  const script = String.raw`
import json
import sys
from sympy import solve, simplify, together
from sympy.parsing.sympy_parser import (
    parse_expr,
    standard_transformations,
    implicit_multiplication_application,
    convert_xor,
)

ALLOWED_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_+-*/().,= <>")
TRANSFORMS = standard_transformations + (implicit_multiplication_application, convert_xor)

def parse_math(text):
    if text is None:
        raise ValueError("missing expression")
    if len(text) > 240:
        raise ValueError("expression too long")
    if not set(text) <= ALLOWED_CHARS:
        raise ValueError("unsupported characters")
    return parse_expr(text, transformations=TRANSFORMS, evaluate=False)

def as_difference(text):
    if text is None:
        raise ValueError("missing expression")
    if text.count("=") == 1:
        left, right = text.split("=", 1)
        return parse_math(left) - parse_math(right)
    return parse_math(text)

def is_equation(text):
    return text is not None and text.count("=") == 1

def equation_parts(text):
    if not is_equation(text):
        raise ValueError("not a single equation")
    left, right = text.split("=", 1)
    return parse_math(left), parse_math(right)

def is_symbol(expr):
    return bool(getattr(expr, "is_Symbol", False))

def variable_assignment(text):
    if not is_equation(text):
        return None
    left, right = equation_parts(text)
    if is_symbol(left):
        return left, right
    if is_symbol(right):
        return right, left
    return None

def system_equations(text):
    if text is None or text.count("=") < 2:
        return []
    pieces = [piece.strip() for piece in text.split(",") if piece.strip()]
    if len(pieces) < 2 or any(piece.count("=") != 1 for piece in pieces):
        return []
    return pieces

def assignment_matches_system(assignment_text, system_text):
    assignment = variable_assignment(assignment_text)
    equations = system_equations(system_text)
    if not assignment or not equations:
        return False

    target_symbol, target_value = assignment
    differences = [as_difference(equation) for equation in equations]
    symbols = sorted(
        set().union(*(difference.free_symbols for difference in differences)),
        key=lambda symbol: symbol.name,
    )
    if target_symbol not in symbols:
        return False

    solutions = solve(differences, symbols, dict=True)
    return any(
        target_symbol in solution and simplify(solution[target_symbol] - target_value) == 0
        for solution in solutions
    )

def merge_substitutions(base, candidate):
    merged = dict(base)
    for symbol, value in candidate.items():
        if symbol in merged and simplify(merged[symbol] - value) != 0:
            return None
        merged[symbol] = value
    return merged

def substitutions_from_reference(reference):
    try:
        equations = system_equations(reference) or ([reference] if is_equation(reference) else [])
        if not equations:
            return []
        differences = [as_difference(equation) for equation in equations]
        symbols = sorted(
            set().union(*(difference.free_symbols for difference in differences)),
            key=lambda symbol: symbol.name,
        )
        if not symbols:
            return []
        return solve(differences, symbols, dict=True)
    except Exception:
        return []

def reference_substitution_sets(references):
    substitution_sets = [{}]
    for reference in references:
        candidates = substitutions_from_reference(reference)
        if not candidates:
            continue
        next_sets = []
        for existing in substitution_sets:
            for candidate in candidates:
                merged = merge_substitutions(existing, candidate)
                if merged is not None:
                    next_sets.append(merged)
        if next_sets:
            substitution_sets = next_sets
    return substitution_sets

def value_matches_final_with_substitutions(submitted_text, final_text, references):
    if not final_text:
        return False
    try:
        final_value = parse_math(final_text)
    except Exception:
        return False

    substitution_sets = reference_substitution_sets(references)
    for substitutions in substitution_sets:
        try:
            if is_equation(submitted_text):
                assignment = variable_assignment(submitted_text)
                if assignment:
                    _target_symbol, target_value = assignment
                    if simplify(target_value.subs(substitutions) - final_value) == 0:
                        return True

                left, right = equation_parts(submitted_text)
                left_value = simplify(left.subs(substitutions))
                right_value = simplify(right.subs(substitutions))
                if (
                    simplify(left_value - right_value) == 0 and
                    (
                        simplify(left_value - final_value) == 0 or
                        simplify(right_value - final_value) == 0
                    )
                ):
                    return True
            else:
                submitted_value = simplify(parse_math(submitted_text).subs(substitutions))
                if simplify(submitted_value - final_value) == 0:
                    return True
        except Exception:
            continue
    return False

def equation_equivalent(left, right):
    left_difference = as_difference(left)
    right_difference = as_difference(right)
    if simplify(left_difference - right_difference) == 0:
        return True
    left_numerator, _left_denominator = together(left_difference).as_numer_denom()
    right_numerator, _right_denominator = together(right_difference).as_numer_denom()
    if simplify(left_numerator - right_numerator) == 0:
        return True
    numerator_ratio = simplify(left_numerator / right_numerator)
    if numerator_ratio.is_number and numerator_ratio != 0:
        return True
    ratio = simplify(left_difference / right_difference)
    return bool(ratio.is_number and ratio != 0)

def equivalent(left, right):
    if assignment_matches_system(left, right) or assignment_matches_system(right, left):
        return True
    if is_equation(left) and is_equation(right):
        return equation_equivalent(left, right)
    return simplify(as_difference(left) - as_difference(right)) == 0

def positive_assignment_satisfies_equation(assignment_text, equation_text):
    try:
        assignment = variable_assignment(assignment_text)
        if not assignment or not is_equation(equation_text):
            return False
        target_symbol, target_value = assignment
        reference_difference = as_difference(equation_text)
        if target_symbol not in reference_difference.free_symbols:
            return False
        if target_value.is_nonnegative is not True:
            compact_assignment = assignment_text.replace(" ", "")
            _left_text, right_text = compact_assignment.split("=", 1)
            assigned_text = right_text if _left_text == str(target_symbol) else _left_text
            if "sqrt(" not in assigned_text or assigned_text.startswith("-"):
                return False
        return simplify(reference_difference.subs(target_symbol, target_value)) == 0
    except Exception:
        return False

def plus_minus_solution_matches_equation(solution_text, equation_text):
    try:
        if "plusminus" not in solution_text or not is_equation(equation_text):
            return False
        pieces = [piece.strip() for piece in solution_text.split("=")]
        if len(pieces) < 2:
            return False
        target_symbol = parse_math(pieces[0])
        if not is_symbol(target_symbol):
            return False

        candidate_text = pieces[-1]
        candidate_values = [
            simplify(parse_math(candidate_text.replace("plusminus", sign)))
            for sign in ("+", "-")
        ]
        reference_difference = as_difference(equation_text)
        if target_symbol not in reference_difference.free_symbols:
            return False
        if not all(
            simplify(reference_difference.subs(target_symbol, value)) == 0
            for value in candidate_values
        ):
            return False

        expected_values = solve(reference_difference, target_symbol)
        return (
            len(expected_values) == len(candidate_values) and
            all(
                any(simplify(expected - candidate) == 0 for candidate in candidate_values)
                for expected in expected_values
            ) and
            all(
                any(simplify(candidate - expected) == 0 for expected in expected_values)
                for candidate in candidate_values
            )
        )
    except Exception:
        return False

def safe_equivalent(left, right):
    try:
        return equivalent(left, right)
    except Exception:
        return False

def equivalent_after_accepted_substitution(submitted_text, references):
    try:
        submitted_difference = as_difference(submitted_text)
    except Exception:
        return False

    direct_substitutions = []
    for reference in references:
        try:
            assignment = variable_assignment(reference)
            if assignment:
                symbol, value = assignment
                direct_substitutions.append({symbol: value})
        except Exception:
            continue

    for substitutions in direct_substitutions:
        for reference in references:
            try:
                if not is_equation(reference):
                    continue
                reference_difference = simplify(as_difference(reference).subs(substitutions))
                if simplify(submitted_difference - reference_difference) == 0:
                    return True
                ratio = simplify(submitted_difference / reference_difference)
                if ratio.is_number and ratio != 0:
                    return True
            except Exception:
                continue
    return False

def internally_true(text):
    return text.count("=") == 1 and simplify(as_difference(text)) == 0

payload = json.loads(sys.argv[1])
submitted = payload.get("submitted")
references = payload.get("references") or []
final_answer = payload.get("finalAnswer")

try:
    equivalent_to_reference = any(
        safe_equivalent(submitted, reference) for reference in references
    )
    equivalent_after_substitution = equivalent_after_accepted_substitution(
        submitted, references
    )
    positive_assignment_satisfies_reference = any(
        positive_assignment_satisfies_equation(submitted, reference)
        for reference in references
    )
    solution_set_matches_reference = any(
        plus_minus_solution_matches_equation(submitted, reference)
        for reference in references
    )
    equivalent_to_final = bool(
        final_answer and (
            safe_equivalent(submitted, final_answer) or
            value_matches_final_with_substitutions(submitted, final_answer, references)
        )
    )
    print(json.dumps({
        "equivalentToReference": bool(equivalent_to_reference),
        "equivalentAfterAcceptedSubstitution": bool(equivalent_after_substitution),
        "equivalentToFinal": bool(equivalent_to_final),
        "internallyTrue": bool(internally_true(submitted)),
        "positiveAssignmentSatisfiesReference": bool(positive_assignment_satisfies_reference),
        "solutionSetMatchesReference": bool(solution_set_matches_reference),
    }))
except Exception as exc:
    print(json.dumps({"reason": str(exc)}))
`;

  try {
    const { stdout } = await execFileAsync(pythonExecutable(), ["-c", script, payload], {
      timeout: 2500,
      windowsHide: true,
      maxBuffer: 32_000,
    });

    return JSON.parse(stdout) as CanonicalSympyResult;
  } catch {
    return null;
  }
}

export async function canonicalSympyVerify(
  session: CoachSession,
  message: string
): Promise<VerificationResult | null> {
  const submitted = submittedMathFromMessage(message);
  if (!submitted) return null;

  const references = candidateReferenceLines(session).filter((reference) => reference !== submitted);
  const normalizedFinalAnswer = session.solutionGuide?.finalAnswer
    ? normalizeMathText(session.solutionGuide.finalAnswer)
    : null;
  const finalAnswer = normalizedFinalAnswer;

  if (references.length === 0 && !finalAnswer) return null;

  const result = await runCanonicalSympy({ submitted, references, finalAnswer });
  if (!result) return null;

  if (result.equivalentToFinal && satisfiesFinalAnswerFormat(session, message, submitted)) {
    return {
      intent: "final_answer",
      status: "correct",
      local_error: null,
      valid_progress: "That final answer is correct.",
      suggested_next_check: null,
      should_finish: true,
      confidence: 0.99,
      source: "symbolic",
    };
  }

  if (result.equivalentToFinal) {
    const reducedCommonFractionFinal =
      asksForCommonFraction(session.problem) &&
      !submittedUsesPercent(message) &&
      submittedIsReducedCommonFraction(message, submitted);

    if (reducedCommonFractionFinal) {
      return {
        intent: "final_answer",
        status: "correct",
        local_error: null,
        valid_progress: "That final answer is correct.",
        suggested_next_check: null,
        should_finish: true,
        confidence: 0.99,
        source: "symbolic",
      };
    }

    return {
      intent: "submitted_work",
      status: submittedUsesPercent(message) ? "correct" : "partially_correct",
      local_error: null,
      valid_progress: "That is correct.",
      suggested_next_check: submittedUsesPercent(message)
        ? "Now convert the percent form into a common fraction."
        : "Reduce the fraction to lowest terms.",
      should_finish: false,
      confidence: 0.99,
      source: "symbolic",
    };
  }

  if (result.equivalentToReference || result.equivalentAfterAcceptedSubstitution) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That step is correct.",
      suggested_next_check: "Continue from this form and make the next useful step.",
      should_finish: false,
      confidence: 0.99,
      source: "symbolic",
    };
  }

  if (result.internallyTrue && internallyTrueClaimUsesReference(submitted, references)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That local symbolic simplification is correct.",
      suggested_next_check: "What would you try next?",
      should_finish: false,
      confidence: 0.99,
      source: "symbolic",
    };
  }

  if (result.solutionSetMatchesReference) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That quadratic-formula step gives the two roots of your equation.",
      suggested_next_check: "What would you try next?",
      should_finish: false,
      confidence: 0.99,
      source: "symbolic",
    };
  }

  if (
    result.positiveAssignmentSatisfiesReference &&
    hasNonnegativeGeometryContext(session)
  ) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That positive-root step is correct for this geometric quantity.",
      suggested_next_check: "Continue from that value and make the next useful step.",
      should_finish: false,
      confidence: 0.99,
      source: "symbolic",
    };
  }

  return null;
}

export async function canonicalFinalAnswerMatches(
  session: CoachSession,
  message: string
): Promise<boolean | null> {
  const submitted = submittedMathFromMessage(message);
  const rawFinalAnswer = session.solutionGuide?.finalAnswer || null;
  if (!rawFinalAnswer) return null;

  if (isShortTextFinalAnswer(rawFinalAnswer)) {
    const expectedText = normalizeShortTextAnswer(rawFinalAnswer);
    const submittedText = normalizeShortTextAnswer(message);
    return submittedText ? submittedText === expectedText : null;
  }

  const finalAnswerCandidates = scalarMathCandidatesFromFinalAnswer(rawFinalAnswer);
  if (isScalarLikeFinalAnswer(rawFinalAnswer)) {
    finalAnswerCandidates.push(normalizeMathText(rawFinalAnswer));
  }

  if (!submitted || finalAnswerCandidates.length === 0) return null;

  let sawMismatch = false;

  for (const finalAnswer of [...new Set(finalAnswerCandidates)]) {
    const result = await runCanonicalSympy({
      submitted,
      references: [],
      finalAnswer,
    });

    if (result?.equivalentToFinal && !satisfiesFinalAnswerFormat(session, message, submitted)) {
      return false;
    }

    if (result?.equivalentToFinal) return true;
    if (result?.equivalentToFinal === false) sawMismatch = true;
  }

  return sawMismatch ? false : null;
}
