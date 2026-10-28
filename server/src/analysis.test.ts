// Tests for the brief analyzer. Ollama is replaced by a scripted fake fetch,
// so no live model or network is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANALYSIS_SYSTEM_PROMPT,
  analysisJsonSchema,
  analyzeBrief,
  buildAnalysis,
  groundedBudget,
  groundedPhrase,
  type Analysis,
} from "./analysis.js";

const SHORT_BRIEF =
  "A client wants a five-page business website with a contact form and a budget of $800.";
const FULL_BRIEF =
  "A client wants a five-page business website with a contact form, mobile responsiveness, delivery in two weeks, two rounds of revisions, and a budget of $800.";

function validOutput(overrides: Partial<Analysis> = {}): Analysis {
  return {
    deliverables: ["Five-page business website", "Contact form"],
    timeline: null,
    budget: { amount: 800, currency: "USD" },
    revisions: null,
    missing_terms: ["Timeline", "Revision rounds"],
    risk_findings: [{ issue: "No deadline", reason: "Delivery date is unclear" }],
    client_questions: ["When do you need the website?"],
    ...overrides,
  };
}

type Reply =
  | { content: string; doneReason?: string }
  | { status: number }
  | { throws: unknown };

function fakeOllama(replies: Reply[]) {
  const requests: Array<Record<string, unknown>> = [];
  const fetch = async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected extra Ollama request");
    if ("throws" in reply) throw reply.throws;
    if ("status" in reply) return new Response("{}", { status: reply.status });
    return new Response(
      JSON.stringify({
        message: { content: reply.content },
        done_reason: reply.doneReason ?? "stop",
      }),
    );
  };
  return { fetch, requests };
}

async function analyze(brief: string, replies: Reply[]) {
  const ollama = fakeOllama(replies);
  const result = await analyzeBrief(brief, {
    fetch: ollama.fetch,
    ollamaUrl: "http://ollama.test",
    model: "qwen2.5:3b",
  });
  return { result, requests: ollama.requests };
}

const json = (value: unknown): Reply => ({ content: JSON.stringify(value) });

// --- Valid output ---------------------------------------------------------

test("a valid short brief returns the analysis in the existing contract", async () => {
  const { result, requests } = await analyze(SHORT_BRIEF, [json(validOutput())]);

  assert.ok(result.ok);
  assert.deepEqual(result.analysis, validOutput());
  assert.deepEqual(result.adjustedFields, []);
  assert.equal(result.attempts, 1);
  assert.deepEqual(Object.keys(result.analysis).sort(), [
    "budget",
    "client_questions",
    "deliverables",
    "missing_terms",
    "revisions",
    "risk_findings",
    "timeline",
  ]);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.model, "qwen2.5:3b");
  assert.deepEqual(requests[0]?.format, analysisJsonSchema);
  const messages = requests[0]?.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0]?.content, ANALYSIS_SYSTEM_PROMPT);
  assert.equal(messages[1]?.content, SHORT_BRIEF);
});

test("stated timeline and revision terms are kept, including 2 vs two", async () => {
  const { result } = await analyze(FULL_BRIEF, [
    json(validOutput({ timeline: "2 weeks", revisions: "two rounds of revisions" })),
  ]);

  assert.ok(result.ok);
  assert.equal(result.analysis.timeline, "2 weeks");
  assert.equal(result.analysis.revisions, "two rounds of revisions");
});

// --- Missing or incorrectly typed fields ---------------------------------

test("deliverables returned as one string become a one-item list (the observed failure)", async () => {
  const { result } = await analyze(SHORT_BRIEF, [
    json({ ...validOutput(), deliverables: "A five-page business website with a contact form" }),
  ]);

  assert.ok(result.ok);
  assert.deepEqual(result.analysis.deliverables, [
    "A five-page business website with a contact form",
  ]);
  assert.equal(result.attempts, 1);
});

test('"Not specified" placeholders become null', async () => {
  const { result } = await analyze(SHORT_BRIEF, [
    json(validOutput({ timeline: "Not specified", revisions: "N/A" })),
  ]);

  assert.ok(result.ok);
  assert.equal(result.analysis.timeline, null);
  assert.equal(result.analysis.revisions, null);
  assert.deepEqual(result.adjustedFields, []);
});

test("missing and wrongly typed fields fall back individually", async () => {
  const { result } = await analyze(SHORT_BRIEF, [
    json({
      deliverables: ["Website"],
      timeline: 14,
      budget: { amount: "800", currency: "USD" },
      missing_terms: null,
      risk_findings: [
        { issue: "Scope creep", reason: "Pages are not described" },
        { issue: "No reason" },
        "junk",
      ],
      // client_questions and revisions missing entirely
    }),
  ]);

  assert.ok(result.ok);
  assert.deepEqual(result.analysis, {
    deliverables: ["Website"],
    timeline: null,
    budget: { amount: null, currency: null },
    revisions: null,
    missing_terms: [],
    risk_findings: [{ issue: "Scope creep", reason: "Pages are not described" }],
    client_questions: [],
  });
  assert.deepEqual(result.adjustedFields.sort(), [
    "budget.amount",
    "client_questions",
    "missing_terms",
    "revisions",
    "risk_findings",
    "timeline",
  ]);
});

// --- No invented terms ----------------------------------------------------

test("a budget, deadline, or revision terms the brief doesn't state are removed", async () => {
  const brief = "Build a landing page for our bakery with an online order form.";
  const { result } = await analyze(brief, [
    json(
      validOutput({
        timeline: "within 4 weeks",
        revisions: "three rounds of revisions",
        budget: { amount: 1500, currency: "USD" },
      }),
    ),
  ]);

  assert.ok(result.ok);
  assert.equal(result.analysis.timeline, null);
  assert.equal(result.analysis.revisions, null);
  assert.deepEqual(result.analysis.budget, { amount: null, currency: null });
  assert.deepEqual(result.adjustedFields.sort(), [
    "budget.amount (not in brief)",
    "revisions (not in brief)",
    "timeline (not in brief)",
  ]);
});

test("budget grounding checks both the amount and the currency", () => {
  assert.deepEqual(groundedBudget("Budget is $800.", { amount: 800, currency: "usd" }), {
    amount: 800,
    currency: "USD",
  });
  assert.deepEqual(groundedBudget("Budget is 800.", { amount: 800, currency: "USD" }), {
    amount: 800,
    currency: null,
  });
  assert.deepEqual(groundedBudget("Budget is $800.", { amount: 900, currency: "USD" }), {
    amount: null,
    currency: null,
  });
  assert.deepEqual(groundedBudget("Around €2k total.", { amount: 2000, currency: "EUR" }), {
    amount: 2000,
    currency: "EUR",
  });
  assert.deepEqual(groundedBudget("Budget is $800.", { amount: -800, currency: "USD" }), {
    amount: null,
    currency: null,
  });
  // The model left the currency empty, but the brief's "$" indicates USD.
  assert.deepEqual(groundedBudget("Budget is $800.", { amount: 800, currency: null }), {
    amount: 800,
    currency: "USD",
  });
  // The brief's currency wins over a wrong model guess.
  assert.deepEqual(groundedBudget("Budget is £800.", { amount: 800, currency: "USD" }), {
    amount: 800,
    currency: "GBP",
  });
  // With two currencies in the brief, only one it mentions is accepted.
  assert.deepEqual(
    groundedBudget("Budget €800, about $870.", { amount: 800, currency: "EUR" }),
    { amount: 800, currency: "EUR" },
  );
  assert.deepEqual(
    groundedBudget("Budget €800, about $870.", { amount: 800, currency: "INR" }),
    { amount: 800, currency: null },
  );
});

test("phrase grounding needs every meaningful word to appear in the brief", () => {
  assert.equal(groundedPhrase(FULL_BRIEF, "delivery in two weeks"), "delivery in two weeks");
  assert.equal(groundedPhrase(FULL_BRIEF, "14 days"), null);
  assert.equal(groundedPhrase(FULL_BRIEF, "Two weeks from signing"), null);
  assert.equal(groundedPhrase(FULL_BRIEF, "Not specified"), null);
  assert.equal(groundedPhrase(FULL_BRIEF, "   "), null);
  assert.equal(groundedPhrase(FULL_BRIEF, null), null);
});

test("output with nothing usable is not treated as an analysis", () => {
  assert.equal(buildAnalysis(SHORT_BRIEF, {}).usable, false);
  assert.equal(buildAnalysis(SHORT_BRIEF, ["not", "an", "object"]).usable, false);
  assert.equal(buildAnalysis(SHORT_BRIEF, validOutput()).usable, true);
});

// --- Retry and failures ---------------------------------------------------

test("malformed JSON is retried once with different settings", async () => {
  const { result, requests } = await analyze(SHORT_BRIEF, [
    { content: '{"deliverables": ["Website"' },
    json(validOutput()),
  ]);

  assert.ok(result.ok);
  assert.equal(result.attempts, 2);
  assert.equal(requests.length, 2);
  const [first, second] = requests.map((r) => r.options as Record<string, number>);
  assert.equal(first?.temperature, 0);
  assert.ok((second?.temperature ?? 0) > 0, "retry is not an identical request");
  assert.ok((second?.num_predict ?? 0) > (first?.num_predict ?? 0));
});

for (const [label, reply, pattern] of [
  ["malformed JSON", { content: "{ not json" }, /invalid JSON/],
  ["truncated output", { content: '{"deliverables": []}', doneReason: "length" }, /cut off/],
  ["an empty response", { content: "" }, /empty response/],
  ["unusable output", { content: "{}" }, /did not match the required schema/],
] as const) {
  test(`${label} twice gives a clear 502 after exactly one retry`, async () => {
    const { result, requests } = await analyze(SHORT_BRIEF, [reply, reply]);

    assert.ok(!result.ok);
    assert.equal(result.status, 502);
    assert.match(result.error, pattern);
    assert.equal(result.attempts, 2);
    assert.equal(requests.length, 2);
  });
}

for (const [label, reply, status, pattern] of [
  [
    "a timeout",
    { throws: new DOMException("The operation timed out.", "TimeoutError") },
    504,
    /timed out/,
  ],
  ["Ollama not running", { throws: new TypeError("fetch failed") }, 503, /Ollama is running/],
  ["an Ollama error status", { status: 500 }, 502, /Ollama request failed/],
] as const) {
  test(`${label} is reported clearly without a retry`, async () => {
    const { result, requests } = await analyze(SHORT_BRIEF, [reply]);

    assert.ok(!result.ok);
    assert.equal(result.status, status);
    assert.match(result.error, pattern);
    assert.equal(requests.length, 1);
  });
}
