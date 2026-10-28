// Regression tests for proposal quality checks: deadline conflicts, missing
// items repeated as questions, and unclear payment due points.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkSchedule,
  clarifyPaymentTrigger,
  mergeOpenItems,
  parseDuration,
  scheduleWarning,
} from "./proposalQuality.js";
import { buildProposalDraft, type ProposalOutput } from "./proposal.js";

const BRIEF =
  "A client wants a five-page business website with a contact form, mobile responsiveness, delivery in two weeks, two rounds of revisions, and a budget of $800.";

// The milestones and open items from the live five-page website draft.
const LIVE_MILESTONES = [
  { name: "Design", estimatedDuration: "3-5 days", dependsOn: [] },
  { name: "Development", estimatedDuration: "3-5 days", dependsOn: ["Design"] },
  { name: "Testing", estimatedDuration: "1-2 days", dependsOn: ["Development"] },
  { name: "Final Review", estimatedDuration: "1-2 days", dependsOn: ["Testing"] },
];
const LIVE_MISSING = [
  "Specific design elements or branding guidelines.",
  "The email address for the contact form.",
  "Any specific features or functionalities the client requires.",
];
const LIVE_QUESTIONS = [
  "What specific design elements or branding guidelines are required?",
  "What is the preferred email address for the contact form?",
  "Are there any specific features or functionalities the client requires?",
];

const milestone = (name: string, estimatedDuration: string, dependsOn: string[] = []) => ({
  name,
  estimatedDuration,
  dependsOn,
});

// --- Durations and deadlines ------------------------------------------------

test("durations are read with their unit and working/calendar basis", () => {
  assert.deepEqual(parseDuration("3-5 days"), { min: 3, max: 5, unit: "day", basis: "unspecified" });
  assert.deepEqual(parseDuration("delivery in two weeks"), { min: 2, max: 2, unit: "week", basis: "unspecified" });
  assert.deepEqual(parseDuration("10 business days"), { min: 10, max: 10, unit: "day", basis: "working" });
  assert.deepEqual(parseDuration("3 to 4 working days"), { min: 3, max: 4, unit: "day", basis: "working" });
  assert.deepEqual(parseDuration("14 calendar days"), { min: 14, max: 14, unit: "day", basis: "calendar" });
  assert.equal(parseDuration("by the end of March"), null);
});

test("the live 8-14 day schedule against 'two weeks' is flagged as a possible conflict", () => {
  const check = checkSchedule(LIVE_MILESTONES, "delivery in two weeks");

  assert.equal(check.status, "may-exceed");
  assert.deepEqual(check.estimateWorkingDays, { min: 8, max: 14 });
  assert.equal(check.deadlineWorkingDays, 10);
  assert.equal(check.deadlineCalendarDays, 14);
  assert.equal(check.assumedWorkingDays, true, "'3-5 days' did not say working or calendar");
  assert.match(
    scheduleWarning(check, "delivery in two weeks") ?? "",
    /total 8–14 working days, but the brief's deadline \("delivery in two weeks"\) is about 10 working days \(14 calendar days\)/,
  );
});

test("a schedule that cannot meet the deadline is reported as exceeding it", () => {
  const check = checkSchedule(
    [milestone("Design", "6 working days"), milestone("Build", "1-2 weeks", ["Design"])],
    "two weeks",
  );

  assert.equal(check.status, "exceeds");
  assert.deepEqual(check.estimateWorkingDays, { min: 11, max: 16 });
  assert.match(scheduleWarning(check, "two weeks") ?? "", /at least 11 working days.*Don't promise this schedule/);
});

test("milestones that fit, including parallel ones, raise no warning", () => {
  const check = checkSchedule(
    [
      milestone("Design", "4 working days"),
      milestone("Copywriting", "4 working days"),
      milestone("Build", "5 working days", ["Design"]),
    ],
    "two weeks",
  );

  assert.equal(check.status, "fits");
  assert.deepEqual(check.estimateWorkingDays, { min: 9, max: 9 }, "copywriting runs alongside design");
  assert.equal(check.assumedWorkingDays, false);
  assert.equal(scheduleWarning(check, "two weeks"), null);
});

test("calendar-day deadlines are converted to working days", () => {
  const check = checkSchedule([milestone("Build", "9 working days")], "within 10 days");

  assert.equal(check.deadlineWorkingDays, 7);
  assert.equal(check.deadlineCalendarDays, 10);
  assert.equal(check.status, "exceeds");
});

test("unparseable deadlines or estimates are 'unknown', never silently 'fits'", () => {
  assert.equal(checkSchedule(LIVE_MILESTONES, "by the end of March").status, "unknown");
  assert.equal(checkSchedule([milestone("Build", "To be estimated")], "two weeks").status, "unknown");
  assert.match(scheduleWarning(checkSchedule(LIVE_MILESTONES, "by the end of March"), "by the end of March") ?? "", /could not be compared/);
  assert.equal(checkSchedule(LIVE_MILESTONES, null).status, "no-deadline");
});

// --- Missing items versus questions -----------------------------------------

test("missing items already asked as questions are not listed twice", () => {
  const merged = mergeOpenItems(LIVE_MISSING, LIVE_QUESTIONS);

  assert.deepEqual(merged.missingInformation, []);
  assert.deepEqual(merged.clarificationQuestions, LIVE_QUESTIONS);
});

test("reworded missing items paired with a question are not listed twice (second live run)", () => {
  // Exact output of a later live run, where the wording differs more.
  const merged = mergeOpenItems(
    [
      "Specific design elements and branding requirements.",
      "Any specific functionality or design requirements.",
      "The client's specific design preferences.",
    ],
    [
      "What specific design elements are required for the website?",
      "Are there any specific functionalities you would like to include?",
      "Do you have any branding elements or preferences for the website?",
    ],
  );

  assert.deepEqual(merged.missingInformation, []);
  assert.equal(merged.clarificationQuestions.length, 3);
});

test("'No X specified' items repeated as questions are not listed twice (third live run)", () => {
  // Exact output of a third live run.
  const questions = [
    "Is there any specific branding or logo design required?",
    "Is there any SEO optimization needed?",
    "Are there any third-party integrations required?",
  ];
  const merged = mergeOpenItems(
    ["No branding or logo design specified.", "No SEO optimization specified.", "No third-party integrations specified."],
    questions,
  );

  assert.deepEqual(merged.missingInformation, []);
  assert.deepEqual(merged.clarificationQuestions, questions);
});

test("a missing item is kept when the questions don't ask about all of it", () => {
  const merged = mergeOpenItems(
    ["Content deadline", "Hosting provider"],
    ["Who writes the page content?", "Which domain name should the site use?"],
  );

  // "content" is asked, but no question asks about the deadline, so the item
  // is distinct information and must stay.
  assert.deepEqual(merged.missingInformation, ["Content deadline", "Hosting provider"]);
});

test("missing items no question covers are kept, and repeated questions are removed", () => {
  const merged = mergeOpenItems(
    ["Hosting provider", "The email address for the contact form."],
    [
      "What is the preferred email address for the contact form?",
      "What email address should the contact form use?",
      "Who writes the page copy?",
    ],
  );

  assert.deepEqual(merged.missingInformation, ["Hosting provider"]);
  assert.deepEqual(merged.clarificationQuestions, [
    "What is the preferred email address for the contact form?",
    "Who writes the page copy?",
  ]);
});

// --- Payment due points ------------------------------------------------------

test("payment milestones say when payment is due", () => {
  const names = LIVE_MILESTONES.map((m) => m.name);

  assert.equal(clarifyPaymentTrigger("Design", names), "On completion of Design");
  assert.equal(clarifyPaymentTrigger("Development phase", names), "On completion of Development phase");
  assert.equal(clarifyPaymentTrigger("Deposit", names), "Deposit");
  assert.equal(clarifyPaymentTrigger("On final delivery", names), "On final delivery");
  assert.equal(clarifyPaymentTrigger("Second instalment", names), "Second instalment (timing to be agreed)");
});

// --- Through the draft builder ------------------------------------------------

function liveOutput(): ProposalOutput {
  return {
    title: "Business Website Development",
    executive_summary: "A five-page website with a contact form.",
    client_goals: ["Get enquiries"],
    deliverables: [{ name: "Website", description: "Five pages", acceptance_criteria: ["Pages load"] }],
    exclusions: [],
    assumptions: [],
    milestones: LIVE_MILESTONES.map((m) => ({
      name: m.name,
      estimated_duration: m.estimatedDuration,
      depends_on: m.dependsOn,
    })),
    budget_breakdown: [{ item: "Build", share_percent: 100 }],
    payment_schedule: [
      { milestone: "Design", share_percent: 30 },
      { milestone: "Development", share_percent: 40 },
      { milestone: "Testing", share_percent: 30 },
    ],
    revision_policy: "Two rounds of revisions.",
    change_request_process: "Quoted first.",
    risks: [],
    missing_information: LIVE_MISSING,
    clarification_questions: LIVE_QUESTIONS,
    client_responsibilities: [],
    prerequisites: [],
    budget_quote: "a budget of $800",
    deadline_quote: "delivery in two weeks",
    revisions_quote: "two rounds of revisions",
  };
}

test("the draft flags the deadline conflict instead of silently promising it", () => {
  const draft = buildProposalDraft(BRIEF, liveOutput());

  assert.equal(draft.schedule.status, "may-exceed");
  assert.ok(draft.warnings.some((w) => /total 8–14 working days/.test(w)));
  assert.ok(draft.warnings.some((w) => /suggestions, not agreed terms/.test(w)), "still marked as suggestions");
});

test("the draft lists each open point once", () => {
  const draft = buildProposalDraft(BRIEF, liveOutput());

  assert.deepEqual(draft.missingInformation, []);
  assert.deepEqual(draft.clarificationQuestions, LIVE_QUESTIONS);
  assert.ok(draft.warnings.some((w) => /^3 open question\(s\)/.test(w)));
});

test("payment due points are clarified without changing the amounts", () => {
  const draft = buildProposalDraft(BRIEF, liveOutput());

  assert.deepEqual(draft.paymentSchedule, [
    { label: "On completion of Design", percent: 30, amount: 240 },
    { label: "On completion of Development", percent: 40, amount: 320 },
    { label: "On completion of Testing", percent: 30, amount: 240 },
  ]);
  assert.ok(draft.warnings.some((w) => /due points were suggested/.test(w)));
});
