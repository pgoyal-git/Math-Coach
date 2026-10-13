"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { InlineMath } from "react-katex";
import Link from "next/link";
import MathStepInput from "@/app/MathStepInput";
import {
  expressionToLatex,
  inlineLatexForDisplay,
  splitExplicitLatex,
  splitPlainMath,
} from "@/lib/mathText";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_PROBLEM_CHARS,
  MAX_STUDENT_MESSAGE_CHARS,
} from "@/lib/inputLimits";

const MAX_SOURCE_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_UPLOAD_IMAGE_DIMENSION = 2_400;

type Message = {
  role: "user" | "assistant";
  content: string;
  displayContent?: string;
  feedbackStatus?: string;
};

type Strategy = {
  game_plan: string;
  what_to_look_for: string;
  smart_move: string;
  your_turn: string;
};

type CompetitionShortcut = {
  has_shortcut: boolean;
  shortcut_title: string | null;
  why_different: string | null;
  recognition_cue: string | null;
  faster_move: string | null;
  why_it_saves_time: string | null;
  quick_check: string | null;
  no_shortcut_reason: string | null;
};

const progressTopics = [
  "Algebra",
  "Combinatorics",
  "Geometry",
  "Number Theory",
  "Sequences & Functions",
  "General Math",
] as const;

type ProgressTopic = typeof progressTopics[number];

type VerificationSummary = {
  intent?: string;
  status?: string;
  local_error?: string | null;
  valid_progress?: string | null;
  suggested_next_check?: string | null;
  source?: string;
};

type ProgressSession = {
  id: string;
  date: string;
  topic: string;
  skills: string[];
  mistakes: string[];
  solved: boolean;
  reviewSteps: number;
};

type LocalProgress = {
  version: 1;
  totals: {
    attempted: number;
    solved: number;
    reviewSteps: number;
  };
  topics: Record<string, number>;
  skills: Record<string, number>;
  mistakes: Record<string, number>;
  recentSessions: ProgressSession[];
};

function hasVisibleStudentDraft(value: string) {
  return Boolean(
    value
      .replace(/\\text\s*\{\s*\}/g, "")
      .replace(/\\placeholder(?:\[[^\]]*\])?\s*\{[^{}]*\}/g, "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[{}]/g, "")
      .trim()
  );
}

type CreateSessionResponse = {
  sessionId: string;
  strategy: Strategy;
  topic?: string;
  solutionGuideStatus?: SolutionGuideStatus;
};

type SolutionGuideStatus = "pending" | "ready" | "failed";

type SessionStateResponse = {
  solutionGuideStatus?: SolutionGuideStatus;
  error?: string;
};

type IngestImageResponse = {
  problem?: string;
  prompt_injection_reason?: string;
  moderation_blocked?: boolean;
  error?: string;
  code?: string;
};

async function readJsonResponse<T extends object>(res: Response): Promise<T & { error?: string }> {
  const contentType = res.headers.get("content-type") || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    const text = await res.text().catch(() => "");
    const fallback = res.ok
      ? "The server returned a non-JSON response."
      : `Request failed with ${res.status}${res.statusText ? ` ${res.statusText}` : ""}.`;

    return {
      error: text.trim() ? `${fallback} ${text.trim().slice(0, 160)}` : fallback,
    } as T & { error?: string };
  }

  try {
    return await res.json() as T & { error?: string };
  } catch {
    return {
      error: "The server returned invalid JSON.",
    } as T & { error?: string };
  }
}

const LOCAL_PROGRESS_KEY = "mathCoachLocalProgress.v1";

const demoScenario = {
  problem:
    "When five standard six-sided dice are rolled sequentially there are 6^5 = 7776 possible outcomes. For how many outcomes is the sum of the five rolled numbers exactly 27?",
  strategy: {
    game_plan:
      "Reason from the highest possible roll total, then count how the small deficit from that maximum can be distributed across the five dice.",
    what_to_look_for:
      "Notice that a sum close to the maximum is easier to count by tracking how far each die falls below 6.",
    smart_move:
      "Think of each die as contributing a deficit from 6, then list the possible deficit patterns before counting ordered rolls.",
    your_turn:
      "On your scratch paper, first compare the target sum with the maximum possible sum for five dice.",
  },
  turns: [
    {
      student: "The maximum sum is 30 if all five dice roll 6.",
      coach:
        "Nice work, that is a useful observation. Compare the target sum to that maximum.",
      status: "Valid step",
    },
    {
      student: "The target sum is 3 less than the maximum.",
      coach:
        "Good. Now describe the possible ways five dice can be a total of 3 below all sixes.",
      status: "Valid step",
    },
    {
      student: "The deficit patterns are 3, 2+1, and 1+1+1.",
      coach:
        "That is the right structure. Now count how many ordered rolls each pattern creates.",
      status: "Valid step",
    },
    {
      student: "So there are 3 outcomes.",
      coach:
        "Check this: 3 is the number of pattern types, not the number of ordered dice rolls. Pick one pattern and count how many positions it can occupy.",
      status: "Check this",
    },
    {
      student: "5 + 5\\cdot4 + \\binom{5}{3}",
      coach: "That setup checks out. Evaluate the count.",
      status: "Valid step",
    },
    {
      student: "5 + 20 + 10 = 35",
      coach: "That solves the problem. Nice work.",
      status: "Solved",
      finalAnswer: "35",
    },
  ],
};

const DEMO_STRATEGY_PAUSE_MS = 3600;
const DEMO_COACH_PAUSE_MS = 3000;

const celebrationParticles = [
  { left: "50%", top: "42%", x: "-210px", y: "-120px", delay: "0ms", size: "0.8rem", color: "#14b8a6" },
  { left: "50%", top: "42%", x: "-145px", y: "-205px", delay: "35ms", size: "0.65rem", color: "#f59e0b" },
  { left: "50%", top: "42%", x: "-45px", y: "-235px", delay: "70ms", size: "0.75rem", color: "#6366f1" },
  { left: "50%", top: "42%", x: "65px", y: "-215px", delay: "20ms", size: "0.9rem", color: "#ef4444" },
  { left: "50%", top: "42%", x: "165px", y: "-145px", delay: "55ms", size: "0.7rem", color: "#22c55e" },
  { left: "50%", top: "42%", x: "235px", y: "-45px", delay: "90ms", size: "0.8rem", color: "#0ea5e9" },
  { left: "50%", top: "42%", x: "205px", y: "95px", delay: "140ms", size: "0.7rem", color: "#f97316" },
  { left: "50%", top: "42%", x: "80px", y: "175px", delay: "105ms", size: "0.85rem", color: "#8b5cf6" },
  { left: "50%", top: "42%", x: "-55px", y: "190px", delay: "165ms", size: "0.65rem", color: "#06b6d4" },
  { left: "50%", top: "42%", x: "-170px", y: "110px", delay: "125ms", size: "0.8rem", color: "#84cc16" },
  { left: "26%", top: "34%", x: "-125px", y: "-120px", delay: "360ms", size: "0.75rem", color: "#3b82f6" },
  { left: "26%", top: "34%", x: "-20px", y: "-170px", delay: "410ms", size: "0.65rem", color: "#ec4899" },
  { left: "26%", top: "34%", x: "95px", y: "-105px", delay: "455ms", size: "0.85rem", color: "#eab308" },
  { left: "26%", top: "34%", x: "135px", y: "35px", delay: "500ms", size: "0.7rem", color: "#10b981" },
  { left: "26%", top: "34%", x: "25px", y: "145px", delay: "445ms", size: "0.8rem", color: "#f97316" },
  { left: "26%", top: "34%", x: "-110px", y: "80px", delay: "390ms", size: "0.7rem", color: "#8b5cf6" },
  { left: "74%", top: "36%", x: "-135px", y: "-75px", delay: "560ms", size: "0.75rem", color: "#f43f5e" },
  { left: "74%", top: "36%", x: "-70px", y: "-165px", delay: "610ms", size: "0.65rem", color: "#14b8a6" },
  { left: "74%", top: "36%", x: "55px", y: "-155px", delay: "650ms", size: "0.8rem", color: "#f59e0b" },
  { left: "74%", top: "36%", x: "145px", y: "-45px", delay: "690ms", size: "0.7rem", color: "#0ea5e9" },
  { left: "74%", top: "36%", x: "100px", y: "110px", delay: "635ms", size: "0.85rem", color: "#22c55e" },
  { left: "74%", top: "36%", x: "-60px", y: "135px", delay: "595ms", size: "0.7rem", color: "#6366f1" },
  { left: "45%", top: "70%", x: "-185px", y: "-55px", delay: "760ms", size: "0.7rem", color: "#06b6d4" },
  { left: "45%", top: "70%", x: "-95px", y: "-135px", delay: "800ms", size: "0.85rem", color: "#ef4444" },
  { left: "45%", top: "70%", x: "30px", y: "-155px", delay: "845ms", size: "0.65rem", color: "#eab308" },
  { left: "45%", top: "70%", x: "160px", y: "-90px", delay: "890ms", size: "0.8rem", color: "#10b981" },
  { left: "45%", top: "70%", x: "125px", y: "55px", delay: "830ms", size: "0.75rem", color: "#ec4899" },
  { left: "45%", top: "70%", x: "-55px", y: "95px", delay: "875ms", size: "0.7rem", color: "#f97316" },
];

function ButtonSpinner() {
  return (
    <span
      className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current"
      aria-hidden="true"
    />
  );
}

function emptyProgress(): LocalProgress {
  return {
    version: 1,
    totals: {
      attempted: 0,
      solved: 0,
      reviewSteps: 0,
    },
    topics: {},
    skills: {},
    mistakes: {},
    recentSessions: [],
  };
}

function normalizeLocalProgress(value: unknown): LocalProgress | null {
  const parsed = value as Partial<LocalProgress>;

  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.version !== 1 ||
    !parsed.totals ||
    !parsed.topics ||
    !parsed.skills ||
    !parsed.mistakes
  ) {
    return null;
  }

  return repairProgressTopics({
    ...emptyProgress(),
    ...parsed,
    totals: {
      ...emptyProgress().totals,
      ...parsed.totals,
    },
    recentSessions: Array.isArray(parsed.recentSessions) ? parsed.recentSessions.slice(0, 8) : [],
  });
}

function loadLocalProgress(): LocalProgress {
  if (typeof window === "undefined") return emptyProgress();

  try {
    const raw = window.localStorage.getItem(LOCAL_PROGRESS_KEY);
    if (!raw) return emptyProgress();
    return normalizeLocalProgress(JSON.parse(raw)) || emptyProgress();
  } catch {
    return emptyProgress();
  }
}

function saveLocalProgress(progress: LocalProgress) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LOCAL_PROGRESS_KEY, JSON.stringify(progress));
}

function incrementCount(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] || 0) + 1;
}

function topEntries(counts: Record<string, number>, limit = 4) {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit);
}

function practiceLabel(count: number, singular = "session") {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function buildDiagnosis(progress: LocalProgress) {
  const topics = topEntries(progress.topics);
  const skills = topEntries(progress.skills);
  const mistakes = topEntries(progress.mistakes);
  const topTopic = topics[0];
  const topSkill = skills[0];
  const topMistake = mistakes[0];
  const solvedRate = progress.totals.attempted
    ? Math.round((progress.totals.solved / progress.totals.attempted) * 100)
    : 0;

  if (!progress.totals.attempted) {
    return {
      strength: "Start a session and this dashboard will identify strengths from your checked steps.",
      focus: "No weak spots yet. The coach needs a few reviewed steps before it can diagnose patterns.",
      nextPractice: "Try one algebra, one counting, and one geometry problem to create a useful baseline.",
    };
  }

  const strength = topSkill
    ? `Strongest signal: ${topSkill[0].toLowerCase()} has shown up in ${practiceLabel(topSkill[1], "review")}.`
    : topTopic
      ? `Most practiced area: ${topTopic[0]} across ${practiceLabel(topTopic[1])}.`
      : "You have started building a practice history. A few more reviewed steps will make this sharper.";

  const focus = topMistake
    ? `Watch-out pattern: ${topMistake[0].toLowerCase()} has appeared ${practiceLabel(topMistake[1], "time")}.`
    : solvedRate >= 80
      ? "Current pattern: clean solving. Keep speed honest by still writing one checkable intermediate step."
      : "Current pattern: progress is mixed. Focus on making each step easy for the coach to verify.";

  const nextPractice = topMistake
    ? `Next practice: choose a ${topTopic?.[0] || "contest"} problem and deliberately write the checkpoint that prevents ${topMistake[0].toLowerCase()}.`
    : topTopic
      ? `Next practice: do another ${topTopic[0]} problem, but aim for fewer coach reviews before the final answer.`
      : "Next practice: solve a fresh contest problem and let the coach review each major checkpoint.";

  return {
    strength,
    focus,
    nextPractice,
  };
}

function isProgressTopic(value: unknown): value is ProgressTopic {
  return typeof value === "string" && progressTopics.includes(value as ProgressTopic);
}

function shouldRepairAlgebraTopic(session: ProgressSession) {
  const hasAlgebraSkill = session.skills.some((skill) => /algebra|equivalence|equation/i.test(skill));
  const hasCountingSkill = session.skills.some((skill) => /combination|permutation|inclusion|count/i.test(skill));

  return session.topic === "Combinatorics" && hasAlgebraSkill && !hasCountingSkill;
}

function repairProgressTopics(progress: LocalProgress): LocalProgress {
  const repairedSessions = progress.recentSessions.map((session) => (
    shouldRepairAlgebraTopic(session) ? { ...session, topic: "Algebra" } : session
  ));

  if (repairedSessions.every((session, index) => session.topic === progress.recentSessions[index]?.topic)) {
    return progress;
  }

  const topics = { ...progress.topics };

  for (const session of progress.recentSessions) {
    if (!shouldRepairAlgebraTopic(session)) continue;
    topics.Combinatorics = Math.max((topics.Combinatorics || 0) - 1, 0);
    if (topics.Combinatorics === 0) delete topics.Combinatorics;
    incrementCount(topics, "Algebra");
  }

  return {
    ...progress,
    topics,
    recentSessions: repairedSessions,
  };
}

function hasAlgebraTopicSignal(text: string) {
  return (
    /\b(equivalent|common fraction|simplify|expression|equation|linear|quadratic|exponent|power|factor(?:ing)?|factor out|common factor)\b/i.test(text) ||
    /\b\d+\s*\^\s*\d+\b/.test(text)
  );
}

function hasCombinatoricsTopicSignal(text: string) {
  return (
    /\b(choose|ways?|permutation|combination|factorial|arrangements?)\b/i.test(text) ||
    (/\b(count|counting)\b/i.test(text) && /\b(selections?|outcomes?|arrangements?|ways?|cases?|objects?|people|committees?)\b/i.test(text)) ||
    (/\bat least\b/i.test(text) && /\b(one|two|three|\d+)\b/i.test(text) && /\b(each|from|selected|chosen)\b/i.test(text))
  );
}

function inferTopic(text: string): ProgressTopic {
  if (hasAlgebraTopicSignal(text)) {
    return "Algebra";
  }

  if (/\btriangle|circle|angle|area|perimeter|radius|diameter|geometry|hypotenuse\b/i.test(text)) {
    return "Geometry";
  }

  if (/\bsequence|series|arithmetic sequence|geometric|a_n|function|f\(x\)\b/i.test(text)) {
    return "Sequences & Functions";
  }

  if (/\bgcd|lcm|mod|remainder|divisible|prime|base|digit|octal\b/i.test(text)) {
    return "Number Theory";
  }

  if (hasCombinatoricsTopicSignal(text)) {
    return "Combinatorics";
  }

  return "General Math";
}

function dashboardTopic(llmTopic: unknown, contextText: string): ProgressTopic {
  const heuristicTopic = inferTopic(contextText);

  if (!isProgressTopic(llmTopic)) {
    return heuristicTopic;
  }

  if (hasAlgebraTopicSignal(contextText) && llmTopic !== "Algebra") {
    return "Algebra";
  }

  if (llmTopic === "Combinatorics" && !hasCombinatoricsTopicSignal(contextText)) {
    return heuristicTopic;
  }

  return llmTopic;
}

function inferSkill(message: string, verification?: VerificationSummary) {
  const text = [
    message,
    verification?.local_error,
    verification?.valid_progress,
    verification?.suggested_next_check,
  ].filter(Boolean).join(" ");

  if (/\bbase\b|\boctal\b|digit sum/i.test(text)) return "Base conversion";
  if (/\bchoose\b|\\binom|combination/i.test(text)) return "Combinations";
  if (/\bpermutation|P\(/i.test(text)) return "Permutations";
  if (/\binclusion-exclusion|missing one category|overlap/i.test(text)) return "Inclusion-exclusion";
  if (/\bgcd|lcm|mod|remainder|prime/i.test(text)) return "Number theory";
  if (/\btriangle|hypotenuse|area|circle|circumference/i.test(text)) return "Geometry formulas";
  if (/\bequivalent|equation|isolate|linear/i.test(text)) return "Algebraic equivalence";
  if (/\barithmetic equality|squared|factorial|sum arithmetic/i.test(text)) return "Arithmetic checks";
  if (/\bsequence|geometric|a_n|function evaluation/i.test(text)) return "Sequences and functions";

  return verification?.source === "deterministic" ? "Deterministic checkpoint" : "Reasoning checkpoint";
}

function inferMistake(message: string, verification?: VerificationSummary) {
  if (verification?.status !== "incorrect") return null;

  const text = [
    message,
    verification.local_error,
    verification.suggested_next_check,
  ].filter(Boolean).join(" ");

  if (/\bovercounts?|overlap|subtracted more than once/i.test(text)) return "Overcounting";
  if (/\barithmetic|recompute|not the same value|squared|factorial/i.test(text)) return "Arithmetic slip";
  if (/\bequivalent|same operation|both sides|equation/i.test(text)) return "Algebra step";
  if (/\bbase|place values|digit/i.test(text)) return "Base/digit error";
  if (/\bcondition|restriction|missing/i.test(text)) return "Missed condition";
  if (/\bmod|remainder|gcd|lcm|prime/i.test(text)) return "Number theory error";

  return "Checkpoint error";
}

function feedbackStatusLabel(verification?: VerificationSummary, isFinished = false) {
  if (isFinished) return "Solved";
  if (
    verification?.intent === "question" &&
    (verification.status === "correct" || verification.status === "partially_correct")
  ) {
    return "Good question";
  }

  switch (verification?.status) {
    case "correct":
      return "Valid step";
    case "partially_correct":
      return verification.local_error ? "Partial progress" : "Valid step";
    case "incorrect":
      return "Check this";
    case "uncertain":
      return "Need one more step";
    default:
      return null;
  }
}

function feedbackStatusClass(status?: string) {
  switch (status) {
    case "Valid step":
    case "Good question":
    case "Solved":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "Partial progress":
      return "border-indigo-200 bg-indigo-50 text-indigo-800";
    case "Check this":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "Need one more step":
      return "border-blue-200 bg-blue-50 text-blue-800";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}

function upsertRecentSession(progress: LocalProgress, session: ProgressSession) {
  return [
    session,
    ...progress.recentSessions.filter((recent) => recent.id !== session.id),
  ].slice(0, 8);
}

export default function Home() {
  // -----------------------------
  // Problem input
  // -----------------------------
  const [problem, setProblem] = useState("");
  const [submittedProblem, setSubmittedProblem] = useState("");
  const [imagePreview, setImagePreview] = useState("");
  const [imageBase64, setImageBase64] = useState("");
  const [imageMimeType, setImageMimeType] = useState("");
  const [extractingImage, setExtractingImage] = useState(false);
  const [imageError, setImageError] = useState("");
  const [showExtractedText, setShowExtractedText] = useState(false);
  const [draggingImage, setDraggingImage] = useState(false);
  const [imagePromptInjectionReason, setImagePromptInjectionReason] = useState("");
  const problemTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // -----------------------------
  // Session + strategy
  // -----------------------------
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [strategyCollapsed, setStrategyCollapsed] = useState(false);
  const [solutionGuideStatus, setSolutionGuideStatus] = useState<SolutionGuideStatus | null>(null);

  // -----------------------------
  // Chat state
  // -----------------------------
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [inputDisplay, setInputDisplay] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [messageAction, setMessageAction] = useState<"review" | "answer" | "stuck" | null>(null);
  const [sessionNotice, setSessionNotice] = useState("");
  const [correct, setCorrect] = useState(false);
  const [solvedFinalAnswer, setSolvedFinalAnswer] = useState("");
  const [celebrating, setCelebrating] = useState(false);
  const [shortcut, setShortcut] = useState<CompetitionShortcut | null>(null);
  const [shortcutLoading, setShortcutLoading] = useState(false);
  const [shortcutError, setShortcutError] = useState("");
  const [showShortcutReview, setShowShortcutReview] = useState(false);
  const [showWhyCoach, setShowWhyCoach] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [localProgress, setLocalProgress] = useState<LocalProgress>(() => loadLocalProgress());
  const [progressBackupStatus, setProgressBackupStatus] = useState("");
  const [activeProgressSession, setActiveProgressSession] = useState<ProgressSession | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [demoStepIndex, setDemoStepIndex] = useState(0);
  const [demoThinking, setDemoThinking] = useState(false);
  const [demoTyping, setDemoTyping] = useState(false);
  const [demoTypedInput, setDemoTypedInput] = useState("");
  const hasStudentMessage = messages.some((message) => message.role === "user");
  const displayProblem = submittedProblem || problem;
  const showOriginalProblem = Boolean(sessionId || demoMode || imagePreview || submittedProblem);
  const hasResettableWorkspace = Boolean(
    problem.trim() ||
    submittedProblem ||
    imagePreview ||
    sessionId ||
    demoMode ||
    strategy ||
    messages.length ||
    correct
  );
  const latestMessageRef = useRef<HTMLDivElement | null>(null);
  const progressImportRef = useRef<HTMLInputElement | null>(null);
  const demoTimeoutRef = useRef<number | null>(null);
  const demoTypingTimeoutRef = useRef<number | null>(null);
  const composerDisabled = loading;
  const hasDraftInput = hasVisibleStudentDraft(input);
  const topTopics = topEntries(localProgress.topics);
  const topSkills = topEntries(localProgress.skills);
  const topMistakes = topEntries(localProgress.mistakes);
  const solvedRate = localProgress.totals.attempted
    ? Math.round((localProgress.totals.solved / localProgress.totals.attempted) * 100)
    : 0;
  const diagnosis = buildDiagnosis(localProgress);

  function resizeTextarea(textarea: HTMLTextAreaElement | null) {
    if (!textarea) return;

    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }

  function commitProgress(update: (progress: LocalProgress) => LocalProgress) {
    setLocalProgress((current) => {
      const next = update(current);
      saveLocalProgress(next);
      return next;
    });
  }

  function clearLocalProgress() {
    const next = emptyProgress();
    saveLocalProgress(next);
    setLocalProgress(next);
    setActiveProgressSession(null);
    setProgressBackupStatus("Local progress cleared.");
  }

  function exportLocalProgress() {
    if (typeof window === "undefined") return;

    const backup = {
      exportedAt: new Date().toISOString(),
      app: "Math Coach",
      note: "This backup contains local progress summary only. It does not include problem text, chat transcripts, or uploaded images.",
      progress: localProgress,
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);

    link.href = url;
    link.download = `math-coach-progress-${date}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setProgressBackupStatus("Progress backup downloaded.");
  }

  function clearDemoTimers() {
    if (demoTimeoutRef.current !== null) {
      window.clearTimeout(demoTimeoutRef.current);
      demoTimeoutRef.current = null;
    }

    if (demoTypingTimeoutRef.current !== null) {
      window.clearTimeout(demoTypingTimeoutRef.current);
      demoTypingTimeoutRef.current = null;
    }
  }

  async function importLocalProgress(file: File | null) {
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { progress?: unknown };
      const progress = normalizeLocalProgress(parsed.progress || parsed);

      if (!progress) {
        setProgressBackupStatus("Could not import that file. Choose a Math Coach progress backup.");
        return;
      }

      saveLocalProgress(progress);
      setLocalProgress(progress);
      setActiveProgressSession(null);
      setProgressBackupStatus("Progress backup imported.");
    } catch {
      setProgressBackupStatus("Could not import that file. Choose a Math Coach progress backup.");
    }
  }

  useEffect(() => {
    if (!celebrating) return;

    const timeout = window.setTimeout(() => {
      setCelebrating(false);
    }, 3400);

    return () => window.clearTimeout(timeout);
  }, [celebrating]);

  useEffect(() => {
    if (!messages.length) return;

    latestMessageRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, [messages]);

  useEffect(() => {
    resizeTextarea(problemTextareaRef.current);
  }, [problem]);

  useEffect(() => {
    return () => {
      clearDemoTimers();
    };
  }, []);

  useEffect(() => {
    if (!sessionId || solutionGuideStatus !== "pending") return;

    let cancelled = false;
    let retryTimer: number | null = null;

    async function waitForChecker() {
      try {
        const res = await fetch("/api/session/state", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sessionId }),
        });

        const data = await readJsonResponse<SessionStateResponse>(res);

        if (cancelled) return;

        if (res.status === 404 && data.error === "Session not found") {
          setSessionId(null);
          setStrategy(null);
          setStrategyCollapsed(false);
          setSolutionGuideStatus(null);
          setMessages([]);
          setCorrect(false);
          setCelebrating(false);
          setShortcut(null);
          setShortcutError("");
          setShortcutLoading(false);
          setActiveProgressSession(null);
          setSessionNotice(
            "This coaching session expired. Start the problem again to continue."
          );
          return;
        }

        if (
          data.solutionGuideStatus === "ready" ||
          data.solutionGuideStatus === "failed"
        ) {
          setSolutionGuideStatus(data.solutionGuideStatus);
          setSessionNotice("");
          setMessages([
            {
              role: "assistant",
              content: "Use the strategy above if it helps, or start with another valid approach.",
            },
          ]);
          return;
        }

        retryTimer = window.setTimeout(waitForChecker, 750);
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setSolutionGuideStatus("failed");
          setSessionNotice("");
          setMessages([
            {
              role: "assistant",
              content: "Use the strategy above if it helps, or start with another valid approach.",
            },
          ]);
        }
      }
    }

    void waitForChecker();

    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [sessionId, solutionGuideStatus]);

  // -----------------------------
  // STRATEGY + SESSION CREATE
  // -----------------------------
  function fileToBase64(file: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        resolve(result.split(",")[1] || "");
      };
      reader.onerror = () => reject(reader.error || new Error("Unable to read image"));
      reader.readAsDataURL(file);
    });
  }

  function canvasToJpeg(canvas: HTMLCanvasElement, quality: number) {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error("Unable to encode image")),
        "image/jpeg",
        quality
      );
    });
  }

  async function optimizeImageForUpload(file: File) {
    if (file.size <= MAX_IMAGE_BYTES) return file as Blob;

    const bitmap = await createImageBitmap(file);
    let scale = Math.min(
      1,
      MAX_UPLOAD_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height)
    );

    try {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Unable to resize image");

        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

        const optimized = await canvasToJpeg(
          canvas,
          Math.max(0.55, 0.9 - attempt * 0.07)
        );
        if (optimized.size <= MAX_IMAGE_BYTES) return optimized;

        scale *= 0.82;
      }
    } finally {
      bitmap.close();
    }

    throw new Error("Unable to reduce image below the upload limit");
  }

  async function handleImageUpload(file: File | null) {
    if (!file) return;

    if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.type as typeof ALLOWED_IMAGE_MIME_TYPES[number])) {
      setImageError("Please use a PNG, JPEG, or WebP image.");
      return;
    }

    if (file.size > MAX_SOURCE_IMAGE_BYTES) {
      setImageError("Please use an image that is 12 MB or smaller.");
      return;
    }

    setImageError("");
    setImagePromptInjectionReason("");
    setShowExtractedText(false);
    setExtractingImage(true);

    let uploadImage: Blob;
    try {
      uploadImage = await optimizeImageForUpload(file);
    } catch (error) {
      console.error(error);
      setImageError("That image could not be compressed for upload. Try a smaller image.");
      setExtractingImage(false);
      return;
    }

    if (imagePreview) {
      URL.revokeObjectURL(imagePreview);
    }

    const nextImagePreview = URL.createObjectURL(uploadImage);
    setImagePreview(nextImagePreview);

    try {
      const uploadedImageBase64 = await fileToBase64(uploadImage);
      setImageBase64(uploadedImageBase64);
      setImageMimeType(uploadImage.type);
      const res = await fetch("/api/ingest-image", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          imageBase64: uploadedImageBase64,
          mimeType: uploadImage.type,
        }),
      });

      const data = await readJsonResponse<IngestImageResponse>(res);

      if (data.moderation_blocked) {
        setImageBase64("");
        setImageMimeType("");
        URL.revokeObjectURL(nextImagePreview);
        setImagePreview("");
        setImageError(data.error || "That image cannot be used in the math coach.");
        return;
      }

      if (!res.ok) {
        setImageBase64("");
        setImageMimeType("");
        URL.revokeObjectURL(nextImagePreview);
        setImagePreview("");
        setImageError(data.error || "That image could not be used.");
        return;
      }

      if (typeof data.problem !== "string" || !data.problem.trim()) {
        setImageError("Image attached. Could not extract editable text, but the coach can still inspect the image.");
        return;
      }

      setProblem(data.problem.trim());
      if (typeof data.prompt_injection_reason === "string" && data.prompt_injection_reason.trim()) {
        setImagePromptInjectionReason(data.prompt_injection_reason.trim());
      }
    } catch (err) {
      console.error(err);
      setImageError("Image attached. Could not extract editable text, but the coach can still inspect the image.");
    } finally {
      setExtractingImage(false);
    }
  }

  function firstImageFile(files?: FileList | null) {
    return Array.from(files || []).find((file) => file.type.startsWith("image/")) || null;
  }

  function firstClipboardImage(items?: DataTransferItemList) {
    return Array.from(items || [])
      .find((item) => item.kind === "file" && item.type.startsWith("image/"))
      ?.getAsFile() || null;
  }

  async function submitProblem() {
    if (!problem.trim() && !imageBase64) return;

    try {
      clearDemoTimers();
      setLoading(true);
      setDemoMode(false);
      setDemoStepIndex(0);
      setDemoThinking(false);
      setDemoTyping(false);
      setDemoTypedInput("");
      setSessionNotice("");
      setSubmittedProblem(problem.trim());

      setMessages([]);
      setSessionId(null);
      setStrategy(null);
      setStrategyCollapsed(false);
      setSolutionGuideStatus(null);
      setCorrect(false);
      setSolvedFinalAnswer("");
      setCelebrating(false);
      setShortcut(null);
      setShortcutError("");
      setShortcutLoading(false);
      setActiveProgressSession(null);

      const res = await fetch("/api/session/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          problem,
          imageBase64,
          mimeType: imageMimeType,
          imagePromptInjectionReason,
        }),
      });

      const data = await readJsonResponse<CreateSessionResponse>(res);

      if (!res.ok) {
        console.error(data);
        setSubmittedProblem("");
        setSessionNotice(data.error || "Could not start the coaching session. Please try again.");
        return;
      }

      setSessionId(data.sessionId);
      setStrategy(data.strategy);
      setSolutionGuideStatus(data.solutionGuideStatus || "pending");
      setSessionNotice(
        data.solutionGuideStatus === "pending"
          ? "Take a moment to read the strategy and decide what first setup line you would try."
          : ""
      );

      const strategyText = data.strategy
        ? [
            data.strategy.game_plan,
            data.strategy.what_to_look_for,
            data.strategy.smart_move,
            data.strategy.your_turn,
          ].filter(Boolean).join(" ")
        : "";
      const progressSession: ProgressSession = {
        id: data.sessionId,
        date: new Date().toISOString(),
        topic: dashboardTopic(data.topic, `${problem} ${strategyText}`),
        skills: [],
        mistakes: [],
        solved: false,
        reviewSteps: 0,
      };

      setActiveProgressSession(progressSession);
      commitProgress((current) => {
        const next: LocalProgress = {
          ...current,
          totals: {
            ...current.totals,
            attempted: current.totals.attempted + 1,
          },
          topics: { ...current.topics },
          skills: { ...current.skills },
          mistakes: { ...current.mistakes },
          recentSessions: current.recentSessions,
        };

        incrementCount(next.topics, progressSession.topic);
        next.recentSessions = upsertRecentSession(next, progressSession);
        return next;
      });

      if (data.solutionGuideStatus !== "pending") {
        setMessages([
          {
            role: "assistant",
            content: "Use the strategy above if it helps, or start with another valid approach.",
          },
        ]);
      }
    } catch (err) {
      console.error(err);
      setSubmittedProblem("");
    } finally {
      setLoading(false);
    }
  }

  function startDemoMode() {
    clearDemoTimers();

    if (imagePreview) {
      URL.revokeObjectURL(imagePreview);
    }

    setProblem(demoScenario.problem);
    setSubmittedProblem(demoScenario.problem);
    setImagePreview("");
    setImageBase64("");
    setImageMimeType("");
    setLoading(false);
    setExtractingImage(false);
    setImageError("");
    setImagePromptInjectionReason("");
    setShowExtractedText(false);
    setDraggingImage(false);
    setSessionId(null);
    setStrategy(null);
    setStrategyCollapsed(false);
    setSolutionGuideStatus("pending");
    setMessages([]);
    setInput("");
    setInputDisplay(null);
    setLoading(false);
    setMessageAction(null);
    setSessionNotice("");
    setCorrect(false);
    setSolvedFinalAnswer("");
    setCelebrating(false);
    setShortcut(null);
    setShortcutLoading(false);
    setShortcutError("");
    setShowShortcutReview(false);
    setActiveProgressSession(null);
    setDemoMode(true);
    setDemoStepIndex(0);
    setDemoThinking(false);
    setDemoTyping(false);
    setDemoTypedInput("");
  }

  function beginDemoStrategy() {
    if (!demoMode || loading || strategy) return;

    clearDemoTimers();
    setLoading(true);
    setSolutionGuideStatus("pending");

    demoTimeoutRef.current = window.setTimeout(() => {
      setStrategy(demoScenario.strategy);
      setSolutionGuideStatus("ready");
      setMessages([
        {
          role: "assistant",
          content: "Use the strategy above if it helps, or start with another valid approach.",
        },
      ]);
      setLoading(false);
      demoTimeoutRef.current = null;
    }, DEMO_STRATEGY_PAUSE_MS);
  }

  function advanceDemoStep() {
    if (demoThinking || demoTyping) return;

    const turn = demoScenario.turns[demoStepIndex];
    if (!turn) return;

    setStrategyCollapsed(true);
    setDemoTyping(true);
    setDemoTypedInput("");

    const characters = Array.from(turn.student);
    const typingDelayMs = Math.max(45, Math.min(90, Math.round(1800 / Math.max(characters.length, 1))));
    let nextIndex = 0;

    function typeNextCharacter() {
      nextIndex += 1;
      const partial = characters.slice(0, nextIndex).join("");
      setDemoTypedInput(partial);

      if (nextIndex < characters.length) {
        demoTypingTimeoutRef.current = window.setTimeout(typeNextCharacter, typingDelayMs);
        return;
      }

      demoTypingTimeoutRef.current = null;
      setMessages((current) => [...current, { role: "user", content: turn.student }]);
      setDemoTypedInput("");
      setDemoTyping(false);
      setDemoThinking(true);

      demoTimeoutRef.current = window.setTimeout(() => {
        setMessages((current) => [
          ...current,
          { role: "assistant", content: turn.coach, feedbackStatus: turn.status },
        ]);
        setDemoThinking(false);
        setDemoStepIndex((index) => index + 1);
        demoTimeoutRef.current = null;

        if (turn.finalAnswer) {
          setCorrect(true);
          setSolvedFinalAnswer(turn.finalAnswer);
          setCelebrating(true);
        }
      }, DEMO_COACH_PAUSE_MS);
    }

    typeNextCharacter();
  }

  // -----------------------------
  // ADAPTIVE MESSAGE LOOP
  // -----------------------------
  async function sendMessage(actionOverride?: "review" | "answer" | "stuck") {
    if (!sessionId || loading) return;

    const trimmedInput = input.trim();
    const hasSubmittedDraft = hasVisibleStudentDraft(trimmedInput);
    const userText = hasSubmittedDraft ? trimmedInput : "I'm stuck";
    const nextMessageAction = hasSubmittedDraft
      ? actionOverride === "answer"
        ? "answer"
        : "review"
      : "stuck";
    const isFirstStudentMessage = !messages.some((message) => message.role === "user");

    setMessages((m) => [
      ...m,
      { role: "user", content: userText, displayContent: inputDisplay || undefined },
    ]);

    setInput("");
    setInputDisplay(null);
    if (isFirstStudentMessage) {
      setStrategyCollapsed(true);
    }
    setMessageAction(nextMessageAction);
    setLoading(true);

    try {
      const res = await fetch("/api/session/message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId,
          message: userText,
          intentOverride: nextMessageAction === "answer" ? "final_answer" : undefined,
        }),
      });

      const data = await readJsonResponse<{
        message?: string;
        verification?: VerificationSummary;
        is_finished?: boolean;
        final_answer?: string;
        moderation_blocked?: boolean;
      }>(res);

      if (res.status === 404 && data.error === "Session not found") {
        setSessionId(null);
        setStrategy(null);
        setStrategyCollapsed(false);
        setSolutionGuideStatus(null);
        setMessages([]);
        setCorrect(false);
        setSolvedFinalAnswer("");
        setCelebrating(false);
        setShortcut(null);
        setShortcutError("");
        setShortcutLoading(false);
        setActiveProgressSession(null);
        setInput(userText);
        setInputDisplay(null);
        setSessionNotice(
          "This coaching session expired after the local server restarted. Start the problem again to continue."
        );
        return;
      }

      if (data.moderation_blocked && typeof data.error === "string") {
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content: data.error || "That message cannot be processed.",
            feedbackStatus: "Need one more step",
          },
        ]);
        return;
      }

      if (!res.ok && typeof data.error === "string") {
        const errorMessage = data.error;
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content: errorMessage,
            feedbackStatus: "Need one more step",
          },
        ]);
        return;
      }

      if (!res.ok || typeof data.message !== "string" || !data.message.trim()) {
        throw new Error(typeof data.error === "string" ? data.error : "Message review failed");
      }

      const assistantMessage = data.message;
      const verification = data.verification as VerificationSummary | undefined;
      const feedbackStatus = feedbackStatusLabel(verification, Boolean(data.is_finished));

      setMessages((m) => [
        ...m,
        { role: "assistant", content: assistantMessage, feedbackStatus: feedbackStatus || undefined },
      ]);

      if (activeProgressSession) {
        const skill = inferSkill(userText, verification);
        const mistake = inferMistake(userText, verification);
        const updatedProgressSession: ProgressSession = {
          ...activeProgressSession,
          reviewSteps: activeProgressSession.reviewSteps + 1,
          solved: activeProgressSession.solved || Boolean(data.is_finished),
          skills: activeProgressSession.skills.includes(skill)
            ? activeProgressSession.skills
            : [...activeProgressSession.skills, skill],
          mistakes: mistake && !activeProgressSession.mistakes.includes(mistake)
            ? [...activeProgressSession.mistakes, mistake]
            : activeProgressSession.mistakes,
        };

        setActiveProgressSession(updatedProgressSession);
        commitProgress((current) => {
          const next: LocalProgress = {
            ...current,
            totals: {
              ...current.totals,
              reviewSteps: current.totals.reviewSteps + 1,
              solved: data.is_finished && !activeProgressSession.solved
                ? current.totals.solved + 1
                : current.totals.solved,
            },
            topics: { ...current.topics },
            skills: { ...current.skills },
            mistakes: { ...current.mistakes },
            recentSessions: current.recentSessions,
          };

          incrementCount(next.skills, skill);
          if (mistake) incrementCount(next.mistakes, mistake);
          next.recentSessions = upsertRecentSession(next, updatedProgressSession);
          return next;
        });
      }

      if (data.is_finished) {
        setCorrect(true);
        setSolvedFinalAnswer(
          typeof data.final_answer === "string" && data.final_answer.trim()
            ? data.final_answer.trim()
            : userText
        );
        setCelebrating(true);
        void requestCompetitionShortcut(sessionId);
      }
    } catch (err) {
      console.error(err);
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: "I could not review that step just now. Please try sending it again.",
          feedbackStatus: "Need one more step",
        },
      ]);
    } finally {
      setLoading(false);
      setMessageAction(null);
    }
  }

  async function requestCompetitionShortcut(targetSessionId = sessionId) {
    if (!targetSessionId) return;

    try {
      setShortcutLoading(true);
      setShortcutError("");

      const res = await fetch("/api/session/shortcut", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionId: targetSessionId }),
      });

      const data = await readJsonResponse<{ shortcut?: CompetitionShortcut }>(res);

      if (!res.ok || !data.shortcut) {
        if (res.status === 404 && data.error === "Session not found") {
          setShortcutError("This coaching session expired. Start the problem again to continue.");
          return;
        }

        setShortcutError(data.error || "Could not generate a competition shortcut yet.");
        return;
      }

      setShortcut(data.shortcut);
      setShowShortcutReview(false);
    } catch (err) {
      console.error(err);
      setShortcutError("Could not generate a competition shortcut yet.");
    } finally {
      setShortcutLoading(false);
    }
  }

  // -----------------------------
  // RESET
  // -----------------------------
  function reset() {
    clearDemoTimers();

    setProblem("");
    setSubmittedProblem("");
    if (imagePreview) {
      URL.revokeObjectURL(imagePreview);
    }
    setImagePreview("");
    setImageBase64("");
    setImageMimeType("");
    setExtractingImage(false);
    setImageError("");
    setImagePromptInjectionReason("");
    setShowExtractedText(false);
    setDraggingImage(false);
    setSessionId(null);
    setStrategy(null);
    setStrategyCollapsed(false);
    setSolutionGuideStatus(null);
    setMessages([]);
    setInput("");
    setInputDisplay(null);
    setSessionNotice("");
    setCorrect(false);
    setSolvedFinalAnswer("");
    setCelebrating(false);
    setShortcut(null);
    setShortcutLoading(false);
    setShortcutError("");
    setShowShortcutReview(false);
    setActiveProgressSession(null);
    setDemoMode(false);
    setDemoStepIndex(0);
    setDemoThinking(false);
    setDemoTyping(false);
    setDemoTypedInput("");
  }

  // -----------------------------
  // LATEX RENDER
  // -----------------------------
  function renderMathText(
    text?: string,
    options?: { mathSource?: "coach" | "student"; preservePlainText?: boolean }
  ) {
    const parts = splitExplicitLatex(text || "", options?.mathSource === "coach" ? "loose" : "strict");
    const renderPlainTextWithMathRuns = (value: string, keyPrefix: string) =>
      splitPlainMath(value).map((plainPart, j) => {
        if (plainPart.math) {
          return (
            <InlineMath
              key={`${keyPrefix}-${j}`}
              math={expressionToLatex(plainPart.text)}
            />
          );
        }

        return <span key={`${keyPrefix}-${j}`}>{plainPart.text}</span>;
      });

    return parts.map((part, i) => {
      if (part.math) {
        return (
          <InlineMath
            key={i}
            math={inlineLatexForDisplay(part.text, options?.mathSource)}
          />
        );
      }

      if (options?.preservePlainText) {
        return <span key={i}>{renderPlainTextWithMathRuns(part.text, `preserved-${i}`)}</span>;
      }

      return renderPlainTextWithMathRuns(part.text, `${i}`);
    });
  }

  // -----------------------------
  // UI
  // -----------------------------
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      {celebrating && (
        <div
          className="pointer-events-none fixed inset-0 z-50 overflow-hidden"
          aria-hidden="true"
        >
          <div className="celebration-glow" />
          <div className="firework-stage">
            {celebrationParticles.map((particle, i) => (
              <span
                key={i}
                className="firework-particle"
                style={{
                  "--firework-left": particle.left,
                  "--firework-top": particle.top,
                  "--firework-x": particle.x,
                  "--firework-y": particle.y,
                  "--firework-delay": particle.delay,
                  "--firework-size": particle.size,
                  "--firework-color": particle.color,
                } as CSSProperties}
              />
            ))}
          </div>
        </div>
      )}

      {/* HEADER */}
      <div className="mb-5">
        <div className="rounded-xl border border-blue-100 bg-linear-to-r from-emerald-100 via-white to-blue-100 px-4 py-3 shadow-sm ring-1 ring-white/70">
          <h1 className="text-center text-3xl font-bold tracking-normal text-slate-950">Math Coach</h1>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2 text-xs font-medium sm:gap-3">
            <button
              type="button"
              onClick={() => setShowWhyCoach(true)}
              className="rounded-full bg-white/70 px-2.5 py-1 text-slate-600 shadow-sm ring-1 ring-white/70 transition hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 cursor-pointer"
            >
              Why this coach?
            </button>
            <Link
              href="/about"
              className="rounded-full bg-white/70 px-2.5 py-1 text-slate-600 shadow-sm ring-1 ring-white/70 transition hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
            >
              About
            </Link>
          </div>
        </div>
      </div>

      {showWhyCoach && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="why-coach-title"
          onClick={() => setShowWhyCoach(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-blue-100 bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-blue-100 bg-blue-50 px-6 py-5">
              <div className="flex flex-wrap items-start gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-blue-700 text-lg font-bold text-white">
                  ?
                </div>
                <div>
                  <h2 id="why-coach-title" className="text-2xl font-bold text-slate-950">
                    Why This Coach?
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-blue-950">
                    Built for practice, not answer dumping.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setShowWhyCoach(false)}
                  aria-label="Close coach details"
                  className="ml-auto rounded-full border border-blue-200 bg-white px-3 py-1 text-sm text-slate-700 shadow-sm hover:bg-blue-50 cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="px-6 py-5">
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  [
                    "Starter strategy",
                    "Each problem begins with a high-level plan, then the coach checks student work as it develops.",
                  ],
                  [
                    "Hints before solutions",
                    "Responses nudge the next useful move and avoid full solutions until the problem is solved.",
                  ],
                  [
                    "Contest shortcuts",
                    "After a solve, Competition Mode looks for faster competition-style recognition patterns.",
                  ],
                  [
                    "Free and nonprofit",
                    "The app is built for learning, with no ads or paid accounts required to practice.",
                  ],
                ].map(([title, body]) => (
                  <div key={title} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                    <div className="text-sm font-bold text-slate-950">{title}</div>
                    <div className="mt-1 text-sm leading-6 text-slate-700">{body}</div>
                  </div>
                ))}
              </div>

              <div className="mt-5 border-t border-blue-100 pt-5">
                <h3 className="text-sm font-bold uppercase text-blue-950">
                  Why I Built This
                </h3>
                <p className="mt-2 text-sm leading-6 text-slate-700">
                  When I prepared for math competitions, my parents helped me by giving hints
                  instead of letting me jump straight to solutions. That taught me that math is
                  about building problem-solving skills, not just getting the answer. As the
                  problems became more advanced, I wanted to create that kind of guidance for
                  every student: free, private, and focused on helping students reason their way
                  forward.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {showProgress && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="progress-title"
          onClick={() => setShowProgress(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-blue-100 bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-blue-100 bg-blue-50 px-6 py-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-blue-700 text-sm font-bold text-white">
                      %
                    </div>
                    <h2 id="progress-title" className="text-2xl font-bold text-slate-950">
                      Local Progress
                    </h2>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-blue-950">
                    Saved with localStorage in this browser only. No problem text, chat transcript, or uploaded image is stored.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setShowProgress(false)}
                  aria-label="Close progress dashboard"
                  className="shrink-0 rounded-full border border-blue-200 bg-white px-3 py-1 text-sm text-slate-700 shadow-sm hover:bg-blue-50 cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="space-y-5 px-6 py-5">
              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  ["Solved", localProgress.totals.solved.toString()],
                  ["Attempted", localProgress.totals.attempted.toString()],
                  ["Solve Rate", `${solvedRate}%`],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                    <div className="text-xs font-semibold uppercase text-slate-500">{label}</div>
                    <div className="mt-1 text-2xl font-bold text-slate-950">{value}</div>
                  </div>
                ))}
              </div>

              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                <div className="text-xs font-semibold uppercase text-amber-900">Coach Diagnosis</div>
                <div className="mt-3 grid gap-3 md:grid-cols-3">
                  {[
                    ["Strength", diagnosis.strength],
                    ["Focus", diagnosis.focus],
                    ["Next Practice", diagnosis.nextPractice],
                  ].map(([label, text]) => (
                    <div key={label} className="rounded-lg bg-white/75 p-3">
                      <div className="text-xs font-bold uppercase text-slate-600">{label}</div>
                      <div className="mt-1 text-sm leading-6 text-slate-800">{text}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <h3 className="text-sm font-bold uppercase text-slate-700">Topics</h3>
                  <div className="mt-2 space-y-2">
                    {topTopics.length ? topTopics.map(([topic, count]) => (
                      <div key={topic} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
                        <span>{topic}</span>
                        <span className="font-semibold text-slate-700">{count}</span>
                      </div>
                    )) : (
                      <div className="text-sm text-slate-500">No practice yet.</div>
                    )}
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-bold uppercase text-slate-700">Skills Seen</h3>
                  <div className="mt-2 space-y-2">
                    {topSkills.length ? topSkills.map(([skill, count]) => (
                      <div key={skill} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
                        <span>{skill}</span>
                        <span className="font-semibold text-slate-700">{count}</span>
                      </div>
                    )) : (
                      <div className="text-sm text-slate-500">Skills appear after coach reviews.</div>
                    )}
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-bold uppercase text-slate-700">Watch Outs</h3>
                  <div className="mt-2 space-y-2">
                    {topMistakes.length ? topMistakes.map(([mistake, count]) => (
                      <div key={mistake} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
                        <span>{mistake}</span>
                        <span className="font-semibold text-slate-700">{count}</span>
                      </div>
                    )) : (
                      <div className="text-sm text-slate-500">No recurring errors logged.</div>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-sm font-bold uppercase text-slate-700">Recent Sessions</h3>
                <div className="mt-2 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
                  {localProgress.recentSessions.length ? localProgress.recentSessions.map((recent) => (
                    <div key={recent.id} className="flex flex-wrap items-center gap-3 bg-white px-3 py-2 text-sm">
                      <span className="font-medium text-slate-900">{recent.topic}</span>
                      <span className="text-slate-500">
                        {new Date(recent.date).toLocaleDateString()}
                      </span>
                      <span className={recent.solved ? "text-emerald-700" : "text-slate-500"}>
                        {recent.solved ? "Solved" : "In progress"}
                      </span>
                      <span className="ml-auto text-slate-500">
                        {recent.reviewSteps} coach review{recent.reviewSteps === 1 ? "" : "s"}
                      </span>
                    </div>
                  )) : (
                    <div className="bg-white px-3 py-3 text-sm text-slate-500">
                      Start a session and this will fill in without saving the problem itself.
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
                <div>
                  <p className="text-xs leading-5 text-slate-500">
                    This is a local diagnosis for this browser, not an account profile. Export a backup before clearing browser data or switching devices.
                  </p>
                  {progressBackupStatus && (
                    <p className="mt-1 text-xs font-medium text-blue-700">{progressBackupStatus}</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={exportLocalProgress}
                    className="rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm font-medium text-blue-700 shadow-sm hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 cursor-pointer"
                  >
                    Export Progress
                  </button>
                  <button
                    type="button"
                    onClick={() => progressImportRef.current?.click()}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 cursor-pointer"
                  >
                    Import Progress
                  </button>
                  <input
                    ref={progressImportRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={(e) => {
                      void importLocalProgress(e.target.files?.[0] ?? null);
                      e.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    onClick={clearLocalProgress}
                    className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 shadow-sm hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 cursor-pointer"
                  >
                    Clear Local Progress
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="mx-auto w-full max-w-3xl">
        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={startDemoMode}
            disabled={loading || extractingImage}
            className="rounded-lg border border-indigo-200 bg-white px-3 py-2 text-sm font-medium text-indigo-800 shadow-sm hover:border-indigo-300 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
          >
            Demo Mode
          </button>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowProgress(true)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 cursor-pointer"
            >
              Progress
            </button>

            {hasResettableWorkspace && (
              <button
                type="button"
                onClick={reset}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 cursor-pointer"
              >
                Reset
              </button>
            )}
          </div>
        </div>

      {showOriginalProblem && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold uppercase text-slate-600">Original Problem</h2>
          {imagePreview && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imagePreview}
              alt="Uploaded math problem"
              className="mb-3 border rounded max-w-full"
            />
          )}
          {imagePreview ? (
            <div>
              {problem.trim() && (
                <button
                  type="button"
                  onClick={() => setShowExtractedText((visible) => !visible)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 cursor-pointer"
                >
                  {showExtractedText ? "Hide Extracted Text" : "Edit Extracted Text"}
                </button>
              )}

              {showExtractedText && (
                <textarea
                  className="mt-3 w-full rounded-lg border border-slate-300 bg-white p-3 text-sm leading-6 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                  rows={4}
                  value={problem}
                  onChange={(e) => setProblem(e.target.value)}
                />
              )}
            </div>
          ) : displayProblem.trim() ? (
            <div className="math-copy leading-7 text-slate-900">
              {renderMathText(displayProblem, { mathSource: "coach" })}
            </div>
          ) : (
            <div className="text-sm text-slate-600">Image problem attached.</div>
          )}
        </div>
      )}

      {sessionNotice && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 shadow-sm">
          {sessionNotice}
        </div>
      )}

      {demoMode && !strategy && (
        <div className="mt-4 rounded-lg border border-dashed border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={beginDemoStrategy}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-lg border border-blue-700 bg-blue-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 cursor-pointer disabled:cursor-not-allowed disabled:border-blue-300 disabled:bg-blue-300 disabled:opacity-80"
            >
              {loading && <ButtonSpinner />}
              {loading ? "Thinking..." : "Get Strategy"}
            </button>
          </div>
        </div>
      )}

      {!sessionId && !demoMode && (
        <div
          onPaste={(e) => {
            const imageFile = firstClipboardImage(e.clipboardData?.items);

            if (imageFile) {
              e.preventDefault();
              void handleImageUpload(imageFile);
            }
          }}
          onDragEnter={(e) => {
            if (firstImageFile(e.dataTransfer.files) || e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setDraggingImage(true);
            }
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setDraggingImage(true);
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setDraggingImage(false);
            }
          }}
          onDrop={(e) => {
            const imageFile = firstImageFile(e.dataTransfer.files);

            if (imageFile) {
              e.preventDefault();
              setDraggingImage(false);
              void handleImageUpload(imageFile);
            }
          }}
          className={[
            "mt-4 rounded-lg border border-dashed border-slate-200 bg-white p-4 shadow-sm",
            draggingImage ? "border-blue-400 bg-blue-50 ring-2 ring-blue-100" : "",
          ].join(" ")}
        >
          {/* PROBLEM INPUT */}
          {!showOriginalProblem && (
            <textarea
              ref={problemTextareaRef}
              autoFocus
              className="min-h-32 w-full resize-none overflow-hidden rounded-lg border border-slate-300 bg-white p-4 leading-6 shadow-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
              rows={5}
              value={problem}
              maxLength={MAX_PROBLEM_CHARS}
              onChange={(e) => {
                setProblem(e.target.value);
                resizeTextarea(e.currentTarget);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitProblem();
                }
              }}
              placeholder="Enter a math problem, or upload an image..."
            />
          )}

          {imageError && (
            <div className="mt-2 text-sm text-red-600">{imageError}</div>
          )}

          <div className="flex flex-wrap gap-3 mt-3">
            <label
              className={[
                "inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 cursor-pointer",
                extractingImage ? "pointer-events-none opacity-60" : "",
              ].join(" ")}
            >
              {imagePreview ? "Change Problem Image" : "Upload Problem Image"}

              <input
                type="file"
                accept={ALLOWED_IMAGE_MIME_TYPES.join(",")}
                className="hidden"
                disabled={extractingImage || loading}
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  void handleImageUpload(file);
                  e.target.value = "";
                }}
              />
            </label>

            {imagePreview && (
              <button
                type="button"
                onClick={() => {
                  URL.revokeObjectURL(imagePreview);
                  setImagePreview("");
                  setImageBase64("");
                  setImageMimeType("");
                  setImageError("");
                  setShowExtractedText(false);
                }}
                disabled={extractingImage || loading}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
              >
                Remove Image
              </button>
            )}

            {/* START */}
            <button
              onClick={submitProblem}
              disabled={loading || extractingImage || (!problem.trim() && !imageBase64)}
              className="ml-auto inline-flex items-center gap-2 rounded-lg border border-blue-700 bg-blue-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 cursor-pointer disabled:cursor-not-allowed disabled:border-blue-300 disabled:bg-blue-300 disabled:opacity-80"
            >
              {(loading || extractingImage) && <ButtonSpinner />}
              {loading ? "Thinking..." : extractingImage ? "Reading Image..." : "Get Strategy"}
            </button>
          </div>
        </div>
      )}

      {/* -----------------------------
          STRATEGY PANEL
      ----------------------------- */}
      {strategy && (
        <div className="mt-6 rounded-lg border border-indigo-100 bg-indigo-50/70 p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-bold uppercase text-indigo-950">Strategy</h2>

            {hasStudentMessage && (
              <button
                type="button"
                onClick={() => setStrategyCollapsed((collapsed) => !collapsed)}
                aria-expanded={!strategyCollapsed}
                className="ml-auto rounded-lg border border-indigo-200 bg-white px-3 py-1.5 text-sm font-medium text-indigo-950 shadow-sm hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 cursor-pointer"
              >
                {strategyCollapsed ? "Show" : "Hide"}
              </button>
            )}
          </div>

          {!strategyCollapsed && (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <div className="text-xs font-semibold uppercase text-indigo-800">Game Plan</div>
                <div className="math-copy mt-1 leading-7 text-slate-950">{renderMathText(strategy.game_plan, { mathSource: "coach" })}</div>
              </div>

              <div>
                <div className="text-xs font-semibold uppercase text-indigo-800">What To Look For</div>
                <div className="math-copy mt-1 leading-7 text-slate-950">{renderMathText(strategy.what_to_look_for, { mathSource: "coach" })}</div>
              </div>

              <div>
                <div className="text-xs font-semibold uppercase text-indigo-800">Smart Move</div>
                <div className="math-copy mt-1 leading-7 text-slate-950">{renderMathText(strategy.smart_move, { mathSource: "coach" })}</div>
              </div>

              <div>
                <div className="text-xs font-semibold uppercase text-indigo-800">Your Turn</div>
                <div className="math-copy mt-1 leading-7 text-slate-950">{renderMathText(strategy.your_turn, { mathSource: "coach" })}</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* -----------------------------
          CHAT SECTION
      ----------------------------- */}
      {(sessionId || demoMode) && solutionGuideStatus !== "pending" && (
        <div className="mt-6">

          <div className="space-y-4">
            {messages.map((m, i) => {
              const isUser = m.role === "user";
              const isLatestMessage = i === messages.length - 1;

              return (
                <div
                  key={i}
                  ref={isLatestMessage ? latestMessageRef : null}
                  className={[
                    "rounded-lg border p-5 shadow-sm",
                    isUser
                      ? "border-blue-200 bg-blue-50/90"
                      : "border-slate-200 bg-white",
                  ].join(" ")}
                >
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div
                      className={[
                        "inline-flex rounded-full px-2.5 py-1 text-xs font-semibold",
                        isUser
                          ? "bg-blue-700 text-white"
                          : "bg-slate-800 text-white",
                      ].join(" ")}
                    >
                      {isUser ? "You" : "Coach"}
                    </div>
                    {!isUser && m.feedbackStatus && (
                      <div
                        className={[
                          "inline-flex max-w-full rounded-full border px-2.5 py-1 text-xs font-semibold",
                          feedbackStatusClass(m.feedbackStatus),
                        ].join(" ")}
                      >
                        {m.feedbackStatus}
                      </div>
                    )}
                  </div>
                  {!isUser && m.feedbackStatus ? (
                    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                      <div className="text-xs font-bold uppercase text-slate-500">Next</div>
                      <div className="math-copy mt-1 leading-7 text-slate-900">
                        {renderMathText(m.content, { mathSource: "coach" })}
                      </div>
                    </div>
                  ) : (
                    <div className="math-copy leading-7 text-slate-900">
                      {renderMathText(m.displayContent || m.content, {
                        mathSource: isUser ? "student" : "coach",
                        preservePlainText: isUser && Boolean(m.displayContent),
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {demoMode && demoTyping && (
            <div className="mt-4 flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-2 shadow-sm sm:flex-row">
              <div className="flex min-w-0 flex-1 items-center gap-1 rounded-lg border border-blue-500 bg-white px-2 py-1 ring-2 ring-blue-100">
                <button
                  type="button"
                  disabled
                  title="Math keyboard"
                  aria-label="Math keyboard"
                  className="flex h-9 w-9 shrink-0 cursor-not-allowed items-center justify-center rounded-md bg-blue-100 text-sm font-semibold text-blue-800 opacity-70"
                >
                  &sum;
                </button>
                <button
                  type="button"
                  disabled
                  title="Text mode"
                  aria-label="Text mode"
                  className="flex h-9 w-9 shrink-0 cursor-not-allowed items-center justify-center rounded-md text-xs font-semibold text-slate-500 opacity-70"
                >
                  Aa
                </button>
                <div className="min-h-9 min-w-0 flex-1 px-2 py-1.5 leading-6 text-slate-900">
                  <span className="whitespace-pre-wrap">{demoTypedInput}</span>
                  <span
                    className="ml-0.5 inline-block h-5 w-0.5 translate-y-0.5 animate-pulse bg-blue-700"
                    aria-hidden="true"
                  />
                </div>
              </div>
              <div className="flex w-full flex-col gap-2 sm:w-32">
                <button
                  type="button"
                  disabled
                  className="inline-flex min-h-0 flex-1 w-full items-center justify-center gap-2 rounded-lg border border-blue-300 bg-blue-300 px-2.5 py-2 text-sm font-semibold text-white shadow-sm opacity-80"
                >
                  Review Step
                </button>
              </div>
            </div>
          )}

          {demoMode && !correct && (
            <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-indigo-100 bg-indigo-50/70 p-3 shadow-sm">
              <div className="mr-auto text-sm font-medium text-indigo-950">
                Demo step {Math.min(demoStepIndex + 1, demoScenario.turns.length)} of {demoScenario.turns.length}
              </div>
              <button
                type="button"
                onClick={advanceDemoStep}
                disabled={demoThinking || demoTyping}
                className="inline-flex items-center gap-2 rounded-lg border border-indigo-700 bg-indigo-700 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 cursor-pointer disabled:cursor-not-allowed disabled:border-indigo-300 disabled:bg-indigo-300 disabled:opacity-80"
              >
                {(demoThinking || demoTyping) && <ButtonSpinner />}
                {demoTyping ? "Typing..." : demoThinking ? "Thinking..." : "Next Demo Step"}
              </button>
              <button
                type="button"
                onClick={startDemoMode}
                disabled={demoThinking || demoTyping}
                className="rounded-lg border border-indigo-200 bg-white px-3 py-2 text-sm font-semibold text-indigo-800 shadow-sm hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 cursor-pointer"
              >
                Restart Demo
              </button>
              <button
                type="button"
                onClick={reset}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 cursor-pointer"
              >
                Exit Demo
              </button>
            </div>
          )}

          {!correct && !demoMode && (
            <div className="mt-4 flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-2 shadow-sm sm:flex-row">
              <MathStepInput
                value={input}
                disabled={composerDisabled}
                autoFocus={!composerDisabled}
                modeResetKey={sessionId}
                maxChars={MAX_STUDENT_MESSAGE_CHARS}
                onChange={(value, displayValue) => {
                  setInput(value);
                  setInputDisplay(displayValue || null);
                }}
                onSubmit={sendMessage}
                placeholder="Your next step"
              />

              <div className="flex w-full shrink-0 flex-col gap-2 self-stretch sm:w-36">
                {hasDraftInput ? (
                  <>
                    <button
                      type="button"
                      onClick={() => sendMessage("review")}
                      disabled={composerDisabled}
                      className="inline-flex min-h-0 flex-1 w-full items-center justify-center gap-2 rounded-lg border border-blue-700 bg-blue-700 px-2.5 py-2 text-sm font-semibold text-white shadow-sm cursor-pointer hover:bg-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-blue-300 disabled:bg-blue-300 disabled:opacity-80"
                    >
                      {loading && messageAction === "review" && <ButtonSpinner />}
                      {loading && messageAction === "review" ? "Reviewing..." : "Review Step"}
                    </button>
                    <button
                      type="button"
                      onClick={() => sendMessage("answer")}
                      disabled={composerDisabled}
                      className="inline-flex min-h-0 flex-1 w-full items-center justify-center gap-2 rounded-lg border border-blue-200 bg-white px-2.5 py-2 text-sm font-semibold text-blue-800 shadow-sm cursor-pointer hover:border-blue-300 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-blue-300 disabled:opacity-80"
                    >
                      {loading && messageAction === "answer" && <ButtonSpinner />}
                      {loading && messageAction === "answer" ? "Checking..." : "Check Answer"}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => sendMessage("stuck")}
                    disabled={composerDisabled}
                    className="inline-flex flex-1 w-full items-center justify-center gap-2 rounded-lg border border-blue-700 bg-blue-700 px-2.5 py-2 text-sm font-semibold text-white shadow-sm cursor-pointer hover:bg-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-blue-300 disabled:bg-blue-300 disabled:opacity-80"
                  >
                    {loading && <ButtonSpinner />}
                    {loading ? "Thinking..." : "Coach Me"}
                  </button>
                )}
              </div>
            </div>
          )}

          {correct && (
            <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50/80 p-5 shadow-sm">
              <div className="flex flex-wrap items-center gap-3">
                <div>
                  <div className="text-sm font-bold uppercase text-emerald-950">
                    Solved
                  </div>
                  {solvedFinalAnswer && (
                    <div className="mt-1 text-sm text-emerald-950">
                      <span className="font-semibold">Final answer:</span>{" "}
                      <span className="math-copy">
                        {renderMathText(solvedFinalAnswer, { mathSource: "student" })}
                      </span>
                    </div>
                  )}
                  <div className="mt-1 flex items-center gap-2 text-sm text-emerald-900">
                    {shortcutLoading && !shortcut && (
                      <span
                        className="h-3 w-3 animate-spin rounded-full border-2 border-emerald-300 border-t-emerald-800"
                        aria-hidden="true"
                      />
                    )}
                    <span>
                      {demoMode
                        ? "Demo complete."
                        : shortcutLoading && !shortcut
                          ? "Checking whether there is a faster contest-style idea."
                          : shortcut?.has_shortcut
                            ? "Faster contest-style idea found."
                            : "Shortcut check complete."}
                    </span>
                  </div>
                </div>

                <div className="ml-auto flex flex-wrap gap-2">
                  {demoMode ? (
                    <button
                      type="button"
                      onClick={startDemoMode}
                      className="rounded-lg border border-emerald-700 bg-emerald-700 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
                    >
                      Restart Demo
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setShowShortcutReview(true);
                        window.setTimeout(() => {
                          const shortcutPanel = document.getElementById("competition-shortcut-panel");
                          shortcutPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
                        }, 0);
                      }}
                      disabled={shortcutLoading || !shortcut}
                      className="rounded-lg border border-emerald-700 bg-emerald-700 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-emerald-300 disabled:bg-emerald-300 disabled:opacity-80"
                    >
                      {showShortcutReview ? "Shortcut Shown" : "Review Shortcut"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={reset}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
                  >
                    Start New Problem
                  </button>
                  {!demoMode && (
                    <button
                      type="button"
                      onClick={() => setShowProgress(true)}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
                    >
                      View Progress
                    </button>
                  )}
                </div>
              </div>

              {!demoMode && shortcutError && (
                <div className="mt-3 text-sm text-red-700">{shortcutError}</div>
              )}

              {!demoMode && shortcut && showShortcutReview && (
                <div
                  id="competition-shortcut-panel"
                  className="math-copy mt-4 space-y-4 rounded-lg border border-emerald-100 bg-white/80 p-4 text-base leading-7 text-slate-950"
                >
                  <div className="text-sm font-bold uppercase text-emerald-950">
                    Competition Mode
                  </div>
                  {shortcut.has_shortcut ? (
                    <>
                      <div>
                        <div className="font-semibold text-emerald-950">
                          {renderMathText(shortcut.shortcut_title || "Competition Shortcut", {
                            mathSource: "coach",
                          })}
                        </div>
                        {shortcut.why_different && (
                          <div className="text-sm leading-6 text-slate-700">
                            {renderMathText(shortcut.why_different, { mathSource: "coach" })}
                          </div>
                        )}
                      </div>

                      {shortcut.recognition_cue && (
                        <div>
                          <div className="text-sm font-semibold text-slate-700">
                            Recognition Cue
                          </div>
                          <div>{renderMathText(shortcut.recognition_cue, { mathSource: "coach" })}</div>
                        </div>
                      )}

                      {shortcut.faster_move && (
                        <div>
                          <div className="text-sm font-semibold text-slate-700">
                            Faster Move
                          </div>
                          <div>{renderMathText(shortcut.faster_move, { mathSource: "coach" })}</div>
                        </div>
                      )}

                      {shortcut.why_it_saves_time && (
                        <div>
                          <div className="text-sm font-semibold text-slate-700">
                            Why It Saves Time
                          </div>
                          <div>{renderMathText(shortcut.why_it_saves_time, { mathSource: "coach" })}</div>
                        </div>
                      )}

                      {shortcut.quick_check && (
                        <div>
                          <div className="text-sm font-semibold text-slate-700">
                            Quick Check
                          </div>
                          <div>{renderMathText(shortcut.quick_check, { mathSource: "coach" })}</div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div>
                      {renderMathText(
                        shortcut.no_shortcut_reason ||
                          "You solved the problem using the fastest method available.",
                        { mathSource: "coach" }
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      </div>
    </main>
  );
}
