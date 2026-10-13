import type { CoachSession } from "@/lib/sessionStore";
import {
  equalRational,
  formatRational,
  negateRational,
  normalizeRational,
  parseArithmetic,
  type Rational,
} from "@/lib/coach-verifier/math";
import type { VerificationResult } from "@/lib/coach-verifier/types";

function canonicalInequality(text: string) {
  return text
    .toLowerCase()
    .replace(/\\leq?(?![a-zA-Z])|≤/g, "<=")
    .replace(/\\geq?(?![a-zA-Z])|≥/g, ">=")
    .replace(/\\(?:cdot|times|ast)(?![a-zA-Z])|[×·]/g, "*")
    .replace(/[${}\s]/g, "");
}

export function verifyStatedGirthConstraint(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const problemText = session.problem.replace(/\$|\\\(|\\\)|\\\[|\\\]/g, "");
  const lengthVariable = problemText.match(
    /\blength\s*,?\s*(?:is\s+represented\s+by\s+)?([a-z])\b/i
  )?.[1];
  const girthExpression = problemText.match(
    /\bgirth\s*,?\s*((?:\d*\s*[a-z]\s*[+\-]\s*)+\d*\s*[a-z])/i
  )?.[1];
  const limit = problemText.match(
    /\b(?:not\s+exceed|at\s+most|no\s+more\s+than)\s*(\d+(?:\.\d+)?)/i
  )?.[1];
  if (!lengthVariable || !girthExpression || !limit) return null;

  const expected = canonicalInequality(
    `${lengthVariable}+${girthExpression}<=${limit}`
  );
  const reversed = canonicalInequality(
    `${limit}>=${lengthVariable}+${girthExpression}`
  );
  const submitted = canonicalInequality(message);
  if (submitted !== expected && submitted !== reversed) return null;

  return {
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress:
      "That inequality correctly combines the stated length and girth constraint.",
    suggested_next_check: "What would you try next?",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function sortedTriple(values: number[]) {
  return [...values].sort((left, right) => left - right);
}

function sameNumber(left: number, right: number) {
  return Math.abs(left - right) < 1e-9;
}

function parseNumber(text: string) {
  return Number(text.replace(/\s+/g, ""));
}

function canonicalSphereSurfaceText(text: string) {
  return text
    .toLowerCase()
    .replace(/\$/g, "")
    .replace(/\\(?:left|right)\b/g, "")
    .replace(/\\(?:cdot|times|ast)(?![a-zA-Z])|[×·]/g, "*")
    .replace(/\\pi|π/g, "pi")
    .replace(/[{}\s]/g, "")
    .replace(/\*+/g, "*");
}

export function verifySphereSurfaceAreaClaim(
  session: CoachSession,
  message: string
): VerificationResult | null {
  if (!/\bsphere\b/i.test(session.problem)) return null;

  const submitted = canonicalSphereSurfaceText(message);
  const surfaceLabel = "(?:s|surfaceareaof(?:a|the)?sphere)";
  const formulaPattern = new RegExp(
    `^${surfaceLabel}(?:=|is)4\\*?pi\\*?r\\^2$`,
    "i"
  );

  if (formulaPattern.test(submitted)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That is the correct surface-area formula for a sphere.",
      suggested_next_check: "What would you try next?",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const radiusText = session.problem.match(
    /\bradius(?:\s+(?:is|of))?\s*(\d+(?:\.\d+)?)/i
  )?.[1];
  const evaluatedMatch = submitted.match(
    new RegExp(`^${surfaceLabel}(?:=|is)(-?\\d+(?:\\.\\d+)?)\\*?pi$`, "i")
  );
  if (!radiusText || !evaluatedMatch) return null;

  const radius = Number(radiusText);
  const coefficient = Number(evaluatedMatch[1]);
  if (!Number.isFinite(radius) || !Number.isFinite(coefficient)) return null;
  const expectedCoefficient = 4 * radius * radius;

  if (sameNumber(coefficient, expectedCoefficient)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That surface-area value correctly uses the sphere's stated radius.",
      suggested_next_check: "What would you try next?",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "That surface-area value does not match the sphere's stated radius.",
    valid_progress: null,
    suggested_next_check: "Substitute the radius into $4\\pi r^2$ and recheck the squaring step.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function inscribedSquareAreas(problem: string) {
  const normalized = problem.replace(/\s+/g, " ");
  const match = normalized.match(
    /\bsquare\s+(?:with\s+(?:an?\s+)?area(?:\s+of)?|of\s+area)\s+(\d+(?:\.\d+)?)\s+is\s+inscribed\s+in\s+(?:a\s+)?square\s+(?:with\s+(?:an?\s+)?area(?:\s+of)?|of\s+area)\s+(\d+(?:\.\d+)?)/i
  );
  if (!match) return null;

  return {
    innerArea: Number(match[1]),
    outerArea: Number(match[2]),
  };
}

function normalizedRadicalRelation(message: string) {
  return message
    .replace(/\$/g, "")
    .replace(/\\sqrt\s*\{\s*(\d+(?:\.\d+)?)\s*\}/gi, "sqrt($1)")
    .replace(/\\sqrt\s*(\d+(?:\.\d+)?)/gi, "sqrt($1)")
    .replace(/\u221a\s*\{?\s*(\d+(?:\.\d+)?)\s*\}?/g, "sqrt($1)")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function strategyDefinesLegVariables(session: CoachSession, left: string, right: string) {
  const strategyText = [
    session.strategy?.game_plan || "",
    session.strategy?.what_to_look_for || "",
    session.strategy?.smart_move || "",
    session.strategy?.your_turn || "",
  ].join(" ");

  return (
    /\blegs?\b/i.test(strategyText) &&
    new RegExp(`\\b${left}\\b`, "i").test(strategyText) &&
    new RegExp(`\\b${right}\\b`, "i").test(strategyText)
  );
}

export function verifyInscribedSquareLegSumClaim(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const areas = inscribedSquareAreas(session.problem);
  if (
    !areas ||
    !Number.isFinite(areas.innerArea) ||
    !Number.isFinite(areas.outerArea) ||
    areas.innerArea <= 0 ||
    areas.outerArea <= areas.innerArea
  ) {
    return null;
  }

  const normalized = normalizedRadicalRelation(message);
  const forward = normalized.match(
    /^([a-z])\+([a-z])=sqrt\((\d+(?:\.\d+)?)\)$/i
  );
  const reversed = normalized.match(
    /^sqrt\((\d+(?:\.\d+)?)\)=([a-z])\+([a-z])$/i
  );
  const leftVariable = forward?.[1] || reversed?.[2];
  const rightVariable = forward?.[2] || reversed?.[3];
  const radicand = Number(forward?.[3] || reversed?.[1]);

  if (
    !leftVariable ||
    !rightVariable ||
    leftVariable.toLowerCase() === rightVariable.toLowerCase() ||
    !strategyDefinesLegVariables(session, leftVariable, rightVariable)
  ) {
    return null;
  }

  if (!sameNumber(radicand, areas.outerArea)) {
    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: "That radical does not give the outer square's side length.",
      valid_progress: null,
      suggested_next_check: "Use the stated outer-square area to recheck its side length.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress:
      "Those two leg segments add to one side of the outer square.",
    suggested_next_check: "What would you try next?",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function rationalFromInteger(value: number): Rational {
  return normalizeRational({
    numerator: BigInt(value),
    denominator: BigInt(1),
  });
}

function statedSquareArea(text: string) {
  const patterns = [
    /\barea\s+of\s+(?:the\s+)?(?:inscribed\s+)?square[\s\S]{0,80}?\b(?:is|equals?|=)\s*(\d+(?:\.\d+)?)/i,
    /\bsquare[\s\S]{0,80}?\b(?:has|with)\s+(?:an?\s+)?area\s+(?:of|equal(?:s)?\s+to)\s*(\d+(?:\.\d+)?)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }

  return null;
}

function claimedSquareSideRadicand(message: string) {
  if (!/\bsquare\b/i.test(message) || !/\b(?:side\s+length|length\s+of\s+(?:the\s+)?side)\b/i.test(message)) {
    return null;
  }

  const radical =
    String.raw`(?:\\sqrt\s*\{\s*(\d+(?:\.\d+)?)\s*\}|\\sqrt\s*(\d+(?:\.\d+)?)|sqrt\s*\(?\s*(\d+(?:\.\d+)?)\s*\)?|\u221a\s*\{?\s*(\d+(?:\.\d+)?)\s*\}?)`;
  const patterns = [
    new RegExp(
      String.raw`\b(?:side\s+length|length\s+of\s+(?:the\s+)?side)[\s\S]{0,60}?\b(?:is|equals?|=)\s*${radical}`,
      "i"
    ),
    new RegExp(
      String.raw`\bsquare\b[\s\S]{0,80}?\b(?:has|with)\s+(?:a\s+)?side\s+length\s+(?:of\s+)?${radical}`,
      "i"
    ),
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) return Number(match[1] || match[2] || match[3] || match[4]);
  }

  return null;
}

export function verifySquareAreaSideClaim(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const givenArea = statedSquareArea(session.problem);
  if (givenArea === null || !Number.isFinite(givenArea) || givenArea < 0) return null;

  const sideRadicand = claimedSquareSideRadicand(message);
  if (sideRadicand !== null) {
    if (sameNumber(sideRadicand, givenArea)) {
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That side length follows correctly from the square's area.",
        suggested_next_check: "Use that side length in the next geometric relationship.",
        should_finish: false,
        confidence: 1,
        source: "deterministic",
      };
    }

    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: "The number under the square root must equal the square's area.",
      valid_progress: null,
      suggested_next_check: "Recheck the stated area before writing the side length.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const claimedArea = statedSquareArea(message);
  if (claimedArea === null) return null;

  if (sameNumber(claimedArea, givenArea)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That correctly identifies the given area of the square.",
      suggested_next_check: "Use that area in the next geometric relationship.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "That is not the area stated for the square.",
    valid_progress: null,
    suggested_next_check: "Recheck the square's given area in the problem.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function rationalFromDecimalText(text: string): Rational | null {
  const normalized = text.trim();
  const match = normalized.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;

  const sign = match[1] === "-" ? BigInt(-1) : BigInt(1);
  const whole = match[2];
  const decimal = match[3] || "";
  const denominator = BigInt(10) ** BigInt(decimal.length);
  const numerator = BigInt(`${whole}${decimal || ""}`) * sign;

  return normalizeRational({ numerator, denominator });
}

function parseSubmittedRationalValue(message: string) {
  const normalized = message
    .replace(/\u2212|\u2013|\u2014/g, "-")
    .replace(/\?+$/g, "")
    .trim();
  const equalityParts = normalized.split("=").map((part) => part.trim()).filter(Boolean);
  const candidate =
    equalityParts.length > 1
      ? equalityParts[equalityParts.length - 1]
      : normalized.match(/\b(?:answer|area|width|length)\s*(?:is|=|equals?)\s*([^.,;]+)$/i)?.[1] ||
        (/^\s*-?\d+(?:\.\d+)?(?:\s*\/\s*\d+)?\s*$/.test(normalized) ? normalized : null);

  if (!candidate) return null;

  return /\d\.\d/.test(candidate)
    ? rationalFromDecimalText(candidate)
    : parseArithmetic(candidate) || rationalFromDecimalText(candidate);
}

function sameRationalMagnitude(left: Rational, right: Rational) {
  return equalRational(left, right) || equalRational(negateRational(left), right);
}

function rhombusAreaAndDiagonal(problem: string) {
  if (!/\brhombus\b/i.test(problem) || !/\barea\b/i.test(problem) || !/\bdiagonal\b/i.test(problem)) {
    return null;
  }

  const areaMatch = problem.match(/\barea\s+(?:of\s+)?(-?\d+(?:\.\d+)?)/i);
  const diagonalMatch = problem.match(/\bdiagonal(?:\s+of\s+length)?\s+(-?\d+(?:\.\d+)?)/i);
  const area = areaMatch ? Number(areaMatch[1]) : null;
  const diagonal = diagonalMatch ? Number(diagonalMatch[1]) : null;

  if (!area || !diagonal || area <= 0 || diagonal <= 0 || !Number.isInteger(area) || !Number.isInteger(diagonal)) {
    return null;
  }

  return { area, diagonal };
}

function looksLikeFinalLengthClaim(message: string) {
  return /\b(?:answer|final|length|other diagonal)\b/i.test(message);
}

function unitFractionFromWords(text: string) {
  const normalized = text.toLowerCase();
  const numeric = normalized.match(/\b(?:one\s*)?(\d+)\s*\/\s*(\d+)\b/);
  if (numeric && Number(numeric[1]) === 1) return Number(numeric[2]);

  const words: Record<string, number> = {
    half: 2,
    third: 3,
    fourth: 4,
    quarter: 4,
    fifth: 5,
    sixth: 6,
    seventh: 7,
    eighth: 8,
    ninth: 9,
    tenth: 10,
  };
  const match = normalized.match(
    /\b(?:one[-\s])?(half|third|fourth|quarter|fifth|sixth|seventh|eighth|ninth|tenth)\b/
  );

  return match ? words[match[1]] : null;
}

function fractionalRectangleAreaProblem(problem: string) {
  if (!/\bshaded\b/i.test(problem) || !/\brectangle\b/i.test(problem) || !/\barea\b/i.test(problem)) {
    return null;
  }

  const denominator = unitFractionFromWords(problem);
  const dimensions = problem.match(/\b(\d+)\s*(?:-| )?inch(?:es)?\s+by\s+(\d+)\s*(?:-| )?inch(?:es)?\b/i);
  if (!denominator || !dimensions) return null;

  return {
    denominator,
    wholeArea: Number(dimensions[1]) * Number(dimensions[2]),
  };
}

function rectanglePerimeterLengthAreaProblem(problem: string) {
  if (!/\brectangle\b/i.test(problem) || !/\bperimeter\b/i.test(problem) || !/\blength\b/i.test(problem)) {
    return null;
  }

  const perimeterMatch = problem.match(/\bperimeter(?:\s+(?:is|of))?\s+(-?\d+(?:\.\d+)?)\b/i);
  const lengthMatch = problem.match(/\blength(?:\s+(?:is|of))?\s+(-?\d+(?:\.\d+)?)\b/i);
  const perimeter = perimeterMatch ? Number(perimeterMatch[1]) : null;
  const length = lengthMatch ? Number(lengthMatch[1]) : null;

  if (!perimeter || !length || perimeter <= 0 || length <= 0 || !Number.isInteger(perimeter) || !Number.isInteger(length)) {
    return null;
  }

  const remainingWidthSum = perimeter - 2 * length;
  if (remainingWidthSum <= 0) return null;

  return {
    length,
    width: normalizeRational({
      numerator: BigInt(remainingWidthSum),
      denominator: BigInt(2),
    }),
    area: normalizeRational({
      numerator: BigInt(length * remainingWidthSum),
      denominator: BigInt(2),
    }),
  };
}

function squareAreaPerimeterDifferenceProblem(problem: string) {
  if (!/\btwo\s+squares\b/i.test(problem) || !/\bareas?\b/i.test(problem) || !/\bperimeters?\b/i.test(problem)) {
    return null;
  }

  const areaDifferenceMatch = problem.match(/\bareas?\b[\s\S]{0,40}?\bdiffer\s+by\s+(\d+(?:\.\d+)?)\b/i);
  const perimeterDifferenceMatch = problem.match(/\bperimeters?\b[\s\S]{0,50}?\bdiffer\s+by\s+(\d+(?:\.\d+)?)\b/i);
  if (!areaDifferenceMatch || !perimeterDifferenceMatch) return null;

  const areaDifference = Number(areaDifferenceMatch[1]);
  const perimeterDifference = Number(perimeterDifferenceMatch[1]);
  if (!Number.isFinite(areaDifference) || !Number.isFinite(perimeterDifference) || perimeterDifference === 0) {
    return null;
  }

  const sideDifference = perimeterDifference / 4;
  const sideSum = areaDifference / sideDifference;
  const smallerSide = (sideSum - sideDifference) / 2;
  const smallerPerimeter = 4 * smallerSide;
  if (![sideDifference, sideSum, smallerSide, smallerPerimeter].every(Number.isFinite)) return null;

  return {
    areaDifference,
    perimeterDifference,
    sideDifference,
    sideSum,
    smallerSide,
    smallerPerimeter,
  };
}

function normalizeSymbolicEquation(message: string) {
  return message
    .toLowerCase()
    .replace(/[−–—]/g, "-")
    .replace(/\\cdot|\\times|[×Ã—Â··]/g, "*")
    .replace(/\s+/g, "")
    .replace(/\*\*/g, "^")
    .replace(/[{}[\]]/g, (char) => (char === "{" || char === "[" ? "(" : ")"));
}

function claimsSquarePerimeterDifferenceSetup(message: string, perimeterDifference: number) {
  const normalized = normalizeSymbolicEquation(message).replace(/\*/g, "");
  const value = String(perimeterDifference);

  return (
    new RegExp(String.raw`^4[a-z]-4[a-z]=${value}$`, "i").test(normalized) ||
    new RegExp(String.raw`^${value}=4[a-z]-4[a-z]$`, "i").test(normalized)
  );
}

function claimsSquareAreaDifferenceSetup(message: string, areaDifference: number) {
  const normalized = normalizeSymbolicEquation(message).replace(/\*\*/g, "^");
  const value = String(areaDifference);

  return (
    new RegExp(String.raw`^[a-z]\^2-[a-z]\^2=${value}$`, "i").test(normalized) ||
    new RegExp(String.raw`^${value}=[a-z]\^2-[a-z]\^2$`, "i").test(normalized)
  );
}

function parseLinearDifferenceValue(message: string) {
  const normalized = normalizeSymbolicEquation(message);
  const match =
    normalized.match(/^([a-z])(?:-)([a-z])=([^=]+)$/i) ||
    normalized.match(/^([^=]+)=([a-z])(?:-)([a-z])$/i);
  if (!match) return null;

  const expression = match.length === 4 && /^[a-z]$/i.test(match[1])
    ? match[3]
    : match[1];
  const decimalValue = rationalFromDecimalText(expression);
  const value = decimalValue || parseArithmetic(expression);
  return value ? Number(value.numerator) / Number(value.denominator) : null;
}

function parseFinalPerimeterClaim(message: string) {
  const normalized = message.replace(/[−–—]/g, "-").trim();
  const match =
    normalized.match(/\b(?:answer|final|perimeter|smaller\s+square)\b[\s\S]{0,20}?(?:is|=|:)?\s*(-?\d+(?:\.\d+)?)\b/i) ||
    normalized.match(/^\s*(-?\d+(?:\.\d+)?)\s*\??\s*$/);
  return match ? Number(match[1]) : null;
}

export function verifySquareAreaPerimeterDifferenceClaim(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const problem = squareAreaPerimeterDifferenceProblem(session.problem);
  if (!problem) return null;

  if (claimsSquarePerimeterDifferenceSetup(message, problem.perimeterDifference)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That correctly represents the difference between the two square perimeters.",
      suggested_next_check: "Use that equation to find the difference between the side lengths.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (claimsSquareAreaDifferenceSetup(message, problem.areaDifference)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That correctly represents the difference between the two square areas.",
      suggested_next_check: "Factor the difference of squares to connect the side sum and side difference.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const sideDifference = parseLinearDifferenceValue(message);
  if (sideDifference !== null) {
    if (sameNumber(Math.abs(sideDifference), problem.sideDifference)) {
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That side-length difference follows from the perimeter difference.",
        suggested_next_check: "Use the area difference as a difference of squares.",
        should_finish: false,
        confidence: 1,
        source: "deterministic",
      };
    }

    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: "That side-length difference does not match the perimeter difference.",
      valid_progress: null,
      suggested_next_check: "Divide the perimeter difference by 4 to get the side-length difference.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const perimeterClaim = parseFinalPerimeterClaim(message);
  if (perimeterClaim !== null) {
    if (sameNumber(perimeterClaim, problem.smallerPerimeter)) {
      return {
        intent: "final_answer",
        status: "correct",
        local_error: null,
        valid_progress: "That is the perimeter of the smaller square.",
        suggested_next_check: null,
        should_finish: true,
        confidence: 1,
        source: "deterministic",
      };
    }

    return {
      intent: "final_answer",
      status: "incorrect",
      local_error: "That perimeter does not match the area and perimeter differences.",
      valid_progress: null,
      suggested_next_check: "Use the side-length difference and the area difference to find the smaller side length.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return null;
}

function looksLikeWidthClaim(message: string) {
  return /\b(?:w|width)\b/i.test(message);
}

function looksLikeAreaFinalClaim(message: string) {
  return /\b(?:answer|final|area)\b/i.test(message);
}

export function verifyRectanglePerimeterAreaClaim(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const problem = rectanglePerimeterLengthAreaProblem(session.problem);
  if (!problem) return null;

  const value = parseSubmittedRationalValue(message);
  if (!value) return null;

  if (looksLikeWidthClaim(message)) {
    if (equalRational(value, problem.width)) {
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That width is correct.",
        suggested_next_check: "Use the rectangle area formula with the length and width.",
        should_finish: false,
        confidence: 1,
        source: "deterministic",
      };
    }

    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: "That width does not match the given perimeter and length.",
      valid_progress: null,
      suggested_next_check: "Use the perimeter relationship and isolate the width.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (looksLikeAreaFinalClaim(message) || equalRational(value, problem.area)) {
    if (equalRational(value, problem.area)) {
      return {
        intent: "final_answer",
        status: "correct",
        local_error: null,
        valid_progress: "That area is correct.",
        suggested_next_check: null,
        should_finish: true,
        confidence: 1,
        source: "deterministic",
      };
    }

    return {
      intent: "final_answer",
      status: "incorrect",
      local_error: "That area does not match the rectangle's length and width.",
      valid_progress: null,
      suggested_next_check: "Use area equals length times width.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return null;
}

function concentricEqualRegionCircleProblem(problem: string) {
  const normalized = problem.toLowerCase();
  if (!/\bconcentric\b/.test(normalized) || !/\bcircles?\b/.test(normalized)) {
    return null;
  }

  const regionCount =
    normalized.match(/\b(\d+)\s+congruent\s+regions?\b/) ||
    normalized.match(/\b(\d+)\s+equal\s+regions?\b/) ||
    normalized.match(/\b(\d+)\s+regions?\b/);
  const unitRegionDenominator = unitFractionFromWords(normalized);
  const denominator = regionCount ? Number(regionCount[1]) : unitRegionDenominator;

  if (denominator !== 12) return null;

  return { totalRegions: denominator, innerDiskRegions: 4 };
}

function messageClaimsInnerDiskArea(message: string) {
  return (
    /\b(?:smallest|inner(?:most)?|center|middle)\b/i.test(message) &&
    /\b(?:circle|disk)\b/i.test(message) &&
    /\barea\b/i.test(message) &&
    !/\bradius\b/i.test(message) &&
    /\b(?:whole|total|outer|large|entire)\b/i.test(message)
  );
}

function messageClaimsInnerRadiusComparison(message: string) {
  return (
    /\b(?:smallest|inner(?:most)?|center|middle)\b/i.test(message) &&
    /\b(?:circle|disk)\b/i.test(message) &&
    /\bradius\b/i.test(message) &&
    /\b(?:whole|total|outer|large|entire)\b/i.test(message)
  );
}

function claimedAreaRatio(message: string): Rational | null {
  const normalized = message
    .toLowerCase()
    .replace(/\\frac\s*\{\s*([^{}]+)\s*\}\s*\{\s*([^{}]+)\s*\}/g, "$1/$2");
  const fraction = normalized.match(/\b(\d+)\s*\/\s*(\d+)\b/);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (denominator !== 0) {
      return normalizeRational({
        numerator: BigInt(numerator),
        denominator: BigInt(denominator),
      });
    }
  }

  const denominator = unitFractionFromWords(normalized);
  if (denominator) {
    return normalizeRational({
      numerator: BigInt(1),
      denominator: BigInt(denominator),
    });
  }

  return null;
}

function claimsSquareRootOneThird(message: string) {
  const normalized = message
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\\frac\{1\}\{3\}/g, "1/3");

  return (
    /(?:sqrt|\\sqrt|√)\(?\{?1\/3\}?\)?/.test(normalized) ||
    /squarerootof(?:one[-\s]?third|1\/3)/i.test(message.replace(/\s+/g, ""))
  );
}

export function verifyConcentricCircleEqualRegionAreaClaim(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const problem = concentricEqualRegionCircleProblem(session.problem);
  if (!problem) return null;

  if (messageClaimsInnerRadiusComparison(message)) {
    const outerCircleWords = "(?:whole|total|outer|large|entire)";
    const comparesToWholeArea =
      new RegExp(`\\b${outerCircleWords}\\s+(?:circle|disk)\\s+area\\b`, "i").test(message) ||
      new RegExp(`\\barea\\s+of\\s+(?:the\\s+)?${outerCircleWords}\\s+(?:circle|disk)\\b`, "i").test(message);
    const comparesToWholeRadius =
      new RegExp(`\\b${outerCircleWords}\\s+(?:circle|disk)\\s+radius\\b`, "i").test(message) ||
      new RegExp(`\\bradius\\s+of\\s+(?:the\\s+)?${outerCircleWords}\\s+(?:circle|disk)\\b`, "i").test(message);

    if (comparesToWholeArea && !comparesToWholeRadius) {
      return {
        intent: "submitted_work",
        status: "incorrect",
        local_error:
          "You switched to a radius relationship, so the comparison should be to the outer circle's radius, not its area.",
        valid_progress: null,
        suggested_next_check:
          "Rewrite this as a relationship between the innermost radius and the outer radius.",
        should_finish: false,
        confidence: 1,
        source: "deterministic",
      };
    }

    if (/\bradius\b/i.test(message) && claimsSquareRootOneThird(message)) {
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That is the correct radius-ratio relationship.",
        suggested_next_check: "Convert the radius ratio to a decimal rounded to the nearest hundredth.",
        should_finish: false,
        confidence: 1,
        source: "deterministic",
      };
    }

    return null;
  }

  if (!messageClaimsInnerDiskArea(message)) return null;

  const ratio = claimedAreaRatio(message);
  if (!ratio) return null;

  const expected = normalizeRational({
    numerator: BigInt(problem.innerDiskRegions),
    denominator: BigInt(problem.totalRegions),
  });

  if (equalRational(ratio, expected)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That area relationship is correct for the innermost circle.",
      suggested_next_check:
        "Use the circle area formula to connect this area ratio to the corresponding radius ratio.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error:
      "That area fraction does not match the number of equal regions in the innermost circle.",
    valid_progress: null,
    suggested_next_check:
      "Count how many of the equal regions make up the innermost circle, then compare that count with the total number of regions.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function explicitFractionDenominator(message: string) {
  const normalized = message.replace(/\\frac\s*\{\s*([^{}]+)\s*\}\s*\{\s*([^{}]+)\s*\}/g, "$1/$2");
  const matches = [...normalized.matchAll(/(?:^|[^\d])\d+\s*\/\s*(\d+)\b/g)];
  const last = matches.at(-1);
  return last ? Number(last[1]) : null;
}

export function verifyFractionalRectangleAreaClaim(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const problem = fractionalRectangleAreaProblem(session.problem);
  if (!problem) return null;

  const mentionsShadedArea = /\bshaded\b/i.test(message) || /\barea\b/i.test(message);
  const value = parseFinalExpression(message);
  const denominator = explicitFractionDenominator(message);
  const expectedArea = normalizeRational({
    numerator: BigInt(problem.wholeArea),
    denominator: BigInt(problem.denominator),
  });

  if (value && equalRational(value, expectedArea)) {
    return {
      intent: "final_answer",
      status: "correct",
      local_error: null,
      valid_progress: "That gives the shaded area.",
      suggested_next_check: null,
      should_finish: true,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (mentionsShadedArea && denominator && denominator !== problem.denominator) {
    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: `You used $\\frac{1}{${denominator}}$ of the large area, but the problem says $\\frac{1}{${problem.denominator}}$.`,
      valid_progress: null,
      suggested_next_check: "Use the given fraction on your large-rectangle area, then send that line.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (mentionsShadedArea && value) {
    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: "That shaded area does not match the given fraction of the large rectangle.",
      valid_progress: null,
      suggested_next_check: "Check the fraction of the large area before simplifying.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return null;
}

export function verifyRhombusAreaFormulaClaim(
  session: CoachSession,
  message: string
): VerificationResult | null {
  if (!rhombusAreaAndDiagonal(session.problem)) return null;

  const normalized = message
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\u2212|\u2013|\u2014/g, "-")
    .trim();
  const proseFormula =
    /\barea(?:\s+of\s+(?:a\s+)?rhombus)?\s*(?:=|is|equals?)\s*(?:the\s+)?product\s+of\s+(?:the\s+)?diagonals?\s*(?:\/|over|divided by)\s*2\b/i.test(
      normalized
    );
  const symbolicFormula =
    /\b(?:a|area)\s*(?:=|is|equals?)\s*(?:d_?1|d1|diagonal\s*1)\s*\*?\s*(?:d_?2|d2|diagonal\s*2)\s*(?:\/|over|divided by)\s*2\b/i.test(
      normalized
    ) ||
    /\b(?:a|area)\s*(?:=|is|equals?)\s*\\frac\s*\{\s*(?:d_?1|d1)\s*(?:d_?2|d2)\s*\}\s*\{\s*2\s*\}/i.test(
      message
    );

  if (!proseFormula && !symbolicFormula) return null;

  return {
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: "That is the correct area formula for a rhombus.",
    suggested_next_check: "Substitute the given area and diagonal into $A=\\frac{d_1d_2}{2}$.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyRhombusDiagonalClaim(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const givens = rhombusAreaAndDiagonal(session.problem);
  if (!givens) return null;

  const value = parseFinalExpression(message) || parseArithmetic(message);
  if (!value) return null;

  const halfDiagonal = normalizeRational({
    numerator: BigInt(givens.area),
    denominator: BigInt(givens.diagonal),
  });
  const otherDiagonal = normalizeRational({
    numerator: BigInt(2 * givens.area),
    denominator: BigInt(givens.diagonal),
  });

  if (equalRational(value, otherDiagonal)) {
    return {
      intent: "final_answer",
      status: "correct",
      local_error: null,
      valid_progress: `The other diagonal is $${formatRational(otherDiagonal)}$.`,
      suggested_next_check: null,
      should_finish: true,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (equalRational(value, halfDiagonal)) {
    const finalClaim = looksLikeFinalLengthClaim(message);

    return {
      intent: finalClaim ? "final_answer" : "submitted_work",
      status: finalClaim ? "incorrect" : "partially_correct",
      local_error: finalClaim
        ? `That is half of the missing diagonal, not the full diagonal.`
        : null,
      valid_progress: finalClaim
        ? null
        : `$${formatRational(halfDiagonal)}$ is half of the missing diagonal.`,
      suggested_next_check:
        "Use $A=\\frac{d_1d_2}{2}$, so the missing diagonal is twice that quotient.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return null;
}

function parseCoordinatePairs(text: string) {
  const normalized = text.replace(/\u2212|\u2013|\u2014/g, "-");
  const pairs = [...normalized.matchAll(/\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/g)].map((match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
  }));

  return pairs.length >= 3 ? pairs : [];
}

function shoelaceForVertices(vertices: { x: number; y: number }[]) {
  let downRight = 0;
  let downLeft = 0;

  vertices.forEach((vertex, index) => {
    const next = vertices[(index + 1) % vertices.length];
    downRight += vertex.x * next.y;
    downLeft += vertex.y * next.x;
  });

  const difference = downRight - downLeft;
  const area = normalizeRational({
    numerator: BigInt(Math.abs(difference)),
    denominator: BigInt(2),
  });

  return {
    downRight,
    downLeft,
    difference: rationalFromInteger(difference),
    area,
  };
}

function parseAbsoluteValueExpression(message: string) {
  const match = message.replace(/\u2212|\u2013|\u2014/g, "-").match(/\|\s*([^|]+?)\s*\|/);
  return match ? parseArithmetic(match[1]) : null;
}

function parseFinalExpression(message: string) {
  const normalized = message.replace(/\u2212|\u2013|\u2014/g, "-").replace(/\?+$/g, "");
  const equalityParts = normalized.split("=").map((part) => part.trim()).filter(Boolean);

  if (equalityParts.length > 1) {
    return parseArithmetic(equalityParts[equalityParts.length - 1]);
  }

  const finalMatch = normalized.match(/\b(?:answer|area)\s*(?:is|=|equals?)\s*([^.,;]+)$/i);
  if (finalMatch) return parseArithmetic(finalMatch[1]);

  if (/^\s*-?\d+(?:\s*\/\s*\d+)?\s*$/.test(normalized)) return parseArithmetic(normalized);

  return null;
}

export function verifyShoelaceQuadrilateralAreaClaim(
  session: CoachSession,
  message: string
): VerificationResult | null {
  if (!/\barea\b/i.test(session.problem) || !/\bquadrilateral\b/i.test(session.problem)) {
    return null;
  }

  const vertices = parseCoordinatePairs(session.problem);
  if (vertices.length !== 4) return null;

  const mentionsRelevantWork =
    /\bshoelace\b/i.test(message) ||
    /\barea\b/i.test(message) ||
    /\|\s*[-\d\s+*/().]+\s*\|/.test(message);
  const finalValue = parseFinalExpression(message);
  const absoluteValue = parseAbsoluteValueExpression(message);
  if (!mentionsRelevantWork && !finalValue) return null;

  const shoelace = shoelaceForVertices(vertices);
  const areaText = formatRational(shoelace.area);

  if (absoluteValue && !sameRationalMagnitude(absoluteValue, shoelace.difference)) {
    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: `The shoelace sums are $${shoelace.downRight}$ and $${shoelace.downLeft}$, so the difference inside the absolute value should have magnitude $${Math.abs(
        shoelace.downRight - shoelace.downLeft
      )}$.`,
      valid_progress: null,
      suggested_next_check: "Recompute the two shoelace sums before simplifying the area.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (finalValue) {
    if (equalRational(finalValue, shoelace.area)) {
      return {
        intent: "final_answer",
        status: "correct",
        local_error: null,
        valid_progress: `The shoelace area is $${areaText}$.`,
        suggested_next_check: null,
        should_finish: true,
        confidence: 1,
        source: "deterministic",
      };
    }

    if (mentionsRelevantWork || absoluteValue) {
      return {
        intent: "submitted_work",
        status: "incorrect",
        local_error: `This shoelace computation should give area $${areaText}$, not $${formatRational(
          finalValue
        )}$.`,
        valid_progress: null,
        suggested_next_check: "Check the absolute value and the final division by 2.",
        should_finish: false,
        confidence: 1,
        source: "deterministic",
      };
    }
  }

  if (absoluteValue) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "Those shoelace sums match the vertices.",
      suggested_next_check: `Now take half of the absolute value to get the area.`,
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return null;
}

export function verifyPythagoreanTripleClaim(message: string): VerificationResult | null {
  const triple = message.match(/\b(\d+)\s*[-,]\s*(\d+)\s*[-,]\s*(\d+)\s+triangle\b/i);
  const hypotenuse = message.match(/\bhypotenuse\s+(?:is|=|equals?)\s*(\d+)\b/i);
  const numbers = triple
    ? [Number(triple[1]), Number(triple[2]), Number(triple[3])]
    : hypotenuse
      ? [...message.matchAll(/\b\d+\b/g)].map((match) => Number(match[0])).slice(0, 3)
      : [];

  if (numbers.length !== 3) return null;

  const [a, b, c] = sortedTriple(numbers);
  const isRight = a * a + b * b === c * c;

  if (isRight) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: `$${a}$-$${b}$-$${c}$ is a right-triangle triple.`,
      suggested_next_check: "Use the matching side lengths in the diagram or area relation.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: `$${a}^2+${b}^2$ is not $${c}^2$.`,
    valid_progress: null,
    suggested_next_check: "Check the Pythagorean relation before using this triangle.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function exteriorAngleTriangleProblem(problem: string) {
  if (
    !/\bexterior\s+angle\b/i.test(problem) ||
    !/\btriangle\b/i.test(problem) ||
    !/\bnon[-\s]?adjacent\s+interior\b/i.test(problem)
  ) {
    return null;
  }

  const exteriorMatch = problem.match(
    /\bexterior\s+angle\b[\s\S]{0,40}?\b(?:is|measures?|of)?\s*(\d+(?:\.\d+)?)\b/i
  );
  const knownInteriorMatch = problem.match(
    /\b(?:one|1)\s+of\s+the\s+non[-\s]?adjacent\s+interior\s+angles?\b[\s\S]{0,50}?\b(?:is|measures?)?\s*(\d+(?:\.\d+)?)\b/i
  );
  if (!exteriorMatch || !knownInteriorMatch) return null;

  const exterior = Number(exteriorMatch[1]);
  const knownInterior = Number(knownInteriorMatch[1]);
  if (!Number.isFinite(exterior) || !Number.isFinite(knownInterior)) return null;
  if (exterior <= knownInterior) return null;

  return {
    exterior,
    knownInterior,
    missingInterior: exterior - knownInterior,
  };
}

function normalizeEquationClaim(message: string) {
  return message
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[−–—]/g, "-")
    .replace(/[{}[\]]/g, (char) => (char === "{" || char === "[" ? "(" : ")"));
}

function claimsExteriorAngleSetup(message: string, exterior: number, knownInterior: number) {
  const normalized = normalizeEquationClaim(message);
  const ext = String(exterior);
  const known = String(knownInterior);
  const variable = String.raw`[a-z]`;

  return (
    new RegExp(String.raw`^(?:${known}\+${variable}|${variable}\+${known})=${ext}$`, "i").test(normalized) ||
    new RegExp(String.raw`^${ext}=(?:${known}\+${variable}|${variable}\+${known})$`, "i").test(normalized)
  );
}

function parseVariableAssignmentValue(message: string) {
  const normalized = message.replace(/[−–—]/g, "-").trim();
  const match =
    normalized.match(/^\s*[a-z]\s*=\s*([^?]+?)\s*\??\s*$/i) ||
    normalized.match(/^\s*([^?]+?)\s*=\s*[a-z]\s*\??\s*$/i);
  if (!match) return null;

  const expression = match[1].trim();
  const value = parseArithmetic(expression);
  if (!value) return null;

  return {
    expression,
    value: Number(value.numerator) / Number(value.denominator),
    isSimplifiedNumber: /^-?\d+(?:\.\d+)?$/.test(expression),
  };
}

function parseBareNumber(message: string) {
  const match = message.trim().match(/^\??\s*(-?\d+(?:\.\d+)?)\s*(?:degrees?)?\s*\??$/i);
  return match ? Number(match[1]) : null;
}

export function verifyExteriorAngleTriangleClaim(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const problem = exteriorAngleTriangleProblem(session.problem);
  if (!problem) return null;

  if (claimsExteriorAngleSetup(message, problem.exterior, problem.knownInterior)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That correctly uses the exterior angle as the sum of the two non-adjacent interior angles.",
      suggested_next_check: "Now isolate the missing angle and evaluate the subtraction.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const assignment = parseVariableAssignmentValue(message);
  if (assignment) {
    if (sameNumber(assignment.value, problem.missingInterior)) {
      const shouldFinish = assignment.isSimplifiedNumber;

      return {
        intent: shouldFinish ? "final_answer" : "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: shouldFinish
          ? "That is the missing non-adjacent interior angle."
          : "That subtraction setup correctly isolates the missing angle.",
        suggested_next_check: shouldFinish
          ? null
          : "Evaluate the subtraction and state the angle measure.",
        should_finish: shouldFinish,
        confidence: 1,
        source: "deterministic",
      };
    }

    return {
      intent: "final_answer",
      status: "incorrect",
      local_error: "That value does not satisfy the exterior-angle equation.",
      valid_progress: null,
      suggested_next_check: "Subtract the given non-adjacent interior angle from the exterior angle.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const bareNumber = parseBareNumber(message);
  if (bareNumber !== null) {
    if (sameNumber(bareNumber, problem.missingInterior)) {
      return {
        intent: "final_answer",
        status: "correct",
        local_error: null,
        valid_progress: "That is the missing non-adjacent interior angle.",
        suggested_next_check: null,
        should_finish: true,
        confidence: 1,
        source: "deterministic",
      };
    }

    return {
      intent: "final_answer",
      status: "incorrect",
      local_error: "That angle measure does not match the exterior-angle relationship.",
      valid_progress: null,
      suggested_next_check: "Use the exterior angle as the sum of the two non-adjacent interior angles.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return null;
}

function rightTriangleLegs(problem: string) {
  if (!/\bright\s+triangle\b/i.test(problem) || !/\blegs?\b/i.test(problem) || !/\bhypotenuse\b/i.test(problem)) {
    return null;
  }

  const legs = [...problem.matchAll(/\b(\d+(?:\.\d+)?)\s+units?\b/gi)]
    .map((match) => Number(match[1]))
    .filter((value) => value > 0);
  if (legs.length < 2) return null;

  return {
    a: legs[0],
    b: legs[1],
    hypotenuse: Math.sqrt(legs[0] * legs[0] + legs[1] * legs[1]),
  };
}

function squareToken(value: number) {
  const escaped = String(value).replace(".", "\\.");
  return String.raw`${escaped}\s*(?:\^|\*\*)\s*\{?\s*2\s*\}?|${escaped}\s*[²Â²]`;
}

function normalizeRadicalText(message: string) {
  return message
    .replace(/\\sqrt\s*\{\s*([^{}]+)\s*\}/gi, "sqrt($1)")
    .replace(/\\left|\\right/g, "")
    .replace(/\\cdot|\\times|[×Ã—Â··]/g, "*")
    .replace(/[−–—]/g, "-")
    .replace(/\s+/g, "");
}

function claimsPythagoreanRadical(message: string, a: number, b: number, operator: "+" | "*") {
  const normalized = normalizeRadicalText(message);
  const first = squareToken(a);
  const second = squareToken(b);
  const op = operator === "+" ? String.raw`\+` : String.raw`\*`;
  const pattern = new RegExp(
    String.raw`(?:sqrt|√)\(?[^)]*(?:${first})${op}(?:${second})[^)]*\)?|(?:sqrt|√)\(?[^)]*(?:${second})${op}(?:${first})[^)]*\)?`,
    "i"
  );

  return pattern.test(normalized);
}

function parseSimpleFinalNumber(message: string) {
  const match = message.match(
    /^\s*(?:answer|final answer|hypotenuse)?\s*(?:is|=|:)?\s*(-?\d+(?:\.\d+)?)\s*(?:units?)?\s*\??\s*$/i
  );
  return match ? Number(match[1]) : null;
}

export function verifyRightTriangleHypotenuseClaim(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const triangle = rightTriangleLegs(session.problem);
  if (!triangle) return null;

  const finalNumber = parseSimpleFinalNumber(message);
  if (finalNumber !== null) {
    if (sameNumber(finalNumber, triangle.hypotenuse)) {
      return {
        intent: "final_answer",
        status: "correct",
        local_error: null,
        valid_progress: "That hypotenuse length is correct.",
        suggested_next_check: null,
        should_finish: true,
        confidence: 1,
        source: "deterministic",
      };
    }

    return {
      intent: "final_answer",
      status: "incorrect",
      local_error: "That length does not match the Pythagorean theorem for the two legs.",
      valid_progress: null,
      suggested_next_check: "Use the sum of the squares of the two legs, then take the square root.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (claimsPythagoreanRadical(message, triangle.a, triangle.b, "*")) {
    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: "The Pythagorean theorem adds the two leg squares; this line multiplies them.",
      valid_progress: null,
      suggested_next_check: "Rewrite the radical with a plus between the squared leg lengths.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (claimsPythagoreanRadical(message, triangle.a, triangle.b, "+")) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That is the correct Pythagorean setup for the hypotenuse.",
      suggested_next_check: "Evaluate the expression under the square root, then simplify the radical.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return null;
}

export function verifyTriangleAreaClaim(message: string): VerificationResult | null {
  const match = message.match(
    /\barea\s*(?:is|=|equals?)?\s*(?:1\/2|0\.5)\s*\*?\s*(\d+(?:\.\d+)?)\s*\*?\s*(\d+(?:\.\d+)?)\s*(?:=|is|equals?)\s*(\d+(?:\.\d+)?)\b/i
  );
  if (!match) return null;

  const base = parseNumber(match[1]);
  const height = parseNumber(match[2]);
  const asserted = parseNumber(match[3]);
  const actual = (base * height) / 2;

  if (sameNumber(asserted, actual)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That triangle area computation is correct.",
      suggested_next_check: "Use that area in the next relation or final count.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: `The triangle area is ${actual}, not ${asserted}.`,
    valid_progress: null,
    suggested_next_check: "Recompute one half times base times height.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyCircleFormulaClaim(message: string): VerificationResult | null {
  const area = message.match(/\barea\s*(?:is|=|equals?)\s*pi\s*\*?\s*(\d+(?:\.\d+)?)\s*\^?2?\s*(?:=|is|equals?)\s*(\d+(?:\.\d+)?)\s*pi\b/i);
  if (area) {
    const radius = parseNumber(area[1]);
    const asserted = parseNumber(area[2]);
    const actual = radius * radius;

    if (sameNumber(asserted, actual)) {
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That circle area setup is correct.",
        suggested_next_check: "Use that area in the problem's requested comparison.",
        should_finish: false,
        confidence: 1,
        source: "deterministic",
      };
    }

    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: `With radius ${radius}, the area is ${actual} pi, not ${asserted} pi.`,
      valid_progress: null,
      suggested_next_check: "Square the radius in the area formula.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const circumference = message.match(/\bcircumference\s*(?:is|=|equals?)\s*2\s*\*?\s*pi\s*\*?\s*(\d+(?:\.\d+)?)\s*(?:=|is|equals?)\s*(\d+(?:\.\d+)?)\s*pi\b/i);
  if (!circumference) return null;

  const radius = parseNumber(circumference[1]);
  const asserted = parseNumber(circumference[2]);
  const actual = 2 * radius;

  if (sameNumber(asserted, actual)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That circumference setup is correct.",
      suggested_next_check: "Use that circumference in the problem's requested comparison.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: `With radius ${radius}, the circumference is ${actual} pi, not ${asserted} pi.`,
    valid_progress: null,
    suggested_next_check: "Use $2\\pi r$ for circumference.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}
