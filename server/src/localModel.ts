// Shared helpers for calling the local Ollama model with schema-constrained
// JSON output and validating that output field by field.
import { z } from "zod";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type OllamaDeps = {
  fetch: FetchLike;
  ollamaUrl: string;
  model: string;
  timeoutMs?: number;
};

export type ChatJsonFailure =
  | "timeout" // No answer in time.
  | "unavailable" // Ollama could not be reached.
  | "http-error" // Ollama answered with an error status.
  | "empty" // The model returned no content.
  | "truncated" // The model hit its output limit mid-answer.
  | "malformed"; // The content is not valid JSON.

export type ChatJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; failure: ChatJsonFailure };

// Model-output problems that a second, differently configured attempt may fix.
export const RETRYABLE_FAILURES = new Set<ChatJsonFailure>([
  "empty",
  "truncated",
  "malformed",
]);

// One non-streaming chat request whose output Ollama constrains to `format`
// (a JSON schema). Never throws.
export async function chatJson(
  deps: OllamaDeps,
  request: {
    system: string;
    user: string;
    format: object;
    options: Record<string, number>;
  },
  defaultTimeoutMs: number,
): Promise<ChatJsonResult> {
  let result: { message?: { content?: string }; done_reason?: string };

  try {
    const response = await deps.fetch(`${deps.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: deps.model,
        stream: false,
        format: request.format,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        options: request.options,
      }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? defaultTimeoutMs),
    });

    if (!response.ok) return { ok: false, failure: "http-error" };

    result = (await response.json()) as typeof result;
  } catch (error) {
    return {
      ok: false,
      failure:
        error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "unavailable",
    };
  }

  const content = result.message?.content;
  if (!content) return { ok: false, failure: "empty" };
  if (result.done_reason === "length") return { ok: false, failure: "truncated" };

  try {
    return { ok: true, value: JSON.parse(content) as unknown };
  } catch {
    return { ok: false, failure: "malformed" };
  }
}

// Validate each field of `schema` separately so one malformed field doesn't
// discard the rest. Invalid fields fall back to empty values (keeping the
// valid entries of a partly malformed list, and the valid fields of a nested
// object) and are reported by name, e.g. "budget.amount".
export function parseFields<T extends z.ZodObject>(
  schema: T,
  raw: unknown,
  path = "",
): { output: z.infer<T>; invalidFields: string[] } {
  const source =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const output: Record<string, unknown> = {};
  const invalidFields: string[] = [];

  for (const [key, field] of Object.entries(schema.shape)) {
    const value = source[key];
    const parsed = (field as z.ZodType).safeParse(value);

    if (parsed.success) {
      output[key] = parsed.data;
      continue;
    }

    if (field instanceof z.ZodObject) {
      const nested = parseFields(field, value, `${path}${key}.`);
      output[key] = nested.output;
      invalidFields.push(...nested.invalidFields);
      continue;
    }

    invalidFields.push(`${path}${key}`);
    if (field instanceof z.ZodArray) {
      output[key] = Array.isArray(value)
        ? value.flatMap((item) => {
            const entry = z.safeParse(field.element, item);
            return entry.success ? [entry.data] : [];
          })
        : [];
    } else {
      output[key] = field instanceof z.ZodNullable ? null : "";
    }
  }

  return { output: output as z.infer<T>, invalidFields };
}
