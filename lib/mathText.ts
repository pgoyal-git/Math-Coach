type MathTextPart = { text: string; math: boolean };

function repairJsonEscapedLatexCommands(text: string) {
  return text
    .replace(/\u000c(?=rac(?:\b|\d|\{))/g, "\\f")
    .replace(/\uFFFD(?=rac(?:\b|\d|\{))/g, "\\f")
    .replace(/\t(?=(?:ext|imes|heta))/g, "\\t")
    .replace(/\u0008(?=(?:ig|inom|oxed|oldsymbol)\b)/g, "\\b")
    .replace(/\r(?=ight\b)/g, "\\r")
    .replace(/\uFFFD(?=irc\b)/g, "\\c")
    .replace(/\uFFFD(?=(?:ldots|cdots)\b)/g, "\\")
    .replace(/\uFFFDigml\b/gi, "\\mid")
    .replace(/(\d+)\s*oot\s*(\d+)/gi, "$1\\sqrt{$2}")
    .replace(/\\\\(?=%)/g, "\\");
}

function normalizeWordPlaceholders(expression: string) {
  return expression.replace(/\b([a-zA-Z]+(?:_[a-zA-Z0-9]+)+)\b/g, (match) => {
    const [base, ...subscriptParts] = match.split("_");

    if (/^[a-zA-Z]$/.test(base)) {
      return `${base}_{${subscriptParts.join("_")}}`;
    }

    if (!/^[a-z]+(?:_[a-z]+)+$/.test(match)) {
      return match.replace(/_/g, "\\_");
    }

    const words = match.split("_").join(" ");
    return `\\text{${words}}`;
  });
}

function escapeBarePercent(expression: string) {
  return expression.replace(/(^|[^\\])%/g, "$1\\%");
}

function repairCompactFractions(expression: string) {
  return expression.replace(/\\?(?:[dt]?frac)\s*([a-zA-Z0-9])\s*([a-zA-Z0-9])/g, "\\frac{$1}{$2}");
}

function repairLegacyChooseNotation(expression: string) {
  return expression.replace(
    /\{\s*([a-zA-Z0-9]+)\s*\\choose\s*([a-zA-Z0-9]+)\s*\}/g,
    "\\binom{$1}{$2}"
  );
}

function repairMathLiveTextLatexArtifacts(text: string) {
  return repairLegacyChooseNotation(repairJsonEscapedLatexCommands(text))
    .replace(
      /\\pmod\s*\{\s*\\?placeholder(?:\s*\{[^{}]*\})?\s*\}\s*(-?\d+)/g,
      "\\pmod{$1}"
    )
    .replace(/\\\\(?=[a-zA-Z])/g, "\\")
    .replace(/\\textasciicircum\s*circ\b/g, "^\\circ")
    .replace(/\\textasciicircum\s*/g, "^")
    .replace(/\\textasciitilde\b/g, "~")
    .replace(/\\textless\b/g, "<")
    .replace(/\\textgreater\b/g, ">")
    .replace(/\\lbrack(?![a-zA-Z])/g, "\\left[")
    .replace(/\\rbrack(?![a-zA-Z])/g, "\\right]")
    .replace(/(^|[^\\])\bleft\s*([([{|])/g, "$1\\left$2")
    .replace(/(^|[^\\])\bright\s*([\])}|])/g, "$1\\right$2")
    .replace(/(^|[^\\])\bfrac\s*\{/g, "$1\\frac{")
    .replace(/(^|[^\\])\bboxed\s*\{/g, "$1\\boxed{")
    .replace(/(^|[^\\])\btextbf\s*\{/g, "$1\\textbf{")
    .replace(/(^|[^\\])\bunderline\s*\{/g, "$1\\underline{")
    .replace(/(^|[^\\])\bhspace\s*\{/g, "$1\\hspace{")
    .replace(/(^|[^\\])\bsin\b/g, "$1\\sin")
    .replace(/\\isin\b/g, "\\in")
    .replace(/(\d+)\s*\\ang\b/g, "$1^\\circ")
    .replace(
      /\\placeholder(?:\[[^\]]*\])?(?:\s*\{[^{}]*\})?/g,
      "\\square"
    )
    .replace(/\\square\s*(?=\\(?:angle|overrightarrow|vec)\b)/g, "")
    .replace(/\\square\s*(?=\\(?:ldots|cdots)\b)/g, "")
    .replace(/\\pmod\s*\{\s*\\square\s*\}/gi, "\\pmod{\\phantom{0}}")
    .replace(/\(\s*mod\s*\\square\s*\)/gi, "\\pmod{\\phantom{0}}");
}

function unescapeMathLiveTextCommands(text: string) {
  return text
    .replace(/\\textbackslash(?:\s*\{\s*\})?/g, "\\")
    .replace(/\\textbraceleft(?:\s*\{\s*\})?/g, "{")
    .replace(/\\textbraceright(?:\s*\{\s*\})?/g, "}");
}

function removeEmptyTextCommands(expression: string) {
  return expression.replace(/\\text\s*\{\s*\}/g, "");
}

function stripMathLiveStyleCommands(value: string): string {
  let result = "";
  let index = 0;

  while (index < value.length) {
    const command = value.slice(index).match(/^\\(?:colorbox|textcolor)\b/);
    if (!command) {
      result += value[index];
      index += 1;
      continue;
    }

    const colorGroup = readLatexGroup(value, index + command[0].length);
    const contentGroup = colorGroup ? readLatexGroup(value, colorGroup.end) : null;
    if (!colorGroup || !contentGroup) {
      result += value[index];
      index += 1;
      continue;
    }

    result += stripMathLiveStyleCommands(contentGroup.content);
    index = contentGroup.end;
  }

  return result;
}

function normalizeMathLiveMath(expression: string) {
  return repairMathLiveTextLatexArtifacts(removeEmptyTextCommands(expression))
    .replace(/\\(?:textcolor|colorbox)\s*\{[^{}]*\}\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:mathopen|mathclose)\s*\{\s*\}/g, "")
    .replace(
      /\\(?:left|right|mleft|mright|bigl|bigr|Bigl|Bigr|biggl|biggr|Biggl|Biggr)\b/g,
      ""
    )
    .replace(/^\s*\\?\$\s*/, "")
    .replace(/\s*\\?\$\s*$/, "")
    .replace(/\\(?:cdot|times|ast|textasteriskcentered)(?![a-zA-Z])\s*/g, "*")
    .replace(/\\div\b/g, "/")
    .replace(/\\,/g, " ");
}

function unescapeMathLiveText(text: string) {
  return repairMathLiveTextLatexArtifacts(unescapeMathLiveTextCommands(text))
    .replace(/\\textasteriskcentered(?![a-zA-Z])/g, "*")
    .replace(/\\([{}#$%&_])/g, "$1")
    .replace(/\\ /g, " ")
    .replace(/~/g, " ");
}

function normalizeMathLiveDisplayMath(expression: string) {
  return stripMathLiveMathWrapperDollars(expression)
    .replace(/\\textasteriskcentered(?![a-zA-Z])/g, "\\cdot ")
    .replace(/[*]/g, "\\cdot ")
    .trim();
}

function normalizeMathLiveAsteriskCommand(value: string) {
  return value.replace(/\\textasteriskcentered(?![a-zA-Z])/g, "*");
}

function stripMathLiveDisplayWrapperDollars(text: string) {
  return text
    .trim()
    .replace(/^(?:\\\(\s*\\?\$\s*\\\)|\\?\$)\s*/, "")
    .replace(/\s*(?:\\\(\s*\\?\$\s*\\\)|\\?\$)$/, "")
    .trim();
}

function stripMathLiveMathWrapperDollars(expression: string) {
  return expression
    .trim()
    .replace(/^\s*\\?\$\s*/, "")
    .replace(/\s*\\?\$\s*$/, "")
    .trim();
}

type MathLiveSegment = { text: string; mode: "math" | "text" };

function splitMathLiveSegments(value: string): MathLiveSegment[] {
  const segments: MathLiveSegment[] = [];
  let index = 0;

  while (index < value.length) {
    const textCommandStart = value.indexOf("\\text", index);

    if (textCommandStart === -1) {
      segments.push({ text: value.slice(index), mode: "math" });
      break;
    }

    if (textCommandStart > index) {
      segments.push({ text: value.slice(index, textCommandStart), mode: "math" });
    }

    const textGroup = readLatexGroup(value, textCommandStart + "\\text".length);
    if (!textGroup) {
      segments.push({ text: value.slice(textCommandStart), mode: "math" });
      break;
    }

    segments.push({ text: textGroup.content, mode: "text" });
    index = textGroup.end;
  }

  return segments.filter((segment) => segment.text.length > 0);
}

export function mathLiveLatexToSubmitText(value: string) {
  const compact = normalizeMathLiveAsteriskCommand(
    removeEmptyTextCommands(stripMathLiveStyleCommands(value))
  );
  const segments = splitMathLiveSegments(compact);

  return segments
    .map((segment) =>
      segment.mode === "text"
        ? unescapeMathLiveText(segment.text)
        : normalizeMathLiveMath(segment.text)
    )
    .join("")
    .trim();
}

export function mathLiveLatexToMixedDisplay(value: string) {
  const compact = normalizeMathLiveAsteriskCommand(
    removeEmptyTextCommands(stripMathLiveStyleCommands(value))
  );
  const segments = splitMathLiveSegments(compact);

  for (let index = 1; index < segments.length - 1; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    const next = segments[index + 1];
    if (
      previous.mode === "text" &&
      current.mode === "math" &&
      next.mode === "text" &&
      /['\u2019]$/.test(previous.text) &&
      /^[a-zA-Z]$/.test(current.text.trim())
    ) {
      previous.text += current.text + next.text;
      segments.splice(index, 2);
      index -= 1;
    }
  }

  if (!segments.some((segment) => segment.mode === "text")) return null;

  const display = segments
    .map((segment) => {
      if (segment.mode === "text") {
        const text = unescapeMathLiveText(segment.text);
        const repairedText = repairCompactFractions(text.trim());
        const hasEscapedMathSignal = /\\[a-zA-Z]+|[=+\-*/^_{}0-9]/.test(repairedText);

        if (
          repairedText &&
          hasEscapedMathSignal &&
          isMathExpression(repairedText) &&
          !hasPlainProseWord(repairedText)
        ) {
          return `\\(${normalizeMathLiveDisplayMath(repairedText)}\\)`;
        }

        return text;
      }

      const math = normalizeMathLiveDisplayMath(segment.text);
      return math ? `\\(${math}\\)` : "";
    })
    .join("")
    .trim();

  return stripMathLiveDisplayWrapperDollars(display) || null;
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

function readLatexFractionRun(text: string, start: number) {
  const command = text.slice(start).match(/^\\[dt]?frac/);
  if (!command) return null;

  const numerator = readLatexGroup(text, start + command[0].length);
  const denominator = numerator ? readLatexGroup(text, numerator.end) : null;
  if (!numerator || !denominator) {
    const compact = text.slice(start).match(/^\\[dt]?frac[a-zA-Z0-9]{2}\b/);
    return compact?.[0] || null;
  }

  return text.slice(start, denominator.end);
}

function readLatexRootRun(text: string, start: number) {
  const command = text.slice(start).match(/^\\sqrt/);
  if (!command) return null;

  let index = start + command[0].length;
  while (/\s/.test(text[index] || "")) index += 1;

  if (text[index] === "[") {
    const close = text.indexOf("]", index + 1);
    if (close === -1) return null;
    index = close + 1;
  }

  const radicand = readLatexGroup(text, index);
  if (!radicand) return null;

  return text.slice(start, radicand.end);
}

function matchingOpenParen(text: string, closeIndex: number) {
  let depth = 0;

  for (let index = closeIndex; index >= 0; index -= 1) {
    if (text[index] === ")") depth += 1;
    if (text[index] === "(") depth -= 1;
    if (depth === 0) return index;
  }

  return -1;
}

function matchingCloseParen(text: string, openIndex: number) {
  let depth = 0;

  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    if (text[index] === ")") depth -= 1;
    if (depth === 0) return index;
  }

  return -1;
}

function balancedOuterParens(text: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return null;

  const closeIndex = matchingCloseParen(trimmed, 0);
  return closeIndex === trimmed.length - 1 ? trimmed.slice(1, -1).trim() : null;
}

function fractionAtomStart(text: string, slashIndex: number) {
  let index = slashIndex - 1;
  while (index >= 0 && /\s/.test(text[index])) index -= 1;
  if (index < 0) return -1;

  if (text[index] === ")") {
    return matchingOpenParen(text, index);
  }

  while (index >= 0 && /[a-zA-Z0-9_{}\\.^]/.test(text[index])) {
    index -= 1;
  }

  return index + 1;
}

function fractionAtomEnd(text: string, slashIndex: number) {
  let index = slashIndex + 1;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  if (index >= text.length) return -1;

  if (text[index] === "(") {
    return matchingCloseParen(text, index) + 1;
  }

  while (index < text.length && /[a-zA-Z0-9_{}\\.^]/.test(text[index])) {
    index += 1;
  }

  return index;
}

function convertSlashFractions(expression: string): string {
  const slashIndex = expression.indexOf("/");
  if (slashIndex === -1) return expression;

  const numeratorStart = fractionAtomStart(expression, slashIndex);
  const denominatorEnd = fractionAtomEnd(expression, slashIndex);
  if (numeratorStart < 0 || denominatorEnd <= slashIndex + 1) {
    return expression;
  }

  const before = expression.slice(0, numeratorStart);
  const numerator = expression.slice(numeratorStart, slashIndex).trim();
  const denominator = expression.slice(slashIndex + 1, denominatorEnd).trim();
  const after = expression.slice(denominatorEnd);
  const cleanNumerator = balancedOuterParens(numerator) || numerator;
  const cleanDenominator = balancedOuterParens(denominator) || denominator;

  return [
    convertSlashFractions(before),
    `\\frac{${convertSlashFractions(cleanNumerator)}}{${convertSlashFractions(cleanDenominator)}}`,
    convertSlashFractions(after),
  ].join("");
}

export function expressionToLatex(expression: string): string {
  const normalized = escapeBarePercent(repairCompactFractions(normalizeWordPlaceholders(repairMathLiveTextLatexArtifacts(removeEmptyTextCommands(expression)))))
    .trim()
    .replace(
      /^\d+(?:\^\{?\d+\}?)?(?:\s+\d+(?:\^\{?\d+\}?)?){1,}$/,
      (product) => product.replace(/\s+/g, "*")
    )
    .replace(/[\u2212\u2013\u2014]/g, "-")
    .replace(/\u00f7/g, "/")
    .replace(/[\u00d7\u00b7]/g, "*")
    .replace(/\\(?:cdot|times|ast|textasteriskcentered)(?![a-zA-Z])\s*/g, "*")
    .replace(/sqrt\s*\(([^()]+)\)/gi, "\\sqrt{$1}")
    .replace(/sqrt\s+([a-zA-Z0-9]+)/gi, "\\sqrt{$1}")
    .replace(/\u221a\s*\(?\s*([a-zA-Z0-9]+)\s*\)?/g, "\\sqrt{$1}")
    .replace(/\\le(?![a-zA-Z])/g, "\\leq")
    .replace(/\\ge(?![a-zA-Z])/g, "\\geq")
    .replace(/<=/g, "\\leq ")
    .replace(/>=/g, "\\geq ")
    .replace(/\\_([a-zA-Z0-9])/g, "_{$1}")
    .replace(/([a-zA-Z])_([a-zA-Z0-9]+)/g, "$1_{$2}")
    .replace(/\b([A-Z])(\d+)\b/g, "$1_{$2}")
    .replace(/\b([CP])\s*\(\s*([0-9]+)\s*,\s*([0-9]+)\s*\)/g, (_match, operator: string, n: string, r: string) =>
      operator === "C" ? `\\binom{${n}}{${r}}` : `P(${n},${r})`
    )
    .replace(/\^\(([^)]+)\)/g, "^{$1}")
    .replace(/\^\{([^}]+)\}/g, "^{$1}")
    .replace(/\^([a-zA-Z0-9]+)/g, "^{$1}");

  const rendered = normalized
    .replace(
      /\\text\{([^}]+)\}\s*\/\s*\\text\{([^}]+)\}/g,
      "\\frac{\\text{$1}}{\\text{$2}}"
    )
    .replace(/.+/, (current) => convertSlashFractions(current))
    .replace(
      /\b([a-zA-Z0-9]+(?:_\{[a-zA-Z0-9+\-]+\})?(?:\^\{[^}]+\})?)\s*\/\s*([a-zA-Z0-9]+(?:_\{[a-zA-Z0-9+\-]+\})?(?:\^\{[^}]+\})?)\b/g,
      "\\frac{$1}{$2}"
    )
    .replace(/[*]/g, "\\cdot ");

  return forceDisplayStyleForBoundedSums(rendered);
}

function forceDisplayStyleForBoundedSums(expression: string) {
  const hasBoundedSum = /\\sum\s*(?:_\s*\{[^{}]*\}\s*\^\s*\{[^{}]*\}|\^\s*\{[^{}]*\}\s*_\s*\{[^{}]*\})/.test(
    expression
  );

  return hasBoundedSum && !/^\\displaystyle\b/.test(expression.trimStart())
    ? `\\displaystyle ${expression}`
    : expression;
}

function repairMalformedCoachLatex(expression: string) {
  return repairCompactFractions(repairMathLiveTextLatexArtifacts(removeEmptyTextCommands(expression)))
    .replace(/\\boldsymbol\s*\{\s*\\times\s*\}/g, "\\times")
    .replace(/\\boxed\s*\{\s*\\text\s*\{\s*_+\s*\}\s*\}/g, "\\boxed{\\phantom{000}}")
    .replace(/\\text\s*\{\s*_{2,}\s*\}/g, "\\underline{\\phantom{000}}")
    .replace(/\\_([a-zA-Z0-9])/g, "_{$1}")
    .replace(/(^|[^\\])\bfrac\s*\{/g, "$1\\frac{")
    .replace(/(^|[^\\])\bcdot\b/g, "$1\\cdot")
    .replace(/(^|[^\\])\btimes\b/g, "$1\\times")
    .replace(/(?<=[0-9}])times(?=[0-9a-zA-Z\\{])/g, "\\times ")
    .replace(/(^|[^\\])\btext\s*\{/g, "$1\\text{")
    .replace(/(^|[^\\a-zA-Z])ext\s*\{/g, "$1\\text{")
    .replace(/\\big\s*\|/g, "\\mid ")
    .replace(/\\cdot\s*\(\s*text([a-zA-Z]+)\s*\)/g, "\\cdot \\text{$1}")
    .replace(/\btext(num|den|area|length|width)\b/g, "\\text{$1}");
}

export function inlineLatexForDisplay(expression: string, source?: "coach" | "student") {
  const repairedExpression = (source === "coach"
    ? repairMalformedCoachLatex(expression)
    : repairCompactFractions(repairMathLiveTextLatexArtifacts(removeEmptyTextCommands(expression)))
        .replace(/\\textasteriskcentered(?![a-zA-Z])/g, "\\cdot "))
    .replace(/\\\(|\\\)/g, "")
    .replace(/[\u00d7\u00b7]\s*/g, "\\cdot ")
    .replace(/[\u2212\u2013\u2014]/g, "-");

  if (source === "coach" && /\b[a-zA-Z]+(?:_[a-zA-Z]+)+\b|%/.test(expression)) {
    return expressionToLatex(repairedExpression);
  }

  return forceDisplayStyleForBoundedSums(repairedExpression);
}

function isMathExpression(text: string) {
  const compact = text.replace(/\s+/g, "");
  if (/^\\(?:spadesuit|heartsuit|diamondsuit|clubsuit|star|bigstar|diamond|blacklozenge|lozenge)$/.test(compact)) {
    return true;
  }
  if (/\\star/.test(compact) && /[a-zA-Z0-9]/.test(compact)) return true;
  if (/^(?:\d+(?:\.\d+)?)?\\pi(?:\^\{?[-a-zA-Z0-9]+\}?)?$/.test(compact)) return true;
  if (/\\(?:leq?|geq?)(?![a-zA-Z])/.test(compact) && /[a-zA-Z0-9]/.test(compact)) return true;

  return (
    /^\\[dt]?frac\s*\{[^{}]+\}\s*\{[^{}]+\}/.test(compact) ||
    /^[CP]\(\d+,\d+\)$/.test(compact) ||
    /^(?:sqrt|\\sqrt|\u221a)/i.test(compact) ||
    /^-?\d+(?:\.\d+)?\\?%$/.test(compact) ||
    /^-?\d+(?:\.\d+)?$/.test(compact) ||
    /^[a-zA-Z]$/.test(compact) ||
    /^[a-zA-Z]_\{[a-zA-Z0-9]+\}$/.test(compact) ||
    /^[a-zA-Z]{1,3}(?:_[a-zA-Z0-9]+|\^\{?[-a-zA-Z0-9]+\}?|\d+)?$/.test(compact) ||
    /^[A-Z](?:_[a-zA-Z0-9]+|_\{[a-zA-Z0-9]+\}|\d+)$/.test(compact) ||
    (/[=^_*/+\-\u2212\u00d7\u00f7×÷·]/.test(compact) && /[a-zA-Z0-9]/.test(compact))
  );
}

function isWordChar(char: string | undefined) {
  return Boolean(char && /[a-zA-Z]/.test(char));
}

function hasMathRunBoundaries(text: string, start: number, value: string) {
  const first = value.trimStart()[0];
  const last = value.trimEnd().at(-1);
  const before = text[start - 1];
  const after = text[start + value.length];

  if (isWordChar(first) && isWordChar(before)) return false;
  if (isWordChar(last) && isWordChar(after)) return false;

  return true;
}

function startsWithSpacedLowercaseWordOperation(value: string) {
  return /^[a-z]{2,3}\s+[+\-\u2212\u2013\u2014*/\u00d7\u00f7\u00b7]/.test(value.trimStart());
}

function hasPlainProseWord(value: string) {
  const scrubbed = value
    .replace(/\\prime\b/g, " ")
    .replace(/\b[a-zA-Z]+_\{[a-zA-Z0-9]+\}/g, " ")
    .replace(/\\[a-zA-Z]+(?:\s*\{[^{}]*\})*/g, " ")
    .replace(/\b[a-zA-Z]+(?:_[a-zA-Z]+)+\b/g, " ");

  return /\b[a-zA-Z]{4,}\b/.test(scrubbed);
}

function trimMathRunBeforeProseOperation(value: string) {
  const proseOperation = value.match(/\s+by\s+/i);
  return proseOperation?.index === undefined
    ? value
    : value.slice(0, proseOperation.index).trimEnd();
}

function readImplicitPrimePowerProduct(text: string, start: number) {
  const match = text.slice(start).match(
    /^\d+(?:\^\{?\d+\}?)?(?:\s+\d+(?:\^\{?\d+\}?)?){1,}/
  );

  return match?.[0] &&
    /\^/.test(match[0]) &&
    hasMathRunBoundaries(text, start, match[0])
    ? match[0].trimEnd()
    : null;
}

function readMathRun(text: string, start: number) {
  const numericSequenceRun = text.slice(start).match(
    /^\d+(?:\s*,\s*\d+){1,}\s*,?\s*\\(?:ldots|cdots)\b/
  );
  if (
    numericSequenceRun?.[0] &&
    hasMathRunBoundaries(text, start, numericSequenceRun[0])
  ) {
    return numericSequenceRun[0].trimEnd();
  }

  const floorAssignmentRun = text.slice(start).match(
    /^[a-zA-Z](?:_\{[^{}\r\n]+\}|_[a-zA-Z0-9]+)?\s*=\s*(?:\\left\s*)?\\lfloor\s*[^,\r\n]+?\s*(?:\\right\s*)?\\rfloor(?:\s*,\s*[a-zA-Z](?:_\{[^{}\r\n]+\}|_[a-zA-Z0-9]+)?\s*=\s*[a-zA-Z0-9_{}+\-*/^\s]+)*/
  );
  if (
    floorAssignmentRun?.[0] &&
    hasMathRunBoundaries(text, start, floorAssignmentRun[0])
  ) {
    return floorAssignmentRun[0].trimEnd();
  }

  const setMembershipRun = text.slice(start).match(
    /^[a-zA-Z](?:_\{[^{}\r\n]+\}|_[a-zA-Z0-9]+)?\s*\\in\s*(?:\\lbrace\s*[^\r\n]+?\s*\\rbrace|\{[^{}\r\n]+\})/
  );
  if (
    setMembershipRun?.[0] &&
    hasMathRunBoundaries(text, start, setMembershipRun[0])
  ) {
    return setMembershipRun[0].trimEnd();
  }

  const tuple = String.raw`\(\s*[-a-zA-Z0-9.]+(?:\s*,\s*[-a-zA-Z0-9.]+)+\s*\)`;
  const transitionValue = String.raw`(?:\\[dt]?frac\s*(?:\{[^{}]+\}\s*\{[^{}]+\}|[a-zA-Z0-9]\s*[a-zA-Z0-9])|-?\d+(?:\.\d+)?)`;
  const tupleTransition = String.raw`${tuple}\s*\\rightarrow\s*${tuple}\s*=\s*${transitionValue}`;
  const tupleTransitionRun = text.slice(start).match(
    new RegExp(`^${tupleTransition}(?:\\s*;\\s*${tupleTransition})*`)
  );
  if (
    tupleTransitionRun?.[0] &&
    hasMathRunBoundaries(text, start, tupleTransitionRun[0])
  ) {
    return tupleTransitionRun[0].trimEnd();
  }

  const compoundSubscriptFractionEquation = text.slice(start).match(
    /^[a-zA-Z]_\{[^{}\r\n]+\}\s*=\s*\\[dt]?frac\s*\{[^{}\r\n]+\}\s*\{[^{}\r\n]+\}/
  );
  if (
    compoundSubscriptFractionEquation?.[0] &&
    hasMathRunBoundaries(text, start, compoundSubscriptFractionEquation[0])
  ) {
    return compoundSubscriptFractionEquation[0].trimEnd();
  }

  const similarityRun = text.slice(start).match(
    /^(?:\\triangle\s*)?[A-Z]{3}\s*\\sim(?:\s*(?:\\triangle\s*)?[A-Z]{3}(?:\s*\\sim\s*(?:\\triangle\s*)?[A-Z]{3})*)?/
  );
  if (
    similarityRun?.[0] &&
    hasMathRunBoundaries(text, start, similarityRun[0])
  ) {
    return similarityRun[0].trimEnd();
  }

  const binomialRun = text.slice(start).match(
    /^\\binom\s*\{[^{}]+\}\s*\{[^{}]+\}/
  );
  if (
    binomialRun?.[0] &&
    hasMathRunBoundaries(text, start, binomialRun[0])
  ) {
    return binomialRun[0].trimEnd();
  }

  const parallelRun = text.slice(start).match(
    /^[A-Z]{1,4}\s*\\parallel\s*[A-Z]{1,4}\b/
  );
  if (
    parallelRun?.[0] &&
    hasMathRunBoundaries(text, start, parallelRun[0])
  ) {
    return parallelRun[0].trimEnd();
  }

  const correspondenceRun = text.slice(start).match(
    /^[A-Z]{1,4}\s*\\leftrightarrow\s*[A-Z]{1,4}\b/
  );
  if (
    correspondenceRun?.[0] &&
    hasMathRunBoundaries(text, start, correspondenceRun[0])
  ) {
    return correspondenceRun[0].trimEnd();
  }

  const perpendicularRun = text.slice(start).match(
    /^[A-Z]{1,4}\s*\\perp\s*[A-Z]{1,4}\b/
  );
  if (
    perpendicularRun?.[0] &&
    hasMathRunBoundaries(text, start, perpendicularRun[0])
  ) {
    return perpendicularRun[0].trimEnd();
  }

  const angleAtom = String.raw`\\angle\s*[A-Z]{3}`;
  const angleScalar = String.raw`(?:-?\d+(?:\.\d+)?|[a-zA-Z](?:_\{?[a-zA-Z0-9]+\}?)?)`;
  const angleTerminal = String.raw`${angleScalar}(?:\s*[+\-]\s*${angleScalar})*(?:\^\\circ)?`;
  const scaledAngleAtom = String.raw`(?:\d+(?:\.\d+)?\s*)?${angleAtom}`;
  const angleOperand = String.raw`(?:${scaledAngleAtom}|${angleTerminal})`;
  const angleEquation = String.raw`(?:[a-zA-Z]\s*=\s*${angleAtom}|${scaledAngleAtom}(?:\s*=\s*${angleOperand})+)`;
  const angleRun = text.slice(start).match(
    new RegExp(`^(?:${angleEquation})(?:\\s*,\\s*(?:${angleEquation}))*`)
  );
  if (
    angleRun?.[0] &&
    hasMathRunBoundaries(text, start, angleRun[0])
  ) {
    return angleRun[0].trimEnd();
  }

  const standaloneAngle = text.slice(start).match(
    /^\\angle\s*[A-Z]{3}/
  );
  if (
    standaloneAngle?.[0] &&
    hasMathRunBoundaries(text, start, standaloneAngle[0])
  ) {
    return standaloneAngle[0].trimEnd();
  }

  const absoluteRelationRun = text.slice(start).match(
    /^\|[^|\r\n]+\|\s*(?:\\(?:leq?|geq?)|<=|>=|≤|≥)\s*[^\r\n.!?]*\|[^|\r\n]+\|/
  );
  if (
    absoluteRelationRun?.[0] &&
    hasMathRunBoundaries(text, start, absoluteRelationRun[0])
  ) {
    return absoluteRelationRun[0].trimEnd();
  }

  const assignmentFraction = String.raw`\\[dt]?frac\s*(?:\{[^{}]+\}\s*\{[^{}]+\}|[a-zA-Z0-9]\s*[a-zA-Z0-9])`;
  const assignmentAtom = String.raw`(?:${assignmentFraction}|\\sqrt\s*\{[^{}]+\}|[-+]?\d+(?:\.\d+)?|[a-zA-Z])`;
  const compactAssignmentRun = text.slice(start).match(
    new RegExp(`^[a-zA-Z]\\s*=\\s*${assignmentAtom}(?:\\s*[a-zA-Z])?(?:\\s*[+\\-*/^]\\s*${assignmentAtom})*`)
  );
  if (
    compactAssignmentRun?.[0] &&
    hasMathRunBoundaries(text, start, compactAssignmentRun[0])
  ) {
    return compactAssignmentRun[0].trimEnd();
  }

  const vectorSymbol = String.raw`\\(?:vec|overrightarrow)\s*\{[^{}]+\}`;
  const vectorAssignment = String.raw`${vectorSymbol}\s*=\s*\[[^\]\r\n]+\]`;
  const vectorRun = text.slice(start).match(
    new RegExp(`^(?:${vectorAssignment})(?:\\s*,\\s*${vectorAssignment})*`)
  );
  if (
    vectorRun?.[0] &&
    hasMathRunBoundaries(text, start, vectorRun[0])
  ) {
    return vectorRun[0].trimEnd();
  }


  const standaloneVector = text.slice(start).match(
    new RegExp(`^${vectorSymbol}`)
  );
  if (
    standaloneVector?.[0] &&
    hasMathRunBoundaries(text, start, standaloneVector[0])
  ) {
    return standaloneVector[0].trimEnd();
  }

  const congruenceRun = text.slice(start).match(
    /^(?:[A-Za-z](?:_\{[A-Za-z0-9]+\}|_[A-Za-z0-9]+|\d+)?|\\?[A-Za-z]+)\s*\\equiv\s*[^\r\n.!?]+/
  );
  if (
    congruenceRun?.[0] &&
    hasMathRunBoundaries(text, start, congruenceRun[0])
  ) {
    return congruenceRun[0].trimEnd();
  }

  const latexOperatorSymbol = text.slice(start).match(
    /^\\(?:spadesuit|heartsuit|diamondsuit|clubsuit|star|bigstar|diamond|blacklozenge|lozenge)(?![a-zA-Z])/
  );
  if (
    latexOperatorSymbol?.[0] &&
    hasMathRunBoundaries(text, start, latexOperatorSymbol[0])
  ) {
    return latexOperatorSymbol[0];
  }

  const modularCongruenceRun = text.slice(start).match(
    /^[A-Za-z](?:_\{?[A-Za-z0-9]+\}?|\d)?(?:\s*[+\-]\s*[A-Za-z](?:_\{?[A-Za-z0-9]+\}?|\d)?)*\s*\\equiv\s*-?\d+(?:\s*\\pmod\s*\{\s*\d+\s*\}|\s*\(\s*mod\s+\d+\s*\))/i
  );
  if (
    modularCongruenceRun?.[0] &&
    hasMathRunBoundaries(text, start, modularCongruenceRun[0])
  ) {
    return modularCongruenceRun[0].trimEnd();
  }

  const latexFraction = String.raw`\\[dt]?frac\s*\{\s*[^{}\r\n]+\s*\}\s*\{\s*[^{}\r\n]+\s*\}`;
  const balancedLatexFraction = readLatexFractionRun(text, start);
  if (
    balancedLatexFraction &&
    !hasPlainProseWord(balancedLatexFraction) &&
    hasMathRunBoundaries(text, start, balancedLatexFraction)
  ) {
    return balancedLatexFraction.trimEnd();
  }

  const latexRoot = readLatexRootRun(text, start);
  if (
    latexRoot &&
    !hasPlainProseWord(latexRoot) &&
    hasMathRunBoundaries(text, start, latexRoot)
  ) {
    return latexRoot.trimEnd();
  }

  const implicitPrimePowerProduct = readImplicitPrimePowerProduct(text, start);
  if (implicitPrimePowerProduct) return implicitPrimePowerProduct;

  const localMathRun = text.slice(start).match(
    /^(?:(?:[CP]\s*\(\s*\d+\s*,\s*\d+\s*\)|-?\d+(?:\.\d+)?!?)(?:\s*(?:\\cdot|\\times|\\ast|[*])\s*(?:[CP]\s*\(\s*\d+\s*,\s*\d+\s*\)|-?\d+(?:\.\d+)?!?))+|[CP]\s*\(\s*\d+\s*,\s*\d+\s*\))/
  );
  if (
    localMathRun?.[0] &&
    /\d/.test(localMathRun[0]) &&
    !hasPlainProseWord(localMathRun[0]) &&
    hasMathRunBoundaries(text, start, localMathRun[0])
  ) {
    return localMathRun[0].trimEnd();
  }

  const starMathRun = text.slice(start).match(
    /^(?:\([^()]*\\star[^()]*\)|[a-zA-Z](?:_\{[a-zA-Z0-9]+\}|_[a-zA-Z0-9]+|\^\{?[-a-zA-Z0-9]+\}?|\d+)?)(?:\s*(?:=|\\star)\s*(?:\([^()]*\\star[^()]*\)|[a-zA-Z](?:_\{[a-zA-Z0-9]+\}|_[a-zA-Z0-9]+|\^\{?[-a-zA-Z0-9]+\}?|\d+)?))+/
  );
  if (
    starMathRun?.[0] &&
    hasMathRunBoundaries(text, start, starMathRun[0])
  ) {
    return starMathRun[0].trimEnd();
  }

  const exponent = String.raw`\^(?:\{(?:\\prime|[-a-zA-Z0-9]+)\}|\\prime|[-a-zA-Z0-9]+)`;
  const variable = String.raw`[a-zA-Z](?:_\{[a-zA-Z0-9+\-]+\}|_[a-zA-Z0-9]+|${exponent}|\d+)?`;
  const variableProduct = String.raw`[a-zA-Z]{2,4}(?:_\{[a-zA-Z0-9+\-]+\}|_[a-zA-Z0-9]+|${exponent}|\d+)?`;
  const number = String.raw`\d+(?:\.\d+)?(?:\\?%)?`;
  const latexConstant = String.raw`(?:${number})?\\pi(?:${exponent})?`;
  const coefficientVariable = String.raw`${number}(?:${variableProduct}|${variable})`;
  const parenExpression = String.raw`\([^()]*(?:[=+\-\u2212\u2013\u2014*/\u00d7\u00f7\u00b7^]|\\(?:leq?|geq?))[^()]*\)`;
  const latexRootAtom = String.raw`\\sqrt\s*(?:\[\s*[-a-zA-Z0-9]+\s*\])?\s*\{\s*[^{}]+\s*\}`;
  const latexFractionAtom = String.raw`${latexFraction}${variable}?`;
  const atom = String.raw`(?:${latexFractionAtom}|${latexRootAtom}|${latexConstant}|\\?sqrt\s*(?:\([^()]+\)|[a-zA-Z0-9]+)|\u221a\s*\(?\s*[a-zA-Z0-9]+\s*\)?|${coefficientVariable}|${variableProduct}|${variable}|${number}|${parenExpression})`;
  const operator = String.raw`(?:<=|>=|\u2264|\u2265|=|\\(?:leq?|geq?|cdot|times|ast)(?![a-zA-Z])\s*|[+\-\u2212\u2013\u2014*/\u00d7\u00f7\u00b7^])`;
  const expressionPattern = new RegExp(`${atom}(?:\\s*${operator}\\s*${atom})+`, "y");
  const standalonePattern = new RegExp(
    String.raw`(?:${latexFraction}|${latexRootAtom}|${latexConstant}|\\?sqrt\s*(?:\([^()]+\)|[a-zA-Z0-9]+)|\u221a\s*\(?\s*[a-zA-Z0-9]+\s*\)?|[+\-\u2212\u2013\u2014]\s*${number}\b|\b${number}(?![a-zA-Z0-9])|[a-zA-Z]_\{[a-zA-Z0-9+\-]+\}|\b(?:[A-Z](?:_[a-zA-Z0-9]+|\d+)|[xynmpq])\b)`,
    "y"
  );

  expressionPattern.lastIndex = start;
  const expressionMatch = expressionPattern.exec(text);

  if (
    expressionMatch?.[0] &&
    isMathExpression(expressionMatch[0]) &&
    !startsWithSpacedLowercaseWordOperation(expressionMatch[0]) &&
    hasMathRunBoundaries(text, start, expressionMatch[0])
  ) {
    return expressionMatch[0].trimEnd();
  }

  standalonePattern.lastIndex = start;
  const standaloneMatch = standalonePattern.exec(text);

  if (
    standaloneMatch?.[0] &&
    isMathExpression(standaloneMatch[0]) &&
    hasMathRunBoundaries(text, start, standaloneMatch[0])
  ) {
    return standaloneMatch[0].trimEnd();
  }

  return null;
}

function readBalancedArithmeticRun(text: string, start: number) {
  if (!/[0-9(\\\u221a]/.test(text[start] || "")) return null;
  if (/^\\angle\b/.test(text.slice(start))) return null;

  let index = start;
  let depth = 0;
  let hasOperator = false;
  let hasDigit = false;

  while (index < text.length) {
    const char = text[index];
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth < 0) break;
      if (depth === 0 && /^\s+[a-zA-Z]{2,}\b/.test(text.slice(index + 1))) {
        index += 1;
        break;
      }
    }
    if (/[=+\-*/^×÷·\u2212\u00d7\u00f7]/.test(char)) hasOperator = true;
    if (/\d/.test(char)) hasDigit = true;

    if (!/[a-zA-Z0-9_\\{}().!\s=+\-*/^%×÷·\u2212\u00d7\u00f7]/.test(char)) break;
    index += 1;
  }

  const candidate = trimMathRunBeforeProseOperation(
    text.slice(start, index).trimEnd()
  );
  if (
    depth === 0 &&
    hasOperator &&
    hasDigit &&
    isMathExpression(candidate) &&
    !hasPlainProseWord(candidate) &&
    hasMathRunBoundaries(text, start, candidate)
  ) {
    return candidate;
  }

  return null;
}

export function splitPlainMath(text: string): MathTextPart[] {
  text = repairMathLiveTextLatexArtifacts(text);
  const descriptiveEquation = text.match(
    /^([a-zA-Z][a-zA-Z ]{3,}\s*=\s*)(.+)$/
  );
  if (
    descriptiveEquation &&
    /\\(?:pi|[dt]?frac|sqrt)\b|\d\s*[+\-*/^]/.test(descriptiveEquation[2])
  ) {
    return [
      { text: descriptiveEquation[1], math: false },
      ...splitPlainMath(descriptiveEquation[2]),
    ];
  }
  const parts: MathTextPart[] = [];
  let index = 0;

  while (index < text.length) {
    const mathRun =
      readImplicitPrimePowerProduct(text, index) ||
      readBalancedArithmeticRun(text, index) ||
      readMathRun(text, index);

    if (mathRun) {
      parts.push({ text: mathRun, math: true });
      index += mathRun.length;
      continue;
    }

    const nextMathStart = text
      .slice(index + 1)
      .search(/(?:\\(?:angle|triangle|leftrightarrow|overrightarrow|vec|binom)\b|\\[dt]?frac|\\?sqrt|\u221a|[+\-\u2212\u2013\u2014]\s*\d+(?:\.\d+)?\b|[a-zA-Z]_\{[a-zA-Z0-9]+\}|[A-Z](?:_[a-zA-Z0-9]+|\d+)|\b\d+(?:\.\d+)?\b|\b[xynmpq]\b|[a-zA-Z0-9(])/);
    const nextIndex = nextMathStart === -1 ? text.length : index + 1 + nextMathStart;

    parts.push({ text: text.slice(index, nextIndex), math: false });
    index = nextIndex;
  }

  return parts;
}

function isLatexDelimiterStart(text: string, index: number, mode: "strict" | "loose") {
  const before = text[index - 1];
  const after = text[index + 1];
  const afterNonSpace = text.slice(index + 1).match(/\S/)?.[0];

  if (mode === "loose") {
    return (
      text[index] === "$" &&
      after !== "$" &&
      Boolean(afterNonSpace) &&
      !/[a-zA-Z0-9]/.test(before || "")
    );
  }

  const nextDollar = text.indexOf("$", index + 1);
  const numericLatexSpan =
    nextDollar !== -1 &&
    /\d/.test(afterNonSpace || "") &&
    /\\[a-zA-Z]+/.test(text.slice(index + 1, nextDollar));

  return (
    text[index] === "$" &&
    after !== "$" &&
    Boolean(afterNonSpace) &&
    (!/\d/.test(afterNonSpace || "") || numericLatexSpan) &&
    !/[a-zA-Z0-9]/.test(before || "")
  );
}

function isLatexDelimiterEnd(text: string, index: number) {
  const before = text[index - 1];
  const beforeNonSpace = text.slice(0, index).match(/\S(?=\s*$)/)?.[0];
  const after = text[index + 1];

  return (
    text[index] === "$" &&
    before !== "$" &&
    Boolean(beforeNonSpace) &&
    !/[a-zA-Z0-9]/.test(after || "")
  );
}

function looksLikeProseInsideLatex(expression: string) {
  const withoutLatexCommands = expression.replace(/\\[a-zA-Z]+(?:\s*\{[^{}]*\})*/g, " ");
  const proseWords = withoutLatexCommands.match(/\b[a-zA-Z]{2,}\b/g) || [];
  const mathSignals = /[=+\-*/^_\\{}0-9]/.test(expression);

  return proseWords.length >= 2 || (proseWords.length >= 1 && !mathSignals);
}

function stripMalformedDollarText(text: string) {
  return text.replace(/\$/g, "");
}

function cleanPlainLatexArtifacts(text: string) {
  return text
    .replace(/\\[,;:! ]/g, "")
    .replace(/\\[()[\]]/g, "");
}

function repairPluralizedDollarMath(text: string) {
  return text.replace(/\$([^$\r\n]+)\$s\b/g, (match, expression: string) => {
    const withoutCommands = expression.replace(/\\[a-zA-Z]+/g, "");
    return /\d/.test(expression) && !/[a-zA-Z]{2,}/.test(withoutCommands)
      ? `\\(${expression}\\)s`
      : match;
  });
}

function repairAttachedDollarExponent(text: string) {
  return text.replace(
    /([a-zA-Z0-9)])\$\s*(\^\{?[-a-zA-Z0-9]+\}?)\s*\$/g,
    "$1\\($2\\)"
  );
}

function repairUndelimitedAlignmentEnvironments(text: string) {
  return text.replace(
    /\\begin\s*\{\s*align\*?\s*\}([\s\S]*?)\\end\s*\{\s*align\*?\s*\}/gi,
    (_match, body: string) =>
      `\\(${body
        .replace(/\\\\/g, "\\qquad ")
        .replace(/&\s*/g, "")
        .trim()}\\)`
  );
}

function wrapUndelimitedSizedFenceMath(text: string) {
  return text.replace(
    /\\left\s*([\[(])([\s\S]*?)\\right\s*([\])])/g,
    (match, open: string, body: string, close: string, offset: number) => {
      const prefix = text.slice(0, offset);
      const braceDepth = [...prefix].reduce((depth, char) => {
        if (char === "{") return depth + 1;
        if (char === "}") return Math.max(0, depth - 1);
        return depth;
      }, 0);
      if (braceDepth > 0) return match;

      return `\\(\\left${open}${repairMathLiveTextLatexArtifacts(body)}\\right${close}\\)`;
    }
  );
}

export function splitExplicitLatex(text: string, mode: "strict" | "loose"): MathTextPart[] {
  text = wrapUndelimitedSizedFenceMath(
    repairUndelimitedAlignmentEnvironments(repairJsonEscapedLatexCommands(text))
  );
  text = repairAttachedDollarExponent(text);
  if (mode === "loose") {
    text = repairPluralizedDollarMath(text);
  }
  const parts: MathTextPart[] = [];
  let index = 0;

  while (index < text.length) {
    const dollarStart = text.indexOf("$", index);
    const parenStart = text.indexOf("\\(", index);
    const bracketStart = text.indexOf("\\[", index);
    const starts = [dollarStart, parenStart, bracketStart].filter((candidate) => candidate !== -1);
    const start = starts.length ? Math.min(...starts) : -1;

    if (start === -1) {
      parts.push({ text: cleanPlainLatexArtifacts(text.slice(index)), math: false });
      break;
    }

    const isParenDelimiter = text.startsWith("\\(", start);
    const isBracketDelimiter = text.startsWith("\\[", start);
    const isEscapedDelimiter = isParenDelimiter || isBracketDelimiter;

    if (!isEscapedDelimiter && !isLatexDelimiterStart(text, start, mode)) {
      parts.push({ text: cleanPlainLatexArtifacts(text.slice(index, start + 1)), math: false });
      index = start + 1;
      continue;
    }

    let end = -1;
    if (isEscapedDelimiter) {
      end = text.indexOf(isBracketDelimiter ? "\\]" : "\\)", start + 2);
    } else {
      end = start + 1;
      while (end < text.length && !isLatexDelimiterEnd(text, end)) {
        end = text.indexOf("$", end + 1);
        if (end === -1) break;
      }
    }

    if (end === -1) {
      parts.push({
        text: mode === "loose"
          ? cleanPlainLatexArtifacts(stripMalformedDollarText(text.slice(index)))
          : cleanPlainLatexArtifacts(text.slice(index)),
        math: false,
      });
      break;
    }

    if (start > index) {
      parts.push({ text: cleanPlainLatexArtifacts(text.slice(index, start)), math: false });
    }

    const expression = text.slice(start + (isEscapedDelimiter ? 2 : 1), end).trim();
    if (looksLikeProseInsideLatex(expression)) {
      parts.push({
        text: isEscapedDelimiter
          ? cleanPlainLatexArtifacts(expression)
          : cleanPlainLatexArtifacts(stripMalformedDollarText(text.slice(start, end + 1))),
        math: false,
      });
    } else {
      parts.push({ text: expression, math: true });
    }
    index = end + (isEscapedDelimiter ? 2 : 1);
  }

  return parts;
}
