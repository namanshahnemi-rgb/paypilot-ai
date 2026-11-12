// Tests for the project helpers: budget parsing never guesses, budgets are
// shown only as entered, and usage is described from the server's numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  PROJECT_STATUS_LABELS,
  PROPOSAL_STATUS_LABELS,
  describeUsage,
  formatBudget,
  parseBudget,
  type Usage,
} from "./projects.ts";

test("the budget field accepts plain amounts and leaves an empty field as not entered", () => {
  assert.equal(parseBudget(""), null);
  assert.equal(parseBudget("  "), null);
  assert.equal(parseBudget("800"), 800);
  assert.equal(parseBudget("1,250.50"), 1250.5);
  for (const bad of ["about 800", "-5", "8e3", "12.345", "$800", "9999999999"]) {
    assert.equal(parseBudget(bad), "invalid", bad);
  }
});

test("budgets are shown only as the freelancer entered them", () => {
  assert.equal(formatBudget({ estimatedBudget: "800.00", budgetCurrency: "USD" }), "USD 800.00");
  assert.equal(formatBudget({ estimatedBudget: null, budgetCurrency: null }), null);
});

test("usage is described from the plan and the server's counts", () => {
  const usage: Usage = {
    plan: "FREE",
    period: { start: "2026-11-01", resetsAt: "2026-12-01T00:00:00.000Z" },
    analyses: { used: 1, limit: 2, remaining: 1 },
    features: { proposalGeneration: false, riskReview: false, savedProposals: false },
  };
  assert.equal(describeUsage(usage), "Free · 1 of 2 analyses used this month");
  assert.equal(
    describeUsage({ ...usage, plan: "PRO", analyses: { used: 3, limit: 30, remaining: 27 } }),
    "Pro · 3 of 30 analyses used this month",
  );
});

test("every project and proposal status has a label", () => {
  assert.deepEqual(Object.keys(PROJECT_STATUS_LABELS), ["LEAD", "ACTIVE", "COMPLETED", "ARCHIVED"]);
  assert.deepEqual(Object.keys(PROPOSAL_STATUS_LABELS), ["DRAFT", "SENT", "ACCEPTED", "REJECTED"]);
});

test("API errors keep the server's status and code", () => {
  const error = new ApiError(402, { error: "Upgrade.", code: "USAGE_LIMIT_REACHED", plan: "FREE" }, "fallback");
  assert.equal(error.message, "Upgrade.");
  assert.equal(error.status, 402);
  assert.equal(error.code, "USAGE_LIMIT_REACHED");
  assert.equal(new ApiError(500, {}, "fallback").message, "fallback");
});

test("the Free plan's exhausted allowance gets an upgrade message, Pro gets a monthly reset message", async () => {
  const { accessProblem } = await import("./account.ts");
  assert.match(accessProblem(402, { code: "USAGE_LIMIT_REACHED", plan: "FREE", limit: 2 })!, /Free plan includes 2 .*Pro free trial/);
  assert.match(accessProblem(429, { code: "USAGE_LIMIT_REACHED", plan: "PRO", limit: 30 })!, /all 30 .*next month/);
  assert.doesNotMatch(accessProblem(402, { code: "USAGE_LIMIT_REACHED", plan: "FREE", limit: 2 })!, /sign in/i);
});
