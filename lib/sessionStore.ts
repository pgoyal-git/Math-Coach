import { Redis } from "@upstash/redis";

export type CoachMessage = {
  role: "user" | "assistant";
  content: string;
};

export type Strategy = {
  game_plan?: string;
  what_to_look_for?: string;
  smart_move?: string;
  your_turn?: string;
};

export type ProblemImage = {
  imageBase64: string;
  mimeType: string;
};

export type SecurityFlag = {
  source: "problem" | "image_extraction" | "student_message";
  reasons: string[];
};

export type WorkState = {
  acceptedLines: string[];
  lastValidLine: string | null;
  rejectedLines: string[];
};

export type HintState = {
  stepIndex: number;
  hintLevel: number;
  stuckCount: number;
  completedSteps: number[];
};

export type InteractionIntent =
  | "submitted_work"
  | "final_answer"
  | "forward_help"
  | "clarification"
  | "concept_question"
  | "method_not_working"
  | "off_topic"
  | "unclear";

export type CoachingState = {
  lastSubstantiveAcceptedStep: string | null;
  knownFacts: string[];
  currentGoal: string | null;
  currentSubgoal: string | null;
  lastCoachQuestion: string | null;
  expectedResponseShape: string | null;
  activeMethod: string | null;
  misconceptions: string[];
  helpEpisode: {
    active: boolean;
    target: string | null;
    helpRequestCount: number;
    nonProgressCount: number;
    previousHints: string[];
  };
};

export type CompetitionShortcut = {
  has_shortcut: boolean;
  shortcut_title: string | null;
  why_different: string | null;
  recognition_cue: string | null;
  faster_move: string | null;
  why_it_saves_time: string | null;
  quick_check: string | null;
  no_shortcut_reason: string | null;
};

export type SolutionGuide = {
  finalAnswer: string | null;
  solutionOutline: string[];
  keyCheckpoints: string[];
  alternateMethods: string[];
  commonWrongPaths: string[];
  confidence: number;
  caution: string | null;
};

export type SolutionGuideStatus = "pending" | "ready" | "failed";

export type CoachSession = {
  sessionId: string;
  problem: string;
  problemImage: ProblemImage | null;
  topic: string;
  securityFlags: SecurityFlag[];
  strategy: Strategy;
  history: CoachMessage[];
  summary: string;
  hintState: HintState;
  workState: WorkState;
  coachingState?: CoachingState;
  solved: boolean;
  competitionShortcut: CompetitionShortcut | null;
  solutionGuide: SolutionGuide | null;
  solutionGuideStatus: SolutionGuideStatus;
  solutionGuideStartedAt?: number;
};

const SESSION_KEY_PREFIX = "math-coach:session:";
const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;

export const sessionStore = new Map<string, CoachSession>();
export const sessionHydrationStore = new Map<string, Promise<void>>();

let redisClient: Redis | null = null;

function hasRedisConfiguration() {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

function redis() {
  redisClient ??= Redis.fromEnv();
  return redisClient;
}

function sessionTtlSeconds() {
  const configured = Number.parseInt(process.env.SESSION_TTL_SECONDS || "", 10);
  return Number.isFinite(configured) && configured >= 300
    ? configured
    : DEFAULT_SESSION_TTL_SECONDS;
}

function sessionKey(sessionId: string) {
  return `${SESSION_KEY_PREFIX}${sessionId}`;
}

export function usesDistributedSessionStore() {
  return hasRedisConfiguration();
}

export async function getSession(sessionId: string) {
  if (!hasRedisConfiguration()) {
    return sessionStore.get(sessionId) ?? null;
  }

  try {
    const session = await redis().get<CoachSession>(sessionKey(sessionId));
    if (session) sessionStore.set(sessionId, session);
    return session ?? null;
  } catch (error) {
    console.error("Distributed session read failed; using the local fallback.", error);
    return sessionStore.get(sessionId) ?? null;
  }
}

export async function setSession(sessionId: string, session: CoachSession) {
  sessionStore.set(sessionId, session);

  if (!hasRedisConfiguration()) return;

  await redis().set(sessionKey(sessionId), session, {
    ex: sessionTtlSeconds(),
  });
}

export async function deleteSession(sessionId: string) {
  sessionStore.delete(sessionId);
  sessionHydrationStore.delete(sessionId);

  if (!hasRedisConfiguration()) return;

  await redis().del(sessionKey(sessionId));
}
