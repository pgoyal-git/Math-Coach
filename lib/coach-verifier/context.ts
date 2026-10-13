import type { CoachSession, Strategy } from "@/lib/sessionStore";

export function normalizeMathText(text: string) {
  return text
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()]/g, "")
    .replace(/\*\*/g, "^")
    .replace(/×/g, "*");
}

export function lastAssistantMessage(session: CoachSession) {
  return [...session.history].reverse().find((entry) => entry.role === "assistant")?.content || "";
}

export function recentSessionText(session: CoachSession) {
  return [
    session.problem,
    ...(session.workState?.acceptedLines || []),
    ...session.history.slice(-8).map((entry) => entry.content),
  ].join(" ");
}

export function strategyToText(strategy: Strategy) {
  return [
    strategy.game_plan && `Game plan: ${strategy.game_plan}`,
    strategy.what_to_look_for && `What to look for: ${strategy.what_to_look_for}`,
    strategy.smart_move && `Smart move: ${strategy.smart_move}`,
    strategy.your_turn && `Your turn: ${strategy.your_turn}`,
  ]
    .filter(Boolean)
    .join("\n");
}
