export function toBase(value: number, base: number) {
  if (!Number.isInteger(value) || !Number.isInteger(base) || value < 0 || base < 2 || base > 36) {
    return null;
  }

  return value.toString(base);
}

export function choose(n: number, k: number) {
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 0 || k < 0 || k > n || n > 200) {
    return null;
  }

  const r = Math.min(k, n - k);
  let value = BigInt(1);

  for (let i = 1; i <= r; i += 1) {
    value = (value * BigInt(n - r + i)) / BigInt(i);
  }

  return value;
}

export function factorial(n: number) {
  if (!Number.isInteger(n) || n < 0 || n > 200) return null;

  let value = BigInt(1);
  for (let i = 2; i <= n; i += 1) {
    value *= BigInt(i);
  }

  return value;
}

export function permutation(n: number, k: number) {
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 0 || k < 0 || k > n || n > 200) {
    return null;
  }

  let value = BigInt(1);
  for (let i = 0; i < k; i += 1) {
    value *= BigInt(n - i);
  }

  return value;
}

export function gcdNumber(left: number, right: number) {
  if (!Number.isInteger(left) || !Number.isInteger(right)) return null;

  let a = Math.abs(left);
  let b = Math.abs(right);

  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }

  return a;
}

export function lcmNumber(left: number, right: number) {
  if (!Number.isInteger(left) || !Number.isInteger(right) || left === 0 || right === 0) return null;
  const divisor = gcdNumber(left, right);
  return divisor === null ? null : Math.abs((left / divisor) * right);
}

export function positiveMod(value: number, modulus: number) {
  if (!Number.isInteger(value) || !Number.isInteger(modulus) || modulus <= 0) return null;
  return ((value % modulus) + modulus) % modulus;
}

export function isPerfectSquare(value: number) {
  if (!Number.isInteger(value) || value < 0) return false;
  const root = Math.sqrt(value);
  return Number.isInteger(root);
}

export type Rational = {
  numerator: bigint;
  denominator: bigint;
};

export const ZERO = BigInt(0);
export const ONE = BigInt(1);
export const NEGATIVE_ONE = BigInt(-1);
export const MAX_EXPONENT = BigInt(5000);

class MathParser {
  private index = 0;

  constructor(private readonly text: string) {}

  parse() {
    const value = this.parseExpression();
    if (!value || this.index !== this.text.length) return null;
    return value;
  }

  private parseExpression(): Rational | null {
    let value = this.parseTerm();
    if (!value) return null;

    while (this.peek() === "+" || this.peek() === "-") {
      const operator = this.next();
      const right = this.parseTerm();
      if (!right) return null;
      value = operator === "+" ? addRational(value, right) : subtractRational(value, right);
    }

    return value;
  }

  private parseTerm(): Rational | null {
    let value = this.parsePower();
    if (!value) return null;

    while (this.peek() === "*" || this.peek() === "/") {
      const operator = this.next();
      const right = this.parsePower();
      if (!right) return null;
      value = operator === "*" ? multiplyRational(value, right) : divideRational(value, right);
      if (!value) return null;
    }

    return value;
  }

  private parsePower(): Rational | null {
    const base = this.parsePrimary();
    if (!base) return null;

    if (this.peek() !== "^") return base;

    this.next();
    const exponent = this.parsePower();
    if (!exponent || exponent.denominator !== ONE) return null;

    return powRational(base, exponent.numerator);
  }

  private parsePrimary(): Rational | null {
    if (this.peek() === "-") {
      this.next();
      const value = this.parsePrimary();
      return value ? negateRational(value) : null;
    }

    if (this.peek() === "(") {
      this.next();
      const value = this.parseExpression();
      if (!value || this.next() !== ")") return null;
      return value;
    }

    return this.parseInteger();
  }

  private parseInteger(): Rational | null {
    const start = this.index;
    while (/\d/.test(this.peek())) {
      this.index += 1;
    }

    if (start === this.index) return null;

    return normalizeRational({
      numerator: BigInt(this.text.slice(start, this.index)),
      denominator: ONE,
    });
  }

  private peek() {
    return this.text[this.index] || "";
  }

  private next() {
    const char = this.peek();
    this.index += 1;
    return char;
  }
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < ZERO ? -a : a;
  let y = b < ZERO ? -b : b;

  while (y !== ZERO) {
    const next = x % y;
    x = y;
    y = next;
  }

  return x || ONE;
}

export function normalizeRational(value: Rational): Rational {
  if (value.denominator === ZERO) {
    throw new Error("Division by zero");
  }

  const sign = value.denominator < ZERO ? NEGATIVE_ONE : ONE;
  const numerator = value.numerator * sign;
  const denominator = value.denominator * sign;
  const divisor = gcd(numerator, denominator);

  return {
    numerator: numerator / divisor,
    denominator: denominator / divisor,
  };
}

export function addRational(left: Rational, right: Rational) {
  return normalizeRational({
    numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  });
}

export function subtractRational(left: Rational, right: Rational) {
  return addRational(left, negateRational(right));
}

export function multiplyRational(left: Rational, right: Rational) {
  return normalizeRational({
    numerator: left.numerator * right.numerator,
    denominator: left.denominator * right.denominator,
  });
}

export function divideRational(left: Rational, right: Rational) {
  if (right.numerator === ZERO) return null;

  return normalizeRational({
    numerator: left.numerator * right.denominator,
    denominator: left.denominator * right.numerator,
  });
}

export function negateRational(value: Rational) {
  return {
    numerator: -value.numerator,
    denominator: value.denominator,
  };
}

export function powRational(base: Rational, exponent: bigint) {
  if (exponent < ZERO) return null;
  if (exponent > MAX_EXPONENT) return null;

  return normalizeRational({
    numerator: base.numerator ** exponent,
    denominator: base.denominator ** exponent,
  });
}

export function equalRational(left: Rational, right: Rational) {
  return left.numerator === right.numerator && left.denominator === right.denominator;
}

export function formatRational(value: Rational) {
  return value.denominator === ONE
    ? value.numerator.toString()
    : `${value.numerator}/${value.denominator}`;
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

export function replaceLatexFractions(text: string): string {
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

function decimalExpressionToFractions(text: string) {
  return text.replace(/(-?)(\d*)\.(\d+)/g, (_match, sign: string, whole: string, fraction: string) => {
    const digits = `${whole || "0"}${fraction}`;
    const denominator = BigInt(10) ** BigInt(fraction.length);
    const numerator = BigInt(`${sign}${digits}`);

    return `(${numerator.toString()}/${denominator.toString()})`;
  });
}

export function sanitizeArithmeticExpression(text: string) {
  const withNumericFactorials = canonicalizeNumericTokens(text).replace(/(\d+)\s*!/g, (match, valueText: string) => {
    const value = factorial(Number(valueText));
    return value === null ? match : value.toString();
  });
  const withoutLabels = decimalExpressionToFractions(replaceLatexFractions(withNumericFactorials))
    .replace(/final\s+answer\s*:/gi, "")
    .replace(/\banswer\s*:/gi, "")
    .replace(/\s+/g, "")
    .replace(/\\(?:cdot|times|ast)(?![a-zA-Z])|[\u00d7\u00b7]/g, "*")
    .replace(/\\div|\u00f7/g, "/")
    .replace(/[−–—]/g, "-")
    .replace(/[×·]/g, "*")
    .replace(/÷/g, "/")
    .replace(/\*\*/g, "^")
    .replace(/[{}[\]]/g, (char) => (char === "{" || char === "[" ? "(" : ")"));

  return withoutLabels.replace(/[^0-9+\-*/^()]/g, "");
}

export function addImplicitMultiplication(text: string) {
  return text
    .replace(/(\d|\))(?=\()/g, "$1*")
    .replace(/\)(?=\d)/g, ")*")
    .replace(/(\d|\))(?=[a-zA-Z])/g, "$1*")
    .replace(/([a-zA-Z])(?=\()/g, "$1*");
}

function findTopLevelSlash(text: string) {
  let depth = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "/" && depth === 0) return index;
  }

  return -1;
}

function groupLooseFractionDenominator(text: string) {
  const slashIndex = findTopLevelSlash(text);
  if (slashIndex === -1) return text;

  const numerator = text.slice(0, slashIndex);
  const denominator = text.slice(slashIndex + 1);
  if (!numerator || !denominator) return text;

  return `${numerator}/(${denominator})`;
}

function parseSanitizedArithmetic(sanitized: string) {
  if (!sanitized || !/\d/.test(sanitized)) return null;

  try {
    return new MathParser(sanitized).parse();
  } catch {
    return null;
  }
}

function floorRational(value: Rational): Rational {
  const quotient = value.numerator / value.denominator;
  const hasRemainder = value.numerator % value.denominator !== ZERO;
  const floor =
    value.numerator < ZERO && hasRemainder
      ? quotient - ONE
      : quotient;

  return {
    numerator: floor,
    denominator: ONE,
  };
}

function parseFloorWrappedArithmetic(text: string): Rational | null {
  const normalized = text
    .replace(/\$/g, "")
    .replace(/\\left|\\right/g, "")
    .trim();
  const match = normalized.match(
    /^(?:\\lfloor|⌊)\s*([\s\S]+?)\s*(?:\\rfloor|⌋)$/
  );
  if (!match) return null;

  const inner = parseArithmeticCandidates(match[1]);
  return inner.length === 1 ? floorRational(inner[0]) : null;
}

export function parseArithmetic(text: string) {
  const floorValue = parseFloorWrappedArithmetic(text);
  if (floorValue) return floorValue;

  return parseSanitizedArithmetic(addImplicitMultiplication(sanitizeArithmeticExpression(text)));
}

export function parseArithmeticCandidates(text: string): Rational[] {
  const floorValue = parseFloorWrappedArithmetic(text);
  if (floorValue) return [floorValue];

  const sanitized = sanitizeArithmeticExpression(text);
  const normal = addImplicitMultiplication(sanitized);
  const groupedDenominator = addImplicitMultiplication(groupLooseFractionDenominator(sanitized));

  return Array.from(new Set([normal, groupedDenominator]))
    .map((candidate) => parseSanitizedArithmetic(candidate))
    .filter((candidate): candidate is Rational => Boolean(candidate));
}

export function parseSingleArithmeticCandidate(text: string) {
  const candidates = parseArithmeticCandidates(text);
  return candidates[0] || null;
}

export function hasArithmeticOperator(text: string) {
  return /[+\-*/^\u00d7\u00b7]|\\(?:[dt]?frac|cdot|times|ast|div)(?![a-zA-Z])/.test(text);
}

export function splitSingleEquals(text: string) {
  const normalized = text.replace(/\bis equal to\b/i, "=");
  const parts = normalized.split("=");
  if (parts.length !== 2) return null;

  const [left, right] = parts.map((part) => part.trim());
  return left && right ? { left, right } : null;
}
import { canonicalizeNumericTokens } from "@/lib/numericText";
