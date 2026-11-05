// Shared helpers for calling the AI model (local Ollama by default, or the
// Gemini Developer API) with schema-constrained JSON output and validating
// that output field by field.
import { z } from "zod";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type AiProvider = "ollama" | "gemini";

export type GeminiConfig = {
  apiKey?: string; // Defaults to GEMINI_API_KEY. Backend only; never logged.
  model?: string; // Defaults to GEMINI_MODEL, then DEFAULT_GEMINI_MODEL.
  baseUrl?: string; // Defaults to the public v1beta endpoint.
};

export type OllamaDeps = {
  fetch: FetchLike;
  ollamaUrl: string;
  model: string; // The Ollama model; Gemini uses `gemini.model`.
  timeoutMs?: number;
  // When omitted, AI_PROVIDER picks the provider (read at call time), and
  // Ollama is the default.
  provider?: AiProvider;
  gemini?: GeminiConfig;
};

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export type ChatJsonFailure =
  | "timeout" // No answer in time.
  | "unavailable" // The model could not be reached (or Gemini has no API key).
  | "http-error" // The model API answered with an error status.
  | "empty" // The model returned no content.
  | "truncated" // The model hit its output limit mid-answer.
  | "malformed"; // The content is not valid JSON.

// Why an "http-error" happened: the status code, and the API's own error
// message once sanitized (see sanitizeApiErrorMessage). Safe to log.
export type HttpErrorDiagnostic = { status: number; message?: string };

export type ChatJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; failure: ChatJsonFailure; diagnostic?: HttpErrorDiagnostic };

type Failed = Extract<ChatJsonResult, { ok: false }>;

// Model-output problems that a second, differently configured attempt may fix.
export const RETRYABLE_FAILURES = new Set<ChatJsonFailure>([
  "empty",
  "truncated",
  "malformed",
]);

type ChatRequest = {
  system: string;
  user: string;
  format: object;
  options: Record<string, number>;
};

// The model's answer text, and whether it stopped at its output limit.
type ModelReply = { content: string | undefined; truncated: boolean };

export function resolveProvider(deps: Pick<OllamaDeps, "provider">): AiProvider {
  if (deps.provider) return deps.provider;
  return process.env.AI_PROVIDER?.trim().toLowerCase() === "gemini"
    ? "gemini"
    : "ollama";
}

// One non-streaming chat request whose output the model constrains to
// `format` (a JSON schema). Never throws.
export async function chatJson(
  deps: OllamaDeps,
  request: ChatRequest,
  defaultTimeoutMs: number,
): Promise<ChatJsonResult> {
  const timeoutMs = deps.timeoutMs ?? defaultTimeoutMs;
  const reply =
    resolveProvider(deps) === "gemini"
      ? await callGemini(deps, request, timeoutMs)
      : await callOllama(deps, request, timeoutMs);
  if ("failure" in reply) return reply;

  if (!reply.content) return { ok: false, failure: "empty" };
  if (reply.truncated) return { ok: false, failure: "truncated" };

  try {
    return { ok: true, value: JSON.parse(reply.content) as unknown };
  } catch {
    return { ok: false, failure: "malformed" };
  }
}

async function callOllama(
  deps: OllamaDeps,
  request: ChatRequest,
  timeoutMs: number,
): Promise<ModelReply | Failed> {
  const result = await postJson(
    "ollama",
    deps.fetch,
    `${deps.ollamaUrl}/api/chat`,
    {},
    {
      model: deps.model,
      stream: false,
      format: request.format,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      options: request.options,
    },
    timeoutMs,
    [request.system, request.user],
  );
  if (!result.ok) return result;

  const body = (result.data ?? {}) as {
    message?: { content?: string };
    done_reason?: string;
  };
  return { content: body.message?.content, truncated: body.done_reason === "length" };
}

// Ollama sampling options that have a Gemini generationConfig equivalent.
// num_predict is not passed on: it caps a small local model's output, and on
// Gemini 2.5 models the thinking tokens count against maxOutputTokens, so the
// same cap would cut answers short. num_ctx has no equivalent.
const GEMINI_OPTION_NAMES: Record<string, string> = {
  temperature: "temperature",
  top_p: "topP",
  top_k: "topK",
  seed: "seed",
};

async function callGemini(
  deps: OllamaDeps,
  request: ChatRequest,
  timeoutMs: number,
): Promise<ModelReply | Failed> {
  const apiKey = deps.gemini?.apiKey ?? process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return { ok: false, failure: "unavailable" };

  const model =
    deps.gemini?.model ?? (process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL);
  const baseUrl = deps.gemini?.baseUrl ?? GEMINI_BASE_URL;

  const generationConfig: Record<string, unknown> = {
    responseMimeType: "application/json",
    responseJsonSchema: withoutSchemaKeyword(request.format),
  };
  for (const [name, value] of Object.entries(request.options)) {
    const geminiName = GEMINI_OPTION_NAMES[name];
    if (geminiName) generationConfig[geminiName] = value;
  }

  const result = await postJson(
    "gemini",
    deps.fetch,
    `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
    { "x-goog-api-key": apiKey },
    {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: "user", parts: [{ text: request.user }] }],
      generationConfig,
    },
    timeoutMs,
    [request.system, request.user],
  );
  if (!result.ok) return result;

  const body = (result.data ?? {}) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean }> };
      finishReason?: string;
    }>;
  };
  const candidate = body.candidates?.[0];
  const content = candidate?.content?.parts
    ?.filter((part) => !part.thought && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  return { content, truncated: candidate?.finishReason === "MAX_TOKENS" };
}

// z.toJSONSchema adds a top-level "$schema" URI, which is metadata rather
// than part of the response shape; leave it out of Gemini's schema.
function withoutSchemaKeyword(schema: object): object {
  const { $schema: _ignored, ...rest } = schema as Record<string, unknown>;
  return rest;
}

// POSTs a JSON body and returns the parsed JSON reply, or why there is none.
// Never throws. On an error status it logs one line with the provider, the
// status, and the API's sanitized error message; it never logs the request,
// the headers, or the response. `headers` are secrets (they are redacted from
// that message), and so is `privateText`, the prompts sent in `body`.
async function postJson(
  provider: AiProvider,
  fetch: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  privateText: string[],
): Promise<{ ok: true; data: unknown } | Failed> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const diagnostic: HttpErrorDiagnostic = { status: response.status };
      const message = sanitizeApiErrorMessage(await readErrorBody(response), {
        secrets: Object.values(headers),
        privateText,
      });
      if (message) diagnostic.message = message;
      console.warn("AI model request failed:", { provider, ...diagnostic });
      return { ok: false, failure: "http-error", diagnostic };
    }

    return { ok: true, data: (await response.json()) as unknown };
  } catch (error) {
    return {
      ok: false,
      failure:
        error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "unavailable",
    };
  }
}

// The parsed JSON body of an error response, or undefined if it is missing,
// not JSON, or cannot be read. A failure here never changes the result.
async function readErrorBody(response: Response): Promise<unknown> {
  try {
    return JSON.parse((await response.text()).slice(0, 64_000)) as unknown;
  } catch {
    return undefined;
  }
}

const MAX_DIAGNOSTIC_LENGTH = 300;
const WITHHELD = "[message withheld: it quoted the request]";

// A quoted part of an error message is kept only if it looks like a field
// path, model name, or URL path, e.g. 'generation_config.response_json_schema'
// or "qwen2.5:3b"; anything else may be request content.
const SAFE_QUOTED = /^[\w$.:/[\]-]{1,80}$/;
// "...", `...`, or '...' (an apostrophe inside a word, as in "doesn't", does
// not open or close a quote).
const QUOTED = /"([^"]*)"|`([^`]*)`|(?<![\p{L}\p{N}])'([^']*)'(?![\p{L}\p{N}])/gu;

// Patterns of credentials that must never appear in a diagnostic even when
// they are not one of the request's own headers.
const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
  [/AIza[\w-]{20,}/g, "[redacted]"], // Google API keys.
  [/\b(Bearer|Basic)\s+[\w.~+/=-]{16,}/gi, "$1 [redacted]"],
  [/([?&](?:key|api_key|access_token)=)[^&\s]+/gi, "$1[redacted]"],
];

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

// Runs of this many consecutive words that also appear in the request mean
// the message is echoing the prompt, so the whole message is withheld.
const ECHO_WORDS = 4;

function wordRuns(text: string): string[] {
  const list = words(text);
  const runs: string[] = [];
  for (let i = 0; i + ECHO_WORDS <= list.length; i++) {
    runs.push(list.slice(i, i + ECHO_WORDS).join(" "));
  }
  return runs;
}

// Turns an Ollama ({ error: "..." }) or Gemini ({ error: { message, status } })
// error body into a short message that is safe to log: control characters
// removed, secrets and credential-like strings redacted, quoted request
// content removed, and cut to MAX_DIAGNOSTIC_LENGTH. Returns undefined when
// the body has no error message.
export function sanitizeApiErrorMessage(
  body: unknown,
  context: { secrets: string[]; privateText: string[] },
): string | undefined {
  const error = (body as { error?: unknown } | undefined)?.error;
  const errorObject =
    error !== null && typeof error === "object"
      ? (error as { message?: unknown; status?: unknown })
      : undefined;

  const rawMessage =
    typeof error === "string" ? error : errorObject?.message;

  if (typeof rawMessage !== "string") return undefined;

  const code = errorObject?.status;
  let message = rawMessage.replace(/[\p{Cc}\s]+/gu, " ").trim();
  if (typeof code === "string" && /^[A-Z_]{1,40}$/.test(code)) {
    message = `${code}: ${message}`;
  }

  for (const secret of context.secrets) {
    if (secret.length >= 8) message = message.split(secret).join("[redacted]");
  }
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    message = message.replace(pattern, replacement);
  }
  message = message.replace(QUOTED, (match, ...groups: unknown[]) => {
    const inner = groups.slice(0, 3).find((group) => typeof group === "string") as string;
    return SAFE_QUOTED.test(inner) ? match : `${match[0]}[…]${match[0]}`;
  });

  const requestRuns = new Set(context.privateText.flatMap(wordRuns));
  if (wordRuns(message).some((run) => requestRuns.has(run))) return WITHHELD;

  if (!message) return undefined;
  return message.length > MAX_DIAGNOSTIC_LENGTH
    ? `${message.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`
    : message;
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
