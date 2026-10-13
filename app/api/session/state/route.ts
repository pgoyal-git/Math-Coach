import {
  getSession,
  sessionHydrationStore,
  setSession,
  usesDistributedSessionStore,
} from "@/lib/sessionStore";

const CHECKER_TIMEOUT_MS = 115_000;

export async function POST(req: Request) {
  const { sessionId } = await req.json();

  if (typeof sessionId !== "string") {
    return Response.json({ error: "Missing sessionId" }, { status: 400 });
  }

  let state = await getSession(sessionId);

  if (!state) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  const hydration = sessionHydrationStore.get(sessionId);
  if (
    state.solutionGuideStatus === "pending" &&
    hydration &&
    !usesDistributedSessionStore()
  ) {
    await hydration;
    state = await getSession(sessionId);

    if (!state) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
  }

  if (
    state.solutionGuideStatus === "pending" &&
    typeof state.solutionGuideStartedAt === "number" &&
    Date.now() - state.solutionGuideStartedAt > CHECKER_TIMEOUT_MS
  ) {
    state.solutionGuideStatus = "failed";
    delete state.solutionGuideStartedAt;
    await setSession(sessionId, state);
  }

  return Response.json({
    sessionId: state.sessionId,
    topic: state.topic,
    strategy: state.strategy,
    solutionGuideStatus: state.solutionGuideStatus,
    solved: state.solved,
    hasImage: Boolean(state.problemImage),
    hintState: state.hintState,
    workState: {
      acceptedCount: state.workState.acceptedLines.length,
      rejectedCount: state.workState.rejectedLines.length,
      hasLastValidLine: Boolean(state.workState.lastValidLine),
    },
    competitionShortcut: state.competitionShortcut,
  });
}
