import type { CoachSession } from "@/lib/sessionStore";
import type { VerificationResult } from "@/lib/coach-verifier/types";
import { ONE, parseSingleArithmeticCandidate, sanitizeArithmeticExpression, splitSingleEquals, toBase } from "@/lib/coach-verifier/math";
import { lastAssistantMessage, recentSessionText } from "@/lib/coach-verifier/context";

export function verifyBaseConversion(message: string): VerificationResult | null {
  const match = message.match(/(\d+)\s+in\s+base\s+(\d+)\s+(?:is|=)\s+([0-9a-z]+)/i);
  if (!match) return null;

  const decimalValue = Number(match[1]);
  const base = Number(match[2]);
  const asserted = match[3].toLowerCase();
  const correct = toBase(decimalValue, base);

  if (!correct) return null;

  if (asserted === correct) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: `${decimalValue} in base ${base} is ${correct}.`,
      suggested_next_check: "Use that converted representation in the problem context.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: `${decimalValue} in base ${base} is ${correct}, not ${asserted}.`,
    valid_progress: null,
    suggested_next_check: `Check the place values from the largest power of ${base} downward.`,
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyBaseConversionRestatement(session: CoachSession, message: string): VerificationResult | null {
  const correction = lastAssistantMessage(session).match(
    /(\d+)\s+in\s+base\s+(\d+)\s+is\s+([0-9a-z]+),\s+not\s+([0-9a-z]+)/i
  );
  if (!correction) return null;

  const decimalValue = Number(correction[1]);
  const base = Number(correction[2]);
  const correct = correction[3].toLowerCase();
  const previousWrong = correction[4].toLowerCase();
  const candidates = [...message.toLowerCase().matchAll(/\b[0-9a-z]*\d[0-9a-z]*\b/g)].map(
    (match) => match[0]
  );

  if (candidates.length === 0) return null;
  if (!/\b(?:yes|yeah|yep|correct|right|it\s+is|is|=|base)\b/i.test(message)) return null;

  if (candidates.includes(correct)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: `${decimalValue} in base ${base} is ${correct}.`,
      suggested_next_check: "Use that converted representation in the problem context.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (candidates.includes(previousWrong) || candidates.some((candidate) => candidate.length >= 2)) {
    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: `${decimalValue} in base ${base} is ${correct}, not ${candidates.at(-1)}.`,
      valid_progress: null,
      suggested_next_check: `Check the place values from the largest power of ${base} downward.`,
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return null;
}

function digitAtPlace(value: number, place: "ones" | "tens" | "hundreds") {
  const divisor = place === "ones" ? 1 : place === "tens" ? 10 : 100;
  return Math.floor(Math.abs(value) / divisor) % 10;
}

function parseClaimedNumbers(text: string) {
  const beforeHave = text.split(/\b(?:has|have|with|whose)\b/i)[0] || text;

  return [...beforeHave.matchAll(/\b\d+\b/g)].map((match) => Number(match[0]));
}

export function verifyDigitPlaceAssertions(message: string): VerificationResult | null {
  if (
    /\b(?:ones|units|tens|hundreds)\s+digit\s+of\s+\d\s*(?:,|\bor\b)/i.test(
      message
    )
  ) {
    return null;
  }

  const match = message.match(
    /\b(?:ones|units|tens|hundreds)\s+digit\s+(?:of\s+|is\s+|equals\s+|=)?(\d)\b/i
  );
  if (!match) return null;

  const placeMatch = message.match(/\b(ones|units|tens|hundreds)\s+digit\b/i);
  const placeText = placeMatch?.[1]?.toLowerCase();
  const place = placeText === "units" ? "ones" : placeText;
  if (place !== "ones" && place !== "tens" && place !== "hundreds") return null;

  const expectedDigit = Number(match[1]);
  const claimedNumbers = parseClaimedNumbers(message).filter((value) => value !== expectedDigit);
  if (claimedNumbers.length === 0) return null;

  const wrong = claimedNumbers.filter((value) => digitAtPlace(value, place) !== expectedDigit);

  if (wrong.length > 0) {
    const firstWrong = wrong[0];
    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: `${firstWrong} has ${digitAtPlace(firstWrong, place)} as its ${place} digit, not ${expectedDigit}.`,
      valid_progress: null,
      suggested_next_check: `Check the ${place} digit of each number you listed.`,
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: `Each listed number has ${expectedDigit} as its ${place} digit.`,
    suggested_next_check: "Now check whether your list is complete for the original condition.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function digitConditionFromProblem(problem: string) {
  const match = problem.match(/\b(ones|units|tens|hundreds)\s+digit\s+(?:of\s+|is\s+|equals\s+|=)?(\d)\b/i);
  if (!match) return null;

  const placeText = match[1].toLowerCase();
  const place = placeText === "units" ? "ones" : placeText;
  if (place !== "ones" && place !== "tens" && place !== "hundreds") return null;

  return {
    place: place as "ones" | "tens" | "hundreds",
    digit: Number(match[2]),
  };
}

export function verifyListedNumbersMeetProblemDigitCondition(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const condition = digitConditionFromProblem(session.problem);
  if (!condition) return null;
  if (!/\b(fit|satisf(?:y|ies)|meet|work|requirements?|condition|digits?)\b/i.test(message)) return null;

  const claimedNumbers = parseClaimedNumbers(message).filter((value) => value !== condition.digit);
  if (claimedNumbers.length === 0) return null;

  const wrong = claimedNumbers.filter(
    (value) => digitAtPlace(value, condition.place) !== condition.digit
  );

  if (wrong.length > 0) {
    const firstWrong = wrong[0];
    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: `${firstWrong} has ${digitAtPlace(firstWrong, condition.place)} as its ${condition.place} digit, not ${condition.digit}.`,
      valid_progress: null,
      suggested_next_check: `Check the ${condition.place} digit of each listed number against the original condition.`,
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: `Each listed number matches the ${condition.place}-digit condition.`,
    suggested_next_check: "Now check whether your list is complete before giving the final count.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function digitSum(text: string) {
  return [...text].reduce((sum, char) => sum + Number(char), 0);
}

function nonzeroDigits(text: string) {
  return [...text].filter((char) => char !== "0");
}

function extractBaseRepresentation(session: CoachSession) {
  const text = recentSessionText(session);
  const explicit = [...text.matchAll(/\bbase\s+(\d+)\s+(?:representation\s+)?(?:is|=)?\s*([0-9a-z]+)\b/gi)];
  const explicitMatch = explicit.at(-1);

  if (explicitMatch) {
    const base = Number(explicitMatch[1]);
    const representation = explicitMatch[2].toLowerCase();

    if (
      Number.isInteger(base) &&
      base >= 2 &&
      base <= 36 &&
      [...representation].every((char) => parseInt(char, 36) < base)
    ) {
      return { base, representation };
    }
  }

  const baseConversion = [...text.matchAll(/\b\d+\s+in\s+base\s+(\d+)\s+(?:is|=)\s+([0-9a-z]+)\b/gi)].at(-1);

  if (baseConversion) {
    return {
      base: Number(baseConversion[1]),
      representation: baseConversion[2].toLowerCase(),
    };
  }

  return null;
}

function parseWholeNumberClaim(message: string) {
  const matches = [...message.matchAll(/\b(\d+)\b/g)];
  return matches.length === 1 ? Number(matches[0][1]) : null;
}

function parseTotalQuantityClaim(message: string) {
  const beforeNoun = message.match(/\b(\d+)\s+(?:total\s+)?(?:balls?|boxes?|items?|objects?|prizes?)\b/i);
  if (beforeNoun) return Number(beforeNoun[1]);

  const afterAnswer = message.match(/\banswer\s*(?:is|=)?\s*(\d+)\b/i);
  if (afterAnswer) return Number(afterAnswer[1]);

  const afterTotal = message.match(/\btotal\s+(?:is|=|of)?\s*(\d+)\b/i);
  if (afterTotal) return Number(afterTotal[1]);

  return null;
}

function targetQuantityName(problem: string) {
  if (/\bprizes?\b/i.test(problem)) return "number of prizes";
  if (/\bballs?\b/i.test(problem)) return "total number of balls";
  if (/\bboxes?\b/i.test(problem)) return "total in the boxes";
  if (/\bitems?\b/i.test(problem)) return "number of items";
  if (/\bobjects?\b/i.test(problem)) return "number of objects";

  return "requested total";
}

function wordToSmallNumber(text: string) {
  const words: Record<string, number> = {
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };

  return words[text.toLowerCase()] ?? Number(text);
}

function inferBaseRepresentationFromProblem(problem: string) {
  if (!/balls?|boxes?|steps?/i.test(problem)) return null;

  const stepMatch = problem.match(/\b(\d+)(?:st|nd|rd|th)?\s+step\b/i);
  if (!stepMatch) return null;

  const explicitBase = problem.match(/\bbase\s+(\d+)\b/i);
  const boxCount = problem.match(/\b(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+boxes\b/i);
  const base = explicitBase ? Number(explicitBase[1]) : boxCount ? wordToSmallNumber(boxCount[1]) : null;
  const step = Number(stepMatch[1]);

  if (!base || !Number.isInteger(base) || base < 2 || base > 10) return null;
  if (!Number.isInteger(step) || step < 0) return null;

  const representation = toBase(step, base);
  return representation ? { base, representation } : null;
}

export function verifyBaseDigitSum(session: CoachSession, message: string): VerificationResult | null {
  const baseRepresentation =
    extractBaseRepresentation(session) || inferBaseRepresentationFromProblem(session.problem);
  if (!baseRepresentation) return null;

  const { representation } = baseRepresentation;
  if (!/^\d+$/.test(representation)) return null;

  const expected = digitSum(representation);
  const quantityName = targetQuantityName(session.problem);
  const numberClaim = parseTotalQuantityClaim(message) ?? parseWholeNumberClaim(message);
  const equality = splitSingleEquals(message);
  const looksLikeAnswerOnly = /^\??\s*\d+\s*\??$/.test(message.trim()) || /\banswer\b/i.test(message);

  if (!equality && !/ball|box|prize|total|sum|digit/i.test(message) && !looksLikeAnswerOnly) {
    return null;
  }

  if (equality) {
    const leftDigits = sanitizeArithmeticExpression(equality.left).split("+").filter(Boolean);
    const expectedDigits = nonzeroDigits(representation);
    const right = parseSingleArithmeticCandidate(equality.right);

    if (
      leftDigits.length > 0 &&
      right?.denominator === ONE &&
      Number(right.numerator) === expected &&
      leftDigits.join("") === expectedDigits.join("")
    ) {
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That correctly sums the digits from the base representation.",
        suggested_next_check: `State what that means for the ${quantityName}.`,
        should_finish: false,
        confidence: 1,
        source: "deterministic",
      };
    }
  }

  if (numberClaim === null) return null;

  if (numberClaim === expected) {
    return {
      intent: "final_answer",
      status: "correct",
      local_error: null,
      valid_progress: `That ${quantityName} matches the digit sum of the base representation.`,
      suggested_next_check: null,
      should_finish: true,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: `That ${quantityName} does not match the digit sum of the base representation.`,
    valid_progress: null,
    suggested_next_check: "Add the digits in the base representation again.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}
