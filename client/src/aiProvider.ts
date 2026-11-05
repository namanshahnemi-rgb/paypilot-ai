// Which AI provider the backend is configured to use (GET /api/health), and
// the labels the UI shows for it. Until the backend answers, or if it cannot
// be reached, the UI names no provider rather than guessing one.
import { requestJson } from "./api.ts";

export type AiProvider = "Gemini" | "Ollama" | "unknown";

export type AiProviderLabels = {
  badge: string; // Top bar.
  note: string; // Under the proposal buttons.
  draftLoading: string; // While a proposal is drafted.
  reviewTag: string; // AI review heading tag.
  reviewIntro: string; // Before the first AI review.
  reviewLoading: string; // AI review button while reviewing.
};

// Only Ollama is described as local. The unknown labels name no provider and
// make no claim about where data is processed.
export const AI_PROVIDER_LABELS: Record<AiProvider, AiProviderLabels> = {
  Gemini: {
    badge: "CLOUD AI · GEMINI",
    note: "Runs through the Google Gemini API configured on the server, so your brief is sent to Google for processing.",
    draftLoading: "Gemini is writing a structured draft.",
    reviewTag: "Gemini · recommendations",
    reviewIntro:
      "Ask Gemini to look for ambiguous wording and commitments the automatic checks can't detect. The proposal and its brief are sent to Google for the review.",
    reviewLoading: "Reviewing with Gemini...",
  },
  Ollama: {
    badge: "LOCAL AI · OLLAMA",
    note: "Runs through your local Ollama model. No paid AI API required.",
    draftLoading: "The local model is writing a structured draft.",
    reviewTag: "Local model · recommendations",
    reviewIntro:
      "Ask the local model to look for ambiguous wording and commitments the automatic checks can't detect. Nothing is sent outside your computer.",
    reviewLoading: "Reviewing with the local model...",
  },
  unknown: {
    badge: "AI PROVIDER UNKNOWN",
    note: "Uses the AI provider configured on the PayPilot server.",
    draftLoading: "AI is writing a structured draft.",
    reviewTag: "AI · recommendations",
    reviewIntro:
      "Ask AI to review the proposal for ambiguous wording and commitments the automatic checks can't detect.",
    reviewLoading: "Reviewing with AI...",
  },
};

export function toAiProvider(value: unknown): AiProvider {
  return value === "Gemini" || value === "Ollama" ? value : "unknown";
}

// Never throws: any failure gives "unknown".
export async function fetchAiProvider(apiUrl: string): Promise<AiProvider> {
  try {
    const { response, data } = await requestJson<{ aiProvider?: unknown }>(
      `${apiUrl}/api/health`,
    );
    return response.ok ? toAiProvider(data.aiProvider) : "unknown";
  } catch {
    return "unknown";
  }
}
