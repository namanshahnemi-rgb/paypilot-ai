// Tests for HTTP error diagnostics in the shared model client. Both providers
// are replaced by fake fetch functions, so no live model or network is used.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  GEMINI_RETRY,
  chatJson,
  parseRetryAfterMs,
  sanitizeApiErrorMessage,
  type OllamaDeps,
} from "./localModel.js";

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
// --- Retries for temporary Gemini failures ---------------------------------
// setTimeout and Date are mocked, so backoff waits take no real time and each
// request's mocked clock time shows exactly how long the client waited.

const HIGH_DEMAND = {
  error: {
    code: 503,
    status: "UNAVAILABLE",
    message:
      "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",
  },
};
const GEMINI_OK = {
  candidates: [{ content: { parts: [{ text: '{"answer":"ok"}' }] }, finishReason: "STOP" }],
};

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

// A fake fetch that answers with `replies` in order (repeating the last one)
// and records the mocked clock time of every request.
function sequence(replies: Reply[]) {
  const calls: Array<{ at: number; init: RequestInit }> = [];
  const fetch = async (_url: string, init: RequestInit) => {
    calls.push({ at: Date.now(), init });
    const reply = replies[Math.min(calls.length, replies.length) - 1]!;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: reply.headers ?? {},
    });
  };
  const waits = () => calls.slice(1).map((call, i) => call.at - calls[i]!.at);
  return { fetch, calls, waits };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

// Runs `run` to completion with mocked timers: lets pending I/O and promises
// settle, then fires due timers, until the call is done.
async function withMockedTimers<T>(t: TestContext, run: () => Promise<T>): Promise<T> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    let done = false;
    const promise = run().finally(() => {
      done = true;
    });
    while (!done) {
      await nextTurn();
      t.mock.timers.runAll();
    }
    return await promise;
  } finally {
    t.mock.timers.reset();
  }
}

const BUDGET_MS = 60_000; // The analysis route's budget.
const runGemini = (t: TestContext, d: OllamaDeps, budget = BUDGET_MS) =>
  withMockedTimers(t, () => chatJson(d, REQUEST, budget));

for (const status of [503, 429, 502]) {
  test(`Gemini ${status} followed by success is retried once and succeeds`, async (t) => {
    const logged = captureWarnings(t);
    const gemini = sequence([{ status, body: HIGH_DEMAND }, { status: 200, body: GEMINI_OK }]);

    const result = await runGemini(t, deps("gemini", gemini.fetch));

    assert.deepEqual(result, { ok: true, value: { answer: "ok" } });
    assert.equal(gemini.calls.length, 2);
    assert.deepEqual(gemini.waits(), [1_000], "the first backoff is 1 s");
    // The retry sends the very same request.
    const [first, second] = gemini.calls;
    assert.equal(second?.init.body, first?.init.body);
    assert.deepEqual(second?.init.headers, first?.init.headers);
    assert.equal(second?.init.method, "POST");

    const lines = logged();
    assert.equal(lines.length, 1, "one line for the failed attempt");
    assert.match(lines[0] ?? "", /retrying/);
    assert.match(lines[0] ?? "", new RegExp(`"status":${status}`));
    assert.match(lines[0] ?? "", /"retry":1,"maxRetries":2,"delayMs":1000/);
    assertNothingPrivate(lines[0] ?? "");
  });
}

for (const status of [400, 401, 403, 404]) {
  test(`a permanent Gemini ${status} error is not retried`, async (t) => {
    const logged = captureWarnings(t);
    const gemini = sequence([
      { status, body: { error: { message: "Permission denied" } } },
      { status: 200, body: GEMINI_OK },
    ]);

    const result = await runGemini(t, deps("gemini", gemini.fetch));

    assert.ok(!result.ok);
    assert.equal(result.failure, "http-error");
    assert.equal(result.diagnostic?.status, status);
    assert.equal(gemini.calls.length, 1);
    assert.equal(logged().length, 1);
    assert.doesNotMatch(logged()[0] ?? "", /retrying/);
  });
}

test("when every Gemini response is 503 it stops after 2 retries, waiting 1 s then 2 s", async (t) => {
  const logged = captureWarnings(t);
  const gemini = sequence([{ status: 503, body: HIGH_DEMAND }]);

  const result = await runGemini(t, deps("gemini", gemini.fetch));

  assert.deepEqual(result, {
    ok: false,
    failure: "http-error",
    diagnostic: { status: 503, message: `UNAVAILABLE: ${HIGH_DEMAND.error.message}` },
  });
  assert.equal(gemini.calls.length, 1 + GEMINI_RETRY.maxRetries);
  assert.deepEqual(gemini.waits(), [1_000, 2_000]);

  const lines = logged();
  assert.equal(lines.length, 3, "one line per failed attempt");
  assert.match(lines[0] ?? "", /retrying.*"retry":1/);
  assert.match(lines[1] ?? "", /retrying.*"retry":2/);
  assert.match(lines[2] ?? "", /^\["AI model request failed:"/);
  assert.doesNotMatch(lines[2] ?? "", /retrying/);
});

test("an Ollama 503 is not retried", async (t) => {
  const logged = captureWarnings(t);
  const ollama = sequence([{ status: 503, body: { error: "server busy" } }, { status: 200, body: {} }]);

  const result = await runGemini(t, deps("ollama", ollama.fetch));

  assert.deepEqual(result, {
    ok: false,
    failure: "http-error",
    diagnostic: { status: 503, message: "server busy" },
  });
  assert.equal(ollama.calls.length, 1);
  assert.equal(logged().length, 1);
});

test("Gemini network failures and timeouts are not retried", async (t) => {
  captureWarnings(t);
  const cases: Array<[Error, string]> = [
    [new TypeError("fetch failed"), "unavailable"],
    [new DOMException("The operation timed out.", "TimeoutError"), "timeout"],
  ];
  for (const [error, failure] of cases) {
    let calls = 0;
    const failing = async () => {
      calls++;
      throw error;
    };
    const result = await chatJson(deps("gemini", failing), REQUEST, BUDGET_MS);
    assert.deepEqual(result, { ok: false, failure });
    assert.equal(calls, 1);
  }
});

test("a valid Retry-After is honoured, and a long one is capped at 10 s", async (t) => {
  captureWarnings(t);
  const cases: Array<[string, number]> = [
    ["3", 3_000], // Seconds.
    ["0", 0],
    ["120", GEMINI_RETRY.maxDelayMs], // Capped.
    ["Thu, 01 Jan 1970 00:00:05 GMT", 5_000], // HTTP date; the mocked clock starts at 0.
    ["soon", 1_000], // Invalid: the normal backoff.
    ["-5", 1_000],
  ];
  for (const [retryAfter, expectedWait] of cases) {
    const gemini = sequence([
      { status: 429, body: {}, headers: { "Retry-After": retryAfter } },
      { status: 200, body: GEMINI_OK },
    ]);
    const result = await runGemini(t, deps("gemini", gemini.fetch));
    assert.ok(result.ok, retryAfter);
    assert.deepEqual(gemini.waits(), [expectedWait], retryAfter);
  }
});

test("Retry-After parsing accepts only whole seconds and HTTP dates", () => {
  assert.equal(parseRetryAfterMs("7", 0), 7_000);
  assert.equal(parseRetryAfterMs(" 2 ", 0), 2_000);
  assert.equal(parseRetryAfterMs("Thu, 01 Jan 1970 00:00:01 GMT", 5_000), 0, "a past date means no wait");
  for (const invalid of [null, undefined, "", "1.5", "-1", "soon", "1e3", "2026-11-12T10:00:00Z"]) {
    assert.equal(parseRetryAfterMs(invalid, 0), undefined, String(invalid));
  }
});

test("a very large Retry-After is valid, never overflows, and the wait is capped at 10 s", async (t) => {
  // Valid integers of any length parse to a finite, safe number.
  assert.equal(parseRetryAfterMs("9999999999", 0), 9_999_999_999_000);
  const huge = "9".repeat(400); // Number(huge) is Infinity.
  for (const value of ["9999999999", "90071992547409930", huge]) {
    const ms = parseRetryAfterMs(value, 0);
    assert.ok(ms !== undefined && Number.isSafeInteger(ms) && ms > GEMINI_RETRY.maxDelayMs, value.slice(0, 20));
  }
  assert.equal(parseRetryAfterMs(huge, 0), Number.MAX_SAFE_INTEGER);

  // The retry still happens, after the capped 10 s wait.
  captureWarnings(t);
  for (const retryAfter of ["9999999999", huge]) {
    const gemini = sequence([
      { status: 503, body: HIGH_DEMAND, headers: { "Retry-After": retryAfter } },
      { status: 200, body: GEMINI_OK },
    ]);
    const result = await runGemini(t, deps("gemini", gemini.fetch));
    assert.ok(result.ok);
    assert.deepEqual(gemini.waits(), [GEMINI_RETRY.maxDelayMs]);
  }
});

test("retries never exceed the request's timeout budget", async (t) => {
  captureWarnings(t);
  // 12 s budget: the first retry (1 s wait, 11 s left) fits; the second
  // (2 s more would leave under 10 s for the request) does not.
  const short = sequence([{ status: 503, body: HIGH_DEMAND }]);
  const result = await runGemini(t, deps("gemini", short.fetch), 12_000);
  assert.ok(!result.ok);
  assert.equal(result.diagnostic?.status, 503);
  assert.equal(short.calls.length, 2);

  // A Retry-After wait that would not leave enough time is not taken.
  const long = sequence([{ status: 429, body: {}, headers: { "Retry-After": "120" } }]);
  await runGemini(t, deps("gemini", long.fetch), 15_000);
  assert.equal(long.calls.length, 1);

  // A budget too small for any retry sends one request.
  const tiny = sequence([{ status: 503, body: HIGH_DEMAND }]);
  await runGemini(t, deps("gemini", tiny.fetch), 1_000);
  assert.equal(tiny.calls.length, 1);
});

test("a cancelled caller gets no retry", async (t) => {
  captureWarnings(t);
  // Cancelled before the request: the request fails and is not retried.
  const before = new AbortController();
  before.abort();
  const first = sequence([{ status: 503, body: HIGH_DEMAND }, { status: 200, body: GEMINI_OK }]);
  let sawSignal: AbortSignal | undefined;
  const watching: OllamaDeps["fetch"] = async (url, init) => {
    sawSignal = init.signal ?? undefined;
    return first.fetch(url, init);
  };
  const result = await runGemini(t, { ...deps("gemini", watching), signal: before.signal });
  assert.ok(!result.ok);
  assert.equal(first.calls.length, 1);
  assert.equal(sawSignal?.aborted, true, "the caller's cancellation reaches the request");

  // Cancelled during the backoff wait: the wait ends and no request follows.
  const during = new AbortController();
  const second = sequence([{ status: 503, body: HIGH_DEMAND }, { status: 200, body: GEMINI_OK }]);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    let done = false;
    const pending = chatJson({ ...deps("gemini", second.fetch), signal: during.signal }, REQUEST, BUDGET_MS);
    void pending.finally(() => {
      done = true;
    });
    while (second.calls.length === 0) await nextTurn();
    for (let i = 0; i < 5; i++) await nextTurn(); // Let it start waiting; no timer fires.
    assert.equal(done, false, "it is waiting to retry");
    during.abort();
    const cancelled = await pending;
    assert.ok(!cancelled.ok);
    assert.equal(cancelled.diagnostic?.status, 503);
    assert.equal(second.calls.length, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test("retried failures are still sanitized, and no log line has secrets, prompts or bodies", async (t) => {
  const logged = captureWarnings(t);
  const leaky = {
    error: {
      status: "UNAVAILABLE",
      message: `Overloaded for key ${API_KEY} while processing ${BRIEF}`,
    },
  };
  const gemini = sequence([{ status: 503, body: leaky }]);

  const result = await runGemini(t, deps("gemini", gemini.fetch));

  assert.ok(!result.ok);
  assert.equal(gemini.calls.length, 3);
  assert.deepEqual(result.diagnostic, {
    status: 503,
    message: "[message withheld: it quoted the request]",
  });
  const lines = logged();
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assertNothingPrivate(line);
    assert.ok(!line.includes("five-page website"), "the prompt is not logged");
    assert.ok(!line.includes("generativelanguage"), "the URL is not logged");
    assert.ok(!line.includes("Overloaded"), "the raw response body is not logged");
  }
});
