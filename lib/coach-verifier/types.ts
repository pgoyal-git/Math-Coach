export type VerificationIntent =
  | "final_answer"
  | "submitted_work"
  | "question"
  | "unclear";

export type VerificationStatus =
  | "correct"
  | "incorrect"
  | "partially_correct"
  | "uncertain";

export type VerificationResult = {
  intent: VerificationIntent;
  status: VerificationStatus;
  local_error: string | null;
  valid_progress: string | null;
  suggested_next_check: string | null;
  should_finish: boolean;
  confidence: number;
  source: "deterministic" | "symbolic" | "model";
};
