// Tests for the editable proposal model and its exports.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dedupeRequirementLines,
  toEditableProposal,
  toHtml,
  toMarkdown,
  toPlainText,
  totalMatchesBrief,
  type EditableProposal,
  type ProposalDraft,
} from "./proposal.ts";

const BRIEF = "A five-page website with a contact form, delivery in two weeks, and a budget of $800.";

function draft(total: number | null): ProposalDraft {
  return {
    title: "Business website",
    executiveSummary: "A five-page website.",
    clientGoals: ["Get enquiries"],
    deliverables: [{ name: "Website", description: "Five pages", acceptanceCriteria: ["Pages load"] }],
    exclusions: [],
    assumptions: [],
    milestones: [{ name: "Build", estimatedDuration: "5 days", dependsOn: [] }],
    budget: {
      total,
      currency: total === null ? null : "USD",
      statedInBrief: total === null ? null : "a budget of $800",
      items: [{ label: "Build", percent: 100, amount: total }],
    },
    paymentSchedule: [{ label: "On delivery", percent: 100, amount: total }],
    deadline: { statedInBrief: "delivery in two weeks" },
    revisions: { statedInBrief: null, suggestedPolicy: "Two rounds." },
    changeRequestProcess: "Quoted first.",
    risks: [],
    missingInformation: [],
    clarificationQuestions: [],
    clientResponsibilities: [],
    prerequisites: [],
    warnings: [],
  };
}

// Regression: retyping the brief's total after an edit left the budget
// labelled "Needs confirmation" and dropped "(as stated in the brief)".
test("the budget is labelled 'From brief' again once the brief's total is restored", () => {
  const proposal = toEditableProposal(draft(800), BRIEF);

  assert.equal(totalMatchesBrief(proposal, "900"), false);
  assert.equal(totalMatchesBrief(proposal, "800"), true);
  assert.equal(totalMatchesBrief(proposal, "800.00"), true);
  assert.equal(totalMatchesBrief(proposal, "800.01"), false);
  assert.equal(totalMatchesBrief(proposal, ""), false);

  const restored = { ...proposal, total: "800.00", totalFromBrief: totalMatchesBrief(proposal, "800.00") };
  assert.match(toMarkdown(restored), /Total: USD 800\.00 \(as stated in the brief\)/);
});

test("a total the brief never stated is never labelled 'From brief'", () => {
  const noBudget = toEditableProposal(draft(null), BRIEF);
  assert.equal(totalMatchesBrief(noBudget, "800"), false);

  const legacy = { ...toEditableProposal(draft(800)), total: "800" };
  assert.equal(totalMatchesBrief(legacy, "800"), false, "no verified brief facts");
});

test("the HTML export escapes user text and includes print styles", () => {
  const proposal = {
    ...toEditableProposal(draft(800), BRIEF),
    title: '<script>alert("x")</script>',
    summary: "<img src=x onerror=alert(1)> & co",
  };
  const html = toHtml(proposal);

  assert.ok(!/<script/i.test(html));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt; &amp; co"));
  assert.match(html, /@media print/);
  assert.match(html, /not legal advice/);
});

// --- Plain-text clipboard export -------------------------------------------

// A draft with every section filled in, including the duplicated
// responsibility/prerequisite pairs the model tends to produce.
function fullDraft(): ProposalDraft {
  return {
    ...draft(800),
    clientGoals: ["Get more enquiries"],
    deliverables: [
      { name: "Website", description: "Five pages", acceptanceCriteria: ["Pages load", "Works on mobile"] },
      { name: "Contact form", description: "Emails enquiries", acceptanceCriteria: ["Test enquiry arrives"] },
    ],
    exclusions: ["Hosting"],
    assumptions: ["Client supplies photos"],
    milestones: [
      { name: "Design", estimatedDuration: "3 days", dependsOn: [] },
      { name: "Build", estimatedDuration: "5 days", dependsOn: ["Design"] },
    ],
    budget: {
      total: 800,
      currency: "USD",
      statedInBrief: "a budget of $800",
      items: [
        { label: "Design", percent: 30, amount: 240 },
        { label: "Build", percent: 70, amount: 560 },
      ],
    },
    paymentSchedule: [
      { label: "Deposit", percent: 50, amount: 400 },
      { label: "Launch", percent: 50, amount: 400 },
    ],
    changeRequestProcess: "Changes are quoted before work starts.",
    risks: [{ issue: "Content delays", reason: "Copy is not ready" }],
    missingInformation: ["Hosting provider"],
    clarificationQuestions: ["Who writes the copy?"],
    clientResponsibilities: ["Provide the email address for the contact form.", "Provide all page content."],
    prerequisites: [
      "Client must provide the email address for the contact form.",
      "Domain access",
      "Client must provide all page content and photos.",
    ],
  };
}

const withText = (proposal: EditableProposal, id: string, text: string): EditableProposal => ({
  ...proposal,
  sections: proposal.sections.map((s) => (s.id === id ? { ...s, text } : s)),
});

test("plain text has underlined headings separated from their content by blank lines", () => {
  const text = toPlainText(toEditableProposal(fullDraft(), BRIEF));
  const lines = text.split("\n");

  assert.equal(lines[0], "BUSINESS WEBSITE");
  assert.equal(lines[1], "=".repeat("BUSINESS WEBSITE".length));
  lines.forEach((line, i) => {
    if (/^-+$/.test(line) && line.length < 60) {
      const heading = lines[i - 1] ?? "";
      assert.equal(line.length, heading.length, `underline matches "${heading}"`);
      assert.equal(lines[i + 1], "", `blank line after "${heading}"`);
      assert.deepEqual([lines[i - 2], lines[i - 3]], ["", ""], `two blank lines before "${heading}"`);
    }
  });
  assert.doesNotMatch(text, /^#|^_|\n#|\n\n\n\n/, "no Markdown syntax or runs of blank lines");
});

test("plain text keeps every section, label, amount, and the draft warning", () => {
  const text = toPlainText(toEditableProposal(fullDraft(), BRIEF));

  for (const heading of [
    "EXECUTIVE SUMMARY",
    "CLIENT GOALS",
    "SCOPE AND DELIVERABLES",
    "ACCEPTANCE CRITERIA (SUGGESTED)",
    "OUT OF SCOPE (SUGGESTED)",
    "ASSUMPTIONS",
    "TIMELINE AND MILESTONES (SUGGESTED)",
    "BUDGET",
    "PAYMENT SCHEDULE (SUGGESTED)",
    "REVISION POLICY (SUGGESTED)",
    "CHANGE REQUESTS (SUGGESTED)",
    "CLIENT RESPONSIBILITIES AND PREREQUISITES (SUGGESTED)",
    "RISKS (TO BE CONFIRMED)",
    "ITEMS TO CONFIRM WITH THE CLIENT (TO BE CONFIRMED)",
  ]) {
    assert.ok(text.includes(`\n${heading}\n`), heading);
  }
  for (const value of [
    "Total: USD 800.00 (as stated in the brief)",
    "  - Design: USD 240.00",
    "  - Build: USD 560.00",
    "  - Deposit: USD 400.00",
    "  - Launch: USD 400.00",
    'Deadline stated in the brief: "delivery in two weeks"',
    "  - Content delays: Copy is not ready",
    "Draft proposal for discussion.",
    "not legal advice",
  ]) {
    assert.ok(text.includes(value), value);
  }
});

test("plain text uses one bullet style and labels lists consistently", () => {
  let proposal = toEditableProposal(fullDraft(), BRIEF);
  proposal = withText(proposal, "goals", "* Star item\n• Dot item\n- Dash item\n  - Indented item\n1. First step\n2) Second step");
  proposal = withText(proposal, "acceptance", "Website\n- Pages load\n\nContact form:\n- Test enquiry arrives");
  proposal = withText(proposal, "changes", "Changes are quoted first.\nWork starts after approval.");
  const text = toPlainText(proposal);

  assert.ok(text.includes("  - Star item\n  - Dot item\n  - Dash item\n  - Indented item\n  1. First step\n  2) Second step"));
  assert.ok(text.includes("Website:\n  - Pages load\n\nContact form:\n  - Test enquiry arrives"));
  assert.ok(text.includes("Changes are quoted first.\n\nWork starts after approval."), "paragraphs get a blank line and no colon");
});

test("duplicated responsibilities and prerequisites are removed, distinct ones kept", () => {
  const text = toPlainText(toEditableProposal(fullDraft(), BRIEF));
  const section = text.split("CLIENT RESPONSIBILITIES AND PREREQUISITES (SUGGESTED)")[1]?.split("\n\n\n")[0] ?? "";
  const items = section.split("\n").filter((line) => line.startsWith("  - "));

  assert.deepEqual(items, [
    "  - Provide the email address for the contact form.",
    "  - Provide all page content.",
    "  - Prerequisite: Domain access",
    // Adds "photos", so it is a different requirement and is kept.
    "  - Prerequisite: Client must provide all page content and photos.",
  ]);
});

test("requirement de-duplication ignores case, filler, and plurals but keeps non-list lines", () => {
  const text = [
    "Before work starts:",
    "- Provide brand guidelines",
    "- prerequisite: The client must provide the brand guideline.",
    "- Provide brand guidelines and logo files",
    "- Approve designs within two days",
  ].join("\n");

  assert.deepEqual(dedupeRequirementLines(text).split("\n"), [
    "Before work starts:",
    "- Provide brand guidelines",
    "- Provide brand guidelines and logo files",
    "- Approve designs within two days",
  ]);
});

test("the Markdown and HTML downloads are not affected by the clipboard format", () => {
  const proposal = toEditableProposal(fullDraft(), BRIEF);
  const markdown = toMarkdown(proposal);

  assert.match(markdown, /^# Business website/);
  assert.match(markdown, /\n## Client responsibilities and prerequisites \(suggested\)\n/);
  assert.match(markdown, /- Prerequisite: Client must provide the email address for the contact form\./, "downloads keep the editor text as written");
  assert.match(toHtml(proposal), /<h2>Payment schedule \(suggested\)<\/h2>/);
});

// --- Schedule check in the timeline section ---------------------------------

const timeline = (proposal: EditableProposal) => proposal.sections.find((s) => s.id === "timeline");

test("a possible deadline conflict is stated in the timeline and needs confirmation", () => {
  const proposal = toEditableProposal(
    {
      ...draft(800),
      schedule: {
        status: "may-exceed",
        estimateWorkingDays: { min: 8, max: 14 },
        deadlineWorkingDays: 10,
        deadlineCalendarDays: 14,
        assumedWorkingDays: true,
      },
    },
    BRIEF,
  );
  const section = timeline(proposal);

  assert.equal(section?.tag, "Needs confirmation");
  assert.match(section?.text ?? "", /^Deadline stated in the brief: "delivery in two weeks" \(about 10 working days, 14 calendar days\)/);
  assert.match(section?.text ?? "", /Estimated schedule: 8–14 working days\. The upper estimate is longer than the deadline/);
  assert.match(section?.text ?? "", /Estimates are working days unless stated otherwise\./);
  assert.match(section?.text ?? "", /- Build: estimated 5 days/, "milestones are kept");
});

test("a schedule that fits keeps the timeline as a suggestion", () => {
  const proposal = toEditableProposal(
    {
      ...draft(800),
      schedule: {
        status: "fits",
        estimateWorkingDays: { min: 5, max: 5 },
        deadlineWorkingDays: 10,
        deadlineCalendarDays: 14,
        assumedWorkingDays: false,
      },
    },
    BRIEF,
  );

  assert.equal(timeline(proposal)?.tag, "Suggested");
  assert.match(timeline(proposal)?.text ?? "", /Estimated schedule: 5 working days, within the deadline \(about 10 working days\)\.$/m);
});

test("drafts generated before the schedule check keep their old timeline text", () => {
  const section = timeline(toEditableProposal(draft(800), BRIEF));

  assert.equal(section?.tag, "Suggested");
  assert.equal(section?.text, 'Deadline stated in the brief: "delivery in two weeks"\n- Build: estimated 5 days');
});
