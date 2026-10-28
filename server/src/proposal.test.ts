// Tests for proposal validation, fact grounding, money allocation, and the
// generator's handling of model output. Ollama is faked; no live AI is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allocate,
  buildProposalDraft,
  parseProposalOutput,
  proposalJsonSchema,
  quoteFromBrief,
  readBudget,
  type ProposalOutput,
} from "./proposal.js";
import { generateProposalDraft, PROPOSAL_SYSTEM_PROMPT } from "./proposalGenerator.js";

const BRIEF =
  "A client wants a five-page business website with a contact form, mobile responsiveness, delivery in two weeks, two rounds of revisions, and a budget of $800.";

function modelOutput(overrides: Partial<ProposalOutput> = {}): ProposalOutput {
  return {
    title: "Business website",
    executive_summary: "A five-page responsive business website with a contact form.",
    client_goals: ["Establish an online presence"],
    deliverables: [
      {
        name: "Five-page website",
        description: "Responsive pages",
        acceptance_criteria: ["All pages render on mobile"],
      },
      {
        name: "Contact form",
        description: "Sends enquiries by email",
        acceptance_criteria: ["Test enquiry is received"],
      },
    ],
    exclusions: ["Hosting costs"],
    assumptions: ["Client supplies copy and images"],
    milestones: [
      { name: "Design", estimated_duration: "3-4 days", depends_on: [] },
      { name: "Build", estimated_duration: "6-8 days", depends_on: ["Design"] },
    ],
    budget_breakdown: [
      { item: "Design", share_percent: 1 },
      { item: "Development", share_percent: 1 },
      { item: "Testing", share_percent: 1 },
    ],
    payment_schedule: [
      { milestone: "Deposit", share_percent: 50 },
      { milestone: "Launch", share_percent: 50 },
    ],
    revision_policy: "Two rounds of revisions per deliverable.",
    change_request_process: "Changes are quoted before work starts.",
    risks: [{ issue: "Content delays", reason: "Copy is not ready" }],
    missing_information: ["Hosting provider"],
    clarification_questions: ["Who provides the copy?"],
    client_responsibilities: ["Provide feedback within two days"],
    prerequisites: ["Domain access"],
    budget_quote: "a budget of $800",
    deadline_quote: "delivery in two weeks",
    revisions_quote: "two rounds of revisions",
    ...overrides,
  };
}

const sum = (values: Array<number | null>) =>
  Math.round(values.reduce<number>((a, b) => a + (b ?? 0), 0) * 100);

// --- Allocation -----------------------------------------------------------

test("allocations add up to 100% and exactly to the total, to the cent", () => {
  const items = allocate(
    [
      { label: "A", weight: 1 },
      { label: "B", weight: 1 },
      { label: "C", weight: 1 },
    ],
    800,
  );

  assert.equal(items.reduce((a, b) => a + b.percent, 0), 100);
  assert.equal(sum(items.map((i) => i.amount)), 80000);
  assert.deepEqual(items.map((i) => i.percent), [34, 33, 33]);
});

test("allocations normalize shares that don't add up to 100", () => {
  const items = allocate(
    [
      { label: "Deposit", weight: 30 },
      { label: "Final", weight: 90 },
    ],
    1234.56,
  );

  assert.deepEqual(items.map((i) => i.percent), [25, 75]);
  assert.equal(sum(items.map((i) => i.amount)), 123456);
});

test("without a total, allocations have percentages but no amounts", () => {
  const items = allocate([{ label: "Design", weight: 40 }, { label: "Build", weight: 60 }], null);

  assert.deepEqual(items, [
    { label: "Design", percent: 40, amount: null },
    { label: "Build", percent: 60, amount: null },
  ]);
});

test("allocations ignore invalid, negative, and unlabeled shares", () => {
  const items = allocate(
    [
      { label: "Valid", weight: 10 },
      { label: "Negative", weight: -5 },
      { label: "", weight: 10 },
      { label: "NaN", weight: Number.NaN },
    ],
    100,
  );

  assert.deepEqual(items, [{ label: "Valid", percent: 100, amount: 100 }]);
  assert.deepEqual(allocate([], 100), []);
});

// --- Fact grounding -------------------------------------------------------

test("quotes are kept only when they appear verbatim in the brief", () => {
  assert.equal(quoteFromBrief(BRIEF, "delivery in two weeks"), "delivery in two weeks");
  assert.equal(quoteFromBrief(BRIEF, '"Delivery  in TWO weeks."'), "Delivery  in TWO weeks");
  assert.equal(quoteFromBrief(BRIEF, "delivery within 14 days"), null);
  assert.equal(quoteFromBrief(BRIEF, null), null);
  assert.equal(quoteFromBrief(BRIEF, " "), null);
});

test("budget quotes are read into a single amount and currency", () => {
  assert.deepEqual(readBudget("a budget of $800"), {
    kind: "amount",
    amount: 800,
    currency: "USD",
    currencyAssumed: true,
  });
  assert.deepEqual(readBudget("USD 1,200.50"), {
    kind: "amount",
    amount: 1200.5,
    currency: "USD",
    currencyAssumed: false,
  });
  assert.deepEqual(readBudget("around €2k"), {
    kind: "amount",
    amount: 2000,
    currency: "EUR",
    currencyAssumed: false,
  });
  assert.deepEqual(readBudget("₹50,000"), {
    kind: "amount",
    amount: 50000,
    currency: "INR",
    currencyAssumed: false,
  });
  assert.equal(readBudget("budget of 900").kind, "amount");
  assert.equal((readBudget("budget of 900") as { currency: string | null }).currency, null);
  assert.deepEqual(readBudget("between $500 and $800"), { kind: "unclear" });
  assert.deepEqual(readBudget("a reasonable budget"), { kind: "none" });
});

// --- Output validation ----------------------------------------------------

test("valid model output passes validation unchanged", () => {
  const { output, invalidFields } = parseProposalOutput(modelOutput());

  assert.deepEqual(invalidFields, []);
  assert.deepEqual(output, modelOutput());
});

test("malformed fields fall back to empty values and are reported", () => {
  const { output, invalidFields } = parseProposalOutput({
    ...modelOutput(),
    title: 42,
    exclusions: "not a list",
    budget_quote: { amount: 800 },
    deliverables: [
      { name: "Good", description: "ok", acceptance_criteria: [] },
      { name: "Missing description" },
      "junk",
    ],
  });

  assert.equal(output.title, "");
  assert.deepEqual(output.exclusions, []);
  assert.equal(output.budget_quote, null);
  assert.deepEqual(output.deliverables, [
    { name: "Good", description: "ok", acceptance_criteria: [] },
  ]);
  assert.deepEqual(invalidFields.sort(), ["budget_quote", "deliverables", "exclusions", "title"]);
});

test("non-object model output yields an empty proposal with every field reported", () => {
  const { output, invalidFields } = parseProposalOutput(["not", "an", "object"]);

  assert.equal(output.title, "");
  assert.deepEqual(output.risks, []);
  assert.equal(output.deadline_quote, null);
  assert.equal(invalidFields.length, Object.keys(modelOutput()).length);
});

test("the JSON schema sent to Ollama requires every proposal field", () => {
  assert.equal(proposalJsonSchema.type, "object");
  assert.deepEqual(
    [...(proposalJsonSchema.required ?? [])].sort(),
    Object.keys(modelOutput()).sort(),
  );
  assert.equal("$schema" in proposalJsonSchema, false);
});

// --- Draft building -------------------------------------------------------

test("a complete brief produces a reconciled draft grounded in the brief", () => {
  const draft = buildProposalDraft(BRIEF, modelOutput());

  assert.equal(draft.budget.total, 800);
  assert.equal(draft.budget.currency, "USD");
  assert.equal(draft.budget.statedInBrief, "a budget of $800");
  assert.equal(sum(draft.budget.items.map((i) => i.amount)), 80000);
  assert.equal(sum(draft.paymentSchedule.map((i) => i.amount)), 80000);
  assert.deepEqual(draft.paymentSchedule.map((p) => p.amount), [400, 400]);
  assert.equal(draft.deadline.statedInBrief, "delivery in two weeks");
  assert.equal(draft.revisions.statedInBrief, "two rounds of revisions");
  assert.equal(draft.deliverables[0]?.acceptanceCriteria[0], "All pages render on mobile");
  assert.ok(draft.warnings.some((w) => /assumed to be USD/.test(w)));
  assert.ok(draft.warnings.some((w) => /suggestions, not agreed terms/.test(w)));
});

test("a budget or deadline the brief doesn't state is unspecified, not invented", () => {
  const brief = "Build a landing page for our bakery with an online order form and photos.";
  const draft = buildProposalDraft(
    brief,
    modelOutput({
      budget_quote: "budget of $1,500", // hallucinated
      deadline_quote: "within one month", // hallucinated
      revisions_quote: null,
    }),
  );

  assert.equal(draft.budget.total, null);
  assert.equal(draft.budget.statedInBrief, null);
  assert.ok(draft.budget.items.every((i) => i.amount === null));
  assert.ok(draft.paymentSchedule.every((i) => i.amount === null));
  assert.equal(draft.deadline.statedInBrief, null);
  assert.equal(draft.revisions.statedInBrief, null);
  assert.ok(draft.warnings.some((w) => /does not appear in the brief/.test(w)));
  assert.ok(draft.warnings.some((w) => /No budget total was stated/.test(w)));
  assert.ok(draft.warnings.some((w) => /No deadline was stated/.test(w)));
});

test("a budget range in the brief is flagged instead of picking a number", () => {
  const brief = "We need an app prototype. Our budget is between $500 and $800.";
  const draft = buildProposalDraft(
    brief,
    modelOutput({ budget_quote: "between $500 and $800" }),
  );

  assert.equal(draft.budget.total, null);
  assert.ok(draft.warnings.some((w) => /range or unclear/.test(w)));
});

test("missing sections get safe defaults and warnings", () => {
  const draft = buildProposalDraft(
    BRIEF,
    modelOutput({
      title: " ",
      deliverables: [],
      budget_breakdown: [{ item: "Budget", share_percent: 100 }],
      payment_schedule: [],
      revision_policy: "",
      change_request_process: "",
    }),
    ["title"],
  );

  assert.equal(draft.title, "Project proposal");
  assert.deepEqual(draft.budget.items, [{ label: "Project total", percent: 100, amount: 800 }]);
  assert.deepEqual(draft.paymentSchedule.map((p) => p.percent), [30, 40, 30]);
  assert.equal(sum(draft.paymentSchedule.map((p) => p.amount)), 80000);
  assert.ok(draft.revisions.suggestedPolicy.length > 0);
  assert.ok(draft.changeRequestProcess.length > 0);
  assert.ok(draft.warnings.some((w) => /did not return any deliverables/.test(w)));
  assert.ok(draft.warnings.some((w) => /malformed and was left empty: title/.test(w)));
});

test("lists are trimmed, de-duplicated, and capped", () => {
  const draft = buildProposalDraft(
    BRIEF,
    modelOutput({
      exclusions: ["  Hosting ", "hosting", "", ...Array.from({ length: 20 }, (_, i) => `Item ${i}`)],
    }),
  );

  assert.equal(draft.exclusions[0], "Hosting");
  assert.equal(draft.exclusions.filter((e) => e.toLowerCase() === "hosting").length, 1);
  assert.equal(draft.exclusions.length, 10);
});

// --- Generator with a fake Ollama -----------------------------------------

function fakeOllama(reply: { status?: number; body?: unknown; throws?: unknown }) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch = async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    if (reply.throws) throw reply.throws;
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  };
  return { fetch, requests };
}

const deps = (fetch: ReturnType<typeof fakeOllama>["fetch"]) => ({
  fetch,
  ollamaUrl: "http://ollama.test",
  model: "qwen2.5:3b",
});

test("the generator sends the schema, model, and brief, and returns a draft", async () => {
  const ollama = fakeOllama({
    body: { message: { content: JSON.stringify(modelOutput()) }, done_reason: "stop" },
  });

  const result = await generateProposalDraft(BRIEF, deps(ollama.fetch));

  assert.ok(result.ok);
  assert.equal(result.draft.budget.total, 800);
  const request = ollama.requests[0];
  assert.equal(request?.url, "http://ollama.test/api/chat");
  assert.equal(request?.body.model, "qwen2.5:3b");
  assert.deepEqual(request?.body.format, proposalJsonSchema);
  const messages = request?.body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0]?.content, PROPOSAL_SYSTEM_PROMPT);
  assert.ok(messages[1]?.content.includes(BRIEF), "brief goes in the user message only");
  assert.ok(!messages[0]?.content.includes(BRIEF));
});

for (const [label, reply, status, pattern] of [
  ["malformed JSON", { body: { message: { content: "{ not json" } } }, 502, /malformed/],
  ["an empty response", { body: { message: { content: "" } } }, 502, /empty response/],
  [
    "a truncated response",
    { body: { message: { content: "{}" }, done_reason: "length" } },
    502,
    /cut off/,
  ],
  ["an Ollama error status", { status: 500, body: { error: "boom" } }, 502, /could not draft/],
  [
    "a timeout",
    { throws: new DOMException("The operation timed out.", "TimeoutError") },
    504,
    /took too long/,
  ],
  ["Ollama not running", { throws: new TypeError("fetch failed") }, 503, /Ollama is running/],
  [
    "a response with no usable content",
    { body: { message: { content: JSON.stringify({ title: "", deliverables: [] }) } } },
    502,
    /usable proposal/,
  ],
] as const) {
  test(`the generator reports ${label} as a clear error`, async () => {
    const result = await generateProposalDraft(BRIEF, deps(fakeOllama(reply).fetch));

    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.status, status);
    assert.match(result.error, pattern);
  });
}

test("the generator keeps a partly malformed proposal and warns about it", async () => {
  const ollama = fakeOllama({
    body: {
      message: { content: JSON.stringify({ ...modelOutput(), risks: "none", milestones: null }) },
    },
  });

  const result = await generateProposalDraft(BRIEF, deps(ollama.fetch));

  assert.ok(result.ok);
  assert.deepEqual(result.draft.risks, []);
  assert.deepEqual(result.draft.milestones, []);
  assert.ok(result.draft.warnings.some((w) => /milestones, risks/.test(w)));
});
