import type { CoachSession } from "@/lib/sessionStore";
import type { VerificationResult } from "@/lib/coach-verifier/types";
import { ONE, choose, factorial, parseSingleArithmeticCandidate, permutation } from "@/lib/coach-verifier/math";

function parseCombinationClaim(message: string) {
  const direct = message.match(
    /^\s*(\d+)\s*(?:choose|c)\s*(\d+)\s*(?:is|=|equals?)\s*(\d+)\s*[\s.!?]*$/i
  );
  if (direct) {
    return {
      n: Number(direct[1]),
      k: Number(direct[2]),
      asserted: BigInt(direct[3]),
    };
  }

  const prose = message.match(
    /\b(?:there\s+are\s+(?:a\s+total\s+of\s+)?|total\s+(?:of\s+)?|answer\s*(?:is|=)?\s*)?(\d+)\s+(?:ways?\s+)?to\s+choose\s+(\d+)\s+(?:\w+\s+){0,4}?from\s+(\d+)\b/i
  );
  if (prose) {
    return {
      n: Number(prose[3]),
      k: Number(prose[2]),
      asserted: BigInt(prose[1]),
    };
  }

  return null;
}

export function verifyCombinationClaim(message: string): VerificationResult | null {
  const claim = parseCombinationClaim(message);
  if (!claim) return null;

  const actual = choose(claim.n, claim.k);
  if (actual === null) return null;

  if (claim.asserted === actual) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: `$\\binom{${claim.n}}{${claim.k}}=${actual.toString()}$ is correct.`,
      suggested_next_check: "Now account for the restriction in the original problem.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: `$\\binom{${claim.n}}{${claim.k}}=${actual.toString()}$, not ${claim.asserted.toString()}.`,
    valid_progress: null,
    suggested_next_check: "Check the factorial cancellation in the combination formula.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyFactorialClaim(message: string): VerificationResult | null {
  const match = message.match(/^\s*(\d+)\s*!\s*(?:is|=|equals?)\s*(\d+)\s*[\s.!?]*$/i);
  if (!match) return null;

  const n = Number(match[1]);
  const asserted = BigInt(match[2]);
  const actual = factorial(n);
  if (actual === null) return null;

  if (asserted === actual) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: `$${n}! = ${actual.toString()}$ is correct.`,
      suggested_next_check: "Use that factorial value in the counting expression.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: `$${n}! = ${actual.toString()}$, not ${asserted.toString()}.`,
    valid_progress: null,
    suggested_next_check: "Multiply the positive integers up to that number again.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function normalizeFactorialProductSide(text: string) {
  return text
    .replace(/\\(?:cdot|times|ast)(?![a-zA-Z])\s*/g, "*")
    .replace(/[\u00d7\u00b7]/g, "*")
    .replace(/\s+/g, "");
}

function parseFactorialProductValue(text: string) {
  const normalized = normalizeFactorialProductSide(text);
  if (!normalized || !/^\d+!?(?:\*\d+!?)*$/.test(normalized)) return null;

  let value = BigInt(1);
  for (const token of normalized.split("*")) {
    const factorialMatch = token.match(/^(\d+)!$/);
    if (factorialMatch) {
      const factorialValue = factorial(Number(factorialMatch[1]));
      if (factorialValue === null) return null;
      value *= factorialValue;
      continue;
    }

    value *= BigInt(token);
  }

  return value;
}

export function verifyFactorialProductEquality(message: string): VerificationResult | null {
  const equality = message.split("=");
  if (equality.length !== 2 || !message.includes("!")) return null;

  const left = parseFactorialProductValue(equality[0]);
  const right = parseFactorialProductValue(equality[1]);
  if (left === null || right === null) return null;

  if (left === right) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That factorial identity checks out.",
      suggested_next_check: "Use that identity to simplify the original equation one step.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: "Those two factorial expressions are not equal.",
    valid_progress: null,
    suggested_next_check: "Use the rule $k! = k\\cdot (k-1)!$ and check the adjacent factorial.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function parseSimpleFactorialEquationProblem(problem: string) {
  const normalized = problem
    .replace(/\\(?:cdot|times|ast)(?![a-zA-Z])\s*/g, "*")
    .replace(/[\u00d7\u00b7]/g, "*")
    .replace(/[{}]/g, "")
    .replace(/[?.]/g, "")
    .replace(/\s+/g, " ");

  const direct = normalized.match(/\bn\s*!\s*\*\s*(\d+)\s*!\s*=\s*(\d+)\s*!/i);
  const reversed = normalized.match(/\b(\d+)\s*!\s*=\s*(?:n\s*!\s*\*\s*(\d+)\s*!|(\d+)\s*!\s*\*\s*n\s*!)/i);
  const known = direct ? Number(direct[1]) : Number(reversed?.[2] || reversed?.[3]);
  const target = direct ? Number(direct[2]) : Number(reversed?.[1]);

  if (!Number.isInteger(known) || !Number.isInteger(target)) return null;
  if (target < known) return null;

  const targetFactorial = factorial(target);
  const knownFactorial = factorial(known);
  if (targetFactorial === null || knownFactorial === null || knownFactorial === BigInt(0)) {
    return null;
  }

  const neededFactorial = targetFactorial / knownFactorial;
  if (neededFactorial * knownFactorial !== targetFactorial) return null;

  for (let candidate = 0; candidate <= 200; candidate += 1) {
    if (factorial(candidate) === neededFactorial) {
      return { known, target, answer: candidate, neededFactorial };
    }
  }

  return null;
}

function parseCleanNFinalAnswer(message: string) {
  const normalized = message.trim();
  const assignment = normalized.match(/^(?:answer|final answer|final)?\s*(?:is|=|:)?\s*n\s*=\s*(\d+)\s*[\s.!?]*$/i);
  if (assignment) return Number(assignment[1]);

  const labeled = normalized.match(/^(?:answer|final answer|final|n)\s*(?:is|=|:)?\s*(\d+)\s*[\s.!?]*$/i);
  if (labeled) return Number(labeled[1]);

  const bare = normalized.match(/^(\d+)\s*[\s.!?]*$/);
  return bare ? Number(bare[1]) : null;
}

function parseEmbeddedNAssignment(message: string) {
  const match = message.match(/\bn\s*=\s*(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function looksExploratory(message: string) {
  return /\b(?:need|needs|trying|try|want|wants|looking|look)\s+to\s+find\b|\bfor\s+which\b/i.test(
    message
  );
}

export function verifySimpleFactorialEquationFinalAnswer(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const context = parseSimpleFactorialEquationProblem(session.problem);
  if (!context) return null;

  if (looksExploratory(message)) {
    const embeddedAnswer = parseEmbeddedNAssignment(message);
    if (embeddedAnswer === null || !Number.isInteger(embeddedAnswer)) return null;

    if (embeddedAnswer === context.answer) {
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That is the right value of $n$.",
        suggested_next_check: "State it directly as the final answer when you are ready.",
        should_finish: false,
        confidence: 1,
        source: "deterministic",
      };
    }

    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: `That value would make $n!$ equal to ${factorial(embeddedAnswer)?.toString() || "a different value"}, not ${context.neededFactorial.toString()}.`,
      valid_progress: null,
      suggested_next_check: "Use the value of $n!$ first, then choose the integer whose factorial has that value.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const answer = parseCleanNFinalAnswer(message);
  if (!Number.isInteger(answer) || answer === null) return null;

  if (answer === context.answer) {
    return {
      intent: "final_answer",
      status: "correct",
      local_error: null,
      valid_progress: "That value of $n$ satisfies the factorial equation.",
      suggested_next_check: null,
      should_finish: true,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "final_answer",
    status: "incorrect",
    local_error: `That value makes $n!$ equal to ${factorial(answer)?.toString() || "a different value"}, not ${context.neededFactorial.toString()}.`,
    valid_progress: null,
    suggested_next_check: "First identify the value of $n!$, then choose the integer whose factorial has that value.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function parseFactorialInequalityContext(problem: string) {
  const normalized = problem
    .replace(/\\left|\\right/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!/\bgreatest\s+integer\s+n\b/i.test(normalized)) return null;
  if (!/n\s*!\s*\(?\s*n\s*-\s*1\s*\)?\s*!/i.test(normalized)) return null;

  const thresholdMatch = normalized.match(/<\s*(\d+)/);
  if (!thresholdMatch) return null;

  const threshold = BigInt(thresholdMatch[1]);
  if (threshold <= BigInt(0)) return null;

  let greatest: number | null = null;

  for (let candidate = 1; candidate <= 100; candidate += 1) {
    const left = factorial(candidate);
    const right = factorial(candidate - 1);
    if (left === null || right === null) return null;

    const value = left * right;
    if (value < threshold) {
      greatest = candidate;
      continue;
    }

    break;
  }

  return greatest === null ? null : { threshold, greatest };
}

function parseIntegerNAnswerClaim(message: string) {
  const normalized = message.trim();
  const variableMatch = normalized.match(/^\s*n\s*=\s*(\d+)\s*$/i);
  if (variableMatch) return Number(variableMatch[1]);

  const answerMatch = normalized.match(
    /\b(?:answer|final answer|final|result|n)\s*(?:is|=|:)?\s*(\d+)\b/i
  );
  if (answerMatch) return Number(answerMatch[1]);

  const bareNumber = normalized.match(/^\s*(\d+)\s*$/);
  return bareNumber ? Number(bareNumber[1]) : null;
}

export function verifyFactorialInequalityFinalAnswer(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const context = parseFactorialInequalityContext(session.problem);
  if (!context) return null;

  const answer = parseIntegerNAnswerClaim(message);
  if (!Number.isInteger(answer) || answer === null) return null;

  if (answer === context.greatest) {
    return {
      intent: "final_answer",
      status: "correct",
      local_error: null,
      valid_progress: "That is the greatest integer that keeps the factorial product below the bound.",
      suggested_next_check: null,
      should_finish: true,
      confidence: 1,
      source: "deterministic",
    };
  }

  const left = answer >= 1 ? factorial(answer) : null;
  const right = answer >= 1 ? factorial(answer - 1) : null;
  const value = left !== null && right !== null ? left * right : null;
  const works = value !== null && value < context.threshold;

  return {
    intent: "final_answer",
    status: "incorrect",
    local_error: works
      ? "That value satisfies the inequality, but it is not the greatest possible integer."
      : "That value does not satisfy the factorial inequality.",
    valid_progress: null,
    suggested_next_check: works
      ? "Try the next integer and check whether the product is still below the bound."
      : "Test the nearby smaller integer and compare the factorial product with the bound.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

export function verifyPermutationClaim(message: string): VerificationResult | null {
  const match =
    message.match(/^\s*(\d+)\s*p\s*(\d+)\s*(?:is|=|equals?)\s*(\d+)\s*[\s.!?]*$/i) ||
    message.match(/^\s*p\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)\s*(?:is|=|equals?)\s*(\d+)\s*[\s.!?]*$/i);
  if (!match) return null;

  const n = Number(match[1]);
  const k = Number(match[2]);
  const asserted = BigInt(match[3]);
  const actual = permutation(n, k);
  if (actual === null) return null;

  if (asserted === actual) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: `$P(${n},${k})=${actual.toString()}$ is correct.`,
      suggested_next_check: "Use that ordered count in the problem context.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "submitted_work",
    status: "incorrect",
    local_error: `$P(${n},${k})=${actual.toString()}$, not ${asserted.toString()}.`,
    valid_progress: null,
    suggested_next_check: "Check the descending product for the ordered choices.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}

function parseChooseFromContext(text: string) {
  const prose = [...text.matchAll(/\bchoose\s+(\d+)\s+(?:\w+\s+){0,4}?from\s+(\d+)\b/gi)].at(-1);
  if (prose) {
    return {
      k: Number(prose[1]),
      n: Number(prose[2]),
    };
  }

  const symbolic = [...text.matchAll(/\b(\d+)\s*(?:choose|c)\s*(\d+)\b/gi)].at(-1);
  if (symbolic) {
    return {
      n: Number(symbolic[1]),
      k: Number(symbolic[2]),
    };
  }

  return null;
}

export function verifyDistinguishedRepresentativeOvercount(
  session: CoachSession,
  message: string
): VerificationResult | null {
  if (!/\bleaves?\b/i.test(message) || !/\bremaining\b/i.test(message)) return null;

  const oneFromEachCounts = [
    ...message.matchAll(/\b(\d+)\s+(?:ways?\s+)?to\s+choose\s+(?:a|an|one)\b/gi),
  ].map((match) => Number(match[1]));
  const remaining = message.match(/\bleaves?\s+(\d+)\s*(?:choose|c)\s*(\d+)\b/i);
  if (oneFromEachCounts.length < 2 || !remaining) return null;

  const groupCount = oneFromEachCounts.length;
  const groupTotal = oneFromEachCounts.reduce((sum, count) => sum + count, 0);
  const remainingN = Number(remaining[1]);
  const remainingK = Number(remaining[2]);
  const context =
    parseChooseFromContext(
      [
        session.problem,
        ...(session.workState?.acceptedLines || []),
        ...session.history.slice(-8).map((entry) => entry.content),
      ].join(" ")
    ) || {
      n: groupTotal,
      k: remainingK + groupCount,
    };

  if (
    groupTotal === context.n &&
    remainingN === context.n - groupCount &&
    remainingK === context.k - groupCount
  ) {
    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error:
        "That setup overcounts because the selected CDs from each genre are being treated as distinguished first choices.",
      valid_progress: null,
      suggested_next_check:
        "Try counting the complement instead: start with all selections and subtract selections missing at least one genre.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return null;
}

type CategorySelectionContext = {
  counts: number[];
  total: number;
  k: number;
};

function parseCategorySelectionContext(session: CoachSession): CategorySelectionContext | null {
  const problem = session.problem;
  if (!/\bat\s+least\s+one\b/i.test(problem) && !/\bone\s+from\s+each\b/i.test(problem)) {
    return null;
  }

  const itemNoun =
    problem.match(/\b(?:cds?|disks?|books?|songs?|cards?|objects?|items?|people|students?)\b/i)?.[0] ||
    "\\w+";
  const categoryPattern = new RegExp(
    `\\b(\\d+)\\s+([a-z][a-z-]*(?:\\s+[a-z][a-z-]*){0,2})\\s+${itemNoun}\\b`,
    "gi"
  );
  const counts = [...problem.matchAll(categoryPattern)]
    .filter((match) => !/\b(?:choose|select|pick|from|total)\b/i.test(match[2]))
    .map((match) => Number(match[1]))
    .filter((count) => Number.isInteger(count) && count > 0);

  const chooseMatch =
    problem.match(/\b(?:choose|select|pick)\s+(\d+)\b/i) ||
    problem.match(/\bcommittees?\s+of\s+(\d+)\b/i);
  const k = chooseMatch ? Number(chooseMatch[1]) : null;

  if (!k || !Number.isInteger(k) || counts.length < 2) return null;

  const total = counts.reduce((sum, count) => sum + count, 0);
  if (k <= 0 || k > total) return null;

  return { counts, total, k };
}

function formatBinomial(n: number, k: number) {
  return `$\\binom{${n}}{${k}}$`;
}

function binomialValue(n: number, k: number) {
  return choose(n, k) ?? BigInt(0);
}

function categorySelectionAnswer(context: CategorySelectionContext) {
  if (context.counts.length !== 3) return null;

  const totalWays = binomialValue(context.total, context.k);
  const missingOne = context.counts.reduce(
    (sum, count) => sum + binomialValue(context.total - count, context.k),
    BigInt(0)
  );
  const missingTwo = context.counts.reduce(
    (sum, count) => sum + binomialValue(count, context.k),
    BigInt(0)
  );

  return totalWays - missingOne + missingTwo;
}

function parseBinomialTerms(text: string) {
  const terms: { n: number; k: number; index: number }[] = [];
  const patterns = [
    /\\binom\{(\d+)\}\{(\d+)\}/gi,
    /\bc\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/gi,
    /\(\s*(\d+)\s*(?:choose|c|,)\s*(\d+)\s*\)/gi,
    /\b(\d+)\s*(?:choose|c)\s*(\d+)\b/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      terms.push({
        n: Number(match[1]),
        k: Number(match[2]),
        index: match.index ?? -1,
      });
    }
  }

  return terms
    .filter((term, index, all) => (
      term.index >= 0 &&
      Number.isInteger(term.n) &&
      Number.isInteger(term.k) &&
      all.findIndex((other) => other.index === term.index) === index
    ))
    .sort((left, right) => left.index - right.index);
}

function sortedKey(values: number[]) {
  return [...values].sort((left, right) => left - right).join(",");
}

function replaceBinomialTermsWithValues(text: string) {
  const replace = (value: string, nText: string, kText: string) => {
    const valueForTerm = choose(Number(nText), Number(kText));
    return valueForTerm === null ? value : valueForTerm.toString();
  };

  return text
    .replace(/\\binom\{(\d+)\}\{(\d+)\}/gi, replace)
    .replace(/\bc\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/gi, replace)
    .replace(/\(\s*(\d+)\s*(?:choose|c|,)\s*(\d+)\s*\)/gi, replace)
    .replace(/\b(\d+)\s*(?:choose|c)\s*(\d+)\b/gi, replace);
}

function parseCombinationExpressionValue(text: string) {
  return parseSingleArithmeticCandidate(replaceBinomialTermsWithValues(text));
}

function parseIntegerAnswerClaim(message: string) {
  const answerMatch = message.match(/\b(?:answer|final|result|total)\s*(?:is|=)?\s*(\d+)\b/i);
  if (answerMatch) return BigInt(answerMatch[1]);

  const bareNumber = message.match(/^\s*(\d+)\s*$/);
  return bareNumber ? BigInt(bareNumber[1]) : null;
}

export function verifyCategorySelectionCombinatorics(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const context = parseCategorySelectionContext(session);
  if (!context) return null;

  const expectedAnswer = categorySelectionAnswer(context);
  const answerClaim = parseIntegerAnswerClaim(message);
  if (expectedAnswer !== null && answerClaim !== null) {
    if (answerClaim === expectedAnswer) {
      return {
        intent: "final_answer",
        status: "correct",
        local_error: null,
        valid_progress: "That count satisfies the at-least-one-from-each restriction.",
        suggested_next_check: null,
        should_finish: true,
        confidence: 1,
        source: "deterministic",
      };
    }

    return {
      intent: "final_answer",
      status: "incorrect",
      local_error: "That total does not match the inclusion-exclusion count for the restriction.",
      valid_progress: null,
      suggested_next_check:
        "Start with all selections, subtract selections missing one category, then add back overlaps.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const expressionValue = parseCombinationExpressionValue(message);
  if (expectedAnswer !== null && expressionValue?.denominator === ONE) {
    if (expressionValue.numerator === expectedAnswer) {
      return {
        intent: "submitted_work",
        status: "correct",
        local_error: null,
        valid_progress: "That inclusion-exclusion expression gives the restricted count.",
        suggested_next_check: "State that value as the final answer.",
        should_finish: false,
        confidence: 1,
        source: "deterministic",
      };
    }
  }

  const terms = parseBinomialTerms(message);
  if (terms.length === 0) return null;

  const missingOneSizes = context.counts.map((count) => context.total - count);
  const missingOneTerms = terms.filter((term) => term.k === context.k);
  if (
    missingOneTerms.length === context.counts.length &&
    sortedKey(missingOneTerms.map((term) => term.n)) === sortedKey(missingOneSizes)
  ) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "Those are the counts for selections missing one category.",
      suggested_next_check: "Now check which overlap cases were subtracted more than once.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  const totalTerm = terms.find((term) => term.n === context.total && term.k === context.k);
  if (totalTerm && terms.length === 1) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: `${formatBinomial(context.total, context.k)} counts all selections before the restriction.`,
      suggested_next_check: "Subtract the selections that miss at least one category.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return null;
}
