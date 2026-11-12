// Saved client projects and plan usage, as stored and enforced by the
// backend. The browser only displays them: ownership, plan limits and Pro
// features are all checked on the server.
import { requestJson } from "./api.ts";

export type ProjectStatus = "LEAD" | "ACTIVE" | "COMPLETED" | "ARCHIVED";
export type ProposalStatus = "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED";

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  LEAD: "Lead",
  ACTIVE: "Active",
  COMPLETED: "Completed",
  ARCHIVED: "Archived",
};

export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  DRAFT: "Draft",
  SENT: "Sent",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
};

export type ProjectSummary = {
  id: string;
  name: string;
  clientName: string;
  status: ProjectStatus;
  proposalStatus: ProposalStatus | null;
  estimatedBudget: string | null;
  budgetCurrency: string | null;
  deadline: string | null;
  hasAnalysis: boolean;
  hasProposal: boolean;
  hasRiskReview: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProjectDetail = ProjectSummary & {
  brief: string;
  analysis: unknown;
  proposal: unknown;
  riskReview: unknown;
};

export type ProjectStats = { total: number; active: number; pendingProposals: number; completed: number };

export type Usage = {
  plan: "FREE" | "PRO";
  period: { start: string; resetsAt: string };
  analyses: { used: number; limit: number; remaining: number };
  features: { proposalGeneration: boolean; riskReview: boolean; savedProposals: boolean };
};

export type NewProject = {
  name: string;
  clientName: string;
  brief: string;
  estimatedBudget: number | null;
  budgetCurrency: string | null;
  deadline: string | null;
};

export type ProjectChanges = Partial<NewProject & { status: ProjectStatus; proposalStatus: ProposalStatus }>;

// A request the server refused, with its status and code so callers can tell
// "sign in" from "upgrade" from other errors.
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>, fallback: string) {
    super(typeof body.error === "string" ? body.error : fallback);
    this.name = "ApiError";
    this.status = status;
    this.code = typeof body.code === "string" ? body.code : undefined;
    this.body = body;
  }
}

async function call<T>(url: string, init: RequestInit | undefined, fallback: string): Promise<T> {
  const { response, data } = await requestJson<T>(url, init);
  if (!response.ok) throw new ApiError(response.status, data as Record<string, unknown>, fallback);
  return data;
}

const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export async function listProjects(apiUrl: string): Promise<{ projects: ProjectSummary[]; stats: ProjectStats }> {
  return call(`${apiUrl}/api/projects`, undefined, "Could not load your projects.");
}

export async function getProject(apiUrl: string, id: string): Promise<ProjectDetail> {
  return (await call<{ project: ProjectDetail }>(`${apiUrl}/api/projects/${encodeURIComponent(id)}`, undefined, "Could not open the project.")).project;
}

export async function createProject(apiUrl: string, project: NewProject): Promise<ProjectDetail> {
  return (await call<{ project: ProjectDetail }>(`${apiUrl}/api/projects`, send("POST", project), "Could not create the project.")).project;
}

export async function updateProject(apiUrl: string, id: string, changes: ProjectChanges): Promise<ProjectDetail> {
  return (await call<{ project: ProjectDetail }>(`${apiUrl}/api/projects/${encodeURIComponent(id)}`, send("PATCH", changes), "Could not save the project.")).project;
}

export async function saveProjectDocument(
  apiUrl: string,
  id: string,
  kind: "analysis" | "proposal" | "risk-review",
  value: unknown,
): Promise<ProjectDetail> {
  const key = kind === "risk-review" ? "review" : kind;
  return (
    await call<{ project: ProjectDetail }>(
      `${apiUrl}/api/projects/${encodeURIComponent(id)}/${kind}`,
      send("PUT", { [key]: value }),
      `Could not save the ${kind.replace("-", " ")}.`,
    )
  ).project;
}

export async function fetchUsage(apiUrl: string): Promise<Usage | null> {
  const { response, data } = await requestJson<Usage>(`${apiUrl}/api/usage`);
  if (response.status === 401) return null;
  if (!response.ok) throw new ApiError(response.status, data as Record<string, unknown>, "Could not load your plan usage.");
  return data;
}

// "Free · 1 of 2 analyses used this month".
export function describeUsage(usage: Usage): string {
  const plan = usage.plan === "PRO" ? "Pro" : "Free";
  return `${plan} · ${usage.analyses.used} of ${usage.analyses.limit} analyses used this month`;
}

// A project budget as entered: "USD 800.00", or null when none was entered.
export function formatBudget(project: Pick<ProjectSummary, "estimatedBudget" | "budgetCurrency">): string | null {
  if (project.estimatedBudget === null) return null;
  return `${project.budgetCurrency ?? ""} ${Number(project.estimatedBudget).toFixed(2)}`.trim();
}

// Reads the optional budget field of the new-project form. Empty means not
// entered; never a guess.
export function parseBudget(value: string): number | null | "invalid" {
  const trimmed = value.trim().replace(/,/g, "");
  if (!trimmed) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return "invalid";
  const amount = Number(trimmed);
  return amount <= 1_000_000_000 ? amount : "invalid";
}
