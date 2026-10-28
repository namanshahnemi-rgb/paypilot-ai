// Proposal draft returned by the backend (see server/src/proposal.ts), the
// editable document the user reviews, and its Markdown/HTML exports.

export type Allocation = { label: string; percent: number; amount: number | null };

export type ProposalDraft = {
  title: string;
  executiveSummary: string;
  clientGoals: string[];
  deliverables: Array<{ name: string; description: string; acceptanceCriteria: string[] }>;
  exclusions: string[];
  assumptions: string[];
  milestones: Array<{ name: string; estimatedDuration: string; dependsOn: string[] }>;
  budget: {
    total: number | null;
    currency: string | null;
    statedInBrief: string | null;
    items: Allocation[];
  };
  paymentSchedule: Allocation[];
  deadline: { statedInBrief: string | null };
  // Milestones versus the deadline, in working days (server/src/proposalQuality.ts).
  // Optional: drafts generated before this check existed don't have it.
  schedule?: ScheduleCheck;
  revisions: { statedInBrief: string | null; suggestedPolicy: string };
  changeRequestProcess: string;
  risks: Array<{ issue: string; reason: string }>;
  missingInformation: string[];
  clarificationQuestions: string[];
  clientResponsibilities: string[];
  prerequisites: string[];
  warnings: string[];
};

export type ScheduleCheck = {
  status: "fits" | "may-exceed" | "exceeds" | "no-deadline" | "unknown";
  estimateWorkingDays: { min: number; max: number } | null;
  deadlineWorkingDays: number | null;
  deadlineCalendarDays: number | null;
  assumedWorkingDays: boolean;
};

const dayRange = ({ min, max }: { min: number; max: number }) =>
  min === max ? `${min}` : `${min}–${max}`;

// One line for the timeline section summarising the schedule check. A
// conflict is stated plainly so the schedule is never silently promised.
export function describeSchedule(schedule: ScheduleCheck): string | null {
  const estimate = schedule.estimateWorkingDays;
  const deadline = `about ${schedule.deadlineWorkingDays} working days`;
  const units = schedule.assumedWorkingDays
    ? " Estimates are working days unless stated otherwise."
    : "";
  switch (schedule.status) {
    case "fits":
      return estimate && `Estimated schedule: ${dayRange(estimate)} working days, within the deadline (${deadline}).${units}`;
    case "may-exceed":
      return estimate && `Estimated schedule: ${dayRange(estimate)} working days. The upper estimate is longer than the deadline (${deadline}); confirm the schedule with the client before committing.${units}`;
    case "exceeds":
      return estimate && `Estimated schedule: at least ${estimate.min} working days, longer than the deadline (${deadline}). Agree a later date or a smaller scope with the client before committing.${units}`;
    case "no-deadline":
      return estimate && `Estimated schedule: ${dayRange(estimate)} working days. No deadline is stated in the brief; agree one with the client.${units}`;
    default:
      return "Estimated schedule: could not be compared with the deadline automatically; check it manually.";
  }
}

// The timeline is only a suggestion when the brief states a deadline and the
// schedule is known to fit it; a conflict or a schedule that can't be compared
// needs the client's confirmation. Drafts without a schedule check keep the
// deadline-only rule.
export function timelineTag(check: ScheduleCheck | undefined, deadlineStated: boolean): SectionTag {
  if (!deadlineStated) return "Needs confirmation";
  if (!check) return "Suggested";
  return check.status === "fits" ? "Suggested" : "Needs confirmation";
}

// How much of a section is grounded in the brief.
export type SectionTag =
  | "From brief" // Quoted verbatim from the brief and verified.
  | "AI-extracted" // Derived from the brief by the AI; verify.
  | "Suggested"
  | "Assumption"
  | "Needs confirmation";

export type ProposalSection = {
  id: string;
  heading: string;
  tag: SectionTag;
  text: string;
};

export type MoneyRow = {
  label: string;
  amount: string;
  suggestedPercent: number | null;
};

// Facts the backend verified against the brief when the draft was generated.
export type BriefFacts = {
  total: number | null;
  currency: string | null;
  budgetQuote: string | null;
  deadlineQuote: string | null;
  revisionsQuote: string | null;
};

export type EditableProposal = {
  title: string;
  summary: string;
  currency: string;
  total: string;
  totalFromBrief: boolean;
  budgetItems: MoneyRow[];
  payments: MoneyRow[];
  sections: ProposalSection[];
  generationNotes: string[];
  // Used by the risk review. Optional so proposals saved before these
  // existed still load.
  sourceBrief?: string;
  briefFacts?: BriefFacts;
  generatedAt?: string;
  // The server's schedule check and the milestone lines it was computed from,
  // so the risk review can use the same result while the milestones are unchanged.
  schedule?: { check: ScheduleCheck; milestoneLines: string[] };
};

// Budget and payment blocks are shown after this section.
export const MONEY_AFTER_SECTION = "timeline";

const bullets = (items: string[]) => items.map((item) => `- ${item}`).join("\n");

function toMoneyRows(items: Allocation[]): MoneyRow[] {
  return items.map((item) => ({
    label: item.label,
    amount: item.amount === null ? "" : item.amount.toFixed(2),
    suggestedPercent: item.percent,
  }));
}

export function toEditableProposal(
  draft: ProposalDraft,
  sourceBrief?: string,
): EditableProposal {
  const schedule = draft.schedule;
  const deadlineDays =
    schedule?.deadlineWorkingDays != null
      ? ` (about ${schedule.deadlineWorkingDays} working days${
          schedule.deadlineCalendarDays ? `, ${schedule.deadlineCalendarDays} calendar days` : ""
        })`
      : "";
  const deadline = draft.deadline.statedInBrief
    ? `Deadline stated in the brief: "${draft.deadline.statedInBrief}"${deadlineDays}`
    : "Deadline: not stated in the brief. To be agreed with the client.";
  const scheduleLine = schedule ? describeSchedule(schedule) : null;
  const milestones = draft.milestones.map(
    (m) =>
      `- ${m.name}: estimated ${m.estimatedDuration}${
        m.dependsOn.length > 0 ? ` (after ${m.dependsOn.join(", ")})` : ""
      }`,
  );
  const revisions = [
    draft.revisions.statedInBrief
      ? `Stated in the brief: "${draft.revisions.statedInBrief}"`
      : "",
    draft.revisions.suggestedPolicy,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    title: draft.title,
    summary: draft.executiveSummary,
    currency: draft.budget.currency ?? "",
    total: draft.budget.total === null ? "" : draft.budget.total.toFixed(2),
    totalFromBrief: draft.budget.total !== null,
    budgetItems: toMoneyRows(draft.budget.items),
    payments: toMoneyRows(draft.paymentSchedule),
    generationNotes: draft.warnings,
    ...(schedule ? { schedule: { check: schedule, milestoneLines: milestones } } : {}),
    ...(sourceBrief === undefined
      ? {}
      : {
          sourceBrief,
          briefFacts: {
            total: draft.budget.total,
            currency: draft.budget.currency,
            budgetQuote: draft.budget.statedInBrief,
            deadlineQuote: draft.deadline.statedInBrief,
            revisionsQuote: draft.revisions.statedInBrief,
          },
          generatedAt: new Date().toISOString(),
        }),
    sections: [
      { id: "goals", heading: "Client goals", tag: "AI-extracted", text: bullets(draft.clientGoals) },
      {
        id: "deliverables",
        heading: "Scope and deliverables",
        tag: "AI-extracted",
        text: draft.deliverables
          .map((d) => `- ${d.name}${d.description ? `: ${d.description}` : ""}`)
          .join("\n"),
      },
      {
        id: "acceptance",
        heading: "Acceptance criteria",
        tag: "Suggested",
        text: draft.deliverables
          .filter((d) => d.acceptanceCriteria.length > 0)
          .map((d) => `${d.name}\n${bullets(d.acceptanceCriteria)}`)
          .join("\n\n"),
      },
      { id: "exclusions", heading: "Out of scope", tag: "Suggested", text: bullets(draft.exclusions) },
      { id: "assumptions", heading: "Assumptions", tag: "Assumption", text: bullets(draft.assumptions) },
      {
        id: MONEY_AFTER_SECTION,
        heading: "Timeline and milestones",
        tag: timelineTag(schedule, Boolean(draft.deadline.statedInBrief)),
        text: [deadline, scheduleLine, ...milestones].filter(Boolean).join("\n"),
      },
      {
        id: "revisions",
        heading: "Revision policy",
        tag: draft.revisions.statedInBrief ? "From brief" : "Suggested",
        text: revisions,
      },
      { id: "changes", heading: "Change requests", tag: "Suggested", text: draft.changeRequestProcess },
      {
        id: "responsibilities",
        heading: "Client responsibilities and prerequisites",
        tag: "Suggested",
        text: bullets([
          ...draft.clientResponsibilities,
          ...draft.prerequisites.map((p) => `Prerequisite: ${p}`),
        ]),
      },
      {
        id: "risks",
        heading: "Risks",
        tag: "Needs confirmation",
        text: draft.risks
          .map((r) => `- ${r.issue.replace(/[.:;]+$/, "")}${r.reason ? `: ${r.reason}` : ""}`)
          .join("\n"),
      },
      {
        id: "open-items",
        heading: "Items to confirm with the client",
        tag: "Needs confirmation",
        text: bullets([...draft.missingInformation, ...draft.clarificationQuestions]),
      },
    ],
  };
}

// Restore a proposal saved in sessionStorage, ignoring anything malformed.
export function loadSavedProposal(saved: string | null): EditableProposal | null {
  if (!saved) return null;
  try {
    const value = JSON.parse(saved) as Partial<EditableProposal>;
    return typeof value.title === "string" &&
      Array.isArray(value.sections) &&
      Array.isArray(value.budgetItems) &&
      Array.isArray(value.payments) &&
      Array.isArray(value.generationNotes)
      ? (value as EditableProposal)
      : null;
  } catch {
    return null;
  }
}

export function toCents(value: string): number | null {
  const text = value.replace(/,/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  return Math.round(Number(text) * 100);
}

export function formatMoney(cents: number, currency: string): string {
  const amount = (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency.trim() ? `${currency.trim()} ${amount}` : amount;
}

export type MoneyCheck =
  | { state: "no-total" }
  | { state: "invalid" }
  | { state: "empty" }
  | { state: "ok"; sumCents: number; totalCents: number }
  | { state: "mismatch"; sumCents: number; totalCents: number };

// Check that the filled-in amounts add up exactly to the total.
export function checkMoneyRows(total: string, rows: MoneyRow[]): MoneyCheck {
  const totalCents = toCents(total);
  const filled = rows.filter((row) => row.amount.trim());
  if (filled.some((row) => toCents(row.amount) === null)) return { state: "invalid" };
  if (totalCents === null) return { state: "no-total" };
  if (filled.length === 0) return { state: "empty" };
  const sumCents = filled.reduce((sum, row) => sum + (toCents(row.amount) ?? 0), 0);
  return sumCents === totalCents
    ? { state: "ok", sumCents, totalCents }
    : { state: "mismatch", sumCents, totalCents };
}

// Whether `total` is exactly the budget verified in the brief, so the budget
// can be labelled "From brief" again after the user retypes it.
export function totalMatchesBrief(proposal: EditableProposal, total: string): boolean {
  const cents = toCents(total);
  const briefTotal = proposal.briefFacts?.total;
  return cents !== null && typeof briefTotal === "number" && cents === Math.round(briefTotal * 100);
}

const EXPORT_NOTE =
  "Draft proposal for discussion. Sections marked as suggested, assumptions, or to be confirmed are not yet agreed.";
const EXPORT_DISCLAIMER =
  "This document is a draft proposal. Suggested terms, estimates, and amounts require confirmation by both parties. It has not been legally reviewed and is not legal advice.";

const TAG_SUFFIX: Record<SectionTag, string> = {
  "From brief": "",
  "AI-extracted": "",
  Suggested: " (suggested)",
  Assumption: "",
  "Needs confirmation": " (to be confirmed)",
};

function moneyLines(rows: MoneyRow[], currency: string): string[] {
  return rows
    .filter((row) => row.label.trim() || row.amount.trim())
    .map((row) => {
      const cents = toCents(row.amount);
      const value =
        cents !== null
          ? formatMoney(cents, currency)
          : row.suggestedPercent !== null
            ? `${row.suggestedPercent}% of the total (amount to be agreed)`
            : "amount to be agreed";
      return `${row.label.trim() || "Item"}: ${value}`;
    });
}

function totalLine(proposal: EditableProposal): string {
  const cents = toCents(proposal.total);
  if (cents === null) return "Total: to be agreed with the client";
  return `Total: ${formatMoney(cents, proposal.currency)}${
    proposal.totalFromBrief ? " (as stated in the brief)" : ""
  }`;
}

// Ordered blocks shared by the Markdown, HTML, and plain-text exports.
type ExportBlock = { id?: string; heading: string; text: string };

function exportBlocks(proposal: EditableProposal): ExportBlock[] {
  const blocks: ExportBlock[] = [];
  if (proposal.summary.trim()) {
    blocks.push({ heading: "Executive summary", text: proposal.summary.trim() });
  }
  for (const section of proposal.sections) {
    if (section.text.trim()) {
      blocks.push({
        id: section.id,
        heading: `${section.heading}${TAG_SUFFIX[section.tag]}`,
        text: section.text.trim(),
      });
    }
    if (section.id === MONEY_AFTER_SECTION) {
      const budgetLines = moneyLines(proposal.budgetItems, proposal.currency);
      blocks.push({
        heading: proposal.totalFromBrief ? "Budget" : "Budget (to be confirmed)",
        text: [
          totalLine(proposal),
          budgetLines.length > 0 ? "Suggested breakdown:" : "",
          bullets(budgetLines),
        ]
          .filter(Boolean)
          .join("\n"),
      });
      const payments = moneyLines(proposal.payments, proposal.currency);
      if (payments.length > 0) {
        blocks.push({ heading: "Payment schedule (suggested)", text: bullets(payments) });
      }
    }
  }
  return blocks;
}

export function toMarkdown(proposal: EditableProposal): string {
  const lines = [`# ${proposal.title.trim() || "Project proposal"}`, "", `_${EXPORT_NOTE}_`, ""];
  for (const block of exportBlocks(proposal)) {
    lines.push(`## ${block.heading}`, "", block.text, "");
  }
  lines.push("---", "", EXPORT_DISCLAIMER, "");
  return lines.join("\n");
}

// --- Plain text (Copy to clipboard) ---------------------------------------
// Readable in Notepad and other plain-text editors: no Markdown syntax,
// underlined headings, blank lines around every block, and one bullet style.

const BULLET_LINE = /^[-*•]\s+(.*)$/;
const NUMBERED_LINE = /^(\d+[.)])\s+(.*)$/;

// Words that don't change what a responsibility or prerequisite requires.
const REQUIREMENT_FILLER = new Set([
  "a", "an", "the", "all", "any", "for", "of", "to", "and", "or", "with", "in",
  "on", "at", "by", "from", "be", "is", "are", "client", "clients", "must",
  "will", "should", "shall", "need", "needs", "provide", "provides", "providing",
]);

function requirementKey(item: string): string {
  const words = (item.replace(/^prerequisite:\s*/i, "").toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((word) => !REQUIREMENT_FILLER.has(word))
    .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word));
  return [...new Set(words)].sort().join(" ");
}

// Remove bullet items that state the same requirement as an earlier item,
// e.g. "Provide the email address for the contact form." and "Prerequisite:
// Client must provide the email address for the contact form." Items with any
// different meaningful word are kept, so no distinct requirement is lost.
export function dedupeRequirementLines(text: string): string {
  const seen = new Set<string>();
  return text
    .split("\n")
    .filter((line) => {
      const item = BULLET_LINE.exec(line.trim())?.[1];
      if (item === undefined) return true;
      const key = requirementKey(item);
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join("\n");
}

const underlined = (heading: string, mark: string) => {
  const text = heading.toUpperCase();
  return [text, mark.repeat(text.length)];
};

// Bullets become "  - item" (numbered items keep their numbers). A line
// directly above bullets is their label and gets a colon if it has none;
// other lines are paragraphs. Blank lines separate paragraphs and groups.
function plainBody(text: string): string[] {
  const source = text.split("\n").map((line) => line.trim());
  const isListItem = (line: string | undefined) =>
    line !== undefined && (BULLET_LINE.test(line) || NUMBERED_LINE.test(line));
  const out: string[] = [];

  source.forEach((line, index) => {
    if (!line) return;
    const numbered = NUMBERED_LINE.exec(line);
    const bullet = BULLET_LINE.exec(line);
    if (numbered) {
      out.push(`  ${numbered[1]} ${numbered[2]}`);
    } else if (bullet) {
      out.push(`  - ${bullet[1]}`);
    } else {
      if (out.length > 0) out.push("");
      const nextLine = source.slice(index + 1).find(Boolean);
      const isLabel = isListItem(nextLine) && !line.includes(":") && !/[.!?]$/.test(line);
      out.push(isLabel ? `${line}:` : line);
    }
  });
  return out;
}

export function toPlainText(proposal: EditableProposal): string {
  const lines = [...underlined(proposal.title.trim() || "Project proposal", "="), "", EXPORT_NOTE];
  for (const block of exportBlocks(proposal)) {
    const text = block.id === "responsibilities" ? dedupeRequirementLines(block.text) : block.text;
    lines.push("", "", ...underlined(block.heading, "-"), "", ...plainBody(text));
  }
  lines.push("", "", "-".repeat(60), "", EXPORT_DISCLAIMER, "");
  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Render editor text: "- " lines become lists, other lines paragraphs.
function textToHtml(text: string): string {
  const html: string[] = [];
  let listItems: string[] = [];
  const flushList = () => {
    if (listItems.length > 0) html.push(`<ul>${listItems.join("")}</ul>`);
    listItems = [];
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      listItems.push(`<li>${escapeHtml(trimmed.slice(2))}</li>`);
      continue;
    }
    flushList();
    if (trimmed) html.push(`<p>${escapeHtml(trimmed)}</p>`);
  }
  flushList();
  return html.join("\n");
}

export function toHtml(proposal: EditableProposal): string {
  const title = escapeHtml(proposal.title.trim() || "Project proposal");
  const body = exportBlocks(proposal)
    .map((block) => `<h2>${escapeHtml(block.heading)}</h2>\n${textToHtml(block.text)}`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body { max-width: 760px; margin: 40px auto; padding: 0 20px; color: #183b37; font: 15px/1.7 system-ui, "Segoe UI", sans-serif; }
h1 { font-size: 28px; margin-bottom: 4px; }
h2 { margin-top: 28px; font-size: 18px; border-bottom: 1px solid #e3ebe7; padding-bottom: 4px; }
.note, .disclaimer { color: #5d6f68; font-size: 13px; }
.disclaimer { margin-top: 40px; border-top: 1px solid #e3ebe7; padding-top: 12px; }
@media print {
  body { max-width: none; margin: 0; padding: 0; font-size: 11pt; }
  h2 { break-after: avoid; page-break-after: avoid; }
  li, p { break-inside: avoid; page-break-inside: avoid; }
}
</style>
</head>
<body>
<h1>${title}</h1>
<p class="note">${escapeHtml(EXPORT_NOTE)}</p>
${body}
<p class="disclaimer">${escapeHtml(EXPORT_DISCLAIMER)}</p>
</body>
</html>
`;
}

export function proposalFileName(proposal: EditableProposal, extension: string): string {
  const slug = proposal.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${slug || "proposal"}.${extension}`;
}
