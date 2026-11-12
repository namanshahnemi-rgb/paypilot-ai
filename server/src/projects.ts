// Persistent client projects: brief, AI analysis, proposal, risk review,
// the freelancer's own budget and deadline, and the project and proposal
// statuses.
//
// Ownership: every query filters on the signed-in user's id, so another
// user's project is indistinguishable from one that doesn't exist (404).
// Saving a proposal or an AI risk review is a Pro feature (requireEntitlement);
// reading saved work never is, so a lapsed subscription keeps its history.
// The AI results are stored as the app produced them; the budget and the
// deadline are only ever what the freelancer entered.
import express, { type RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { getAuth, type AuthModule } from "./auth.js";
import type { HandlerTracker } from "./gracefulShutdown.js";

export const PROJECT_STATUSES = ["LEAD", "ACTIVE", "COMPLETED", "ARCHIVED"] as const;
export const PROPOSAL_STATUSES = ["DRAFT", "SENT", "ACCEPTED", "REJECTED"] as const;

// Size caps for the stored JSON documents (well under the 100 kB body limit).
const MAX_ANALYSIS_BYTES = 32_000;
const MAX_PROPOSAL_BYTES = 80_000;
const MAX_REVIEW_BYTES = 40_000;

const NOT_FOUND = { error: "No such project.", code: "NOT_FOUND" } as const;

const Name = z.string().trim().min(1).max(120);
const ClientName = z.string().trim().max(120);
const Brief = z.string().trim().max(5000);
const Budget = z.number().finite().min(0).max(1_000_000_000).nullable();
const Currency = z.string().regex(/^[A-Z]{3}$/).nullable();
const Deadline = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "invalid date")
  .nullable();

const CreateSchema = z.object({
  name: Name,
  clientName: ClientName.default(""),
  brief: Brief.default(""),
  estimatedBudget: Budget.optional(),
  budgetCurrency: Currency.optional(),
  deadline: Deadline.optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
});

const UpdateSchema = z
  .object({
    name: Name.optional(),
    clientName: ClientName.optional(),
    brief: Brief.optional(),
    estimatedBudget: Budget.optional(),
    budgetCurrency: Currency.optional(),
    deadline: Deadline.optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
    proposalStatus: z.enum(PROPOSAL_STATUSES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "nothing to update");

const JsonObject = z.record(z.string(), z.unknown());
const AnalysisBody = z.object({ analysis: JsonObject });
const ProposalBody = z.object({ proposal: JsonObject });
const ReviewBody = z.object({
  review: z.object({
    fingerprint: z.string().min(1).max(200),
    findings: z.array(JsonObject).max(20),
    ranAt: z.string().max(40),
  }),
});

const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

// Columns returned to the client. DATE is formatted in SQL, so no time zone
// conversion can move the deadline by a day.
const DETAIL_COLUMNS = `
  id, name, client_name, brief, analysis, proposal, risk_review,
  estimated_budget::text AS estimated_budget, budget_currency,
  to_char(deadline, 'YYYY-MM-DD') AS deadline, status, proposal_status, created_at, updated_at`;

type ProjectRow = {
  id: string;
  name: string;
  client_name: string;
  brief: string;
  analysis: unknown;
  proposal: unknown;
  risk_review: unknown;
  estimated_budget: string | null;
  budget_currency: string | null;
  deadline: string | null;
  status: string;
  proposal_status: string | null;
  created_at: Date;
  updated_at: Date;
};

function summaryView(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    clientName: row.client_name,
    status: row.status,
    proposalStatus: row.proposal_status,
    estimatedBudget: row.estimated_budget,
    budgetCurrency: row.budget_currency,
    deadline: row.deadline,
    hasAnalysis: row.analysis !== null,
    hasProposal: row.proposal !== null,
    hasRiskReview: row.risk_review !== null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function detailView(row: ProjectRow) {
  return {
    ...summaryView(row),
    brief: row.brief,
    analysis: row.analysis,
    proposal: row.proposal,
    riskReview: row.risk_review,
  };
}

export type ProjectModuleOptions = {
  pool: Pool;
  auth: AuthModule;
  // The Pro gate from subscriptions.ts.
  requireEntitlement: RequestHandler;
  trackHandler?: HandlerTracker;
};

export function createProjectRouter(options: ProjectModuleOptions) {
  const { pool, auth } = options;
  const track: HandlerTracker = options.trackHandler ?? ((handler) => handler);
  const router = express.Router();
  // Writes need an allowed Origin, as for every cookie-authenticated route.
  router.use("/api/projects", auth.requireTrustedOrigin, auth.requireUser);

  const ProjectId = z.uuid();
  // Loads one of the signed-in user's projects, or undefined (also for an id
  // that is malformed or belongs to someone else).
  async function ownProject(userId: string, id: unknown): Promise<ProjectRow | undefined> {
    const parsed = ProjectId.safeParse(id);
    if (!parsed.success) return undefined;
    const result = await pool.query<ProjectRow>(
      `SELECT ${DETAIL_COLUMNS} FROM projects WHERE id = $1 AND user_id = $2`,
      [parsed.data, userId],
    );
    return result.rows[0];
  }

  router.get(
    "/api/projects",
    auth.requirePermission("proposal:read"),
    track(async (_req, res) => {
      const userId = getAuth(res)!.userId;
      const [projects, stats] = await Promise.all([
        pool.query<ProjectRow>(
          `SELECT ${DETAIL_COLUMNS} FROM projects WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 200`,
          [userId],
        ),
        pool.query<{ total: number; active: number; pending_proposals: number; completed: number }>(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
                  COUNT(*) FILTER (WHERE proposal_status IN ('DRAFT', 'SENT'))::int AS pending_proposals,
                  COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed
             FROM projects WHERE user_id = $1`,
          [userId],
        ),
      ]);
      const s = stats.rows[0]!;
      return res.json({
        projects: projects.rows.map(summaryView),
        stats: { total: s.total, active: s.active, pendingProposals: s.pending_proposals, completed: s.completed },
      });
    }),
  );

  router.post(
    "/api/projects",
    auth.requirePermission("proposal:create"),
    track(async (req, res) => {
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Give the project a name (1-120 characters) and check the other fields.", code: "INVALID_INPUT" });
      }
      const p = parsed.data;
      const result = await pool.query<ProjectRow>(
        `INSERT INTO projects (id, user_id, name, client_name, brief, estimated_budget, budget_currency, deadline, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${DETAIL_COLUMNS}`,
        [
          randomUUID(),
          getAuth(res)!.userId,
          p.name,
          p.clientName,
          p.brief,
          p.estimatedBudget ?? null,
          p.budgetCurrency ?? null,
          p.deadline ?? null,
          p.status ?? "LEAD",
        ],
      );
      return res.status(201).json({ project: detailView(result.rows[0]!) });
    }),
  );

  router.get(
    "/api/projects/:id",
    auth.requirePermission("proposal:read"),
    track(async (req, res) => {
      const project = await ownProject(getAuth(res)!.userId, req.params.id);
      return project ? res.json({ project: detailView(project) }) : res.status(404).json(NOT_FOUND);
    }),
  );

  // Updates the freelancer's own fields and the statuses. Columns are named
  // from a fixed list; values are always parameters.
  router.patch(
    "/api/projects/:id",
    auth.requirePermission("proposal:update"),
    track(async (req, res) => {
      const userId = getAuth(res)!.userId;
      const parsed = UpdateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Check the project fields.", code: "INVALID_INPUT" });
      const project = await ownProject(userId, req.params.id);
      if (!project) return res.status(404).json(NOT_FOUND);
      const fields = parsed.data;
      if (fields.proposalStatus !== undefined && project.proposal === null) {
        return res.status(409).json({ error: "Save a proposal before changing its status.", code: "NO_PROPOSAL" });
      }
      const columns: Record<keyof typeof fields, string> = {
        name: "name",
        clientName: "client_name",
        brief: "brief",
        estimatedBudget: "estimated_budget",
        budgetCurrency: "budget_currency",
        deadline: "deadline",
        status: "status",
        proposalStatus: "proposal_status",
      };
      const sets: string[] = [];
      const values: unknown[] = [project.id, userId];
      for (const [key, value] of Object.entries(fields) as Array<[keyof typeof fields, unknown]>) {
        values.push(value);
        sets.push(`${columns[key]} = $${values.length}`);
      }
      const result = await pool.query<ProjectRow>(
        `UPDATE projects SET ${sets.join(", ")}, updated_at = NOW()
          WHERE id = $1 AND user_id = $2 RETURNING ${DETAIL_COLUMNS}`,
        values,
      );
      return result.rows[0] ? res.json({ project: detailView(result.rows[0]) }) : res.status(404).json(NOT_FOUND);
    }),
  );

  // Saves a JSON document column after checking ownership and size.
  function saveDocument(
    column: "analysis" | "proposal" | "risk_review",
    maxBytes: number,
    extraSet = "",
  ): RequestHandler {
    return track(async (req, res) => {
      const userId = getAuth(res)!.userId;
      const body =
        column === "analysis" ? AnalysisBody.safeParse(req.body) : column === "proposal" ? ProposalBody.safeParse(req.body) : ReviewBody.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "The document is not in the expected format.", code: "INVALID_INPUT" });
      const value = column === "analysis" ? (body.data as { analysis: unknown }).analysis : column === "proposal" ? (body.data as { proposal: unknown }).proposal : (body.data as { review: unknown }).review;
      if (byteSize(value) > maxBytes) return res.status(413).json({ error: "The document is too large to save.", code: "TOO_LARGE" });
      const result = await pool.query<ProjectRow>(
        `UPDATE projects SET ${column} = $3::jsonb${extraSet}, updated_at = NOW()
          WHERE id = $1 AND user_id = $2 RETURNING ${DETAIL_COLUMNS}`,
        [ProjectId.safeParse(req.params.id).success ? req.params.id : "00000000-0000-0000-0000-000000000000", userId, JSON.stringify(value)],
      );
      return result.rows[0] ? res.json({ project: detailView(result.rows[0]) }) : res.status(404).json(NOT_FOUND);
    });
  }

  router.put("/api/projects/:id/analysis", auth.requirePermission("proposal:update"), saveDocument("analysis", MAX_ANALYSIS_BYTES));
  // A newly saved proposal starts as a draft; saving an edit keeps its status.
  router.put(
    "/api/projects/:id/proposal",
    auth.requirePermission("proposal:update"),
    options.requireEntitlement,
    saveDocument("proposal", MAX_PROPOSAL_BYTES, ", proposal_status = COALESCE(proposal_status, 'DRAFT')"),
  );
  router.put(
    "/api/projects/:id/risk-review",
    auth.requirePermission("proposal:review"),
    options.requireEntitlement,
    saveDocument("risk_review", MAX_REVIEW_BYTES),
  );

  return router;
}
