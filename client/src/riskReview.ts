// Proposal risk review. Deterministic checks run in the browser on every edit
// and compare the proposal with the brief it was generated from. Findings
// from the local AI model (POST /api/proposals/review) are kept separately and
// shown only while they match the current proposal.
//
// Findings are recommendations for the freelancer's own review. They are not
// legal advice, and marking one as reviewed is not client approval.
import {
  MONEY_AFTER_SECTION,
  checkMoneyRows,
  describeSchedule,
  formatMoney,
  timelineTag,
  toCents,
  type EditableProposal,
  type ScheduleCheck,
  type SectionTag,
} from "./proposal.ts";

export type Severity = "High" | "Medium" | "Low";

export type FindingCategory =
  | "Missing or ambiguous"
  | "Not agreed in the brief"
  | "Inconsistent with the brief"
  | "Arithmetic";

// What kind of information the finding is about.
export type FindingBasis =
  | "Brief fact" // Compared against something the brief states.
  | "AI suggestion" // Proposal content the AI suggested.
  | "Assumption" // Content assumed without confirmation.
  | "Open question"; // Something unknown that must be asked.

export type ReviewFinding = {
  id: string;
  source: "check" | "ai";
  severity: Severity;
  category: FindingCategory;
  basis: FindingBasis;
  title: string;
  why: string;
  suggestion: string;
  // Editor section to jump to: a section id, "summary", or "budget".
  sectionId: string | null;
};

type Rule = { severity: Severity; category: FindingCategory; basis: FindingBasis };

// Severity, category, and default basis of every deterministic check.
export const RULES = {
  // Missing or ambiguous requirements
  "missing-total": { severity: "High", category: "Missing or ambiguous", basis: "Open question" },
  "missing-currency": { severity: "Medium", category: "Missing or ambiguous", basis: "Open question" },
  "brief-no-deadline": { severity: "High", category: "Missing or ambiguous", basis: "Open question" },
  "missing-milestones": { severity: "Medium", category: "Missing or ambiguous", basis: "AI suggestion" },
  "missing-deliverables": { severity: "High", category: "Missing or ambiguous", basis: "AI suggestion" },
  "missing-acceptance": { severity: "Medium", category: "Missing or ambiguous", basis: "AI suggestion" },
  "missing-payments": { severity: "High", category: "Missing or ambiguous", basis: "AI suggestion" },
  "payment-amount-missing": { severity: "Medium", category: "Missing or ambiguous", basis: "AI suggestion" },
  "missing-revision-policy": { severity: "Medium", category: "Missing or ambiguous", basis: "AI suggestion" },
  "revision-limit-undefined": { severity: "Medium", category: "Missing or ambiguous", basis: "AI suggestion" },
  "missing-responsibilities": { severity: "Medium", category: "Missing or ambiguous", basis: "AI suggestion" },
  "missing-dependencies": { severity: "Low", category: "Missing or ambiguous", basis: "Assumption" },
  "open-questions": { severity: "Medium", category: "Missing or ambiguous", basis: "Open question" },
  "placeholder-text": { severity: "Medium", category: "Missing or ambiguous", basis: "AI suggestion" },
  "no-source-brief": { severity: "Low", category: "Missing or ambiguous", basis: "Open question" },
  // Arithmetic
  "budget-sum": { severity: "High", category: "Arithmetic", basis: "AI suggestion" },
  "payments-sum": { severity: "High", category: "Arithmetic", basis: "AI suggestion" },
  "invalid-amount": { severity: "High", category: "Arithmetic", basis: "AI suggestion" },
  // Brief versus proposal
  "total-differs": { severity: "High", category: "Inconsistent with the brief", basis: "Brief fact" },
  "currency-differs": { severity: "High", category: "Inconsistent with the brief", basis: "Brief fact" },
  "total-not-in-brief": { severity: "Medium", category: "Inconsistent with the brief", basis: "Assumption" },
  "deadline-not-reflected": { severity: "Medium", category: "Inconsistent with the brief", basis: "Brief fact" },
  "schedule-exceeds-deadline": { severity: "High", category: "Inconsistent with the brief", basis: "Brief fact" },
  "schedule-may-exceed-deadline": { severity: "Medium", category: "Inconsistent with the brief", basis: "Brief fact" },
  "revisions-differ": { severity: "High", category: "Inconsistent with the brief", basis: "Brief fact" },
  "deliverable-not-in-brief": { severity: "Low", category: "Inconsistent with the brief", basis: "AI suggestion" },
  // Commitments the brief didn't ask for
  "unlimited-revisions": { severity: "High", category: "Not agreed in the brief", basis: "AI suggestion" },
  "absolute-guarantee": { severity: "High", category: "Not agreed in the brief", basis: "AI suggestion" },
  "rush-commitment": { severity: "Medium", category: "Not agreed in the brief", basis: "AI suggestion" },
  "extra-work": { severity: "Medium", category: "Not agreed in the brief", basis: "AI suggestion" },
} as const satisfies Record<string, Rule>;

export type RuleId = keyof typeof RULES;

function finding(
  rule: RuleId,
  details: {
    title: string;
    why: string;
    suggestion: string;
    sectionId: string | null;
    idSuffix?: string;
    basis?: FindingBasis;
  },
): ReviewFinding {
  const { severity, category, basis } = RULES[rule];
  return {
    id: details.idSuffix ? `${rule}:${details.idSuffix}` : rule,
    source: "check",
    severity,
    category,
    basis: details.basis ?? basis,
    title: details.title,
    why: details.why,
    suggestion: details.suggestion,
    sectionId: details.sectionId,
  };
}

// --- Text helpers ----------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const NUM = "(\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30 };

function toNumber(word: string): number | null {
  const value = Number(word);
  if (Number.isInteger(value) && value > 0) return value;
  return NUMBER_WORDS[word.toLowerCase()] ?? null;
}

const lines = (text: string) =>
  text.split("\n").map((line) => line.trim()).filter(Boolean);

const FILLER = new Set([
  "a", "an", "the", "of", "in", "within", "by", "for", "and", "to", "at", "on",
  "with", "per", "about", "around", "is", "are", "be", "will", "from",
]);

// Lower-case meaningful words, with spelled-out numbers as digits and a
// trailing plural "s" removed.
function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((word) => !FILLER.has(word))
    .map((word) => {
      const canonical = String(NUMBER_WORDS[word] ?? word);
      return canonical.length > 3 && canonical.endsWith("s")
        ? canonical.slice(0, -1)
        : canonical;
    });
}

// "3-5 days", "two weeks", "1 month", "10 business days" as a day range.
export function parseDurationDays(text: string): { min: number; max: number } | null {
  const match = new RegExp(
    `\\b${NUM}(?:\\s*(?:-|–|to)\\s*${NUM})?\\s+(?:business\\s+|working\\s+)?(day|week|month)s?\\b`,
    "i",
  ).exec(text);
  if (!match) return null;
  const low = toNumber(match[1] ?? "");
  const high = match[2] ? toNumber(match[2]) : low;
  const unit = UNIT_DAYS[(match[3] ?? "").toLowerCase()];
  if (low === null || high === null || unit === undefined) return null;
  return { min: Math.min(low, high) * unit, max: Math.max(low, high) * unit };
}

// Estimated effort in working days, using the same rules as the server's
// schedule check (estimateInWorkingDays in server/src/proposalQuality.ts):
// unqualified days are working days, a week is 5 working days, a month 21,
// and calendar days count as 5/7 of a working day.
export function parseEstimateWorkingDays(text: string): { min: number; max: number } | null {
  const match = new RegExp(
    `\\b${NUM}(?:\\s*(?:-|–|to)\\s*${NUM})?\\s+(business\\s+|working\\s+|calendar\\s+)?(day|week|month)s?\\b`,
    "i",
  ).exec(text);
  if (!match) return null;
  const low = toNumber(match[1] ?? "");
  const high = match[2] ? toNumber(match[2]) : low;
  if (low === null || high === null) return null;
  const unit = (match[4] ?? "").toLowerCase();
  const perUnit = unit === "week" ? 5 : unit === "month" ? 21 : 1;
  const calendarDays = unit === "day" && (match[3] ?? "").trim().toLowerCase() === "calendar";
  const factor = perUnit * (calendarDays ? 5 / 7 : 1);
  return {
    min: Math.ceil(Math.min(low, high) * factor),
    max: Math.ceil(Math.max(low, high) * factor),
  };
}

type Span = { min: number; max: number };

// Milestone lines ("- Name: estimated 3-5 days (after A, B)") with durations
// read by `parse`.
function parseMilestones(timelineText: string, parse: (text: string) => Span | null) {
  return lines(timelineText)
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const body = line.slice(2);
      const colon = body.indexOf(":");
      const name = (colon >= 0 ? body.slice(0, colon) : body).trim().toLowerCase();
      // "(after A, B)" as generated, or "after A" typed without brackets;
      // ignoring an unbracketed dependency would understate the schedule.
      const after =
        (/\(after ([^)]+)\)/i.exec(body) ?? /\bafter\s([^()]+)$/i.exec(body))?.[1] ?? "";
      return {
        name,
        duration: parse(colon >= 0 ? body.slice(colon + 1) : body),
        dependsOn: after
          .split(/,|\band\b/i)
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean),
      };
    });
}

// Earliest and latest finish of the milestone list, following dependencies;
// independent milestones may run in parallel. Milestones without a readable
// duration are skipped (used for drafts without the server's schedule check).
export function scheduleSpanDays(timelineText: string): Span | null {
  const milestones = parseMilestones(timelineText, parseDurationDays).filter((m) => m.duration !== null);
  return milestones.length === 0 ? null : criticalPath(milestones);
}

// The same span in working days, matching the server's schedule check: every
// milestone needs a readable estimate, otherwise the span is unknown.
export function workingDaySpan(timelineText: string): Span | null {
  const milestones = parseMilestones(timelineText, parseEstimateWorkingDays);
  return milestones.length === 0 || milestones.some((m) => m.duration === null)
    ? null
    : criticalPath(milestones);
}

function criticalPath(
  milestones: Array<{ name: string; duration: Span | null; dependsOn: string[] }>,
): Span {
  const byName = new Map(milestones.map((m) => [m.name, m]));
  const finished = new Map<string, { min: number; max: number }>();
  const finish = (name: string, depth: number): { min: number; max: number } => {
    const known = finished.get(name);
    if (known) return known;
    const milestone = byName.get(name);
    // Unknown dependency or a dependency cycle: treat it as already done.
    if (!milestone?.duration || depth > milestones.length) return { min: 0, max: 0 };
    let start = { min: 0, max: 0 };
    for (const dependency of milestone.dependsOn) {
      const done = finish(dependency, depth + 1);
      start = { min: Math.max(start.min, done.min), max: Math.max(start.max, done.max) };
    }
    const result = {
      min: start.min + milestone.duration.min,
      max: start.max + milestone.duration.max,
    };
    finished.set(name, result);
    return result;
  };

  const ends = milestones.map((m) => finish(m.name, 0));
  return {
    min: Math.max(...ends.map((e) => e.min)),
    max: Math.max(...ends.map((e) => e.max)),
  };
}

// Number of revision rounds stated in a text, e.g. "two rounds of revisions".
export function revisionCount(text: string): number | null {
  const match = new RegExp(
    `\\b${NUM}\\s+(?:free\\s+)?(?:rounds?|revisions?|revision rounds?)\\b`,
    "i",
  ).exec(text);
  return match ? toNumber(match[1] ?? "") : null;
}

const UNLIMITED_REVISIONS =
  /\b(unlimited|infinite|endless)\s+(revisions?|changes|rounds)\b|\bas many (revisions|changes|rounds)\b|\bfree (revisions|changes)\b|\b(revisions|changes) (are )?(free|at no (extra |additional )?(cost|charge))\b/i;

const ABSOLUTE_GUARANTEES = [
  /\b100\s*%\s*(secure|security|uptime|bug[- ]free|satisfaction|guaranteed)\b/i,
  /\b(fully|completely|totally|absolutely|perfectly)\s+(secure|bug[- ]free|hack[- ]?proof)\b/i,
  /\bguarantee[sd]?\b[^.]{0,40}\b(security|secure|uptime|rankings?|results|traffic|sales|first page|bug)/i,
  /\b(never|cannot|can't|won't)\s+be\s+(hacked|breached)\b/i,
  /\b(bug[- ]free|zero bugs|error[- ]free|hack[- ]?proof|unhackable)\b/i,
];

// "We cannot guarantee..." is a disclaimer, not a promise.
const DISCLAIMER =
  /\b(cannot|can't|not|no|don't|do not|does not|won't)\s+(be\s+)?(guarantee|promise|warrant)/i;

const RUSH = /\b(within|in)\s+(24|48)\s*(hours|hrs|h)\b|\bsame[- ]day\b|\bovernight\b|\bimmediately\b/i;

// Lines that exclude work rather than promise it.
const NEGATION =
  /\b(no|not|excluding|excluded|exclude|excludes|out of scope|without|isn't|aren't|does not|do not)\b/i;

const EXTRA_WORK = [
  { key: "seo", label: "SEO", pattern: /\b(seo|search engine optimi[sz]ation)\b/i },
  {
    key: "integrations",
    label: "third-party integrations",
    pattern: /\b(third[- ]party|integrations|integrate with|integration with|crm)\b/i,
  },
  { key: "api", label: "API work", pattern: /\bapis?\b/i },
  { key: "hosting", label: "hosting", pattern: /\bhosting\b/i },
  {
    key: "maintenance",
    label: "ongoing maintenance or support",
    pattern: /\b(maintenance|ongoing support|support period|retainer)\b/i,
  },
  { key: "analytics", label: "analytics", pattern: /\banalytics\b/i },
  {
    key: "content",
    label: "copywriting or content creation",
    pattern: /\b(copywriting|content (writing|creation))\b/i,
  },
  { key: "branding", label: "logo or branding work", pattern: /\b(logo|branding)\b/i },
  {
    key: "payments",
    label: "payment processing",
    pattern: /\b(payment gateway|payment processing|e-?commerce)\b/i,
  },
  { key: "training", label: "training", pattern: /\btraining\b/i },
  { key: "migration", label: "data migration", pattern: /\bmigrat(e|ion)\b/i },
  { key: "translation", label: "translation", pattern: /\b(translation|multilingual|locali[sz]ation)\b/i },
];

const PLACEHOLDER = /\b(TBD|TBC|lorem ipsum)\b|\[(insert|add|client|name|date|amount)[^\]]*\]/i;

const TAG_BASIS: Record<SectionTag, FindingBasis> = {
  "From brief": "Brief fact",
  "AI-extracted": "AI suggestion",
  Suggested: "AI suggestion",
  Assumption: "Assumption",
  "Needs confirmation": "Open question",
};

// Sections whose wording commits the freelancer to something. Exclusions,
// assumptions, risks, and open questions are not promises.
const COMMITMENT_SECTIONS = ["deliverables", "acceptance", "timeline", "revisions", "changes"];

// --- Checks ----------------------------------------------------------------

export function runRiskChecks(proposal: EditableProposal): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const add = (...items: ReviewFinding[]) => findings.push(...items);
  const sectionText = (id: string) =>
    proposal.sections.find((s) => s.id === id)?.text.trim() ?? "";
  const brief = proposal.sourceBrief?.trim() ?? "";
  const facts = proposal.briefFacts;
  const currency = proposal.currency.trim();
  const totalCents = toCents(proposal.total);

  // Commitment text with where it came from.
  const committed = [
    { id: "summary", tag: "AI-extracted" as SectionTag, text: proposal.summary },
    ...proposal.sections
      .filter((s) => COMMITMENT_SECTIONS.includes(s.id))
      .map((s) => ({ id: s.id, tag: s.tag, text: s.text })),
  ];
  const committedLines = committed.flatMap((section) =>
    lines(section.text).map((line) => ({ ...section, line })),
  );

  // Money
  if (!proposal.total.trim()) {
    add(
      finding("missing-total", {
        title: "The total budget is unspecified",
        why: "Without an agreed total, payment milestones can't be calculated and the price is open to dispute.",
        suggestion: "Ask the client: \"What total budget have you set aside for this project?\"",
        sectionId: "budget",
      }),
    );
  } else if (totalCents !== null && !currency) {
    add(
      finding("missing-currency", {
        title: "The budget currency is unspecified",
        why: "The same number means very different amounts in different currencies.",
        suggestion: "State the currency next to the total, for example USD.",
        sectionId: "budget",
      }),
    );
  }

  if (proposal.total.trim() && totalCents === null) {
    add(
      finding("invalid-amount", {
        idSuffix: "total",
        title: "The total budget is not a valid amount",
        why: "A total that can't be read can't be checked or invoiced.",
        suggestion: "Use a plain number such as 800 or 800.00.",
        sectionId: "budget",
      }),
    );
  }

  for (const [rule, name, rows] of [
    ["budget-sum", "Budget line items", proposal.budgetItems],
    ["payments-sum", "Payment milestones", proposal.payments],
  ] as const) {
    const check = checkMoneyRows(proposal.total, rows);
    if (check.state === "invalid") {
      add(
        finding("invalid-amount", {
          idSuffix: rule,
          title: `${name} include an amount that is not a valid number`,
          why: "Amounts that can't be read can't be checked or invoiced.",
          suggestion: "Use plain numbers such as 250 or 250.50.",
          sectionId: "budget",
        }),
      );
    } else if (check.state === "mismatch") {
      add(
        finding(rule, {
          title: `${name} add up to ${formatMoney(check.sumCents, currency)}, not the total of ${formatMoney(check.totalCents, currency)}`,
          why: "A proposal whose numbers don't reconcile looks unreliable and can lead to under- or over-billing.",
          suggestion: `Adjust the amounts so they add up to ${formatMoney(check.totalCents, currency)}, or correct the total.`,
          sectionId: "budget",
        }),
      );
    }
  }

  if (proposal.payments.length === 0) {
    add(
      finding("missing-payments", {
        title: "No payment milestones are listed",
        why: "Without milestones, it's unclear when the client pays and how much work is at risk before payment.",
        suggestion: "Add milestones, for example a deposit before work starts and a final payment on delivery.",
        sectionId: "budget",
      }),
    );
  } else if (totalCents !== null && proposal.payments.some((p) => !p.amount.trim())) {
    add(
      finding("payment-amount-missing", {
        title: "Some payment milestones have no amount",
        why: "The client can't see what is due at each milestone.",
        suggestion: "Fill in an amount for every payment milestone.",
        sectionId: "budget",
      }),
    );
  }

  // Scope
  if (!sectionText("deliverables")) {
    add(
      finding("missing-deliverables", {
        title: "No deliverables are listed",
        why: "Undefined scope is the most common cause of disputes about what was paid for.",
        suggestion: "List every deliverable the client will receive.",
        sectionId: "deliverables",
      }),
    );
  }
  if (!sectionText("acceptance")) {
    add(
      finding("missing-acceptance", {
        title: "No acceptance criteria are defined",
        why: "Without criteria, there's no clear point at which a deliverable counts as done.",
        suggestion: "Add one to three testable criteria per deliverable.",
        sectionId: "acceptance",
      }),
    );
  }

  // Timeline
  const timeline = sectionText("timeline");
  if (!lines(timeline).some((line) => line.startsWith("- "))) {
    add(
      finding("missing-milestones", {
        title: "No project milestones are listed",
        why: "Milestones let both sides see progress and link payments to delivered work.",
        suggestion: "Add milestones with estimated durations.",
        sectionId: "timeline",
      }),
    );
  }

  // Revisions
  const revisions = sectionText("revisions");
  if (!revisions) {
    add(
      finding("missing-revision-policy", {
        title: "There is no revision policy",
        why: "Without a policy, the client may expect unlimited changes.",
        suggestion: "State how many revision rounds are included and how extra rounds are charged.",
        sectionId: "revisions",
      }),
    );
  } else if (revisionCount(revisions) === null && !UNLIMITED_REVISIONS.test(revisions)) {
    add(
      finding("revision-limit-undefined", {
        title: "The revision policy doesn't state a number of rounds",
        why: "\"A set number of revisions\" leaves the actual limit open to interpretation.",
        suggestion: "State the exact number of included revision rounds, for example two.",
        sectionId: "revisions",
      }),
    );
  }

  // Responsibilities and dependencies
  const responsibilities = sectionText("responsibilities");
  if (!responsibilities) {
    add(
      finding("missing-responsibilities", {
        title: "Client responsibilities are not listed",
        why: "Delays caused by missing content, access, or feedback can't be attributed fairly.",
        suggestion: "List what the client must provide (content, access, feedback times).",
        sectionId: "responsibilities",
      }),
    );
  }
  const hasPrerequisites = /prerequisite/i.test(responsibilities) || Boolean(sectionText("assumptions"));
  const milestoneLines = lines(timeline).filter((line) => line.startsWith("- "));
  if (!hasPrerequisites || (milestoneLines.length > 1 && !/\(after /i.test(timeline))) {
    add(
      finding("missing-dependencies", {
        title: hasPrerequisites
          ? "Milestone dependencies aren't stated"
          : "Project prerequisites and dependencies aren't stated",
        why: "If one step depends on another or on the client, delays elsewhere move the deadline.",
        suggestion: "Note which milestones depend on earlier ones and what the client must provide first.",
        sectionId: hasPrerequisites ? "timeline" : "responsibilities",
      }),
    );
  }

  // Open questions and placeholders
  const openItems = lines(sectionText("open-items"));
  if (openItems.length > 0) {
    add(
      finding("open-questions", {
        title: `${openItems.length} item(s) still need the client's answer`,
        why: "Unanswered questions become assumptions, which are a common source of disputes.",
        suggestion: "Ask the client these questions before sharing a final proposal, or keep them visible as open items.",
        sectionId: "open-items",
      }),
    );
  }
  const withPlaceholder = [
    { id: "summary", text: proposal.summary },
    ...proposal.sections,
  ].find((s) => PLACEHOLDER.test(s.text));
  if (withPlaceholder) {
    add(
      finding("placeholder-text", {
        title: "The proposal still contains placeholder text",
        why: "Placeholders such as TBD look unfinished and leave terms undefined.",
        suggestion: "Replace the placeholder with the real value, or move it to the open questions.",
        sectionId: withPlaceholder.id,
      }),
    );
  }

  // Commitments the brief didn't ask for
  const unlimited = committedLines.find((l) => UNLIMITED_REVISIONS.test(l.line));
  if (unlimited && !UNLIMITED_REVISIONS.test(brief)) {
    add(
      finding("unlimited-revisions", {
        title: "The proposal offers unlimited or free revisions",
        why: "The brief doesn't ask for this, and open-ended revisions can consume the whole budget.",
        suggestion: "Limit revisions to a set number of rounds and price extra rounds separately.",
        sectionId: unlimited.id,
        basis: TAG_BASIS[unlimited.tag],
      }),
    );
  }

  const guarantee = committedLines.find(
    (l) => !DISCLAIMER.test(l.line) && ABSOLUTE_GUARANTEES.some((p) => p.test(l.line)),
  );
  if (guarantee) {
    add(
      finding("absolute-guarantee", {
        title: "The proposal makes an absolute guarantee",
        why: "No one can guarantee perfect security, uptime, or results; a broken guarantee can lead to claims against you.",
        suggestion: "Describe the measures you will take (for example, following security best practices) instead of guaranteeing outcomes.",
        sectionId: guarantee.id,
        basis: TAG_BASIS[guarantee.tag],
      }),
    );
  }

  const rush = committedLines.find((l) => RUSH.test(l.line) && !NEGATION.test(l.line));
  if (rush && !RUSH.test(brief)) {
    add(
      finding("rush-commitment", {
        title: "The proposal promises a very fast turnaround",
        why: "The brief doesn't ask for this, and rush commitments are easy to miss.",
        suggestion: "Replace it with a realistic response time, or confirm the client needs it and price it accordingly.",
        sectionId: rush.id,
        basis: TAG_BASIS[rush.tag],
      }),
    );
  }

  if (brief) {
    for (const extra of EXTRA_WORK) {
      const line = committedLines.find((l) => extra.pattern.test(l.line) && !NEGATION.test(l.line));
      if (line && !extra.pattern.test(brief)) {
        add(
          finding("extra-work", {
            idSuffix: extra.key,
            title: `The proposal includes ${extra.label}, which the brief doesn't mention`,
            why: "Extra work that wasn't requested adds cost and time the client may not have agreed to.",
            suggestion: `Ask the client whether they want ${extra.label}. If not, list it under Out of scope; if so, price it separately.`,
            sectionId: line.id,
            basis: TAG_BASIS[line.tag],
          }),
        );
      }
    }
  }

  // Brief versus proposal
  if (!brief || !facts) {
    add(
      finding("no-source-brief", {
        title: "This proposal can't be compared with its original brief",
        why: "It was created before brief tracking existed, so budget, deadline, and scope consistency weren't checked.",
        suggestion: "Generate the proposal again to enable the comparison.",
        sectionId: null,
      }),
    );
    return findings;
  }

  if (facts.total !== null) {
    const briefCents = Math.round(facts.total * 100);
    if (totalCents !== null && totalCents !== briefCents) {
      add(
        finding("total-differs", {
          title: `The total (${formatMoney(totalCents, currency)}) differs from the brief's budget ("${facts.budgetQuote ?? facts.total}")`,
          why: "Changing the client's stated budget without discussion can surprise them or look like a mistake.",
          suggestion: "Restore the brief's budget, or explain the difference and confirm it with the client.",
          sectionId: "budget",
        }),
      );
    }
    if (facts.currency && currency && currency.toUpperCase() !== facts.currency) {
      add(
        finding("currency-differs", {
          title: `The currency (${currency}) differs from the brief's (${facts.currency})`,
          why: "A different currency changes the real price.",
          suggestion: `Use ${facts.currency}, or confirm the currency change with the client.`,
          sectionId: "budget",
        }),
      );
    }
  } else if (totalCents !== null) {
    add(
      finding("total-not-in-brief", {
        title: `The total of ${formatMoney(totalCents, currency)} is not stated in the brief`,
        why: "The brief gives no budget, so this figure is your proposal, not an agreed amount.",
        suggestion: "Present it as your quote and confirm it with the client.",
        sectionId: "budget",
      }),
    );
  }

  if (!facts.deadlineQuote) {
    add(
      finding("brief-no-deadline", {
        title: "The brief doesn't state a deadline",
        why: "Without an agreed date, the client may expect delivery sooner than your estimates.",
        suggestion: "Ask the client: \"Is there a date you need this delivered by?\"",
        sectionId: "timeline",
      }),
    );
  } else {
    const timelineWords = new Set(words(timeline));
    if (!words(facts.deadlineQuote).every((word) => timelineWords.has(word))) {
      add(
        finding("deadline-not-reflected", {
          title: `The timeline no longer mentions the brief's deadline ("${facts.deadlineQuote}")`,
          why: "The client will compare your plan with the deadline they asked for.",
          suggestion: "State the brief's deadline in the timeline and show how the milestones meet it.",
          sectionId: "timeline",
        }),
      );
    }
    if (proposal.schedule) {
      // Same result and working-day interpretation as the proposal timeline.
      const conflict = scheduleConflictFinding(
        currentSchedule(proposal.schedule, timeline),
        facts.deadlineQuote,
      );
      if (conflict && !findings.some((f) => f.id.startsWith("schedule-"))) add(conflict);
    }

    // Drafts without the server's schedule check keep the calendar-day check.
    const deadline = proposal.schedule ? null : parseDurationDays(facts.deadlineQuote);
    const span = proposal.schedule ? null : scheduleSpanDays(timeline);
    if (deadline && span) {
      if (span.min > deadline.max) {
        add(
          finding("schedule-exceeds-deadline", {
            title: `The milestones take at least ${span.min} days, longer than the brief's deadline ("${facts.deadlineQuote}")`,
            why: "Committing to a schedule that can't meet the deadline sets the project up to fail.",
            suggestion: "Shorten or run milestones in parallel, reduce scope, or agree a later deadline with the client.",
            sectionId: "timeline",
          }),
        );
      } else if (span.max > deadline.max) {
        add(
          finding("schedule-may-exceed-deadline", {
            title: `The milestones could take up to ${span.max} days, beyond the brief's deadline ("${facts.deadlineQuote}")`,
            why: "The upper estimates don't fit the deadline, leaving no buffer for delays.",
            suggestion: "Tighten the estimates or confirm the deadline with the client.",
            sectionId: "timeline",
          }),
        );
      }
    }
  }

  const briefRounds = revisionCount(brief);
  const proposalRounds = revisionCount(revisions);
  if (briefRounds !== null && proposalRounds !== null && briefRounds !== proposalRounds) {
    add(
      finding("revisions-differ", {
        title: `The revision policy offers ${proposalRounds} round(s), but the brief mentions ${briefRounds}`,
        why: "A different revision limit from the one the client asked for will cause disagreement later.",
        suggestion: `Match the brief (${briefRounds} rounds), or explain the change and confirm it with the client.`,
        sectionId: "revisions",
      }),
    );
  }

  const briefWords = new Set(words(brief));
  for (const line of lines(sectionText("deliverables")).filter((l) => l.startsWith("- "))) {
    // Already reported more specifically as extra work.
    if (EXTRA_WORK.some((e) => e.pattern.test(line) && !NEGATION.test(line) && !e.pattern.test(brief))) {
      continue;
    }
    const name = line.slice(2).split(":")[0] ?? "";
    const keyWords = words(name).filter((word) => word.length >= 4);
    if (keyWords.length > 0 && !keyWords.some((word) => briefWords.has(word))) {
      add(
        finding("deliverable-not-in-brief", {
          idSuffix: hashText(name.toLowerCase()),
          title: `"${name.trim()}" may not be something the brief asks for`,
          why: "None of its key words appear in the brief, so it may be work the client didn't request.",
          suggestion: "Check it against the brief and remove it, or confirm the client wants it.",
          sectionId: "deliverables",
        }),
      );
    }
  }

  return findings;
}

// --- Schedule versus deadline ----------------------------------------------

// The server's schedule result while the milestone lines are as generated.
// After they are edited, the estimate is recalculated with the same
// working-day rules against the same deadline, so the review never goes back
// to a different interpretation.
export function currentSchedule(
  stored: NonNullable<EditableProposal["schedule"]>,
  timelineText: string,
): ScheduleCheck {
  const current = milestoneLinesOf(timelineText);
  if (sameLines(current, stored.milestoneLines)) return stored.check;

  const estimate = workingDaySpan(timelineText);
  const deadline = stored.check.deadlineWorkingDays;
  let status: ScheduleCheck["status"];
  if (stored.check.status === "no-deadline") status = "no-deadline";
  else if (!estimate || deadline === null) status = "unknown";
  else if (estimate.min > deadline) status = "exceeds";
  else if (estimate.max > deadline) status = "may-exceed";
  else status = "fits";
  // As on the server: an estimate that doesn't say working, business, or
  // calendar days was read as working days.
  const assumedWorkingDays = current.some(
    (line) =>
      parseEstimateWorkingDays(line) !== null &&
      !/\b(working|business|calendar)\s+(day|week|month)s?\b/i.test(line),
  );
  return { ...stored.check, status, estimateWorkingDays: estimate, assumedWorkingDays };
}

const milestoneLinesOf = (timelineText: string) =>
  lines(timelineText).filter((line) => line.startsWith("- "));

const sameLines = (a: string[], b: string[]) =>
  a.length === b.length && a.every((line, i) => line === b[i]?.trim());

// Keep the timeline consistent with its milestones. When the milestone lines
// differ from those the stored result was computed from, recalculate the
// schedule, rewrite the "Estimated schedule:" summary line and the section's
// confirmation tag, and store the new result with the current lines, so no
// stale schedule metadata remains. Returns the same object when nothing
// changed, and leaves drafts without schedule metadata untouched.
export function syncSchedule(proposal: EditableProposal): EditableProposal {
  const stored = proposal.schedule;
  const section = proposal.sections.find((s) => s.id === MONEY_AFTER_SECTION);
  if (!stored || !section) return proposal;

  const current = milestoneLinesOf(section.text);
  if (sameLines(current, stored.milestoneLines)) return proposal;

  const check = currentSchedule(stored, section.text);
  const summary = describeSchedule(check);
  const text = summary
    ? section.text
        .split("\n")
        .map((line) => (line.trim().startsWith("Estimated schedule:") ? summary : line))
        .join("\n")
    : section.text;

  return {
    ...proposal,
    schedule: { check, milestoneLines: current },
    sections: proposal.sections.map((s) =>
      s === section ? { ...s, text, tag: timelineTag(check, check.status !== "no-deadline") } : s,
    ),
  };
}

// A finding for a schedule that may or will exceed the deadline. Estimates
// are never presented as certain: "exceeds" means even the low estimates
// don't fit; "may-exceed" means only the high estimates don't.
export function scheduleConflictFinding(
  check: ScheduleCheck,
  deadlineQuote: string,
): ReviewFinding | null {
  const estimate = check.estimateWorkingDays;
  if (!estimate || check.deadlineWorkingDays === null) return null;
  const calendar = check.deadlineCalendarDays ? ` (${check.deadlineCalendarDays} calendar days)` : "";
  const deadline = `"${deadlineQuote}", about ${check.deadlineWorkingDays} working days${calendar}`;

  if (check.status === "exceeds") {
    return finding("schedule-exceeds-deadline", {
      title: `The milestones are estimated to need at least ${estimate.min} working days, longer than the brief's deadline (${deadline})`,
      why: "Even the lowest estimates don't fit the deadline, so committing to this schedule would very likely mean missing it.",
      suggestion: "Before committing, agree a later deadline or a smaller scope with the client, or re-plan milestones to run in parallel.",
      sectionId: "timeline",
    });
  }
  if (check.status === "may-exceed") {
    return finding("schedule-may-exceed-deadline", {
      title: `The milestones could take up to ${estimate.max} working days, beyond the brief's deadline (${deadline})`,
      why: "The lower estimates fit, but the upper ones don't, leaving no buffer for feedback or delays.",
      suggestion: "Confirm the deadline and priorities with the client, or tighten the estimates, before committing to the schedule.",
      sectionId: "timeline",
    });
  }
  return null;
}

// --- Review state ----------------------------------------------------------

const SEVERITY_ORDER: Record<Severity, number> = { High: 0, Medium: 1, Low: 2 };

export function sortFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}

// Small stable hash (FNV-1a) for fingerprints and keys; not for security.
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// Changes whenever reviewable proposal content changes.
export function proposalFingerprint(proposal: EditableProposal): string {
  return hashText(
    JSON.stringify([
      proposal.title,
      proposal.summary,
      proposal.currency,
      proposal.total,
      proposal.budgetItems.map((r) => [r.label, r.amount]),
      proposal.payments.map((r) => [r.label, r.amount]),
      proposal.sections.map((s) => [s.id, s.text]),
      proposal.sourceBrief ?? "",
    ]),
  );
}

// Key for the freelancer's "reviewed" mark. It changes when the finding's
// wording changes (for example a different mismatch amount) or the proposal
// is regenerated, so an old mark never carries over to a new problem.
export function reviewedKey(proposal: EditableProposal, finding: ReviewFinding): string {
  return `${proposal.generatedAt ?? "saved"}|${finding.id}|${hashText(`${finding.title}\n${finding.why}`)}`;
}

export function summarizeFindings(
  findings: ReviewFinding[],
  isReviewed: (finding: ReviewFinding) => boolean,
) {
  const open = findings.filter((f) => !isReviewed(f));
  return {
    total: findings.length,
    reviewed: findings.length - open.length,
    High: open.filter((f) => f.severity === "High").length,
    Medium: open.filter((f) => f.severity === "Medium").length,
    Low: open.filter((f) => f.severity === "Low").length,
  };
}

export type AiReview = {
  fingerprint: string;
  findings: ReviewFinding[];
  ranAt: string;
};

// AI findings are only current for the exact proposal they reviewed.
export function aiReviewStatus(
  review: AiReview | null,
  currentFingerprint: string,
): "none" | "current" | "stale" {
  if (!review) return "none";
  return review.fingerprint === currentFingerprint ? "current" : "stale";
}

// Body for POST /api/proposals/review: the proposal content and its source
// brief only.
export function toReviewRequest(proposal: EditableProposal) {
  return {
    brief: proposal.sourceBrief ?? "",
    proposal: {
      title: proposal.title,
      summary: proposal.summary,
      currency: proposal.currency,
      total: proposal.total,
      budgetItems: proposal.budgetItems.map(({ label, amount }) => ({ label, amount })),
      payments: proposal.payments.map(({ label, amount }) => ({ label, amount })),
      sections: proposal.sections.map(({ id, heading, tag, text }) => ({ id, heading, tag, text })),
    },
  };
}
