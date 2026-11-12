import { useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  PROJECT_STATUS_LABELS,
  PROPOSAL_STATUS_LABELS,
  createProject,
  formatBudget,
  listProjects,
  parseBudget,
  type ProjectDetail,
  type ProjectStats,
  type ProjectSummary,
} from "./projects";

type Props = {
  apiUrl: string;
  refreshKey: number;
  // The brief in the workspace, offered as the new project's brief.
  workspaceBrief: string;
  // Whether a project created now keeps this tab's unsaved analysis and proposal.
  carriesUnsavedWork: boolean;
  // Open the new-project form straight away.
  startWithForm: boolean;
  // The project open in the workspace, marked on its card.
  currentProjectId: string | null;
  onOpen: (projectId: string) => void;
  onCreated: (project: ProjectDetail) => void;
  onSignIn: () => void;
};

// The freelancer's overview: pipeline numbers, the most recent projects and
// a form to start a new one. Everything comes from GET /api/projects.
export default function Dashboard({
  apiUrl,
  refreshKey,
  workspaceBrief,
  carriesUnsavedWork,
  startWithForm,
  currentProjectId,
  onOpen,
  onCreated,
  onSignIn,
}: Props) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "signed-out" | "error">("loading");
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(startWithForm);

  useEffect(() => {
    let cancelled = false;
    listProjects(apiUrl)
      .then((result) => {
        if (cancelled) return;
        setProjects(result.projects);
        setStats(result.stats);
        setState("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return setState("signed-out");
        setError(err instanceof Error ? err.message : "Could not load your projects.");
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [apiUrl, refreshKey]);

  if (state === "signed-out") {
    return (
      <section className="dashboard">
        <div className="empty-state">
          <h2>Your freelancer workspace</h2>
          <p>Sign in or create a free account to save client projects, proposals and risk reviews.</p>
          <button className="primary-button" type="button" onClick={onSignIn}>
            Sign in or create an account
          </button>
        </div>
      </section>
    );
  }

  const cards: Array<[string, number | undefined]> = [
    ["Total projects", stats?.total],
    ["Active projects", stats?.active],
    ["Pending proposals", stats?.pendingProposals],
    ["Completed", stats?.completed],
  ];

  return (
    <section className="dashboard" aria-labelledby="dashboard-heading">
      <div className="dashboard-heading">
        <div>
          <p className="eyebrow">OVERVIEW</p>
          <h1 id="dashboard-heading">Your project pipeline</h1>
        </div>
        <button className="primary-button" type="button" onClick={() => setShowForm((open) => !open)}>
          {showForm ? "Close" : "New project"}
        </button>
      </div>

      {showForm && (
        <NewProjectForm
          apiUrl={apiUrl}
          initialBrief={workspaceBrief}
          carriesUnsavedWork={carriesUnsavedWork}
          onCreated={(project) => {
            setShowForm(false);
            onCreated(project);
          }}
        />
      )}

      <div className="stat-grid">
        {cards.map(([label, value]) => (
          <div className="stat-card" key={label}>
            <span>{label}</span>
            <strong>{state === "loading" ? "…" : (value ?? 0)}</strong>
          </div>
        ))}
      </div>

      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}

      <h2 className="section-title">Recent projects</h2>
      {state === "ready" && projects.length === 0 && (
        <div className="empty-state">
          <p>No projects yet. Create one from a client brief to keep its analysis, proposal and review together.</p>
          {!showForm && (
            <button className="primary-button" type="button" onClick={() => setShowForm(true)}>
              Create your first project
            </button>
          )}
        </div>
      )}
      <div className="project-grid">
        {projects.map((project) => (
          <article className={project.id === currentProjectId ? "project-card current" : "project-card"} key={project.id}>
            <div className="project-card-top">
              {project.id === currentProjectId && <span className="status-tag status-open">Open in workspace</span>}
              <span className={`status-tag status-${project.status.toLowerCase()}`}>{PROJECT_STATUS_LABELS[project.status]}</span>
              {project.proposalStatus && (
                <span className={`status-tag proposal-${project.proposalStatus.toLowerCase()}`}>
                  Proposal: {PROPOSAL_STATUS_LABELS[project.proposalStatus]}
                </span>
              )}
            </div>
            <h3>{project.name}</h3>
            <p className="muted">{project.clientName || "No client name"}</p>
            <dl className="project-facts">
              <div>
                <dt>Budget</dt>
                <dd>{formatBudget(project) ?? "Not entered"}</dd>
              </div>
              <div>
                <dt>Deadline</dt>
                <dd>{project.deadline ?? "Not entered"}</dd>
              </div>
            </dl>
            <p className="project-progress">
              {[project.hasAnalysis && "Analysis", project.hasProposal && "Proposal", project.hasRiskReview && "Risk review"]
                .filter(Boolean)
                .join(" · ") || "Brief only"}
            </p>
            <div className="project-card-footer">
              <span className="muted">Updated {new Date(project.updatedAt).toLocaleDateString()}</span>
              <button className="secondary-button" type="button" onClick={() => onOpen(project.id)}>
                {project.id === currentProjectId ? "Continue" : "Open"}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function NewProjectForm({
  apiUrl,
  initialBrief,
  carriesUnsavedWork,
  onCreated,
}: {
  apiUrl: string;
  initialBrief: string;
  carriesUnsavedWork: boolean;
  onCreated: (project: ProjectDetail) => void;
}) {
  const [name, setName] = useState("");
  const [clientName, setClientName] = useState("");
  const [brief, setBrief] = useState(initialBrief);
  const [budget, setBudget] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [deadline, setDeadline] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const amount = parseBudget(budget);
    if (amount === "invalid") return setError("Enter the budget as a number, such as 800 or 1250.50, or leave it empty.");
    setBusy(true);
    setError("");
    try {
      onCreated(
        await createProject(apiUrl, {
          name: name.trim(),
          clientName: clientName.trim(),
          brief: brief.trim(),
          estimatedBudget: amount,
          budgetCurrency: amount === null ? null : currency,
          deadline: deadline || null,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the project.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel new-project-form" onSubmit={(event) => void submit(event)}>
      <h2>New project</h2>
      {carriesUnsavedWork && (
        <p className="muted">The unsaved analysis and proposal from your workspace will be saved into this project if you keep the same brief.</p>
      )}
      <label htmlFor="project-name">Project name</label>
      <input id="project-name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
      <label htmlFor="project-client">Client</label>
      <input id="project-client" maxLength={120} value={clientName} onChange={(e) => setClientName(e.target.value)} />
      <label htmlFor="project-brief">Client brief</label>
      <textarea id="project-brief" rows={5} maxLength={5000} value={brief} onChange={(e) => setBrief(e.target.value)} />
      <div className="form-row">
        <div>
          <label htmlFor="project-budget">Estimated budget (optional)</label>
          <input id="project-budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="e.g. 800" />
        </div>
        <div>
          <label htmlFor="project-currency">Currency</label>
          <select id="project-currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {["USD", "EUR", "GBP", "INR", "CAD", "AUD"].map((code) => (
              <option key={code}>{code}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="project-deadline">Deadline (optional)</label>
          <input id="project-deadline" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </div>
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <button className="primary-button" type="submit" disabled={busy || !name.trim()}>
        {busy ? "Creating…" : "Create project and open it"}
      </button>
    </form>
  );
}
