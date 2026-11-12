// User-facing AI error messages match the provider that handled the request
// (PP-30): in Gemini mode they never tell the user to start a local model or
// Ollama, while Ollama mode keeps its local instructions. Status codes are the
// same for both providers. The model APIs are faked; nothing is sent anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AiProvider, OllamaDeps } from "./localModel.js";
import { analyzeBrief } from "./analysis.js";
import { generateProposalDraft } from "./proposalGenerator.js";
import { reviewProposalWithAI, type ReviewRequest } from "./riskReview.js";

const BRIEF =
  "A client wants a five-page business website with a contact form, delivery in two weeks, " +
  "two rounds of revisions, and a budget of $800.";

const REVIEW: ReviewRequest = {
  brief: BRIEF,
  proposal: {
    title: "Business website",
    summary: "A five-page website.",
    currency: "USD",
    total: "800.00",
    budgetItems: [{ label: "Build", amount: "800.00" }],
    payments: [{ label: "On delivery", amount: "800.00" }],
    sections: [
      { id: "revisions", heading: "Revision policy", tag: "Suggested", text: "Two rounds of revisions." },
    ],
  },
};

type Fault = "unavailable" | "http-error" | "timeout";

function failingDeps(provider: AiProvider, fault: Fault): OllamaDeps {
  return {
    provider,
    gemini: { apiKey: "AIzaFakeKeyForProviderErrorTests_0123", model: "gemini-test", baseUrl: "https://gemini.test/v1beta" },
    ollamaUrl: "http://ollama.test",
    model: "qwen2.5:3b",
    fetch: async () => {
      if (fault === "unavailable") throw new TypeError("fetch failed");
      if (fault === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
      return new Response(JSON.stringify({ error: { message: "Internal error", status: "INTERNAL" } }), {
        status: 500,
      });
    },
  };
}

const FEATURES = {
  analysis: (deps: OllamaDeps) => analyzeBrief(BRIEF, deps),
  proposal: (deps: OllamaDeps) => generateProposalDraft(BRIEF, deps),
  review: (deps: OllamaDeps) => reviewProposalWithAI(REVIEW, deps),
};

const EXPECTED_STATUS: Record<Fault, number> = { unavailable: 503, "http-error": 502, timeout: 504 };
const LOCAL_WORDING = /ollama|local (ai )?model|is running/i;

for (const [feature, run] of Object.entries(FEATURES)) {
  for (const fault of ["unavailable", "http-error", "timeout"] as const) {
    test(`${feature}, Gemini mode, ${fault}: no local-model or Ollama wording`, async (t) => {
      t.mock.method(console, "warn", () => {});
      const result = await run(failingDeps("gemini", fault));
      assert.ok(!result.ok);
      assert.equal(result.status, EXPECTED_STATUS[fault]);
      assert.doesNotMatch(result.error, LOCAL_WORDING);
      assert.ok(result.error.length > 0);
    });

    test(`${feature}, Ollama mode, ${fault}: same status code`, async (t) => {
      t.mock.method(console, "warn", () => {});
      const result = await run(failingDeps("ollama", fault));
      assert.ok(!result.ok);
      assert.equal(result.status, EXPECTED_STATUS[fault]);
    });
  }

  test(`${feature}, Ollama mode: an unreachable model still says to check Ollama`, async () => {
    const result = await run(failingDeps("ollama", "unavailable"));
    assert.ok(!result.ok);
    assert.match(result.error, /Ollama is running/);
  });
}

test("Gemini mode without an API key is reported as unavailable, without local wording", async () => {
  const deps: OllamaDeps = {
    provider: "gemini",
    gemini: { apiKey: "" },
    ollamaUrl: "http://ollama.test",
    model: "unused",
    fetch: async () => assert.fail("no request is sent without a key"),
  };
  const previous = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const result = await analyzeBrief(BRIEF, deps);
    assert.ok(!result.ok);
    assert.equal(result.status, 503);
    assert.doesNotMatch(result.error, LOCAL_WORDING);
  } finally {
    if (previous !== undefined) process.env.GEMINI_API_KEY = previous;
  }
});
