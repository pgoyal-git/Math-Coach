import type OpenAI from "openai";

type ModerationClient = Pick<OpenAI, "moderations">;

export type ModerationInput = {
  text?: string | null;
  image?: { imageBase64: string; mimeType: string } | null;
};

export type ModerationDecision = {
  flagged: boolean;
  categories: string[];
};

export class ContentModerationUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("Content moderation is temporarily unavailable.", { cause });
    this.name = "ContentModerationUnavailableError";
  }
}

export async function moderateUserContent(
  client: ModerationClient,
  input: ModerationInput
): Promise<ModerationDecision> {
  const text = input.text?.trim() || "";
  const moderationInput: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [];

  if (text) moderationInput.push({ type: "text", text });
  if (input.image?.imageBase64 && input.image.mimeType) {
    moderationInput.push({
      type: "image_url",
      image_url: {
        url: `data:${input.image.mimeType};base64,${input.image.imageBase64}`,
      },
    });
  }

  if (moderationInput.length === 0) return { flagged: false, categories: [] };

  try {
    const response = await client.moderations.create({
      model: "omni-moderation-latest",
      input: moderationInput,
    });
    const categories = new Set<string>();

    for (const result of response.results) {
      for (const [category, flagged] of Object.entries(result.categories)) {
        if (flagged === true) categories.add(category);
      }
    }

    return {
      flagged: response.results.some((result) => result.flagged),
      categories: [...categories],
    };
  } catch (error) {
    throw new ContentModerationUnavailableError(error);
  }
}

export function moderationBlockedMessage(decision: ModerationDecision) {
  const selfHarm = decision.categories.some((category) => category.startsWith("self-harm"));

  if (selfHarm) {
    return "I’m glad you reached out. I can’t help with self-harm content, but you deserve support. Please tell a trusted adult now. If you may be in immediate danger, contact your local emergency services.";
  }

  return "I can’t process that content. Please keep messages respectful and focused on the math problem.";
}

export function isModerationUnavailableError(
  error: unknown
): error is ContentModerationUnavailableError {
  return error instanceof ContentModerationUnavailableError;
}
