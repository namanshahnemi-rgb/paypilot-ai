// Tests for HTTP error diagnostics in the shared model client. Both providers
// are replaced by fake fetch functions, so no live model or network is used.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chatJson, sanitizeApiErrorMessage, type OllamaDeps } from "./localModel.js";

const API_KEY = "AIzaFakeKeyForTests_0123456789abcdefghij";
const BRIEF =
  "Acme Bakery wants a five-page website with online ordering for a budget of $800.";
const REQUEST = {
  system: "You review freelance proposals and answer in JSON.",
  user: `Project brief:\n${BRIEF}`,
  format: { type: "object" },
  options: { temperature: 0 },
};

function replyWith(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  };
  return { fetch, calls };
}

function deps(provider: "ollama" | "gemini", fetch: OllamaDeps["fetch"]): OllamaDeps {
  return {
    fetch,
    ollamaUrl: "http://ollama.test",
    model: "qwen2.5:3b",
    provider,
    gemini: { apiKey: API_KEY, model: "gemini-2.5-flash" },
  };
}

const jsonResponse = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status });

// Captures console.warn so the test can check exactly what was logged.
function captureWarnings(t: TestContext) {
  const warn = t.mock.method(console, "warn", () => {});
  return () => warn.mock.calls.map((call) => JSON.stringify(call.arguments));
}

function assertNothingPrivate(text: string) {
  assert.ok(!text.includes(API_KEY), "the API key is not included");
  assert.ok(!text.includes("Acme Bakery"), "the brief is not included");
  assert.ok(!text.includes("$800"), "the brief is not included");
  assert.ok(!text.includes(REQUEST.system), "the system prompt is not included");
  assert.ok(!/x-goog-api-key|content-type/i.test(text), "no request headers are included");
}

// --- HTTP errors ----------------------------------------------------------

test("a Gemini error status keeps its status code and a sanitized message", async (t) => {
  const logged = captureWarnings(t);
  const gemini = replyWith(
    jsonResponse(400, {
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: `Invalid value at 'generation_config.response_json_schema' for key ${API_KEY}: "${BRIEF}"`,
      },
    }),
  );

  const result = await chatJson(deps("gemini", gemini.fetch), REQUEST, 1000);

  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.failure, "http-error");
  assert.equal(result.diagnostic?.status, 400);
  assert.equal(
    result.diagnostic?.message,
    `INVALID_ARGUMENT: Invalid value at 'generation_config.response_json_schema' for key [redacted]: "[…]"`,
  );
  assertNothingPrivate(JSON.stringify(result));

  const lines = logged();
  const line = lines[0] ?? "";
  assert.equal(lines.length, 1, "one log line per failed request");
  assert.match(line, /AI model request failed/);
  assert.match(line, /"provider":"gemini"/);
  assert.match(line, /"status":400/);
  assertNothingPrivate(line);
  assert.ok(!line.includes("generativelanguage"), "the URL is not logged");
});

test("an Ollama error status keeps its status code and message", async (t) => {
  const logged = captureWarnings(t);
  const ollama = replyWith(
    jsonResponse(404, { error: 'model "qwen2.5:3b" not found, try pulling it first' }),
  );

  const result = await chatJson(deps("ollama", ollama.fetch), REQUEST, 1000);

  assert.deepEqual(result, {
    ok: false,
    failure: "http-error",
    diagnostic: {
      status: 404,
      message: 'model "qwen2.5:3b" not found, try pulling it first',
    },
  });
  assert.match((logged()[0] ?? ""), /"provider":"ollama"/);
});

test("an error message that repeats the prompt outside quotes is withheld", async (t) => {
  const logged = captureWarnings(t);
  const gemini = replyWith(
    jsonResponse(400, { error: { message: `Cannot process: wants a five-page website with online ordering` } }),
  );

  const result = await chatJson(deps("gemini", gemini.fetch), REQUEST, 1000);

  assert.ok(!result.ok);
  assert.deepEqual(result.diagnostic, {
    status: 400,
    message: "[message withheld: it quoted the request]",
  });
  assert.ok(!(logged()[0] ?? "").includes("five-page website"));
});

test("an error body that is not JSON gives only the status code", async (t) => {
  const logged = captureWarnings(t);
  const gemini = replyWith(
    () => new Response(`<html>Bad gateway for ${API_KEY} and ${BRIEF}</html>`, { status: 502 }),
  );

  const result = await chatJson(deps("gemini", gemini.fetch), REQUEST, 1000);

  assert.deepEqual(result, { ok: false, failure: "http-error", diagnostic: { status: 502 } });
  assertNothingPrivate((logged()[0] ?? ""));
});

test("an error body that cannot be read still gives an http-error with the status", async (t) => {
  captureWarnings(t);
  const broken = new ReadableStream({
    start(controller) {
      controller.error(new Error("connection reset"));
    },
  });
  const ollama = replyWith(() => new Response(broken, { status: 500 }));

  const result = await chatJson(deps("ollama", ollama.fetch), REQUEST, 1000);

  assert.deepEqual(result, { ok: false, failure: "http-error", diagnostic: { status: 500 } });
});

test("a long error message is cut to a bounded length", async (t) => {
  captureWarnings(t);
  const ollama = replyWith(jsonResponse(500, { error: `out of memory ${"x".repeat(1000)}` }));

  const result = await chatJson(deps("ollama", ollama.fetch), REQUEST, 1000);

  assert.ok(!result.ok);
  assert.equal(result.diagnostic?.message?.length, 300);
  assert.ok(result.diagnostic?.message?.endsWith("…"));
});

test("the request sent is unchanged by the diagnostics", async (t) => {
  captureWarnings(t);
  const gemini = replyWith(jsonResponse(500, { error: { message: "Internal error" } }));

  await chatJson(deps("gemini", gemini.fetch), REQUEST, 1000);

  const call = gemini.calls[0];
  assert.ok(call);
  assert.equal(
    call.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
  );
  assert.deepEqual(call.init.headers, {
    "Content-Type": "application/json",
    "x-goog-api-key": API_KEY,
  });
  assert.equal(call.init.method, "POST");
});

// --- Failures without an HTTP status keep their existing shape ---------------

test("timeouts, unreachable servers, and a missing key have no diagnostic and log nothing", async (t) => {
  const logged = captureWarnings(t);
  const unreachable = async () => {
    throw new TypeError("fetch failed");
  };
  const timedOut = async () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  };

  assert.deepEqual(await chatJson(deps("ollama", unreachable), REQUEST, 1000), {
    ok: false,
    failure: "unavailable",
  });
  assert.deepEqual(await chatJson(deps("gemini", timedOut), REQUEST, 1000), {
    ok: false,
    failure: "timeout",
  });
  assert.deepEqual(
    await chatJson({ ...deps("gemini", unreachable), gemini: { apiKey: "" } }, REQUEST, 1000),
    { ok: false, failure: "unavailable" },
  );
  assert.deepEqual(logged(), []);
});

// --- Sanitizing ------------------------------------------------------------

const noContext = { secrets: [], privateText: [] };

test("credential-like strings are redacted even when they are not the request's own key", () => {
  assert.equal(
    sanitizeApiErrorMessage(
      {
        error:
          "denied for AIzaSyOtherKey_abcdefghijklmnopqrstuvwxyz0 via https://x.test/v1?key=abc123&alt=json with Bearer abcdefghijklmnopqrstuvwxyz",
      },
      noContext,
    ),
    "denied for [redacted] via https://x.test/v1?key=[redacted]&alt=json with Bearer [redacted]",
  );
});

test("plain wording, apostrophes, and identifier-like quotes are kept", () => {
  assert.equal(
    sanitizeApiErrorMessage(
      { error: { message: "The model doesn't support 'responseJsonSchema'. Basic plan limits apply." } },
      noContext,
    ),
    "The model doesn't support 'responseJsonSchema'. Basic plan limits apply.",
  );
});

test("control characters and line breaks are collapsed", () => {
  assert.equal(
    sanitizeApiErrorMessage({ error: "bad\n\trequest\u0000 here" }, noContext),
    "bad request here",
  );
});

test("a body with no error message gives no message", () => {
  for (const body of [
    undefined,
    null,
    "text",
    {},
    { error: null },
    { error: {} },
    { error: { message: 42 } },
    { error: "   " },
  ]) {
    assert.equal(sanitizeApiErrorMessage(body, noContext), undefined);
  }
});