// Tests for the AI part of the proposal risk review. Ollama is replaced by a
// scripted fake fetch; no live model, network, or PayPal calls are involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RISK_REVIEW_PROMPT,
  ReviewRequestSchema,
  aiReviewJsonSchema,
  groundFindings,
  renderProposal,
  reviewProposalWithAI,
  type ReviewRequest,
} from "./riskReview.js";

const BRIEF =
  "A client wants a five-page business website with a contact form, delivery in two weeks, two rounds of revisions, and a budget of $800.";

function request(overrides: Partial<ReviewRequest["proposal"]> = {}): ReviewRequest {
  return {
    brief: BRIEF,
    proposal: {
      title: "Business website",
      summary: "A five-page website. The site will be 100% secure.",
      currency: "USD",
      total: "800.00",
      budgetItems: [{ label: "Build", amount: "800.00" }],
      payments: [
        { label: "Deposit", amount: "400.00" },
        { label: "Launch", amount: "400.00" },
      ],
      sections: [
        { id: "deliverables", heading: "Scope and deliverables", tag: "AI-extracted", text: "- Five-page website\n- SEO package for all pages" },
        { id: "revisions", heading: "Revision policy", tag: "Suggested", text: "Unlimited revisions included." },
        { id: "assumptions", heading: "Assumptions", tag: "Assumption", text: "- Client supplies all photos" },
      ],
      ...overrides,
    },
  };
}

type Finding = {
  severity: "High" | "Medium" | "Low";
  category: "missing_requirement" | "ambiguity" | "unagreed_commitment" | "inconsistency";
  title: string;
  why_it_matters: string;
  suggestion: string;
  proposal_quote: string | null;
  brief_quote: string | null;
};

function aiFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: "High",
    category: "unagreed_commitment",
    title: "Unlimited revisions offered",
    why_it_matters: "The brief asks for two rounds only.",
    suggestion: "Limit revisions to two rounds.",
    proposal_quote: "Unlimited revisions included",
    brief_quote: "two rounds of revisions",
    ...overrides,
  };
}

// --- Request validation ----------------------------------------------------

test("the request schema accepts a proposal and rejects invalid input", () => {
  assert.ok(ReviewRequestSchema.safeParse(request()).success);
  assert.ok(!ReviewRequestSchema.safeParse({ ...request(), brief: "short" }).success);
  assert.ok(!ReviewRequestSchema.safeParse({ brief: BRIEF }).success);
  const badTag = request();
  (badTag.proposal.sections[0] as { tag: string }).tag = "Agreed";
  assert.ok(!ReviewRequestSchema.safeParse(badTag).success);
  assert.ok(
    !ReviewRequestSchema.safeParse(request({ summary: "x".repeat(5001) })).success,
    "oversized text is rejected",
  );
});

test("the rendered proposal keeps section labels and is capped in length", () => {
  const text = renderProposal(request().proposal);
  assert.match(text, /## Revision policy \[Suggested\]/);
  assert.match(text, /Total: USD 800\.00/);

  const long = renderProposal(
    request({
      sections: Array.from({ length: 5 }, (_, i) => ({
        id: `s${i}`,
        heading: `Section ${i}`,
        tag: "Suggested" as const,
        text: "y".repeat(5000),
      })),
    }).proposal,
  );
  assert.ok(long.length <= 16000 + 30);
  assert.match(long, /\[proposal truncated\]$/);
});

// --- Grounding -------------------------------------------------------------

test("a quoted commitment is kept and labelled by the section it came from", () => {
  const [finding] = groundFindings(request(), [aiFinding()]);

  assert.equal(finding?.source, "ai");
  assert.equal(finding?.severity, "High");
  assert.equal(finding?.category, "Not agreed in the brief");
  assert.equal(finding?.basis, "AI suggestion");
  assert.equal(finding?.sectionId, "revisions");
  assert.match(finding?.id ?? "", /^ai:[0-9a-f]{12}$/);
});

test("findings quoting text that isn't in the proposal or brief are dropped", () => {
  const found = groundFindings(request(), [
    aiFinding({ proposal_quote: "We guarantee first-page Google rankings", brief_quote: null }),
    aiFinding({ category: "inconsistency", title: "Budget mismatch", proposal_quote: "USD 950", brief_quote: "a budget of $950" }),
  ]);
  assert.deepEqual(found, []);
});

test("a 'commitment' quoted from an exclusion or assumption is dropped", () => {
  const found = groundFindings(
    request({
      sections: [
        ...request().proposal.sections,
        { id: "exclusions", heading: "Out of scope", tag: "Suggested", text: "- No branding or logo design" },
      ],
    }),
    [
      aiFinding({ title: "Branding promised", proposal_quote: "No branding or logo design", brief_quote: null }),
      aiFinding({ title: "Photos promised", proposal_quote: "Client supplies all photos", brief_quote: null }),
    ],
  );
  assert.deepEqual(found, []);
});

test("the schema sent to Ollama limits findings and text length", () => {
  const findings = (aiReviewJsonSchema.properties as Record<string, { maxItems?: number; items?: { properties?: Record<string, { maxLength?: number }> } }>).findings;
  assert.equal(findings?.maxItems, 8);
  assert.equal(findings?.items?.properties?.title?.maxLength, 160);
});

test("a commitment the brief actually asked for is not flagged", () => {
  const found = groundFindings(request(), [
    aiFinding({ title: "Contact form promised", proposal_quote: "contact form", brief_quote: null }),
  ]);
  assert.deepEqual(found, []);
});

test("only verified brief quotes make a finding a brief fact", () => {
  const [verified, unverified] = groundFindings(
    request({ total: "950.00" }),
    [
      aiFinding({ category: "inconsistency", title: "Total differs from brief", proposal_quote: "Total: USD 950.00", brief_quote: "a budget of $800" }),
      aiFinding({ category: "inconsistency", title: "Deadline differs", proposal_quote: "Five-page website", brief_quote: "deliver within 10 days" }),
    ],
  );

  assert.equal(verified?.basis, "Brief fact");
  assert.equal(verified?.sectionId, "budget");
  assert.equal(unverified?.basis, "AI suggestion", "an unverified brief claim is not presented as a brief fact");
});

test("missing requirements need no quote and are open questions", () => {
  const [finding] = groundFindings(request(), [
    aiFinding({ category: "missing_requirement", severity: "Medium", title: "No acceptance criteria", proposal_quote: null, brief_quote: null }),
  ]);

  assert.equal(finding?.category, "Missing or ambiguous");
  assert.equal(finding?.basis, "Open question");
  assert.equal(finding?.sectionId, null);
});

test("assumption sections give an assumption basis, and duplicates are removed", () => {
  const found = groundFindings(request(), [
    aiFinding({ category: "ambiguity", severity: "Low", title: "Photo ownership unclear", proposal_quote: "Client supplies all photos", brief_quote: null }),
    aiFinding({ category: "ambiguity", severity: "Low", title: "photo ownership unclear", proposal_quote: "Client supplies all photos", brief_quote: null }),
  ]);

  assert.equal(found.length, 1);
  assert.equal(found[0]?.basis, "Assumption");
});

test("at most eight findings are returned", () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    aiFinding({ category: "missing_requirement", title: `Missing item ${i}`, proposal_quote: null, brief_quote: null }),
  );
  assert.equal(groundFindings(request(), many).length, 8);
});

// --- Model call ------------------------------------------------------------

type Reply = { content: string; doneReason?: string } | { status: number } | { throws: unknown };

function fakeOllama(reply: Reply) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch = async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    if ("throws" in reply) throw reply.throws;
    if ("status" in reply) return new Response("{}", { status: reply.status });
    return new Response(
      JSON.stringify({ message: { content: reply.content }, done_reason: reply.doneReason ?? "stop" }),
    );
  };
  return { fetch, requests };
}

const deps = (fetch: ReturnType<typeof fakeOllama>["fetch"]) => ({
  fetch,
  ollamaUrl: "http://ollama.test",
  model: "qwen2.5:3b",
});

test("the review calls only the local model with the schema, brief, and proposal", async () => {
  const ollama = fakeOllama({
    content: JSON.stringify({
      findings: [
        aiFinding(),
        aiFinding({ title: "Made-up issue", proposal_quote: "not in the proposal", brief_quote: null }),
        { severity: "Critical", title: "bad entry" },
      ],
    }),
  });

  const result = await reviewProposalWithAI(request(), deps(ollama.fetch));

  assert.ok(result.ok);
  assert.equal(result.findings.length, 1);
  assert.equal(result.discarded, 2);
  assert.equal(ollama.requests.length, 1);
  assert.equal(ollama.requests[0]?.url, "http://ollama.test/api/chat");
  assert.deepEqual(ollama.requests[0]?.body.format, aiReviewJsonSchema);
  const messages = ollama.requests[0]?.body.messages as Array<{ content: string }>;
  assert.equal(messages[0]?.content, RISK_REVIEW_PROMPT);
  assert.ok(messages[1]?.content.includes(BRIEF));
  assert.ok(messages[1]?.content.includes("Unlimited revisions included."));
});

test("an empty findings list is a valid result", async () => {
  const result = await reviewProposalWithAI(
    request(),
    deps(fakeOllama({ content: JSON.stringify({ findings: [] }) }).fetch),
  );
  assert.deepEqual(result, { ok: true, findings: [], discarded: 0 });
});

for (const [label, reply, status, pattern, attempts] of [
  ["malformed JSON", { content: "{ not json" }, 502, /malformed/, 2],
  ["a truncated review", { content: '{"findings": [', doneReason: "length" }, 502, /cut off/, 2],
  ["a missing findings list", { content: JSON.stringify({ issues: [] }) }, 502, /usable review/, 2],
  ["a timeout", { throws: new DOMException("The operation timed out.", "TimeoutError") }, 504, /too long/, 1],
  ["Ollama not running", { throws: new TypeError("fetch failed") }, 503, /Ollama is running/, 1],
  ["an Ollama error status", { status: 500 }, 502, /could not review/, 1],
] as const) {
  test(`${label} gives a clear error after ${attempts} attempt(s)`, async () => {
    const ollama = fakeOllama(reply);
    const result = await reviewProposalWithAI(request(), deps(ollama.fetch));

    assert.ok(!result.ok);
    assert.equal(result.status, status);
    assert.match(result.error, pattern);
    assert.equal(ollama.requests.length, attempts, "retries only model-output failures, once");
  });
}

test("a truncated first answer is retried once with a larger output limit", async () => {
  const replies: Reply[] = [
    { content: '{"findings": [', doneReason: "length" },
    { content: JSON.stringify({ findings: [aiFinding()] }) },
  ];
  const requests: Array<Record<string, unknown>> = [];
  const fetch = async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const reply = replies.shift() as { content: string; doneReason?: string };
    return new Response(JSON.stringify({ message: { content: reply.content }, done_reason: reply.doneReason ?? "stop" }));
  };

  const result = await reviewProposalWithAI(request(), deps(fetch));

  assert.ok(result.ok);
  assert.equal(result.findings.length, 1);
  const [first, second] = requests.map((r) => r.options as Record<string, number>);
  assert.ok((second?.num_predict ?? 0) > (first?.num_predict ?? 0));
  assert.ok((second?.temperature ?? 0) > 0);
});
