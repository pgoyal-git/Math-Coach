import type { CoachSession } from "@/lib/sessionStore";
import type { VerificationResult } from "@/lib/coach-verifier/types";
import { normalizeStudentProseTypos } from "@/lib/coach-verifier/typos";

function sessionText(session: CoachSession) {
  return [
    session.problem,
    session.summary,
    session.workState?.lastValidLine,
    ...(session.workState?.acceptedLines || []),
    ...session.history.slice(-8).map((entry) => entry.content),
  ].join(" ");
}

function extractClaimedPageNumber(message: string) {
  const normalizedMessage = normalizeStudentProseTypos(message).text;
  const bareNumber = normalizedMessage.trim().match(/^(\d+)\??$/);
  if (bareNumber) {
    const value = Number(bareNumber[1]);
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  const match = normalizedMessage.match(
    /\b(?:answer|final|last|page|pages?|number|is|equals?)\b[\s\S]*?(\d+)\s*\??\s*$/i
  );
  if (!match) return null;

  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function extractTargetTotal(text: string) {
  const equationTotal = text.match(/=\s*(\d{2,6})\b/);
  const proseTotal = text.match(/\b(?:sum|total|equals?|is)\D{0,20}(\d{2,6})\b/i);
  const value = Number(equationTotal?.[1] ?? proseTotal?.[1]);

  return Number.isInteger(value) && value > 0 ? value : null;
}

function extractProblemTargetTotal(session: CoachSession) {
  return extractTargetTotal(session.problem) ?? extractTargetTotal(session.summary ?? "");
}

function looksLikeMissingConsecutivePagesProblem(text: string) {
  const hasMissingSheetContext =
    /\bsheets?\b/i.test(text) &&
    /\bodd\b/i.test(text) &&
    /\beven\b/i.test(text);

  return (
    /\bpages?\b/i.test(text) &&
    (/\bconsecutive\b/i.test(text) || hasMissingSheetContext) &&
    /\b(?:missing|removed|torn|lost|omitted)\b/i.test(text) &&
    /\b(?:sum|total|added)\b/i.test(text)
  );
}

function normalizeEquationText(message: string) {
  return message
    .replace(/\\left|\\right/g, "")
    .replace(/[{}\[\]]/g, (token) => (token === "{" || token === "[" ? "(" : ")"))
    .replace(/[−–—]/g, "-")
    .replace(/[×·]/g, "*")
    .replace(/\s+/g, "");
}

function looksLikeBorrowedConsecutiveSheetsAverageProblem(text: string) {
  return (
    /\bpages?\b/i.test(text) &&
    /\bsheets?\b/i.test(text) &&
    /\bconsecutive\b/i.test(text) &&
    /\b(?:borrow(?:ed|ing|s)?|take|takes|taken|took)\b/i.test(text) &&
    /\b(?:average|mean)\b/i.test(text)
  );
}

function extractBorrowedSheetBounds(text: string) {
  const first =
    text.match(/\b([a-z])\s+is\s+(?:the\s+)?first(?:\s+borrowed)?\s+sheet\b/i)?.[1] ??
    text.match(/\bfirst(?:\s+borrowed)?\s+sheet\s+(?:is|=)\s*(?:sheet\s*)?([a-z])\b/i)?.[1];
  const last =
    text.match(/\b([a-z])\s+is\s+(?:the\s+)?last(?:\s+borrowed)?(?:\s+sheet)?\b/i)?.[1] ??
    text.match(/\blast(?:\s+borrowed)?\s+sheet\s+(?:is|=)\s*(?:sheet\s*)?([a-z])\b/i)?.[1];

  if (!first || !last || first.toLowerCase() === last.toLowerCase()) return null;
  return { first: first.toLowerCase(), last: last.toLowerCase() };
}

function normalizeBorrowedSheetsStep(message: string) {
  return normalizeEquationText(message)
    .replace(/\$/g, "")
    .replace(/\\[()\[\]]/g, "")
    .toLowerCase();
}

export function verifyBorrowedConsecutiveSheetsSetup(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const text = sessionText(session);
  if (!looksLikeBorrowedConsecutiveSheetsAverageProblem(text)) return null;

  const bounds = extractBorrowedSheetBounds(text);
  if (!bounds) return null;

  const normalized = normalizeBorrowedSheetsStep(message);
  const firstPageVariable = normalized.match(
    /first(?:borrowed)?page(?:is|=)(?:page)?2([a-z])-1/
  )?.[1];
  const lastPageVariable = normalized.match(
    /last(?:borrowed)?page(?:is|=)(?:page)?2([a-z])\b/
  )?.[1];
  const countVariables = normalized.match(
    /(?:number|count)of(?:(?:the)?borrowedsheets|sheetsborrowed)(?:is|=)?([a-z])-([a-z])\+1/
  );
  const promptedForCount = /\b(?:express|write|find)\b[^.?!]{0,50}\bnumber of (?:the )?(?:borrowed sheets|sheets borrowed)\b/i.test(
    text
  );
  const bareCount = normalized.match(/^([a-z])-([a-z])\+1[.!?]?$/);
  const submittedCount = countVariables ?? (promptedForCount ? bareCount : null);

  const correctFirstPage = firstPageVariable === bounds.first;
  const correctLastPage = lastPageVariable === bounds.last;
  const correctCount =
    submittedCount?.[1] === bounds.last && submittedCount?.[2] === bounds.first;

  if (correctFirstPage && correctLastPage) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress:
        "Those formulas correctly identify the first and last pages on the borrowed sheets.",
      suggested_next_check:
        "Use those endpoints to express the sum of the borrowed page numbers.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (correctFirstPage || correctLastPage) {
    const acceptedFormula = correctFirstPage
      ? `2${bounds.first}-1`
      : `2${bounds.last}`;
    const nextEndpoint = correctFirstPage ? "last" : "first";
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: `That ${correctFirstPage ? "first" : "last"} borrowed-page formula, $${acceptedFormula}$, is correct.`,
      suggested_next_check: `Now write the ${nextEndpoint} borrowed page in terms of ${
        correctFirstPage ? bounds.last : bounds.first
      }.`,
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (correctCount) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: `The inclusive count $${bounds.last}-${bounds.first}+1$ is correct.`,
      suggested_next_check:
        "Now relate that count to the sum or average of the borrowed page numbers.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return null;
}

function hasTriangularPageSumTerm(text: string) {
  return /[a-zA-Z]\([a-zA-Z]\+1\)\/2/.test(text);
}

function hasConsecutiveMissingPageTerm(text: string) {
  const match = text.match(/\(([a-zA-Z])\+\1\+1\)/);
  return Boolean(match);
}

export function verifyMissingConsecutivePagesSetup(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const text = sessionText(session);
  if (!looksLikeMissingConsecutivePagesProblem(text)) return null;

  const targetTotal = extractProblemTargetTotal(session) ?? extractTargetTotal(text);
  if (!targetTotal) return null;

  const normalized = normalizeEquationText(message);
  const submittedTotal = normalized.match(/=(\d{2,6})$/);
  if (Number(submittedTotal?.[1]) !== targetTotal) return null;

  if (
    hasTriangularPageSumTerm(normalized) &&
    hasConsecutiveMissingPageTerm(normalized) &&
    /-/.test(normalized)
  ) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress:
        "That setup matches the full page sum minus the missing sheet.",
      suggested_next_check:
        "Now use the total to test possible final page numbers, or solve for when the missing amount is two consecutive page numbers.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return null;
}

function validMissingPairForFinalPage(finalPage: number, targetTotal: number) {
  const fullSum = (finalPage * (finalPage + 1)) / 2;
  const missingSum = fullSum - targetTotal;

  if (!Number.isInteger(missingSum) || missingSum <= 0 || missingSum % 2 === 0) {
    return null;
  }

  const firstMissingPage = (missingSum - 1) / 2;
  if (
    !Number.isInteger(firstMissingPage) ||
    firstMissingPage < 1 ||
    firstMissingPage + 1 > finalPage
  ) {
    return null;
  }

  return {
    firstMissingPage,
    secondMissingPage: firstMissingPage + 1,
  };
}

export function verifyMissingConsecutivePagesFinalAnswer(
  session: CoachSession,
  message: string
): VerificationResult | null {
  const claimedFinalPage = extractClaimedPageNumber(message);
  if (!claimedFinalPage) return null;

  const text = sessionText(session);
  if (!looksLikeMissingConsecutivePagesProblem(text)) return null;

  const targetTotal = extractProblemTargetTotal(session) ?? extractTargetTotal(text);
  if (!targetTotal) return null;

  const missingPair = validMissingPairForFinalPage(claimedFinalPage, targetTotal);
  if (missingPair) {
    return {
      intent: "final_answer",
      status: "correct",
      local_error: null,
      valid_progress: "That final page number fits the total after removing two consecutive pages.",
      suggested_next_check: null,
      should_finish: true,
      confidence: 1,
      source: "deterministic",
    };
  }

  return {
    intent: "final_answer",
    status: "incorrect",
    local_error: "That page count does not fit the total after removing two consecutive pages.",
    valid_progress: null,
    suggested_next_check: "Use the full page sum, subtract the given total, and check whether the missing amount can be two consecutive page numbers.",
    should_finish: false,
    confidence: 1,
    source: "deterministic",
  };
}
