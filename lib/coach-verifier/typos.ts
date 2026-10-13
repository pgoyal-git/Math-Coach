export type TypoCorrection = {
  from: string;
  to: string;
};

const TYPO_ALIASES: Record<string, string> = {
  dgiit: "digit",
  dgiits: "digits",
  denomniator: "denominator",
  denomniators: "denominators",
};

const TYPO_VOCABULARY = new Set([
  "absolute",
  "add",
  "and",
  "answer",
  "are",
  "area",
  "average",
  "base",
  "both",
  "bottom",
  "cancel",
  "case",
  "cases",
  "choose",
  "circumference",
  "clear",
  "common",
  "denominator",
  "denominators",
  "difference",
  "digit",
  "digits",
  "divisor",
  "divisors",
  "divide",
  "dividing",
  "equal",
  "equals",
  "even",
  "expression",
  "factor",
  "factors",
  "factorization",
  "final",
  "fraction",
  "from",
  "geometric",
  "greater",
  "hypotenuse",
  "integer",
  "is",
  "largest",
  "leaves",
  "less",
  "modulo",
  "multiply",
  "multiplying",
  "number",
  "numerator",
  "numerators",
  "odd",
  "page",
  "pages",
  "positive",
  "prime",
  "pull",
  "ratio",
  "reduce",
  "root",
  "side",
  "sides",
  "simplify",
  "smallest",
  "score",
  "scores",
  "square",
  "squared",
  "subtract",
  "subtracting",
  "sum",
  "take",
  "than",
  "the",
  "top",
  "total",
  "triangle",
  "ways",
  "write",
  "writes",
  "written",
  "wrote",
]);

function isAdjacentTransposition(left: string, right: string) {
  if (left.length !== right.length) return false;

  const differences: number[] = [];
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) differences.push(index);
  }

  return (
    differences.length === 2 &&
    differences[1] === differences[0] + 1 &&
    left[differences[0]] === right[differences[1]] &&
    left[differences[1]] === right[differences[0]]
  );
}

function editDistanceAtMostOne(left: string, right: string) {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;

  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    edits += 1;
    if (edits > 1) return false;

    if (left.length > right.length) {
      leftIndex += 1;
    } else if (right.length > left.length) {
      rightIndex += 1;
    } else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }

  return edits + (left.length - leftIndex) + (right.length - rightIndex) <= 1;
}

function preserveCase(original: string, corrected: string) {
  if (original.toUpperCase() === original) return corrected.toUpperCase();
  if (original[0]?.toUpperCase() === original[0]) {
    return `${corrected[0].toUpperCase()}${corrected.slice(1)}`;
  }

  return corrected;
}

function correctionForWord(word: string) {
  const lower = word.toLowerCase();
  if (lower.length < 3 || TYPO_VOCABULARY.has(lower)) return null;
  if (lower.endsWith("s") && TYPO_VOCABULARY.has(lower.slice(0, -1))) return null;

  const alias = TYPO_ALIASES[lower];
  if (alias) return alias;

  const matches = [...TYPO_VOCABULARY].filter(
    (candidate) =>
      Math.abs(candidate.length - lower.length) <= 1 &&
      (editDistanceAtMostOne(lower, candidate) || isAdjacentTransposition(lower, candidate))
  );

  return matches.length === 1 ? matches[0] : null;
}

export function normalizeStudentProseTypos(text: string) {
  const corrections: TypoCorrection[] = [];
  const normalized = text.replace(/[A-Za-z]+/g, (word, offset) => {
    if (text[offset - 1] === "\\") return word;

    const correction = correctionForWord(word);
    if (!correction) return word;

    corrections.push({ from: word, to: correction });
    return preserveCase(word, correction);
  });

  return {
    text: normalized,
    corrections,
  };
}
