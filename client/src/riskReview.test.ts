// Tests for the proposal risk review. Run with `npm test` (Node's built-in
// test runner; no browser or extra dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { toEditableProposal, type EditableProposal, type ProposalDraft } from "./proposal.ts";
import {
  RULES,
  aiReviewStatus,
  parseDurationDays,
  proposalFingerprint,
  revisionCount,
  reviewedKey,
  runRiskChecks,
  scheduleSpanDays,
  sortFindings,
  summarizeFindings,
  toReviewRequest,
  syncSchedule,
  workingDaySpan,
  type ReviewFinding,
  type RuleId,
} from "./riskReview.ts";
// The server's authoritative schedule check (dependency-free), used to build
// realistic drafts and to prove the client's recalculation matches it.
import { checkSchedule } from "../../server/src/proposalQuality.ts";

const BRIEF =
  "A client wants a five-page business website with a contact form, mobile responsiveness, delivery in two weeks, two rounds of revisions, and a budget of $800.";

function draft(overrides: Partial<ProposalDraft> = {}): ProposalDraft {
  return {
    title: "Business website",
    executiveSummary: "A five-page responsive business website with a contact form.",
    clientGoals: ["Establish an online presence"],
    deliverables: [
      { name: "Five-page website", description: "Responsive pages", acceptanceCriteria: ["Pages render on mobile"] },
      { name: "Contact form", description: "Sends enquiries by email", acceptanceCriteria: ["A test enquiry arrives"] },
    ],
    exclusions: ["No SEO optimization"],
    assumptions: ["Client supplies images"],
    milestones: [
      { name: "Design", estimatedDuration: "3-4 days", dependsOn: [] },
      { name: "Build", estimatedDuration: "5-6 days", dependsOn: ["Design"] },
    ],
    budget: {
      total: 800,
      currency: "USD",
      statedInBrief: "a budget of $800",
      items: [
        { label: "Design", percent: 30, amount: 240 },
        { label: "Development", percent: 50, amount: 400 },
        { label: "Testing", percent: 20, amount: 160 },
      ],
    },
    paymentSchedule: [
      { label: "Deposit", percent: 50, amount: 400 },
      { label: "Launch", percent: 50, amount: 400 },
    ],
    deadline: { statedInBrief: "delivery in two weeks" },
    revisions: {
      statedInBrief: "two rounds of revisions",
      suggestedPolicy: "Two rounds of revisions per deliverable.",
    },
    changeRequestProcess: "Changes are quoted before work starts.",
    risks: [],
    missingInformation: [],
    clarificationQuestions: [],
    clientResponsibilities: ["Provide page content"],
    prerequisites: ["Domain access"],
    warnings: [],
    ...overrides,
  };
}

const proposalFor = (overrides: Partial<ProposalDraft> = {}, brief = BRIEF) =>
  toEditableProposal(draft(overrides), brief);

function withSection(proposal: EditableProposal, id: string, text: string): EditableProposal {
  return {
    ...proposal,
    sections: proposal.sections.map((s) => (s.id === id ? { ...s, text } : s)),
  };
}

const ids = (findings: ReviewFinding[]) => findings.map((f) => f.id).sort();
const byId = (findings: ReviewFinding[], id: string) => findings.find((f) => f.id === id);

// --- Baseline --------------------------------------------------------------

test("a complete proposal that matches its brief has no findings", () => {
  assert.deepEqual(runRiskChecks(proposalFor()), []);
});

// --- Arithmetic ------------------------------------------------------------

test("payment milestones that don't add up to the total are a High arithmetic finding", () => {
  const proposal = proposalFor();
  proposal.payments = [
    { label: "Deposit", amount: "300", suggestedPercent: 50 },
    { label: "Launch", amount: "400", suggestedPercent: 50 },
  ];
  const found = byId(runRiskChecks(proposal), "payments-sum");

  assert.equal(found?.severity, "High");
  assert.equal(found?.category, "Arithmetic");
  assert.match(found?.title ?? "", /USD 700\.00, not the total of USD 800\.00/);
  assert.equal(found?.sectionId, "budget");
});

test("unreadable amounts are reported instead of silently ignored", () => {
  const proposal = proposalFor();
  proposal.budgetItems = [{ label: "Design", amount: "eight hundred", suggestedPercent: null }];
  proposal.total = "800 dollars";

  assert.deepEqual(
    ids(runRiskChecks(proposal)).filter((id) => id.startsWith("invalid-amount")),
    ["invalid-amount:budget-sum", "invalid-amount:total"],
  );
});

// --- Missing or ambiguous requirements ------------------------------------

test("missing deliverables, acceptance criteria, revisions, responsibilities, and payments are flagged", () => {
  let proposal = proposalFor();
  for (const id of ["deliverables", "acceptance", "revisions", "responsibilities"]) {
    proposal = withSection(proposal, id, "");
  }
  proposal.payments = [];
  const found = runRiskChecks(proposal);

  assert.equal(byId(found, "missing-deliverables")?.severity, "High");
  assert.equal(byId(found, "missing-payments")?.severity, "High");
  assert.equal(byId(found, "missing-acceptance")?.severity, "Medium");
  assert.equal(byId(found, "missing-revision-policy")?.severity, "Medium");
  assert.equal(byId(found, "missing-responsibilities")?.severity, "Medium");
});

test("an unspecified total is a High open question, and a vague revision limit is flagged", () => {
  let proposal = proposalFor({ budget: { ...draft().budget, total: null, currency: null, statedInBrief: null } });
  proposal = withSection(proposal, "revisions", "A set number of revision rounds, to be agreed.");
  const found = runRiskChecks(proposal);

  assert.equal(byId(found, "missing-total")?.severity, "High");
  assert.equal(byId(found, "missing-total")?.basis, "Open question");
  assert.equal(byId(found, "revision-limit-undefined")?.severity, "Medium");
});

test("a brief without a deadline is a High open question, not an invented date", () => {
  const brief = "Build a five-page business website with a contact form for $800, two rounds of revisions.";
  const found = runRiskChecks(proposalFor({ deadline: { statedInBrief: null } }, brief));
  const deadline = byId(found, "brief-no-deadline");

  assert.equal(deadline?.severity, "High");
  assert.equal(deadline?.basis, "Open question");
});

test("open questions, placeholders, and missing dependencies are reported", () => {
  let proposal = proposalFor({ missingInformation: ["Hosting provider"], clarificationQuestions: ["Who writes the copy?"] });
  proposal = withSection(proposal, "changes", "Change requests cost TBD per hour.");
  proposal = withSection(proposal, "timeline", 'Deadline stated in the brief: "delivery in two weeks"\n- Design: estimated 3 days\n- Build: estimated 5 days');
  const found = runRiskChecks(proposal);

  assert.match(byId(found, "open-questions")?.title ?? "", /^2 item/);
  assert.equal(byId(found, "placeholder-text")?.sectionId, "changes");
  assert.equal(byId(found, "missing-dependencies")?.severity, "Low");
});

// --- Commitments the brief didn't ask for ---------------------------------

test("unlimited revisions are a High finding unless the brief asks for them", () => {
  const proposal = withSection(proposalFor(), "revisions", "Unlimited revisions until you are happy.");

  const found = byId(runRiskChecks(proposal), "unlimited-revisions");
  assert.equal(found?.severity, "High");
  assert.equal(found?.category, "Not agreed in the brief");

  const askedFor = { ...proposal, sourceBrief: `${BRIEF} We expect unlimited revisions.` };
  assert.equal(byId(runRiskChecks(askedFor), "unlimited-revisions"), undefined);
});

test("absolute guarantees are flagged, but disclaimers are not", () => {
  const promise = { ...proposalFor(), summary: "The website will be 100% secure and bug-free." };
  const disclaimer = { ...proposalFor(), summary: "We cannot guarantee 100% security, but follow best practices." };

  const found = byId(runRiskChecks(promise), "absolute-guarantee");
  assert.equal(found?.severity, "High");
  assert.equal(found?.basis, "AI suggestion");
  assert.equal(found?.sectionId, "summary");
  assert.equal(byId(runRiskChecks(disclaimer), "absolute-guarantee"), undefined);
});

test("extra work such as SEO is flagged only when promised and not in the brief", () => {
  const promised = withSection(
    proposalFor(),
    "deliverables",
    "- Five-page website: Responsive pages\n- SEO optimization: On-page SEO for all pages",
  );
  const excluded = withSection(proposalFor(), "exclusions", "- SEO optimization\n- Hosting");
  const requested = { ...promised, sourceBrief: `${BRIEF} Please include SEO.` };

  assert.equal(byId(runRiskChecks(promised), "extra-work:seo")?.severity, "Medium");
  assert.equal(byId(runRiskChecks(excluded), "extra-work:seo"), undefined);
  assert.equal(byId(runRiskChecks(requested), "extra-work:seo"), undefined);
});

test("an unrequested extra-work deliverable is reported once, not twice", () => {
  const proposal = withSection(
    proposalFor(),
    "deliverables",
    "- Five-page website: Responsive pages\n- SEO and analytics setup: Rank on Google",
  );
  const found = runRiskChecks(proposal).map((f) => f.id);

  assert.ok(found.includes("extra-work:seo"));
  assert.ok(!found.some((id) => id.startsWith("deliverable-not-in-brief")), found.join(", "));
});

test("rush turnaround promises are flagged", () => {
  const proposal = withSection(proposalFor(), "changes", "Change requests are completed within 24 hours.");
  assert.equal(byId(runRiskChecks(proposal), "rush-commitment")?.severity, "Medium");
});

// --- Brief versus proposal -------------------------------------------------

test("a total or currency that differs from the brief is a High inconsistency", () => {
  const proposal = { ...proposalFor(), total: "900.00", currency: "EUR" };
  const found = runRiskChecks(proposal);

  assert.equal(byId(found, "total-differs")?.severity, "High");
  assert.equal(byId(found, "total-differs")?.basis, "Brief fact");
  assert.match(byId(found, "total-differs")?.title ?? "", /"a budget of \$800"/);
  assert.equal(byId(found, "currency-differs")?.severity, "High");
});

test("a total the brief never stated is marked as an assumption to confirm", () => {
  const brief = "Build a five-page business website with a contact form, delivery in two weeks, two rounds of revisions.";
  const proposal = proposalFor({ budget: { ...draft().budget, total: null, currency: null, statedInBrief: null } }, brief);
  const found = byId(runRiskChecks({ ...proposal, total: "800", currency: "USD" }), "total-not-in-brief");

  assert.equal(found?.severity, "Medium");
  assert.equal(found?.basis, "Assumption");
});

test("milestones that can't meet the brief's deadline are flagged by severity", () => {
  const deadline = 'Deadline stated in the brief: "delivery in two weeks"';
  const tooLong = withSection(proposalFor(), "timeline", `${deadline}\n- Design: estimated 10 days\n- Build: estimated 8 days (after Design)`);
  const mayExceed = withSection(proposalFor(), "timeline", `${deadline}\n- Design: estimated 3-5 days\n- Build: estimated 5-12 days (after Design)`);
  const parallel = withSection(proposalFor(), "timeline", `${deadline}\n- Design: estimated 10 days\n- Copy: estimated 10 days`);

  assert.equal(byId(runRiskChecks(tooLong), "schedule-exceeds-deadline")?.severity, "High");
  assert.equal(byId(runRiskChecks(mayExceed), "schedule-may-exceed-deadline")?.severity, "Medium");
  const parallelIds = ids(runRiskChecks(parallel));
  assert.ok(!parallelIds.includes("schedule-exceeds-deadline"));
  assert.ok(!parallelIds.includes("schedule-may-exceed-deadline"));
});

test("a timeline that drops the brief's deadline is flagged", () => {
  const proposal = withSection(proposalFor(), "timeline", "- Design: estimated 3 days\n- Build: estimated 5 days (after Design)");
  assert.equal(byId(runRiskChecks(proposal), "deadline-not-reflected")?.severity, "Medium");
});

test("a revision count that differs from the brief is a High inconsistency", () => {
  const proposal = withSection(proposalFor(), "revisions", "Three rounds of revisions are included.");
  const found = byId(runRiskChecks(proposal), "revisions-differ");

  assert.equal(found?.severity, "High");
  assert.match(found?.title ?? "", /offers 3 round\(s\), but the brief mentions 2/);
});

test("a deliverable with no link to the brief is a Low, hedged finding", () => {
  const proposal = withSection(proposalFor(), "deliverables", "- Five-page website: Pages\n- Blockchain ledger: Records orders");
  const found = runRiskChecks(proposal).filter((f) => f.id.startsWith("deliverable-not-in-brief"));

  assert.equal(found.length, 1);
  assert.equal(found[0]?.severity, "Low");
  assert.match(found[0]?.title ?? "", /may not be/);
});

test("proposals saved before brief tracking skip brief comparisons with a note", () => {
  const legacy = { ...proposalFor(), total: "900" };
  delete legacy.sourceBrief;
  delete legacy.briefFacts;
  const found = runRiskChecks(legacy);

  assert.ok(byId(found, "no-source-brief"));
  assert.equal(byId(found, "total-differs"), undefined);
});

// --- Severity and basis classification -------------------------------------

test("every finding uses the severity and category defined for its rule", () => {
  const messy = withSection(
    { ...proposalFor(), total: "900", summary: "Fully secure, unlimited revisions. TBD." },
    "deliverables",
    "- SEO package: Rankings",
  );
  const found = runRiskChecks(messy);
  assert.ok(found.length > 5);
  for (const f of found) {
    const rule = RULES[f.id.split(":")[0] as RuleId];
    assert.equal(f.severity, rule.severity, f.id);
    assert.equal(f.category, rule.category, f.id);
    assert.equal(f.source, "check");
  }
});

test("severity reflects impact: contradictions and broken arithmetic are High", () => {
  const high: RuleId[] = ["budget-sum", "payments-sum", "total-differs", "currency-differs", "revisions-differ", "schedule-exceeds-deadline", "unlimited-revisions", "absolute-guarantee", "missing-total", "missing-deliverables"];
  const low: RuleId[] = ["missing-dependencies", "deliverable-not-in-brief", "no-source-brief"];
  for (const id of high) assert.equal(RULES[id].severity, "High", id);
  for (const id of low) assert.equal(RULES[id].severity, "Low", id);
});

test("only brief comparisons claim to be based on a brief fact", () => {
  const briefRules = new Set(["total-differs", "currency-differs", "deadline-not-reflected", "schedule-exceeds-deadline", "schedule-may-exceed-deadline", "revisions-differ"]);
  const found = runRiskChecks({ ...proposalFor(), total: "900", summary: "100% secure. Unlimited revisions." });
  for (const f of found.filter((x) => x.basis === "Brief fact")) {
    assert.ok(briefRules.has(f.id), f.id);
  }
});

test("findings are sorted High, Medium, Low", () => {
  const found = sortFindings(runRiskChecks({ ...proposalFor({ missingInformation: ["x"] }), total: "900" }));
  const order = found.map((f) => f.severity);
  assert.deepEqual(order, [...order].sort((a, b) => ["High", "Medium", "Low"].indexOf(a) - ["High", "Medium", "Low"].indexOf(b)));
});

// --- Parsing helpers -------------------------------------------------------

test("durations and revision counts are read from common phrasings", () => {
  assert.deepEqual(parseDurationDays("estimated 3-5 days"), { min: 3, max: 5 });
  assert.deepEqual(parseDurationDays("delivery in two weeks"), { min: 14, max: 14 });
  assert.deepEqual(parseDurationDays("a month"), { min: 30, max: 30 });
  assert.equal(parseDurationDays("soon"), null);
  assert.deepEqual(scheduleSpanDays("- A: 2 days\n- B: 3 days (after A)\n- C: 1 day"), { min: 5, max: 5 });
  assert.equal(revisionCount("two rounds of revisions"), 2);
  assert.equal(revisionCount("1 revision included"), 1);
  assert.equal(revisionCount("a set number of revision rounds"), null);
});

// --- Review state used by the UI -------------------------------------------

test("the fingerprint changes with content edits but not with generation notes", () => {
  const proposal = proposalFor();
  const edited = withSection(proposal, "changes", "Different text");

  assert.notEqual(proposalFingerprint(edited), proposalFingerprint(proposal));
  assert.equal(
    proposalFingerprint({ ...proposal, generationNotes: ["new note"] }),
    proposalFingerprint(proposal),
  );
});

test("AI findings are stale as soon as the proposal changes", () => {
  const proposal = proposalFor();
  const review = { fingerprint: proposalFingerprint(proposal), findings: [], ranAt: "now" };

  assert.equal(aiReviewStatus(null, proposalFingerprint(proposal)), "none");
  assert.equal(aiReviewStatus(review, proposalFingerprint(proposal)), "current");
  assert.equal(aiReviewStatus(review, proposalFingerprint({ ...proposal, total: "801" })), "stale");
});

test("a reviewed mark does not carry over to a changed finding or a new proposal", () => {
  const proposal = proposalFor();
  const mismatch = (amount: string) => {
    const p = { ...proposal, payments: [{ label: "All", amount, suggestedPercent: null }] };
    return byId(runRiskChecks(p), "payments-sum") as ReviewFinding;
  };

  assert.equal(reviewedKey(proposal, mismatch("700")), reviewedKey(proposal, mismatch("700")));
  assert.notEqual(reviewedKey(proposal, mismatch("700")), reviewedKey(proposal, mismatch("600")));
  assert.notEqual(
    reviewedKey(proposal, mismatch("700")),
    reviewedKey({ ...proposal, generatedAt: "2099-01-01T00:00:00.000Z" }, mismatch("700")),
  );
});

test("the summary counts only findings not yet reviewed", () => {
  const found = runRiskChecks({ ...proposalFor({ missingInformation: ["x"] }), total: "900" });
  const reviewedIds = new Set(["total-differs"]);
  const summary = summarizeFindings(found, (f) => reviewedIds.has(f.id));

  assert.equal(summary.total, found.length);
  assert.equal(summary.reviewed, 1);
  assert.equal(summary.High + summary.Medium + summary.Low, found.length - 1);
});

test("the AI review request contains the proposal content and source brief only", () => {
  const body = toReviewRequest(proposalFor());

  assert.equal(body.brief, BRIEF);
  assert.deepEqual(Object.keys(body.proposal).sort(), ["budgetItems", "currency", "payments", "sections", "summary", "title", "total"]);
  assert.deepEqual(Object.keys(body.proposal.payments[0] ?? {}), ["label", "amount"]);
  assert.ok(!JSON.stringify(body).includes("suggestedPercent"));
});

// --- Schedule findings use the proposal timeline's schedule result ----------

type Milestone = { name: string; estimatedDuration: string; dependsOn: string[] };
const m = (name: string, estimatedDuration: string, dependsOn: string[] = []): Milestone => ({
  name,
  estimatedDuration,
  dependsOn,
});

// The live five-page website milestones: 8-14 working days in sequence.
const LIVE_MILESTONES = [
  m("Design", "3-5 days"),
  m("Development", "3-5 days", ["Design"]),
  m("Testing", "1-2 days", ["Development"]),
  m("Final Review", "1-2 days", ["Testing"]),
];

// A proposal as generated now: the server computes the schedule result.
function generated(milestones: Milestone[], deadline: string | null = "delivery in two weeks") {
  return proposalFor({
    milestones,
    deadline: { statedInBrief: deadline },
    schedule: checkSchedule(milestones, deadline),
  });
}

const scheduleFindings = (proposal: EditableProposal) =>
  runRiskChecks(proposal).filter((f) => f.id.startsWith("schedule-"));
const timelineTag = (proposal: EditableProposal) => proposal.sections.find((s) => s.id === "timeline")?.tag;

test("8-14 working days against 'two weeks' is a Medium 'may exceed' finding, matching the timeline", () => {
  const proposal = generated(LIVE_MILESTONES);
  const found = scheduleFindings(proposal);

  assert.equal(proposal.schedule?.check.status, "may-exceed");
  assert.equal(timelineTag(proposal), "Needs confirmation");
  assert.equal(found.length, 1);
  assert.equal(found[0]?.id, "schedule-may-exceed-deadline");
  assert.equal(found[0]?.severity, "Medium");
  assert.equal(
    found[0]?.title,
    'The milestones could take up to 14 working days, beyond the brief\'s deadline ("delivery in two weeks", about 10 working days (14 calendar days))',
  );
  assert.doesNotMatch(`${found[0]?.title} ${found[0]?.why}`, /impossible|cannot|can't be met/i, "a possible overrun is not called impossible");
  assert.match(found[0]?.suggestion ?? "", /Confirm the deadline/);
});

test("the old calendar-day check missed this conflict, which is why the stored result is used", () => {
  const legacy = generated(LIVE_MILESTONES);
  delete legacy.schedule;

  // 14 calendar days of estimates fit "two weeks" in calendar days.
  assert.deepEqual(scheduleFindings(legacy), []);
});

test("a schedule that fits raises no schedule finding and keeps the timeline a suggestion", () => {
  const proposal = generated([m("Design", "3 working days"), m("Build", "5 working days", ["Design"])]);

  assert.equal(proposal.schedule?.check.status, "fits");
  assert.equal(timelineTag(proposal), "Suggested");
  assert.deepEqual(scheduleFindings(proposal), []);
});

test("a schedule that exceeds the deadline is a High finding, worded as an estimate", () => {
  const proposal = generated([m("Design", "6 working days"), m("Build", "1-2 weeks", ["Design"])]);
  const found = scheduleFindings(proposal);

  assert.equal(proposal.schedule?.check.status, "exceeds");
  assert.equal(found.length, 1);
  assert.equal(found[0]?.id, "schedule-exceeds-deadline");
  assert.equal(found[0]?.severity, "High");
  assert.match(found[0]?.title ?? "", /^The milestones are estimated to need at least 11 working days, longer than the brief's deadline/);
  assert.match(found[0]?.suggestion ?? "", /later deadline or a smaller scope/);
});

test("12 working days is flagged even though it fits two weeks in calendar days", () => {
  const proposal = generated([m("Design", "5 days"), m("Build", "7 days", ["Design"])]);

  assert.equal(proposal.schedule?.check.status, "exceeds");
  assert.deepEqual(scheduleFindings(proposal).map((f) => f.id), ["schedule-exceeds-deadline"]);
});

test("a deadline that can't be compared produces no schedule conflict", () => {
  const proposal = generated(LIVE_MILESTONES, "by the end of March");

  assert.equal(proposal.schedule?.check.status, "unknown");
  assert.deepEqual(scheduleFindings(proposal), []);
  assert.match(proposal.sections.find((s) => s.id === "timeline")?.text ?? "", /could not be compared/);
});

test("a brief without a deadline keeps the 'no deadline' finding and no schedule conflict", () => {
  const brief = "Build a five-page business website with a contact form for $800, two rounds of revisions.";
  const milestones = [m("Design", "20 days")];
  const proposal = proposalFor({ milestones, deadline: { statedInBrief: null }, schedule: checkSchedule(milestones, null) }, brief);
  const ids = runRiskChecks(proposal).map((f) => f.id);

  assert.equal(proposal.schedule?.check.status, "no-deadline");
  assert.ok(ids.includes("brief-no-deadline"));
  assert.ok(!ids.some((id) => id.startsWith("schedule-")));
});

test("there is never more than one schedule finding", () => {
  for (const milestones of [
    LIVE_MILESTONES,
    [m("Design", "6 working days"), m("Build", "1-2 weeks", ["Design"])],
    [m("Design", "10 days"), m("Build", "8 days", ["Design"])],
  ]) {
    assert.equal(scheduleFindings(generated(milestones)).length, 1, milestones.map((x) => x.estimatedDuration).join(", "));
  }
});

test("edited milestones are rechecked in working days against the same deadline", () => {
  const proposal = generated(LIVE_MILESTONES);
  const withTimeline = (edit: (text: string) => string) =>
    withSection(proposal, "timeline", edit(proposal.sections.find((s) => s.id === "timeline")?.text ?? ""));

  // Rewording the summary line leaves the milestones and the stored result as they were.
  const reworded = withTimeline((t) => t.replace(/^Estimated schedule:.*$/m, "Estimated schedule: see milestones."));
  assert.equal(scheduleFindings(reworded)[0]?.title.includes("up to 14 working days"), true);

  // A longer upper estimate updates the finding.
  const longer = withTimeline((t) => t.replace("Final Review: estimated 1-2 days", "Final Review: estimated 1-3 days"));
  assert.match(scheduleFindings(longer)[0]?.title ?? "", /up to 15 working days/);

  // Shorter estimates that fit remove it.
  const fits = withTimeline((t) => t.replaceAll("estimated 3-5 days", "estimated 2-3 days"));
  assert.deepEqual(scheduleFindings(fits), []);

  // An unreadable estimate makes the schedule unknown rather than "fits" by omission.
  const unreadable = withTimeline((t) => t.replace("estimated 1-2 days (after Development)", "estimated TBC (after Development)"));
  assert.deepEqual(scheduleFindings(unreadable), []);
});

test("the client's working-day recalculation matches the server's schedule check", () => {
  for (const milestones of [
    LIVE_MILESTONES,
    [m("Design", "6 working days"), m("Build", "1-2 weeks", ["Design"])],
    [m("Design", "4 working days"), m("Copy", "4 working days"), m("Build", "5 working days", ["Design"])],
    [m("Research", "10 calendar days"), m("Build", "1 month", ["Research"])],
  ]) {
    const proposal = generated(milestones);
    const timeline = proposal.sections.find((s) => s.id === "timeline")?.text ?? "";
    assert.deepEqual(workingDaySpan(timeline), checkSchedule(milestones, "two weeks").estimateWorkingDays);
  }
});

// --- Editing milestones keeps the schedule summary and metadata current -----

const timelineOf = (proposal: EditableProposal) => proposal.sections.find((s) => s.id === "timeline");
const summaryOf = (proposal: EditableProposal) =>
  (timelineOf(proposal)?.text ?? "").split("\n").filter((line) => line.startsWith("Estimated schedule:"));

// What the editor does on every keystroke in the timeline.
function editTimeline(proposal: EditableProposal, edit: (text: string) => string): EditableProposal {
  return syncSchedule(withSection(proposal, "timeline", edit(timelineOf(proposal)?.text ?? "")));
}
const allEstimates = (range: string) => (text: string) =>
  text.replace(/estimated [^(\n]*?days/g, `estimated ${range} working days`);

test("editing the milestones to 1–2 working days updates the summary from 8–14 to 4–8", () => {
  const generatedProposal = generated(LIVE_MILESTONES);
  assert.match(summaryOf(generatedProposal)[0] ?? "", /^Estimated schedule: 8–14 working days\./);

  const edited = editTimeline(generatedProposal, allEstimates("1–2"));

  assert.deepEqual(summaryOf(edited), [
    "Estimated schedule: 4–8 working days, within the deadline (about 10 working days).",
  ]);
  assert.equal(timelineOf(edited)?.tag, "Suggested");
  assert.equal(edited.schedule?.check.status, "fits");
  assert.deepEqual(edited.schedule?.check.estimateWorkingDays, { min: 4, max: 8 });
});

test("the schedule-conflict finding disappears when the revised schedule fits", () => {
  const generatedProposal = generated(LIVE_MILESTONES);
  assert.equal(scheduleFindings(generatedProposal).length, 1);

  assert.deepEqual(scheduleFindings(editTimeline(generatedProposal, allEstimates("1–2"))), []);
});

test("the warning stays, with the right severity, when the revised upper estimate exceeds the deadline", () => {
  const mayExceed = editTimeline(generated(LIVE_MILESTONES), allEstimates("2–4"));
  assert.match(summaryOf(mayExceed)[0] ?? "", /^Estimated schedule: 8–16 working days\. The upper estimate is longer than the deadline/);
  assert.equal(timelineOf(mayExceed)?.tag, "Needs confirmation");
  assert.deepEqual(scheduleFindings(mayExceed).map((f) => [f.severity, f.id]), [["Medium", "schedule-may-exceed-deadline"]]);
  assert.match(scheduleFindings(mayExceed)[0]?.title ?? "", /up to 16 working days/);

  const exceeds = editTimeline(generated(LIVE_MILESTONES), allEstimates("3–6"));
  assert.match(summaryOf(exceeds)[0] ?? "", /^Estimated schedule: at least 12 working days, longer than the deadline/);
  assert.deepEqual(scheduleFindings(exceeds).map((f) => [f.severity, f.id]), [["High", "schedule-exceeds-deadline"]]);
});

test("repeated edits never leave stale schedule metadata or summary lines", () => {
  let proposal = generated(LIVE_MILESTONES);
  for (const [range, expected] of [
    ["1–2", { min: 4, max: 8 }],
    ["2–4", { min: 8, max: 16 }],
    ["3–5", { min: 12, max: 20 }],
    ["1–2", { min: 4, max: 8 }],
  ] as const) {
    proposal = editTimeline(proposal, allEstimates(range));
    const text = timelineOf(proposal)?.text ?? "";

    assert.deepEqual(proposal.schedule?.check.estimateWorkingDays, expected, range);
    assert.deepEqual(workingDaySpan(text), expected, "stored result matches the text");
    assert.deepEqual(proposal.schedule?.milestoneLines, text.split("\n").filter((l) => l.startsWith("- ")), "stored lines are the current lines");
    assert.equal(summaryOf(proposal).length, 1, "exactly one summary line");
    assert.match(summaryOf(proposal)[0] ?? "", new RegExp(`${expected.min}(–${expected.max})? working days`));
    assert.ok(scheduleFindings(proposal).length <= 1);
  }
});

test("unreadable estimates make the schedule unknown and need confirmation, never 'fits'", () => {
  const proposal = editTimeline(generated(LIVE_MILESTONES), (t) =>
    allEstimates("1–2")(t).replace("Testing: estimated 1–2 working days", "Testing: estimated TBC"),
  );

  assert.equal(proposal.schedule?.check.status, "unknown");
  assert.deepEqual(summaryOf(proposal), [
    "Estimated schedule: could not be compared with the deadline automatically; check it manually.",
  ]);
  assert.equal(timelineOf(proposal)?.tag, "Needs confirmation");
  assert.deepEqual(scheduleFindings(proposal), []);
});

test("dependencies typed as 'after X' without brackets are followed", () => {
  const proposal = editTimeline(generated(LIVE_MILESTONES), (t) =>
    t.replace(/^- .*$/gm, "").trim() +
      "\n- Design: 1–2 working days\n- Development: 1–2 working days after Design\n- Testing: 1–2 working days after Development\n- Final Delivery: 1–2 working days after Testing",
  );

  assert.deepEqual(proposal.schedule?.check.estimateWorkingDays, { min: 4, max: 8 }, "sequential, not 1–2 in parallel");
});

test("unchanged milestones and drafts without schedule metadata are left untouched", () => {
  const proposal = generated(LIVE_MILESTONES);
  assert.equal(syncSchedule(proposal), proposal);

  // Editing only the summary wording keeps the stored result.
  const reworded = editTimeline(proposal, (t) => t.replace(/^Estimated schedule:.*$/m, "Estimated schedule: see below."));
  assert.equal(reworded.schedule, proposal.schedule);
  assert.deepEqual(summaryOf(reworded), ["Estimated schedule: see below."]);

  const legacy = withSection(proposalFor(), "timeline", "Deadline: two weeks\n- Build: estimated 20 days");
  assert.equal(legacy.schedule, undefined);
  assert.equal(syncSchedule(legacy), legacy);
});

test("the edited working-day schedule matches the server's schedule check", () => {
  const edited = [
    m("Design", "1–2 working days"),
    m("Development", "1–2 working days", ["Design"]),
    m("Testing", "1–2 working days", ["Development"]),
    m("Final Delivery", "1–2 working days", ["Testing"]),
  ];
  const proposal = editTimeline(generated(LIVE_MILESTONES), allEstimates("1–2"));

  assert.deepEqual(proposal.schedule?.check.estimateWorkingDays, checkSchedule(edited, "delivery in two weeks").estimateWorkingDays);
  assert.equal(proposal.schedule?.check.status, checkSchedule(edited, "delivery in two weeks").status);
});
