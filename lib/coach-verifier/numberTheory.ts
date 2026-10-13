import type { CoachSession } from "@/lib/sessionStore";
import type { VerificationResult } from "@/lib/coach-verifier/types";
import { gcdNumber, lcmNumber, positiveMod } from "@/lib/coach-verifier/math";
import { canonicalizeNumericTokens } from "@/lib/numericText";

function numberList(text: string) {
  return [...text.matchAll(/-?\d+/g)].map((match) => Number(match[0]));
}

function formatList(values: number[]) {
  return values.join(", ");
}

function primeFactors(value: number) {
  if (!Number.isInteger(value) || value < 2 || value > 1_000_000) return null;

  const factors: number[] = [];
  let remaining = value;
  let factor = 2;

  while (factor * factor <= remaining) {
    while (remaining % factor === 0) {
      factors.push(factor);
      remaining /= factor;
    }
    factor += factor === 2 ? 1 : 2;
  }

  if (remaining > 1) factors.push(remaining);
  return factors;
}

function positiveDivisors(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000) return null;

  const divisors: number[] = [];
  for (let divisor = 1; divisor * divisor <= value; divisor += 1) {
    if (value % divisor !== 0) continue;

    divisors.push(divisor);
    if (divisor !== value / divisor) divisors.push(value / divisor);
  }

  return divisors.sort((left, right) => left - right);
}

function primePowerExponents(text: string) {
  return [...text.matchAll(/(\d+)\s*(?:\^|\^\{)\s*\{?\s*(\d+)\s*\}?/g)]
    .map((match) => ({
      prime: Number(match[1]),
      exponent: Number(match[2]),
    }))
    .filter(
      (entry) =>
        Number.isInteger(entry.prime) &&
        Number.isInteger(entry.exponent) &&
        entry.prime > 1 &&
        entry.exponent >= 0
    );
}

function evenExponentOptions(maxExponent: number) {
  const options: number[] = [];
  for (let exponent = 0; exponent <= maxExponent; exponent += 2) {
    options.push(exponent);
  }
  return options;
}

function looksLikeSquareDivisorCountingProblem(problem: string) {
  return (
    /\bhow\s+many\b/i.test(problem) &&
    /\bperfect\s+squares?\b/i.test(problem) &&
    /\bdivisors?\b/i.test(problem)
  );
}

function factorialProductLimit(problem: string) {
  const factorials = [...problem.matchAll(/\b(\d+)\s*!/g)].map((match) =>
    Number(match[1])
  );
  return factorials.length ? Math.max(...factorials) : null;
}

function factorialProductPrimeExponents(limit: number) {
  const exponents = new Map<number, number>();

  for (let value = 2; value <= limit; value += 1) {
    const factors = primeFactors(value);
    if (!factors) return null;
    const multiplicity = limit - value + 1;
    for (const prime of factors) {
      exponents.set(prime, (exponents.get(prime) || 0) + multiplicity);
    }
  }

  return exponents;
}

function submittedPrimePowerFactorization(message: string) {
  const compact = message
    .replace(/\$/g, "")
    .replace(/\\(?:cdot|times|ast)(?![a-zA-Z])/g, "*")
    .replace(/[\u00d7\u00b7]/g, "*")
    .replace(/\s+/g, "");
  if (!compact.includes("*") && !compact.includes("^")) return null;
  if (!/^\d+(?:\^\{?\d+\}?|)(?:\*\d+(?:\^\{?\d+\}?|))*$/.test(compact)) {
    return null;
  }

  const entries = compact.split("*").map((factor) => {
    const match = factor.match(/^(\d+)(?:\^\{?(\d+)\}?)?$/);
    return match
      ? { prime: Number(match[1]), exponent: Number(match[2] || "1") }
      : null;
  });
  if (entries.some((entry) => !entry)) return null;

  return new Map(
    (entries as Array<{ prime: number; exponent: number }>).map((entry) => [
      entry.prime,
      entry.exponent,
    ])
  );
}

function targetedPrimePower(session: CoachSession) {
  const context = [
    session.coachingState?.lastCoachQuestion,
    session.coachingState?.currentSubgoal,
    session.history.filter((entry) => entry.role === "assistant").at(-1)?.content,
  ]
    .filter(Boolean)
    .join(" ");
  const match = context.match(/(\d+)\s*\^\s*\{?\s*(\d+)\s*\}?/);
  return match
    ? { prime: Number(match[1]), exponent: Number(match[2]) }
    : null;
}

export function verifySquareDivisorFactorization(
  session: CoachSession,
  message: string
): VerificationResult | null {
  if (!looksLikeSquareDivisorCountingProblem(session.problem)) return null;
  const limit = factorialProductLimit(session.problem);
  const expected = limit ? factorialProductPrimeExponents(limit) : null;
  const submitted = submittedPrimePowerFactorization(message);
  if (!expected || !submitted) return null;

  const correct =
    expected.size === submitted.size &&
    [...expected].every(
      ([prime, exponent]) => submitted.get(prime) === exponent
    );

  if (!correct) {
    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: "At least one prime exponent in that factorization is incorrect.",
      valid_progress: null,
      suggested_next_check:
        "Recount how many of the factorials contribute each prime before using the factorization.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const first = [...expected][0];
  return {
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: "That prime-power factorization is correct.",
    suggested_next_check: `A square divisor needs even prime exponents. For $${first[0]}^{${first[1]}}$, list the even exponent choices from $0$ through $${first[1]}$.`,
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifySquareDivisorExponentOptions(
  session: CoachSession,
  message: string
): VerificationResult | null {
  if (!looksLikeSquareDivisorCountingProblem(session.problem)) return null;
  const target = targetedPrimePower(session);
  if (!target || !/^\s*\d+(?:\s*,\s*\d+)+\s*$/.test(message)) return null;

  const submitted = numberList(message);
  const expected = evenExponentOptions(target.exponent);
  const correct = equalNumberLists(submitted, expected);

  return {
    intent: "submitted_work",
    status: correct ? "correct" : "incorrect",
    local_error: correct
      ? null
      : `Those choices must be every even exponent from 0 through ${target.exponent}.`,
    valid_progress: correct
      ? `You listed all allowed even exponents for the prime ${target.prime}.`
      : null,
    suggested_next_check: correct
      ? "How many exponent choices are in that list?"
      : "Check for a missing or repeated even exponent, then resend the list.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifySquareDivisorChoiceCount(
  session: CoachSession,
  message: string
): VerificationResult | null {
  if (!looksLikeSquareDivisorCountingProblem(session.problem)) return null;
  const target = targetedPrimePower(session);
  const asserted = message.trim().match(/^\d+$/)?.[0];
  const question = session.coachingState?.lastCoachQuestion || "";
  if (!target || !asserted || !/\bhow\s+many\b|\bcount\b/i.test(question)) {
    return null;
  }

  const expected = Math.floor(target.exponent / 2) + 1;
  const correct = Number(asserted) === expected;
  if (!correct) {
    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: `That is not the number of even choices from 0 through ${target.exponent}.`,
      valid_progress: null,
      suggested_next_check: "Count the entries in your exponent list once more.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: `There are ${expected} choices for the exponent of ${target.prime}.`,
    suggested_next_check:
      "Apply the same even-exponent count to the next prime in your factorization.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function equalNumberLists(left: number[], right: number[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function exponentListsByPrime(message: string) {
  const entries = new Map<number, number[]>();

  for (const clause of message.split(/[;.]/)) {
    const match = clause.match(/(\d+)[\s\S]*?\bexponent(?:\s+of)?\b([\s\S]+)/i);
    if (!match) continue;

    const prime = Number(match[1]);
    const values = [...match[2].matchAll(/\d+/g)].map((valueMatch) => Number(valueMatch[0]));
    if (Number.isInteger(prime) && values.length > 0) {
      entries.set(prime, values);
    }
  }

  return entries;
}

function looksLikeOddPerfectSquareFactorProblem(problem: string) {
  return (
    /\bodd\b/i.test(problem) &&
    /\bperfect\s+square\b/i.test(problem) &&
    /\bfactors?\b/i.test(problem) &&
    primePowerExponents(problem).length > 0
  );
}

export function verifyPerfectSquareExponentPrinciple(
  session: CoachSession,
  message: string
): VerificationResult | null {
  if (!looksLikeOddPerfectSquareFactorProblem(session.problem)) return null;
  if (!/\bsquare\b/i.test(message) || !/\bprime\s+factors?\b/i.test(message)) return null;
  if (!/\beven\s+exponents?\b/i.test(message)) return null;

  return {
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress: "That is the right perfect-square condition: prime exponents must be even.",
    suggested_next_check: "List the allowed even exponents for each prime in the factorization, keeping the odd condition in mind.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyOddPerfectSquareFactorExponentOptions(
  session: CoachSession,
  message: string
): VerificationResult | null {
  if (!looksLikeOddPerfectSquareFactorProblem(session.problem)) return null;
  if (!/\bexponents?\b/i.test(message)) return null;

  const primePowers = primePowerExponents(session.problem);
  const submitted = exponentListsByPrime(message);
  if (submitted.size === 0) return null;

  const wrongPrime = primePowers.find(({ prime, exponent }) => {
    const submittedOptions = submitted.get(prime);
    if (!submittedOptions) return false;

    const expectedOptions = prime === 2
      ? [0]
      : evenExponentOptions(exponent);
    return !equalNumberLists(submittedOptions, expectedOptions);
  });

  if (wrongPrime) {
    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error:
        wrongPrime.prime === 2
          ? "For an odd factor, the exponent of 2 must be 0."
          : `For a perfect-square factor, the exponent of ${wrongPrime.prime} must be an even number no larger than ${wrongPrime.exponent}.`,
      valid_progress: null,
      suggested_next_check: "Rewrite the allowed exponents for that prime, then continue the count.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const requiredPrimes = primePowers.map((entry) => entry.prime);
  const mentionedAllPrimes = requiredPrimes.every((prime) => submitted.has(prime));

  return {
    intent: "submitted_work",
    status: mentionedAllPrimes ? "correct" : "partially_correct",
    local_error: null,
    valid_progress: mentionedAllPrimes
      ? "Those exponent choices match the odd perfect-square factor conditions."
      : "Those exponent choices are valid for the primes you listed.",
    suggested_next_check: mentionedAllPrimes
      ? "Now count the choices for those exponents."
      : "Now list the remaining primes' allowed exponents.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyGcdLcmClaim(message: string): VerificationResult | null {
  const match = message.match(/\b(gcd|lcm)\s*\(?\s*(-?\d+)\s*,\s*(-?\d+)\s*\)?\s*(?:is|=|equals?)\s*(-?\d+)\b/i);
  if (!match) return null;

  const operation = match[1].toLowerCase();
  const left = Number(match[2]);
  const right = Number(match[3]);
  const asserted = Number(match[4]);
  const actual = operation === "gcd" ? gcdNumber(left, right) : lcmNumber(left, right);
  if (actual === null) return null;

  if (asserted === actual) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: `The ${operation} claim is correct.`,
      suggested_next_check: "Use that value in the next step of the problem.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: `The ${operation} of ${left} and ${right} is ${actual}, not ${asserted}.`,
    valid_progress: null,
    suggested_next_check: "Recheck the common factors before using this value.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyDivisorListClaim(message: string): VerificationResult | null {
  const match = message.match(
    /\b(?:natural[-\s]+number\s+)?(?:factors?|divisors?)\s+of\s+(\d+)\s*(?:are|is|=|:)\s*([0-9\s,;and]+)\b/i
  );
  if (!match) return null;

  const value = Number(match[1]);
  const actual = positiveDivisors(value);
  if (!actual) return null;

  const claimed = [...new Set(numberList(match[2]))].sort((left, right) => left - right);
  const claimedText = claimed.join(",");
  const actualText = actual.join(",");

  if (claimed.length > 0 && claimedText === actualText) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: `The positive divisors of ${value} are correct.`,
      suggested_next_check: "Use that divisor list in the next step of the problem.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: `The positive divisors of ${value} are ${formatList(actual)}.`,
    valid_progress: null,
    suggested_next_check: "Check which whole numbers divide evenly into the target number.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyModuloClaim(message: string): VerificationResult | null {
  const normalized = canonicalizeNumericTokens(message);
  const symbolic = normalized.match(
    /\b(-?\d+)\s*(?:mod|modulo|%)\s*(-?\d+)\s*(?:is|=|equals?)\s*(-?\d+)\b/i
  );
  const prose = normalized.match(
    /\b(-?\d+)\s+leaves?\s+(?:a\s+)?remainder\s+(?:of\s+)?(-?\d+)\s+when\s+divide(?:d)?\s+by\s+(-?\d+)\b/i
  );
  if (!symbolic && !prose) return null;

  const value = Number((symbolic || prose)![1]);
  const modulus = Number(symbolic ? symbolic[2] : prose![3]);
  const asserted = Number(symbolic ? symbolic[3] : prose![2]);
  const actual = positiveMod(value, modulus);
  if (actual === null) return null;

  if (asserted === actual) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: `The remainder ${value} modulo ${modulus} is correct.`,
      suggested_next_check: "Use that remainder in the next congruence or case check.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: `${value} modulo ${modulus} is ${actual}, not ${asserted}.`,
    valid_progress: null,
    suggested_next_check: "Divide again and check the remainder.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyParityClaim(message: string): VerificationResult | null {
  const match = message.match(/\b(-?\d+)\s+is\s+(even|odd)\b/i);
  if (!match) return null;

  const value = Number(match[1]);
  const asserted = match[2].toLowerCase();
  const actual = Math.abs(value) % 2 === 0 ? "even" : "odd";

  if (asserted === actual) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: `${value} is ${actual}.`,
      suggested_next_check: "Use that parity fact in the condition you are checking.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: `${value} is ${actual}, not ${asserted}.`,
    valid_progress: null,
    suggested_next_check: "Check divisibility by 2 before continuing.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function normalizeNearestOddText(text: string) {
  return text
    .toLowerCase()
    .replace(/\\left|\\right/g, "")
    .replace(/[{}[\]]/g, (char) => (char === "{" || char === "[" ? "(" : ")"))
    .replace(/[−–—]/g, "-")
    .replace(/[×·]/g, "*")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeEvenIntegerNearestOddProblem(problem: string) {
  const normalized = normalizeNearestOddText(problem);

  return (
    /\beven integer\b/.test(normalized) &&
    /\bsmallest odd\b/.test(normalized) &&
    /\blargest odd\b/.test(normalized) &&
    /\bgreater than\b/.test(normalized) &&
    /\bless than\b/.test(normalized)
  );
}

function nearestOddProblemExpressions(problem: string) {
  const normalized = normalizeNearestOddText(problem);
  const smallestBase = normalized.match(/\bsmallest odd(?: number)? greater than\s+(.+?)\s+and\b/)?.[1];
  const largestBase = normalized.match(/\blargest odd(?: number)? less than\s+(.+?)\s+can be written\b/)?.[1];

  return smallestBase && largestBase ? { smallestBase, largestBase } : null;
}

function parseLinearXExpression(text: string) {
  const normalized = normalizeNearestOddText(text).replace(/\s+/g, "");
  const match = normalized.match(/^([+-]?\d*)x(?:([+-])(\d+))?$/);
  if (!match) return null;

  const coefficientText = match[1];
  const coefficient =
    coefficientText === "" || coefficientText === "+"
      ? 1
      : coefficientText === "-"
        ? -1
        : Number(coefficientText);
  const constant = match[2]
    ? (match[2] === "-" ? -1 : 1) * Number(match[3])
    : 0;

  if (!Number.isInteger(coefficient) || !Number.isInteger(constant)) return null;
  return { coefficient, constant };
}

function sameLinearExpression(
  left: { coefficient: number; constant: number } | null,
  right: { coefficient: number; constant: number }
) {
  return Boolean(
    left &&
      left.coefficient === right.coefficient &&
      left.constant === right.constant
  );
}

function smallestOddGreaterExpected(expression: string) {
  const base = parseLinearXExpression(expression);
  return base && base.coefficient % 2 !== 0 && base.constant % 2 === 0
    ? { coefficient: base.coefficient, constant: base.constant + 1 }
    : null;
}

function largestOddLessExpected(expression: string) {
  const base = parseLinearXExpression(expression);
  return base && base.coefficient % 2 !== 0 && Math.abs(base.constant % 2) === 1
    ? { coefficient: base.coefficient, constant: base.constant - 2 }
    : null;
}

function formatLinearXExpression(expression: { coefficient: number; constant: number }) {
  const coefficient =
    expression.coefficient === 1
      ? "x"
      : expression.coefficient === -1
        ? "-x"
        : `${expression.coefficient}x`;

  if (expression.constant === 0) return coefficient;
  return `${coefficient}${expression.constant > 0 ? "+" : ""}${expression.constant}`;
}

export function verifyNearestOddExpressionClaim(
  session: CoachSession,
  message: string
): VerificationResult | null {
  if (!looksLikeEvenIntegerNearestOddProblem(session.problem)) return null;

  const normalized = normalizeNearestOddText(message);
  const smallestGreaterMatch = normalized.match(
    /\bsmallest odd(?: number)? greater than\s+(.+?)\s+(?:is|=|equals?)\s+([+-]?\d*\s*x\s*(?:[+-]\s*\d+)?)\b/i
  );
  const largestLessMatch = normalized.match(
    /\blargest odd(?: number)? less than\s+(.+?)\s+(?:is|=|equals?)\s+([+-]?\d*\s*x\s*(?:[+-]\s*\d+)?)\b/i
  );

  const smallestExpected = smallestGreaterMatch
    ? smallestOddGreaterExpected(smallestGreaterMatch[1])
    : null;
  const smallestClaim = smallestGreaterMatch
    ? parseLinearXExpression(smallestGreaterMatch[2])
    : null;
  const largestExpected = largestLessMatch
    ? largestOddLessExpected(largestLessMatch[1])
    : null;
  const largestClaim = largestLessMatch
    ? parseLinearXExpression(largestLessMatch[2])
    : null;

  if (
    smallestGreaterMatch &&
    largestLessMatch &&
    sameLinearExpression(smallestClaim, smallestExpected ?? { coefficient: 0, constant: 0 }) &&
    sameLinearExpression(largestClaim, largestExpected ?? { coefficient: 0, constant: 0 })
  ) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress:
        "Both nearest-odd expressions are correct for an even value of $x$.",
      suggested_next_check:
        "Now take the positive difference between those two expressions.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (smallestGreaterMatch) {
    const claim = smallestClaim;
    const expected = smallestExpected;

    if (sameLinearExpression(claim, expected ?? { coefficient: 0, constant: 0 })) {
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress:
          "That nearest-odd claim is correct for an even value of $x$.",
        suggested_next_check:
          "Now find the corresponding largest odd number less than the other expression.",
        should_finish: false,
        confidence: 1,
        source: "deterministic",
      };
    }

    if (!expected) return null;

    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error:
        "For even $x$, the expression you are comparing from is even, so the smallest odd number greater than it is one more.",
      valid_progress: null,
      suggested_next_check:
        "Add $1$ to the expression after confirming its parity.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (largestLessMatch) {
    const claim = largestClaim;
    const expected = largestExpected;

    if (sameLinearExpression(claim, expected ?? { coefficient: 0, constant: 0 })) {
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress:
          "That nearest-odd claim is correct for an even value of $x$.",
        suggested_next_check:
          "Now take the positive difference between the two odd expressions.",
        should_finish: false,
        confidence: 1,
        source: "deterministic",
      };
    }

    if (!expected) return null;

    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error:
        "For even $x$, that expression is odd already, so the largest odd number less than it is two less.",
      valid_progress: null,
      suggested_next_check:
        "Subtract $2$ from the expression because the number must be strictly less.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return null;
}

export function verifyNearestOddDifferenceSetup(
  session: CoachSession,
  message: string
): VerificationResult | null {
  if (!looksLikeEvenIntegerNearestOddProblem(session.problem)) return null;

  const normalized = normalizeNearestOddText(message).replace(/\s+/g, "");
  if (!/\b(?:difference|absolute|positive)\b/i.test(message)) return null;

  const problemExpressions = nearestOddProblemExpressions(session.problem);
  if (!problemExpressions) return null;

  const smallestExpected = smallestOddGreaterExpected(problemExpressions.smallestBase);
  const largestExpected = largestOddLessExpected(problemExpressions.largestBase);
  if (!smallestExpected || !largestExpected) return null;

  const first = formatLinearXExpression(smallestExpected);
  const second = formatLinearXExpression(largestExpected);
  const escapedFirst = first.replace(/[+]/g, "\\+");
  const escapedSecond = second.replace(/[+]/g, "\\+");
  const absolutePattern = new RegExp(
    `(?:\\|${escapedFirst}-\\(${escapedSecond}\\)\\||abs\\(${escapedFirst}-\\(${escapedSecond}\\)\\))`
  );

  if (!absolutePattern.test(normalized)) return null;

  return {
    intent: "submitted_work",
    status: "correct",
    local_error: null,
    valid_progress:
      "That absolute-difference setup uses the two correct odd expressions.",
    suggested_next_check:
      "Now simplify inside the absolute value and use that positive expression to identify $a+b$.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function nearestOddFinalExpression(session: CoachSession) {
  if (!looksLikeEvenIntegerNearestOddProblem(session.problem)) return null;

  const problemExpressions = nearestOddProblemExpressions(session.problem);
  if (!problemExpressions) return null;

  const smallestExpected = smallestOddGreaterExpected(problemExpressions.smallestBase);
  const largestExpected = largestOddLessExpected(problemExpressions.largestBase);
  if (!smallestExpected || !largestExpected) return null;

  const difference = {
    coefficient: smallestExpected.coefficient - largestExpected.coefficient,
    constant: smallestExpected.constant - largestExpected.constant,
  };
  const valueAtSmallestPositiveEvenX = difference.coefficient * 2 + difference.constant;

  return valueAtSmallestPositiveEvenX < 0
    ? { coefficient: -difference.coefficient, constant: -difference.constant }
    : difference;
}

function parseNearestOddFinalAnswer(message: string) {
  const normalized = normalizeNearestOddText(message);
  const sumMatch = normalized.match(/\ba\s*\+\s*b\s*(?:is|=|equals?)\s*(-?\d+)\b/i);
  if (sumMatch) return Number(sumMatch[1]);

  const answerMatch = normalized.match(
    /\b(?:answer|final|result|a\s*\+\s*b)\s*(?:is|=|equals?)?\s*(-?\d+)\s*\??$/i
  );
  if (answerMatch) return Number(answerMatch[1]);

  const bareMatch = normalized.match(/^-?\d+\??$/);
  if (bareMatch) return Number(bareMatch[0].replace("?", ""));

  return null;
}

function parseNearestOddCoefficientClaim(message: string) {
  const normalized = normalizeNearestOddText(message);
  const aMatch = normalized.match(/\ba\s*(?:is|=|equals?)\s*(-?\d+)\b/i);
  const bMatch = normalized.match(/\bb\s*(?:is|=|equals?)\s*(-?\d+)\b/i);
  const a = Number(aMatch?.[1]);
  const b = Number(bMatch?.[1]);

  return Number.isInteger(a) && Number.isInteger(b) ? { a, b } : null;
}

export function verifyNearestOddFinalAnswer(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const expectedExpression = nearestOddFinalExpression(session);
  if (!expectedExpression) return null;

  const expectedSum = expectedExpression.coefficient + expectedExpression.constant;
  const finalAnswer = parseNearestOddFinalAnswer(message);

  if (Number.isInteger(finalAnswer)) {
    if (finalAnswer === expectedSum) {
      return {
        intent: "final_answer",
        status: "correct",
        local_error: null,
        valid_progress: "That is the correct value of $a+b$.",
        suggested_next_check: null,
        should_finish: true,
        confidence: 1,
        source: "deterministic",
      };
    }

    return {
      intent: "final_answer",
      status: "incorrect",
      local_error: "That is not the value of $a+b$ from the simplified difference.",
      valid_progress: null,
      suggested_next_check:
        "First simplify the positive difference into the form $ax+b$, then add those two coefficients.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const coefficientClaim = parseNearestOddCoefficientClaim(message);
  if (!coefficientClaim) return null;

  if (
    coefficientClaim.a === expectedExpression.coefficient &&
    coefficientClaim.b === expectedExpression.constant
  ) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "Those values of $a$ and $b$ match the simplified difference.",
      suggested_next_check: "Now add $a+b$ for the requested final value.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "Those coefficients do not match the simplified positive difference.",
    valid_progress: null,
    suggested_next_check: "Recheck the subtraction before identifying $a$ and $b$.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyPrimeFactorizationClaim(message: string): VerificationResult | null {
  const match = message.match(/\b(?:prime\s+)?factorization\s+of\s+(\d+)\s+(?:is|=)\s+([0-9\s*×x\^\(\),]+)\b/i);
  if (!match) return null;

  const value = Number(match[1]);
  const actual = primeFactors(value);
  if (!actual) return null;

  const claimed = numberList(match[2])
    .filter((factor) => factor > 1)
    .sort((left, right) => left - right);
  const sortedActual = [...actual].sort((left, right) => left - right);

  if (claimed.length > 0 && claimed.join(",") === sortedActual.join(",")) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: `The prime factorization of ${value} is correct.`,
      suggested_next_check: "Use those prime factors to check the divisibility condition.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: `The prime factors of ${value} are ${formatList(sortedActual)}.`,
    valid_progress: null,
    suggested_next_check: "Divide by the smallest prime factors first and try again.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function extractMultipleOfElevenDigitPattern(problem: string) {
  if (!/\bmultiple\s+of\s+11\b/i.test(problem)) return null;

  const numberPhrase = problem.match(/\bnumber\s+([\s\S]+?)\s+is\s+a\s+multiple\s+of\s+11\b/i)?.[1];
  if (!numberPhrase) return null;

  const compact = numberPhrase
    .replace(/\\(?:left|right)\b/g, "")
    .replace(/\\text\s*\{([^{}]*)\}/g, "$1")
    .replace(/[_{}()[\],.]/g, "");
  const tokens = [...compact.matchAll(/\d|[A-Z]/g)].map((match) => match[0].toUpperCase());
  const variables = tokens.filter((token) => /[A-Z]/.test(token));

  if (tokens.length < 2 || variables.length !== 1) return null;
  return tokens;
}

function normalizeDivisibilityEquationSide(side: string) {
  const tokens = [...side.matchAll(/\d|[A-Z]/gi)].map((match) => match[0].toUpperCase());
  return tokens.length > 0 && tokens.join("") === side.replace(/[^0-9A-Z]/gi, "").toUpperCase()
    ? tokens
    : null;
}

function sameTerms(left: string[] | null, right: string[]) {
  return Boolean(
    left &&
      left.length === right.length &&
      left.every((term, index) => term === right[index])
  );
}

function multipleOfElevenMissingDigitSolution(problem: string) {
  const pattern = extractMultipleOfElevenDigitPattern(problem);
  if (!pattern) return null;

  const variable = pattern.find((token) => /[A-Z]/.test(token));
  if (!variable) return null;

  for (let digit = 0; digit <= 9; digit += 1) {
    const digits = pattern.map((token) => (token === variable ? String(digit) : token));
    const oddSum = digits
      .filter((_token, index) => index % 2 === 0)
      .reduce((sum, token) => sum + Number(token), 0);
    const evenSum = digits
      .filter((_token, index) => index % 2 === 1)
      .reduce((sum, token) => sum + Number(token), 0);

    if ((oddSum - evenSum) % 11 === 0) {
      return { variable, digit };
    }
  }

  return null;
}

function parseMissingDigitFinalAnswer(message: string, variable: string) {
  const normalized = message
    .replace(/\$/g, "")
    .replace(/[−–—]/g, "-")
    .trim();
  const assignment = normalized.match(new RegExp(`^${variable}\\s*=\\s*(\\d)$`, "i"));
  if (assignment) return Number(assignment[1]);

  const labeledAnswer = normalized.match(
    /^(?:answer|final|final answer|the digit|missing digit)\s*(?:is|=|:)?\s*(\d)$/i
  );
  if (labeledAnswer) return Number(labeledAnswer[1]);

  const bare = normalized.match(/^\d$/);
  return bare ? Number(bare[0]) : null;
}

export function verifyMultipleOfElevenMissingDigitFinalAnswer(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const solution = multipleOfElevenMissingDigitSolution(session.problem);
  if (!solution) return null;

  const submitted = parseMissingDigitFinalAnswer(message, solution.variable);
  if (submitted === null) return null;

  if (submitted === solution.digit) {
    return {
      intent: "final_answer",
      status: "correct",
      local_error: null,
      valid_progress: `That is the correct value of $${solution.variable}$.`,
      suggested_next_check: null,
      should_finish: true,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "final_answer",
    status: "incorrect",
    local_error:
      "That digit does not make the alternating digit sums differ by a multiple of $11$.",
    valid_progress: null,
    suggested_next_check:
      "Use the divisibility rule for $11$ and solve the alternating-sums equation again.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyMultipleOfElevenMissingDigitSetup(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const pattern = extractMultipleOfElevenDigitPattern(session.problem);
  if (!pattern) return null;

  const normalized = message
    .replace(/\\(?:left|right)\b/g, "")
    .replace(/[{}()[\]]/g, "")
    .replace(/[−–—]/g, "-")
    .trim();
  const equality = normalized.split("=");
  if (equality.length !== 2) return null;

  const oddPositionTerms = pattern.filter((_token, index) => index % 2 === 0);
  const evenPositionTerms = pattern.filter((_token, index) => index % 2 === 1);
  const leftTerms = normalizeDivisibilityEquationSide(equality[0]);
  const rightTerms = normalizeDivisibilityEquationSide(equality[1]);

  if (
    (sameTerms(leftTerms, oddPositionTerms) && sameTerms(rightTerms, evenPositionTerms)) ||
    (sameTerms(leftTerms, evenPositionTerms) && sameTerms(rightTerms, oddPositionTerms))
  ) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress:
        "That setup correctly compares the alternating digit sums for divisibility by $11$.",
      suggested_next_check:
        "Now simplify each side of that equation, then solve for the missing digit.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return null;
}
