// Deterministic quality checks for generated proposals: whether the milestone
// estimates fit the brief's deadline, missing-information items that repeat a
// client question, and payment milestones that don't say when they are due.

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const NUM = "(\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
const DURATION = new RegExp(
  `\\b${NUM}(?:\\s*(?:-|–|to)\\s*${NUM})?\\s+(business\\s+|working\\s+|calendar\\s+)?(day|week|month)s?\\b`,
  "i",
);

const toNumber = (word: string) =>
  /^\d+$/.test(word) ? Number(word) : (NUMBER_WORDS[word.toLowerCase()] ?? NaN);

export type Duration = {
  min: number;
  max: number;
  unit: "day" | "week" | "month";
  basis: "working" | "calendar" | "unspecified";
};

// "3-5 days", "two weeks", "10 business days", "1 calendar month".
export function parseDuration(text: string): Duration | null {
  const match = DURATION.exec(text);
  if (!match) return null;
  const low = toNumber(match[1] ?? "");
  const high = match[2] ? toNumber(match[2]) : low;
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0) return null;
  const qualifier = (match[3] ?? "").trim().toLowerCase();
  return {
    min: Math.min(low, high),
    max: Math.max(low, high),
    unit: (match[4] ?? "day").toLowerCase() as Duration["unit"],
    basis: qualifier === "calendar" ? "calendar" : qualifier ? "working" : "unspecified",
  };
}

// Estimates measure effort, so unqualified days count as working days.
function estimateInWorkingDays(d: Duration): { min: number; max: number } {
  const perUnit = d.unit === "week" ? 5 : d.unit === "month" ? 21 : 1;
  const calendarToWorking = d.unit === "day" && d.basis === "calendar" ? 5 / 7 : 1;
  return {
    min: Math.ceil(d.min * perUnit * calendarToWorking),
    max: Math.ceil(d.max * perUnit * calendarToWorking),
  };
}

// Deadlines measure elapsed time, so unqualified days count as calendar days.
// The later bound of a range is used.
function deadlineInDays(d: Duration): { working: number; calendar: number | null } {
  if (d.unit === "week") return { working: d.max * 5, calendar: d.max * 7 };
  if (d.unit === "month") return { working: d.max * 21, calendar: d.max * 30 };
  if (d.basis === "working") return { working: d.max, calendar: null };
  return { working: Math.floor((d.max * 5) / 7), calendar: d.max };
}

export type ScheduleCheck = {
  status: "fits" | "may-exceed" | "exceeds" | "no-deadline" | "unknown";
  estimateWorkingDays: { min: number; max: number } | null;
  deadlineWorkingDays: number | null;
  deadlineCalendarDays: number | null;
  // Some estimates didn't say working or calendar days and were read as working days.
  assumedWorkingDays: boolean;
};

type Milestone = { name: string; estimatedDuration: string; dependsOn: string[] };

// Total schedule along the dependency chain: a milestone starts when the
// milestones it depends on finish; independent milestones may run in parallel.
export function checkSchedule(milestones: Milestone[], deadlineQuote: string | null): ScheduleCheck {
  const parsed = milestones.map((m) => ({ ...m, duration: parseDuration(m.estimatedDuration) }));
  const deadline = deadlineQuote ? parseDuration(deadlineQuote) : null;
  const deadlineDays = deadline ? deadlineInDays(deadline) : null;
  const base = {
    deadlineWorkingDays: deadlineDays?.working ?? null,
    deadlineCalendarDays: deadlineDays?.calendar ?? null,
    assumedWorkingDays: parsed.some((m) => m.duration?.basis === "unspecified"),
  };

  let estimate: { min: number; max: number } | null = null;
  if (parsed.length > 0 && parsed.every((m) => m.duration)) {
    const byName = new Map(parsed.map((m) => [m.name.toLowerCase(), m]));
    const finished = new Map<string, { min: number; max: number }>();
    const finish = (name: string, depth: number): { min: number; max: number } => {
      const known = finished.get(name);
      if (known) return known;
      const milestone = byName.get(name);
      if (!milestone?.duration || depth > parsed.length) return { min: 0, max: 0 };
      let start = { min: 0, max: 0 };
      for (const dependency of milestone.dependsOn) {
        const done = finish(dependency.toLowerCase(), depth + 1);
        start = { min: Math.max(start.min, done.min), max: Math.max(start.max, done.max) };
      }
      const own = estimateInWorkingDays(milestone.duration);
      const result = { min: start.min + own.min, max: start.max + own.max };
      finished.set(name, result);
      return result;
    };
    const ends = parsed.map((m) => finish(m.name.toLowerCase(), 0));
    estimate = {
      min: Math.max(...ends.map((e) => e.min)),
      max: Math.max(...ends.map((e) => e.max)),
    };
  }

  let status: ScheduleCheck["status"];
  if (!deadlineQuote) status = "no-deadline";
  else if (!estimate || !deadlineDays) status = "unknown";
  else if (estimate.min > deadlineDays.working) status = "exceeds";
  else if (estimate.max > deadlineDays.working) status = "may-exceed";
  else status = "fits";

  return { status, estimateWorkingDays: estimate, ...base };
}

const range = ({ min, max }: { min: number; max: number }) =>
  min === max ? `${min}` : `${min}–${max}`;

function deadlineDescription(check: ScheduleCheck): string {
  const calendar = check.deadlineCalendarDays ? ` (${check.deadlineCalendarDays} calendar days)` : "";
  return `about ${check.deadlineWorkingDays} working days${calendar}`;
}

// Warning for the draft, or null when there is nothing to flag.
export function scheduleWarning(check: ScheduleCheck, deadlineQuote: string | null): string | null {
  const estimate = check.estimateWorkingDays;
  if (check.status === "exceeds" && estimate) {
    return `The milestones need at least ${estimate.min} working days, longer than the brief's deadline ("${deadlineQuote}", ${deadlineDescription(check)}). Don't promise this schedule: agree a later date or a smaller scope with the client.`;
  }
  if (check.status === "may-exceed" && estimate) {
    return `The milestone estimates total ${range(estimate)} working days, but the brief's deadline ("${deadlineQuote}") is ${deadlineDescription(check)}. The schedule may not fit; confirm priorities or the date with the client before committing.`;
  }
  if (check.status === "unknown") {
    return `The milestone estimates could not be compared with the brief's deadline ("${deadlineQuote}") automatically. Check the schedule against it manually.`;
  }
  return null;
}

// --- Missing information versus client questions --------------------------

const QUESTION_FILLER = new Set([
  "what", "which", "who", "whom", "whose", "when", "where", "why", "how", "is", "are",
  "was", "were", "do", "does", "did", "can", "could", "would", "will", "should", "there",
  "any", "the", "a", "an", "of", "for", "to", "and", "or", "in", "on", "with", "be", "you",
  "your", "we", "our", "client", "clients", "please", "specific", "preferred", "required",
  "require", "requires", "requirement", "need", "needs", "needed", "want", "wants", "like",
  "have", "has", "include", "including", "detail", "information", "about",
  // Words that only say something is absent ("No SEO specified").
  "no", "not", "none", "missing", "unclear", "unknown", "specified", "stated", "provided",
  "mentioned", "defined", "given", "yet",
]);

// Crude stem so "functionalities" matches "functionality" and "preferences"
// matches "preference".
const stem = (word: string) =>
  word.endsWith("ies") && word.length > 4
    ? `${word.slice(0, -3)}y`
    : word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
      ? word.slice(0, -1)
      : word;

function questionWords(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().replace(/['’]s\b/g, "").match(/[a-z0-9]+/g) ?? [])
      .map(stem)
      .filter((word) => word.length > 1 && !QUESTION_FILLER.has(word)),
  );
}

// Share of `item`'s meaningful words that also appear in `question`.
function overlap(item: string, question: string): number {
  const itemWords = questionWords(item);
  if (itemWords.size === 0) return 0;
  const questionSet = questionWords(question);
  return [...itemWords].filter((word) => questionSet.has(word)).length / itemWords.size;
}

const isCoveredBy = (item: string, question: string) => overlap(item, question) >= 0.8;

// Keep each open point once: a question that asks the same as an earlier one
// (each covers the other) is removed, and a missing item that a question
// already asks about is dropped in favour of the actionable question. A
// missing item counts as asked when any question covers 80% of its words, or
// when the question at the same position (the model is asked for one question
// per missing item) shares at least half of them and every one of its words
// is asked somewhere. Other items are kept, so nothing unasked is lost.
export function mergeOpenItems(
  missingInformation: string[],
  clarificationQuestions: string[],
): { missingInformation: string[]; clarificationQuestions: string[] } {
  const questions: string[] = [];
  for (const question of clarificationQuestions) {
    const repeats = questions.some(
      (earlier) => isCoveredBy(question, earlier) && isCoveredBy(earlier, question),
    );
    if (!repeats) questions.push(question);
  }
  const allQuestions = questions.join(" ");
  return {
    missingInformation: missingInformation.filter((item, index) => {
      const paired = clarificationQuestions[index];
      const askedByPair =
        paired !== undefined && overlap(item, paired) >= 0.5 && overlap(item, allQuestions) === 1;
      return !askedByPair && !questions.some((question) => isCoveredBy(item, question));
    }),
    clarificationQuestions: questions,
  };
}

// --- Payment due points ----------------------------------------------------

const DUE_POINT =
  /\b(deposit|upfront|up-front|advance|retainer|before|on|upon|after|at|when|start|signing|signature|kick-?off|completion|complete|completed|delivery|delivered|approval|approved|acceptance|accepted|launch|go-live|final|handover)\b/i;

// Make clear when a suggested payment is due. Labels that already say so are
// kept; a label naming a milestone becomes "On completion of <milestone>";
// anything else is marked as having its timing still to be agreed.
export function clarifyPaymentTrigger(label: string, milestoneNames: string[]): string {
  if (DUE_POINT.test(label)) return label;
  const normalized = label.toLowerCase().trim();
  const milestone = milestoneNames.find((name) => {
    const n = name.toLowerCase().trim();
    return n && (normalized.includes(n) || n.includes(normalized));
  });
  return milestone ? `On completion of ${label}` : `${label} (timing to be agreed)`;
}
