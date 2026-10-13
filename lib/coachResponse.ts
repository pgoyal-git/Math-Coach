import type { VerificationResult } from "@/lib/coachVerifier";
import { normalizeStudentProseTypos } from "@/lib/coach-verifier/typos";

type CoachResponseContext = {
  hintLevel?: number;
  problem?: string;
  acceptedLines?: string[];
  previousAssistantMessages?: string[];
  lastValidLine?: string | null;
  recentRejectedLines?: string[];
  studentMessage?: string;
};

function studentFacing(text: string) {
  return text
    .replace(/^the student suggests\s+/i, "You suggest ")
    .replace(/^the student says\s+/i, "You say ")
    .replace(/^the student claims\s+/i, "You claim ")
    .replace(/^the student wrote\s+/i, "You wrote ")
    .replace(/^the student correctly\s+/i, "You correctly ")
    .replace(/^the student\s+/i, "You ")
    .replace(/\bthe student\b/gi, "you");
}

function normalizeForRepeatCheck(text: string) {
  return text
    .toLowerCase()
    .replace(/\$[^$]*\$/g, "$math$")
    .replace(/[^a-z0-9$]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wasRecentlySaid(text: string, context?: CoachResponseContext) {
  const normalized = normalizeForRepeatCheck(text);
  if (!normalized) return false;

  return (context?.previousAssistantMessages || []).some((message) => {
    const recent = normalizeForRepeatCheck(message);
    return recent === normalized || recent.includes(normalized) || normalized.includes(recent);
  });
}

function looksLikeSolutionDump(text: string) {
  return (
    text.length > 160 ||
    (text.match(/=/g)?.length || 0) >= 2 ||
    /\bso the expression equals\b/i.test(text) ||
    /\bfinal answer\b/i.test(text)
  );
}

function looksTooSpecificForPositiveFeedback(text: string) {
  return (
    text.length > 120 ||
    (text.match(/\^|=|\//g)?.length || 0) >= 2 ||
    /\bfactor(?:ed|ing)? out\b/i.test(text) ||
    /\bsimplif(?:y|ied|ying)\b/i.test(text) ||
    /\bcancel(?:ed|ing)?\b/i.test(text) ||
    /\bfrom the numerator\b/i.test(text) ||
    /\bfrom the denominator\b/i.test(text)
  );
}

function modelNextCheckRevealsNextResult(text: string) {
  return (
    /\b(?:write|set\s*up|form|give|provide|send)\b[\s\S]{0,100}\b(?:second|another|additional|other|remaining)\b[\s\S]{0,100}\bequation\b[\s\S]{0,160}(?:\$[^$]*=|\b\d+(?:\.\d+)?\s*=|\b[A-Za-z]\s*=)/i.test(
      text
    ) ||
    /\bdivide\b[\s\S]{0,80}\b(?:entire\s+)?equation\b[\s\S]{0,80}\bby\s+\$?-?\d+(?:\.\d+)?\$?/i.test(
      text
    ) ||
    /\b(?:modular arithmetic|modulo)\b[\s\S]{0,120}\bmod(?:ulo)?\s+\$?-?\d+\$?/i.test(
      text
    ) ||
    /\(\s*(?:for example|e\.g\.|i\.e\.)[\s\S]{0,180}(?:\$[^$]*=|[A-Za-z]\s*=|\\frac|\\sqrt|\\cos|\\sin)/i.test(
      text
    ) ||
    /\b(?:for example|e\.g\.)[\s\S]{0,140}\b(?:state|write)\b[\s\S]{0,100}(?:\$[^$]*=|[A-Za-z]\s*=|\\frac|\\sqrt|\\cos|\\sin)/i.test(
      text
    ) ||
    /\bwrite\s+the\s+next\s+line\b[\s\S]{0,120}\b[A-Za-z]\s*=\s*\$?[-+*/()\\{}\w\s^=.]+\$?/i.test(
      text
    ) ||
    /\b(?:set\s+the\s+exponents\s+equal|exponents?\s+equal)\b[\s\S]{0,120}\bwrite\s+the\s+equation\b[\s\S]{0,160}(?:\$[^$]*=|[A-Za-z0-9][^.!?]{0,120}=)/i.test(
      text
    ) ||
    /\b(?:simplify|reduce|evaluate|compute|isolate|solve|rewrite)\b[\s\S]{0,120}\bto\s+\$?[-+*/()\\{}\w\s^=.]+\$?/i.test(
      text
    ) ||
    /\b(?:which gives|giving|you get|get)\s+\$?[-+*/()\\{}\w\s^=.]+\$?/i.test(text) ||
    /\b(?:compute|evaluate|use|using)\b[\s\S]{0,120}\$[^$]*(?:\\frac\s*\{\s*\d+\s*\}\s*\{\s*\d+\s*\}|\d+\s*\/\s*\d+)[^$]*[\\cdot*/]\s*\d+[^$]*\$/i.test(
      text
    ) ||
    /\bi\.e\.\s*,?\s*(?:evaluate|compute)?\s*\$[^$]*\d[^$]*[\\cdot*/][^$]*\d[^$]*\$/i.test(text) ||
    /\b(?:use|using|write|rewrite)\b[\s\S]{0,80}\$?[A-Za-z]\s*[+\-]\s*[A-Za-z]\s*=\s*-?\d+(?:\.\d+)?\$?/i.test(
      text
    ) ||
    /\b(?:probability|fraction|ratio)\b[\s\S]{0,140}\b(?:over|\/)\b[\s\S]{0,80}\b(?:total|outcomes?|cubes?|possibilities)\b[\s\S]{0,140}\b(?:write|give|result|answer)\b[\s\S]{0,80}(?:\\frac\s*\{\s*\d+\s*\}\s*\{\s*\d+\s*\}|\d+\s*\/\s*\d+)/i.test(
      text
    ) ||
    /\b(?:probability|fraction|ratio)\b[\s\S]{0,120}(?:\\frac\s*\{\s*\d+\s*\}\s*\{\s*\d+\s*\}|\d+\s*\/\s*\d+)/i.test(
      text
    ) ||
    /\b(?:write|give)\b[\s\S]{0,80}(?:\\frac\s*\{\s*\d+\s*\}\s*\{\s*\d+\s*\}|\d+\s*\/\s*\d+)[\s\S]{0,120}\b(?:probability|fraction|ratio|favorable|total)\b/i.test(
      text
    )
  );
}

function concreteScalarAssignments(text: string) {
  const normalized = text.replace(/\bis\b/gi, "=");
  return [...normalized.matchAll(/(?:^|[$\s,(;:])([a-z])\s*=\s*(-?\d+(?:\.\d+)?(?:\s*\/\s*-?\d+)?)\b/gi)]
    .map((match) => `${match[1].toLowerCase()}=${match[2].replace(/\s+/g, "")}`);
}

function modelNextCheckIntroducesUnestablishedValue(
  text: string,
  context?: CoachResponseContext
) {
  const assignments = concreteScalarAssignments(text);
  if (assignments.length === 0) return false;

  const establishedAssignments = new Set(
    concreteScalarAssignments(
      [
        context?.problem,
        ...(context?.acceptedLines || []),
        context?.lastValidLine,
        context?.studentMessage,
      ]
        .filter(Boolean)
        .join(" ")
    )
  );

  return assignments.some((assignment) => !establishedAssignments.has(assignment));
}

function genericNonRevealingNextCheck(text: string) {
  if (concreteScalarAssignments(text).length > 0) {
    return "Use the relationships already established to determine the needed value, then send that line.";
  }

  if (
    /\b(?:write|set\s*up|form|give|provide|send)\b[\s\S]{0,100}\b(?:second|another|additional|other|remaining)\b[\s\S]{0,100}\bequation\b/i.test(
      text
    )
  ) {
    return "Use the other given data to write a second equation.";
  }

  if (/\bdivide\b[\s\S]{0,80}\b(?:entire\s+)?equation\b[\s\S]{0,80}\bby\s+\$?-?\d+(?:\.\d+)?\$?/i.test(text)) {
    return "Simplify the equation.";
  }

  if (/\b(?:modular arithmetic|modulo)\b[\s\S]{0,120}\bmod(?:ulo)?\s+\$?-?\d+\$?/i.test(text)) {
    return "Look for a divisibility property in the simplified equation.";
  }

  if (/\bdivid(?:e|ing)\b[\s\S]{0,80}\bboth\s+sides\b/i.test(text)) {
    return "Divide both sides by the same quantity, then send the resulting equation.";
  }

  if (/\bexponents?\b/i.test(text)) {
    return "Use the fact that equal bases have equal exponents, then send the resulting equation.";
  }

  if (/\bprobability|favorable|outcomes?|total\s+(?:cubes?|outcomes?)\b/i.test(text)) {
    return "Set up the probability as favorable outcomes over total outcomes, then send that fraction.";
  }

  if (/\bshaded\b/i.test(text)) {
    return "Use the given fraction of the large area, then send that line.";
  }

  if (/\bright(?:-hand)?\s+side|\brhs\b/i.test(text)) {
    return "Simplify the right-hand side one step, then send that line.";
  }

  if (/\bleft(?:-hand)?\s+side|\blhs\b/i.test(text)) {
    return "Simplify the left-hand side one step, then send that line.";
  }

  if (/\bisolate|solve\b/i.test(text)) {
    return "Use one inverse operation to keep isolating the unknown, then send that line.";
  }

  return "Make the next local simplification, then send that line.";
}

function adaptiveFallback(context: CoachResponseContext | undefined, status: VerificationResult["status"]) {
  const hintLevel = Math.max(0, context?.hintLevel ?? 0);
  const options =
    status === "incorrect"
      ? [
          "Check the operation on both sides, then send just the corrected line.",
          "Show the line immediately before this step and the line immediately after it.",
          "Focus on one local claim: what exact arithmetic or algebra change did you make?",
          "Back up one step and verify the smallest calculation in this line first.",
        ]
      : [
          "Make the next useful simplification, then send that line.",
          "Write just the equation or expression you are transforming next.",
          "Combine or simplify one local part of the expression, then send that line.",
          "Pick one local arithmetic or algebra claim from your work and send that single line.",
        ];

  const start = Math.min(hintLevel, options.length - 1);
  return options.slice(start).find((option) => !wasRecentlySaid(option, context)) || options[start];
}

function genericLocalError(text: string) {
  return (
    /^that step has an error\.?$/i.test(text.trim()) ||
    /\bnot equivalent to the original expression\b/i.test(text) ||
    /\bcannot verify\b/i.test(text) ||
    /\bnot sure\b/i.test(text)
  );
}

function hasSpecificLocalFeedback(result: VerificationResult) {
  return Boolean(result.local_error && !genericLocalError(result.local_error));
}

function genericRecoveryPrompt(text: string | null | undefined) {
  if (!text) return true;

  return (
    /\bone intermediate (?:step|equation|line)\b/i.test(text) ||
    /\bshow the line immediately before\b/i.test(text) ||
    /\bfocus on one local claim\b/i.test(text) ||
    /\bback up one step\b/i.test(text) ||
    /\bmake the next local simplification\b/i.test(text) ||
    /\bwrite just the equation or expression\b/i.test(text) ||
    /\bplease rewrite the step another way\b/i.test(text)
  );
}

function hasRepeatedRejections(context?: CoachResponseContext) {
  return (context?.recentRejectedLines || []).filter((line) => line.trim()).length >= 2;
}

function anchorToLastValidLine(
  result: VerificationResult,
  context?: CoachResponseContext,
  nextCheck?: string
) {
  const lastValidLine = context?.lastValidLine?.trim();
  if (!lastValidLine) return null;
  if (result.intent === "final_answer") return null;
  if (result.status !== "incorrect" && result.status !== "uncertain") return null;
  if (hasSpecificLocalFeedback(result)) return null;

  const shouldAnchor =
    (context?.hintLevel ?? 0) >= 2 ||
    hasRepeatedRejections(context) ||
    genericRecoveryPrompt(nextCheck || result.suggested_next_check);
  if (!shouldAnchor) return null;

  return `Let's reset to the last line we know is valid: ${lastValidLine}. From there, send just the next local step.`;
}

function safePositiveProgress(result: VerificationResult) {
  if (!result.valid_progress) {
    return result.status === "correct"
      ? "That is valid progress. "
      : "";
  }

  if (result.source === "model" && looksTooSpecificForPositiveFeedback(result.valid_progress)) {
    return "Nice work, that's a reasonable step. ";
  }

  return `${result.source === "model" ? "That looks reasonable: " : ""}${studentFacing(
    result.valid_progress
  )} `;
}

function safeNextCheck(
  result: VerificationResult,
  fallback: string,
  context?: CoachResponseContext
) {
  const next = result.suggested_next_check || fallback;

  if (
    result.source === "model" &&
    /\bfind the (?:common fraction|final answer|answer)\b/i.test(next)
  ) {
    return "Simplify your current expression one small step at a time.";
  }

  if (
    result.source === "model" &&
    (
      modelNextCheckRevealsNextResult(next) ||
      modelNextCheckIntroducesUnestablishedValue(next, context)
    )
  ) {
    return genericNonRevealingNextCheck(next);
  }

  const studentFacingNext = studentFacing(next);

  if (wasRecentlySaid(studentFacingNext, context)) {
    return adaptiveFallback(context, result.status);
  }

  return studentFacingNext;
}

function autonomousNextCheck(context?: CoachResponseContext) {
  if ((context?.hintLevel ?? 0) > 0) return null;

  const options = [
    "What would you try next?",
    "How would you continue from here?",
    "What do you notice that could move the solution forward?",
  ];

  return options.find((option) => !wasRecentlySaid(option, context)) || options[0];
}

function typoClarificationFallback(context?: CoachResponseContext) {
  if (!context?.studentMessage) return null;
  if ((context.studentMessage.match(/\b[A-Za-z]+\b/g) || []).length > 12) return null;

  const typoResult = normalizeStudentProseTypos(context.studentMessage);
  if (typoResult.corrections.length === 0) return null;

  return "Sorry, I may be misreading a typo in that line. Could you rewrite the step another way, or send the single equation you want me to check?";
}

export function composeCoachResponse(result: VerificationResult, context?: CoachResponseContext) {
  if (result.should_finish && result.status === "correct") {
    return "That solves the problem. Nice work.";
  }

  if (result.status === "incorrect") {
    if (result.source === "model" && looksLikeSolutionDump(result.local_error || "")) {
      return "I cannot verify the error from this line alone. Can you show the cancellation or arithmetic step you used?";
    }

    const nextCheck = safeNextCheck(
      result,
      adaptiveFallback(context, result.status),
      context
    );
    const anchor = anchorToLastValidLine(result, context, nextCheck);
    if (anchor) return anchor;

    const next = ` ${wasRecentlySaid(nextCheck, context) ? adaptiveFallback(context, result.status) : nextCheck}`;
    return `${studentFacing(result.local_error || "That step has an error.")}${next}`;
  }

  if (result.status === "partially_correct") {
    const progress = safePositiveProgress(result);
    const next = safeNextCheck(result, "What remaining condition still needs to be checked?", context);
    return `${progress}${next}`;
  }

  if (result.status === "correct") {
    const progress = safePositiveProgress(result) || "That is valid progress. ";
    const next =
      autonomousNextCheck(context) ||
      safeNextCheck(result, "What follows from that line?", context);
    return `${progress}${next}`;
  }

  const typoFallback = typoClarificationFallback(context);
  if (typoFallback && !wasRecentlySaid(typoFallback, context)) return typoFallback;

  const nextCheck = safeNextCheck(
    result,
    "I am not sure what this line means yet. Please rewrite the step another way, or send one intermediate equation.",
    context
  );
  const anchor = anchorToLastValidLine(result, context, nextCheck);
  if (anchor) return anchor;

  return nextCheck;
}
