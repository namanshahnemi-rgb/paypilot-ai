// Proposal drafting: validates the local model's output and turns it into a
// draft for the freelancer to review. Facts (budget, deadline, revisions) are
// kept only when the model quotes them verbatim from the brief, and money
// amounts are calculated here, never by the model.
import { z } from "zod";
import { parseFields } from "./localModel.js";
import {
  checkSchedule,
  clarifyPaymentTrigger,
  mergeOpenItems,
  scheduleWarning,
  type ScheduleCheck,
} from "./proposalQuality.js";

// Shape the model must produce. Also sent to Ollama as a JSON schema so the
// local model's output is constrained to it.
export const ProposalOutputSchema = z.object({
  title: z.string(),
  executive_summary: z.string(),
  client_goals: z.array(z.string()),
  deliverables: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      acceptance_criteria: z.array(z.string()),
    }),
  ),
  exclusions: z.array(z.string()),
  assumptions: z.array(z.string()),
  milestones: z.array(
    z.object({
      name: z.string(),
      estimated_duration: z.string(),
      depends_on: z.array(z.string()),
    }),
  ),
  budget_breakdown: z.array(
    z.object({ item: z.string(), share_percent: z.number() }),
  ),
  payment_schedule: z.array(
    z.object({ milestone: z.string(), share_percent: z.number() }),
  ),
  revision_policy: z.string(),
  change_request_process: z.string(),
  risks: z.array(z.object({ issue: z.string(), reason: z.string() })),
  missing_information: z.array(z.string()),
  clarification_questions: z.array(z.string()),
  client_responsibilities: z.array(z.string()),
  prerequisites: z.array(z.string()),
  budget_quote: z.string().nullable(),
  deadline_quote: z.string().nullable(),
  revisions_quote: z.string().nullable(),
});

export type ProposalOutput = z.infer<typeof ProposalOutputSchema>;

const { $schema: _schemaVersion, ...proposalJsonSchema } =
  z.toJSONSchema(ProposalOutputSchema);
export { proposalJsonSchema };

// Validate each field separately so one malformed section doesn't discard the
// whole draft. Invalid fields fall back to empty values (keeping the valid
// entries of a partly malformed list) and are reported by name.
export function parseProposalOutput(raw: unknown): {
  output: ProposalOutput;
  invalidFields: string[];
} {
  return parseFields(ProposalOutputSchema, raw);
}

function cleanText(value: string, maxLength = 1200): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

// Trim, drop empty and duplicate entries, and cap the list length.
function cleanList(values: string[], maxItems = 10): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = cleanText(value, 400);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function normalizeForSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Return the model's quote only if it really appears in the brief (ignoring
// case, spacing, and surrounding quote marks or punctuation).
export function quoteFromBrief(brief: string, quote: string | null): string | null {
  if (!quote) return null;
  const cleaned = quote
    .trim()
    .replace(/^["'“‘]+/, "")
    .replace(/["'”’.,;:]+$/, "")
    .trim();
  if (cleaned.length < 2) return null;
  return normalizeForSearch(brief).includes(normalizeForSearch(cleaned))
    ? cleaned
    : null;
}

export type BudgetReading =
  | { kind: "amount"; amount: number; currency: string | null; currencyAssumed: boolean }
  | { kind: "unclear" }
  | { kind: "none" };

const NUMBER_PATTERN = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(\s*k\b)?/gi;
const CURRENCY_PATTERN =
  /US\$|USD|EUR|GBP|INR|\$|€|£|₹|\bRs\.?|\bdollars?\b|\beuros?\b|\bpounds?\b|\brupees?\b/gi;

function currencyCode(token: string): string | null {
  const t = token.toLowerCase();
  if (t === "us$" || t === "usd" || t === "$" || t.startsWith("dollar")) return "USD";
  if (t === "€" || t === "eur" || t.startsWith("euro")) return "EUR";
  if (t === "£" || t === "gbp" || t.startsWith("pound")) return "GBP";
  if (t === "₹" || t === "inr" || t.startsWith("rs") || t.startsWith("rupee")) return "INR";
  return null;
}

// Every numeric amount written in `text`, e.g. "1,200.50" or "2k".
export function amountsInText(text: string): number[] {
  return [...text.matchAll(NUMBER_PATTERN)].map(
    ([, whole = "", decimals, thousands]) =>
      Number(`${whole.replace(/,/g, "")}.${decimals ?? "0"}`) * (thousands ? 1000 : 1),
  );
}

// Currency codes indicated by symbols, codes, or names in `text`.
export function currenciesInText(text: string): Set<string> {
  return new Set(
    [...text.matchAll(CURRENCY_PATTERN)]
      .map((match) => currencyCode(match[0]))
      .filter((code) => code !== null),
  );
}

// Read a single total amount from a verified budget quote. Ranges or several
// numbers are "unclear" rather than guessed.
export function readBudget(quote: string): BudgetReading {
  const amounts = amountsInText(quote);
  if (amounts.length === 0) return { kind: "none" };
  if (amounts.length > 1) return { kind: "unclear" };

  const amount = amounts[0] ?? 0;
  if (!Number.isFinite(amount) || amount <= 0) return { kind: "none" };

  const tokens = [...quote.matchAll(CURRENCY_PATTERN)].map((m) => m[0]);
  const codes = currenciesInText(quote);
  const currency = codes.size === 1 ? [...codes][0] ?? null : null;
  // "$" and "dollars" could also mean AUD, CAD, and others.
  const currencyAssumed =
    currency === "USD" &&
    !tokens.some((t) => /^(us\$|usd)$/i.test(t));

  return { kind: "amount", amount, currency, currencyAssumed };
}

export type Allocation = { label: string; percent: number; amount: number | null };

// Split `total` units into whole parts proportional to `weights` that add up
// exactly to `total` (largest remainder method).
function splitWhole(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (w / sum) * total);
  const parts = exact.map(Math.floor);
  let remaining = total - parts.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of byRemainder) {
    if (remaining <= 0) break;
    parts[index] = (parts[index] ?? 0) + 1;
    remaining--;
  }
  return parts;
}

// Turn suggested shares into whole percentages that add up to 100 and, when a
// total is known, amounts that add up exactly to that total.
export function allocate(
  shares: Array<{ label: string; weight: number }>,
  total: number | null,
): Allocation[] {
  const valid = shares
    .filter((s) => s.label && Number.isFinite(s.weight) && s.weight > 0)
    .slice(0, 8);
  if (valid.length === 0) return [];

  const percents = splitWhole(valid.map((s) => s.weight), 100);
  const kept = valid
    .map((s, i) => ({ label: s.label, percent: percents[i] ?? 0 }))
    .filter((s) => s.percent > 0);
  const cents =
    total === null
      ? null
      : splitWhole(kept.map((s) => s.percent), Math.round(total * 100));

  return kept.map((s, i) => ({
    ...s,
    amount: cents ? (cents[i] ?? 0) / 100 : null,
  }));
}

const DEFAULT_PAYMENT_SCHEDULE = [
  { label: "Deposit before work starts", weight: 30 },
  { label: "On completion of the mid-project milestone", weight: 40 },
  { label: "Final delivery and acceptance", weight: 30 },
];

const DEFAULT_REVISION_POLICY =
  "A set number of revision rounds per deliverable, to be agreed with the client. Further changes are handled as change requests.";

const DEFAULT_CHANGE_PROCESS =
  "Changes outside the agreed scope are requested in writing, estimated for cost and time impact, and started only after written approval.";

// Budget lines that just restate the total are not a breakdown.
const NOT_A_BUDGET_ITEM = /^(total|budget|total budget|project budget|project total)$/i;

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
  schedule: ScheduleCheck;
  revisions: { statedInBrief: string | null; suggestedPolicy: string };
  changeRequestProcess: string;
  risks: Array<{ issue: string; reason: string }>;
  missingInformation: string[];
  clarificationQuestions: string[];
  clientResponsibilities: string[];
  prerequisites: string[];
  warnings: string[];
};

export function buildProposalDraft(
  brief: string,
  output: ProposalOutput,
  invalidFields: string[] = [],
): ProposalDraft {
  const warnings: string[] = [];

  // Budget: only a total quoted verbatim from the brief is used.
  const budgetQuote = quoteFromBrief(brief, output.budget_quote);
  const reading = budgetQuote ? readBudget(budgetQuote) : { kind: "none" as const };
  const total = reading.kind === "amount" ? reading.amount : null;
  const currency = reading.kind === "amount" ? reading.currency : null;

  if (output.budget_quote && !budgetQuote) {
    warnings.push(
      "The AI reported a budget that does not appear in the brief, so it was ignored.",
    );
  }
  if (reading.kind === "unclear") {
    warnings.push(
      `The brief's budget ("${budgetQuote}") is a range or unclear. Agree on a single total with the client.`,
    );
  } else if (total === null) {
    warnings.push(
      "No budget total was stated in the brief. Amounts are left unspecified; agree on a total with the client.",
    );
  } else if (currency === null) {
    warnings.push("The budget currency is not stated in the brief. Confirm it with the client.");
  } else if (reading.kind === "amount" && reading.currencyAssumed) {
    warnings.push(`The currency was assumed to be ${currency} from "${budgetQuote}". Confirm it with the client.`);
  }

  let budgetItems = allocate(
    output.budget_breakdown
      .map((b) => ({ label: cleanText(b.item, 120), weight: b.share_percent }))
      .filter((b) => !NOT_A_BUDGET_ITEM.test(b.label)),
    total,
  );
  if (budgetItems.length === 0) {
    budgetItems = allocate([{ label: "Project total", weight: 100 }], total);
    warnings.push("The AI did not suggest a budget breakdown; add one if the client needs it.");
  }

  let paymentSchedule = allocate(
    output.payment_schedule.map((p) => ({
      label: cleanText(p.milestone, 120),
      weight: p.share_percent,
    })),
    total,
  );
  if (paymentSchedule.length === 0) {
    paymentSchedule = allocate(DEFAULT_PAYMENT_SCHEDULE, total);
    warnings.push("The AI did not suggest a payment schedule, so a common 30/40/30 split is shown.");
  }

  const milestones = output.milestones
    .map((m) => ({
      name: cleanText(m.name, 160),
      estimatedDuration: cleanText(m.estimated_duration, 80) || "To be estimated",
      dependsOn: cleanList(m.depends_on, 5),
    }))
    .filter((m) => m.name)
    .slice(0, 10);

  // Say when each suggested payment is due; amounts are unchanged.
  const milestoneNames = milestones.map((m) => m.name);
  const unclearTriggers = paymentSchedule.filter(
    (p) => clarifyPaymentTrigger(p.label, milestoneNames) !== p.label,
  ).length;
  paymentSchedule = paymentSchedule.map((p) => ({
    ...p,
    label: clarifyPaymentTrigger(p.label, milestoneNames),
  }));
  if (unclearTriggers > 0) {
    warnings.push(
      "Some payment milestones did not say when payment is due; due points were suggested from the milestone names. Confirm them with the client.",
    );
  }

  const deadlineQuote = quoteFromBrief(brief, output.deadline_quote);
  if (!deadlineQuote) {
    warnings.push(
      "No deadline was stated in the brief. Milestone durations are estimates only.",
    );
  }
  const schedule = checkSchedule(milestones, deadlineQuote);
  const scheduleNote = scheduleWarning(schedule, deadlineQuote);
  if (scheduleNote) warnings.push(scheduleNote);

  const revisionsQuote = quoteFromBrief(brief, output.revisions_quote);
  if (!revisionsQuote) {
    warnings.push("Revision terms were not stated in the brief; the revision policy is a suggestion.");
  }

  const deliverables = output.deliverables
    .map((d) => ({
      name: cleanText(d.name, 160),
      description: cleanText(d.description, 600),
      acceptanceCriteria: cleanList(d.acceptance_criteria, 5),
    }))
    .filter((d) => d.name)
    .slice(0, 10);
  if (deliverables.length === 0) {
    warnings.push("The AI did not return any deliverables. Add them before sharing.");
  }

  // Each open point once: a missing item already asked as a question is dropped.
  const { missingInformation, clarificationQuestions } = mergeOpenItems(
    cleanList(output.missing_information),
    cleanList(output.clarification_questions),
  );
  const openItems = missingInformation.length + clarificationQuestions.length;
  if (openItems > 0) {
    warnings.push(`${openItems} open question(s) or missing item(s) need the client's answer.`);
  }

  if (invalidFields.length > 0) {
    warnings.push(
      `Some AI output was missing or malformed and was left empty: ${invalidFields.join(", ")}.`,
    );
  }

  warnings.push(
    "Milestones, durations, the budget breakdown, and the payment schedule are suggestions, not agreed terms.",
  );

  return {
    title: cleanText(output.title, 160) || "Project proposal",
    executiveSummary: cleanText(output.executive_summary, 1500),
    clientGoals: cleanList(output.client_goals),
    deliverables,
    exclusions: cleanList(output.exclusions),
    assumptions: cleanList(output.assumptions),
    milestones,
    budget: { total, currency, statedInBrief: budgetQuote, items: budgetItems },
    paymentSchedule,
    deadline: { statedInBrief: deadlineQuote },
    schedule,
    revisions: {
      statedInBrief: revisionsQuote,
      suggestedPolicy: cleanText(output.revision_policy, 800) || DEFAULT_REVISION_POLICY,
    },
    changeRequestProcess:
      cleanText(output.change_request_process, 800) || DEFAULT_CHANGE_PROCESS,
    risks: output.risks
      .map((r) => ({ issue: cleanText(r.issue, 200), reason: cleanText(r.reason, 400) }))
      .filter((r) => r.issue)
      .slice(0, 10),
    missingInformation,
    clarificationQuestions,
    clientResponsibilities: cleanList(output.client_responsibilities),
    prerequisites: cleanList(output.prerequisites),
    warnings,
  };
}
