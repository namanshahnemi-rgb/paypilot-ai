
import { useEffect, useRef, useState } from "react";
import "./App.css";
import ProposalEditor from "./ProposalEditor";
import ProposalRiskReview from "./ProposalRiskReview";
import AccountPanel from "./AccountPanel";
import Dashboard from "./Dashboard";
import {
  ApiError,
  PROJECT_STATUS_LABELS,
  PROPOSAL_STATUS_LABELS,
  describeUsage,
  fetchUsage,
  formatBudget,
  getProject,
  saveProjectDocument,
  updateProject,
  type ProjectDetail,
  type ProjectStatus,
  type ProposalStatus,
  type Usage,
} from "./projects";
import { accessProblem } from "./account";
import { requestJson } from "./api";
import {
  CHECKOUT_TOKEN_HEADER,
  forgetCheckout,
  isConfirmedPayment,
  readPaymentReturn,
  readSavedCheckout,
} from "./paymentFlow";
import { AI_PROVIDER_LABELS, fetchAiProvider, type AiProvider } from "./aiProvider";
import { syncSchedule, type AiReview } from "./riskReview";
import {
  loadSavedProposal,
  toEditableProposal,
  type EditableProposal,
  type ProposalDraft,
} from "./proposal";

type Risk = {
  issue: string;
  reason: string;
};

type Analysis = {
  deliverables: string[];
  timeline: string | null;
  budget: {
    amount: number | null;
    currency: string | null;
  };
  revisions: string | null;
  missing_terms: string[];
  risk_findings: Risk[];
  client_questions: string[];
};

// Order status as verified and recorded by the backend.
type OrderPaymentStatus = {
  orderID?: string;
  paymentStatus?:
    | "CREATED"
    | "PAID"
    | "PENDING"
    | "FAILED"
    | "NEEDS_REVIEW"
    | "UNKNOWN";
  paid?: boolean;
  orderStatus?: string | null;
  captureStatus?: string | null;
  amount?: string | null;
  currency?: string | null;
  message?: string;
  error?: string;
};

const API_URL = (
  import.meta.env.VITE_API_URL || "http://localhost:4000"
).replace(/\/$/, "");

type View = "dashboard" | "workspace" | "billing";
const PROJECT_STORAGE_KEY = "paypilot_project_id";

// A saved analysis is shown only if it has the shape this page renders.
function isAnalysis(value: unknown): value is Analysis {
  const a = value as Partial<Analysis> | null;
  return Boolean(
    a &&
      Array.isArray(a.deliverables) &&
      Array.isArray(a.missing_terms) &&
      Array.isArray(a.risk_findings) &&
      Array.isArray(a.client_questions) &&
      a.budget &&
      typeof a.budget === "object",
  );
}

function remember(key: string, value: unknown) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    // Storage unavailable: the page still works for this view.
  }
}

const exampleBrief =
  "A client wants a five-page business website with a contact form, mobile responsiveness, delivery in two weeks, two rounds of revisions, and a budget of $800.";

function App() {
  const [brief, setBrief] = useState(
    () => sessionStorage.getItem("paypilot_brief") ?? exampleBrief,
  );

  const [analysis, setAnalysis] = useState<Analysis | null>(() => {
    try {
      const saved = sessionStorage.getItem("paypilot_analysis");
      return saved ? (JSON.parse(saved) as Analysis) : null;
    } catch {
      return null;
    }
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Saved in sessionStorage so edits survive the PayPal checkout redirect.
  const [proposal, setProposal] = useState<EditableProposal | null>(() =>
    {
      // Bring a proposal saved with an out-of-date schedule summary up to date.
      const saved = loadSavedProposal(sessionStorage.getItem("paypilot_proposal"));
      return saved ? syncSchedule(saved) : null;
    },
  );
  const [proposalLoading, setProposalLoading] = useState(false);
  const [proposalError, setProposalError] = useState("");
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [paymentMessage, setPaymentMessage] = useState("");
  const [paymentError, setPaymentError] = useState("");
  const [recheckOrderID, setRecheckOrderID] = useState<string | null>(null);
  // Blocks a second checkout or capture request while one is running, even
  // before React re-renders the disabled button (for example, a fast double
  // click).
  const paymentRequestActive = useRef(false);
  // The backend's configured AI provider; "unknown" until /api/health answers.
  const [aiProvider, setAiProvider] = useState<AiProvider>("unknown");
  const providerLabels = AI_PROVIDER_LABELS[aiProvider];
  // Bumped when the server refuses an AI request for access reasons (signed
  // out, no active subscription), so the account panel reloads its state.
  const [accountRefresh, setAccountRefresh] = useState(0);

  // SaaS shell: the current view, the open project (if any) and plan usage.
  // Returning from a PayPal subscription approval opens the billing page,
  // where the account panel confirms the subscription with the server.
  const [view, setView] = useState<View>(() =>
    new URLSearchParams(window.location.search).has("subscription") ? "billing" : "dashboard",
  );
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [projectNotice, setProjectNotice] = useState("");
  const [projectError, setProjectError] = useState("");
  const [projectSaving, setProjectSaving] = useState(false);
  const [proposalDirty, setProposalDirty] = useState(false);
  // Opens the dashboard with the new-project form already showing.
  const [dashboardForm, setDashboardForm] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  // Bumped after anything that can change usage, the plan or the project list.
  const [dataRefresh, setDataRefresh] = useState(0);
  const refreshData = () => setDataRefresh((value) => value + 1);

  useEffect(() => {
    let active = true;
    fetchUsage(API_URL)
      .then((next) => {
        if (active) setUsage(next);
      })
      .catch(() => {
        if (active) setUsage(null);
      });
    return () => {
      active = false;
    };
  }, [dataRefresh, accountRefresh]);

  function adoptProject(next: ProjectDetail) {
    setProject(next);
    remember(PROJECT_STORAGE_KEY, next.id);
  }

  function closeProject() {
    setProject(null);
    setProposalDirty(false);
    setProjectNotice("");
    setProjectError("");
    remember(PROJECT_STORAGE_KEY, null);
    setBrief("");
    setAnalysis(null);
    setProposal(null);
    remember("paypilot_brief", null);
    remember("paypilot_analysis", null);
    remember("paypilot_proposal", null);
    setView("dashboard");
  }

  // Saves an edited brief without running the AI.
  async function saveBrief() {
    await saveToProject((target) => saveBriefIfChanged(target), "Brief saved.");
  }

  // Loads a saved project into the workspace: its brief, analysis, proposal
  // and saved risk review.
  async function openProject(id: string, options: { show?: boolean } = {}) {
    setProjectError("");
    setProjectNotice("");
    try {
      const saved = await getProject(API_URL, id);
      adoptProject(saved);
      setBrief(saved.brief);
      remember("paypilot_brief", saved.brief);
      const savedAnalysis = isAnalysis(saved.analysis) ? saved.analysis : null;
      setAnalysis(savedAnalysis);
      remember("paypilot_analysis", savedAnalysis);
      const savedProposal = saved.proposal ? loadSavedProposal(JSON.stringify(saved.proposal)) : null;
      const current = savedProposal ? syncSchedule(savedProposal) : null;
      setProposal(current);
      remember("paypilot_proposal", current);
      setProposalDirty(false);
      if (options.show !== false) setView("workspace");
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 401)) closeProject();
      setProjectError(err instanceof Error ? err.message : "Could not open the project.");
    }
  }

  // After a refresh or the PayPal redirect, reopen the project that was open.
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(PROJECT_STORAGE_KEY);
    } catch {
      saved = null;
    }
    // Reload the data only; the page keeps its current view.
    if (saved) void openProject(saved, { show: false });
    // Runs once on load.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Saves the brief first if it was edited, so the project keeps the brief
  // its AI results were produced from.
  async function saveBriefIfChanged(target: ProjectDetail): Promise<ProjectDetail> {
    const current = brief.trim();
    if (current === target.brief) return target;
    return updateProject(API_URL, target.id, { brief: current });
  }

  async function saveToProject(task: (target: ProjectDetail) => Promise<ProjectDetail>, notice: string) {
    if (!project) return;
    setProjectSaving(true);
    setProjectError("");
    try {
      const saved = await task(project);
      adoptProject(saved);
      setProjectNotice(notice);
      refreshData();
      return true;
    } catch (err) {
      setProjectError(accessProblemFor(err) ?? (err instanceof Error ? err.message : "Could not save to the project."));
      return false;
    } finally {
      setProjectSaving(false);
    }
  }

  function accessProblemFor(err: unknown): string | undefined {
    if (!(err instanceof ApiError)) return undefined;
    if (err.code === "SUBSCRIPTION_REQUIRED") return "Saving proposals and risk reviews is a Pro feature. Start the free trial on the Account & billing page.";
    return accessProblem(err.status, err.body);
  }

  async function saveProposal() {
    if (!proposal) return;
    const saved = await saveToProject(
      async (target) => saveProjectDocument(API_URL, (await saveBriefIfChanged(target)).id, "proposal", proposal),
      "Proposal saved.",
    );
    if (saved) setProposalDirty(false);
  }

  async function changeProjectStatus(changes: { status?: ProjectStatus; proposalStatus?: ProposalStatus }) {
    await saveToProject((target) => updateProject(API_URL, target.id, changes), "Status updated.");
  }

  function saveAiReview(review: AiReview) {
    void saveToProject((target) => saveProjectDocument(API_URL, target.id, "risk-review", review), "Risk review saved to the project.");
  }

  // A project created from the dashboard: if it was started from the brief in
  // the workspace, keep the analysis and proposal already made for it.
  async function projectCreated(created: ProjectDetail) {
    if (project || created.brief !== brief.trim() || (!analysis && !proposal)) {
      await openProject(created.id);
      refreshData();
      return;
    }
    adoptProject(created);
    setView("workspace");
    let latest = created;
    try {
      if (analysis) latest = await saveProjectDocument(API_URL, latest.id, "analysis", analysis);
      if (proposal) latest = await saveProjectDocument(API_URL, latest.id, "proposal", proposal);
      setProposalDirty(false);
      setProjectNotice("Project created with the current analysis and proposal.");
    } catch (err) {
      setProposalDirty(Boolean(proposal));
      setProjectError(accessProblemFor(err) ?? (err instanceof Error ? err.message : "Could not save everything to the project."));
    }
    adoptProject(latest);
    refreshData();
  }

  // The message for a refused AI request: the access reason when there is
  // one (the server decides access), otherwise the server error.
  function aiRequestError(response: Response, data: { error?: string }, fallback: string): Error {
    const problem = accessProblem(response.status, data);
    if (problem) setAccountRefresh((value) => value + 1);
    return new Error(problem ?? data.error ?? fallback);
  }

  useEffect(() => {
    let active = true;
    void fetchAiProvider(API_URL).then((provider) => {
      if (active) setAiProvider(provider);
    });
    return () => {
      active = false;
    };
  }, []);

  async function analyzeBrief() {
    setLoading(true);
    setError("");
    setAnalysis(null);
    sessionStorage.removeItem("paypilot_analysis");

    try {
      const { response, data } = await requestJson<{ analysis?: Analysis }>(
        `${API_URL}/api/proposals/analyze`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brief }),
        },
      );

      if (!response.ok || !data.analysis) {
        throw aiRequestError(response, data, "Analysis failed.");
      }

      const result = data.analysis;
      setAnalysis(result);
      sessionStorage.setItem("paypilot_analysis", JSON.stringify(result));
      sessionStorage.setItem("paypilot_brief", brief);
      if (project) {
        await saveToProject(
          async (target) => saveProjectDocument(API_URL, (await saveBriefIfChanged(target)).id, "analysis", result),
          "Analysis saved to the project.",
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not connect to the backend.",
      );
    } finally {
      setLoading(false);
      // Analyses count towards the monthly allowance.
      refreshData();
    }
  }

  function updateProposal(next: EditableProposal) {
    setProposal(next);
    try {
      sessionStorage.setItem("paypilot_proposal", JSON.stringify(next));
    } catch {
      // Storage full or unavailable: edits still work for this page view.
    }
  }

  async function generateProposal() {
    if (
      proposal &&
      !window.confirm("Replace the current proposal and your edits with a new draft?")
    ) {
      return;
    }

    setProposalLoading(true);
    setProposalError("");

    try {
      const { response, data } = await requestJson<{ proposal?: ProposalDraft }>(
        `${API_URL}/api/proposals/draft`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brief }),
        },
      );

      if (!response.ok || !data.proposal) {
        throw aiRequestError(response, data, "Could not draft the proposal.");
      }

      const draft = toEditableProposal(data.proposal, brief);
      updateProposal(draft);
      sessionStorage.setItem("paypilot_brief", brief);
      if (project) {
        const saved = await saveToProject(
          async (target) => saveProjectDocument(API_URL, (await saveBriefIfChanged(target)).id, "proposal", draft),
          "New proposal draft saved to the project.",
        );
        setProposalDirty(!saved);
      }
    } catch (err) {
      setProposalError(
        err instanceof Error ? err.message : "Could not connect to the backend.",
      );
    } finally {
      setProposalLoading(false);
    }
  }

  // Show the backend's verified status. The success message uses only the
  // amount and currency the backend reports; never frontend values.
  function showPaymentStatus(data: OrderPaymentStatus) {
    const confirmed = isConfirmedPayment(data);

    setPaymentMessage(
      confirmed
        ? `Sandbox payment completed successfully: ${data.currency} ${data.amount}.`
        : "",
    );
    setPaymentError(
      confirmed
        ? ""
        : (data.message ?? "PayPal has not confirmed completed payment."),
    );
    setRecheckOrderID(
      !confirmed &&
        data.orderID &&
        (data.paymentStatus === "UNKNOWN" || data.paymentStatus === "PENDING")
        ? data.orderID
        : null,
    );
  }

  // The backend doesn't know the order (for example, it was created against a
  // different server or database).
  function forgetUnknownOrder(message: string) {
    forgetCheckout(sessionStorage);
    setPaymentMessage("");
    setPaymentError(message);
    setRecheckOrderID(null);
  }

  // Capture an order the backend registered, or safely check it again.
  // Repeating this for the same order never creates a new order or a second
  // payment: the backend answers settled orders itself and reuses PayPal's
  // idempotent request for the rest. Only the tab that started the checkout
  // has its checkout token, which the backend requires.
  async function verifyPayment(orderID: string) {
    const saved = readSavedCheckout(sessionStorage);
    if (!saved || saved.orderID !== orderID) {
      forgetUnknownOrder(
        "This checkout can only be confirmed in the browser tab that started it. Start a new checkout.",
      );
      return;
    }
    if (paymentRequestActive.current) return;
    paymentRequestActive.current = true;
    setPaymentLoading(true);
    setPaymentMessage("Confirming your payment with PayPal...");
    setPaymentError("");
    setRecheckOrderID(null);

    try {
      const { response, data } = await requestJson<OrderPaymentStatus>(
        `${API_URL}/api/payments/capture-order`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderID, checkoutToken: saved.checkoutToken }),
        },
      );

      if (response.status === 404) {
        forgetUnknownOrder(data.error ?? "This order is not known to the server.");
        return;
      }

      if (!response.ok || !data.paymentStatus) {
        throw new Error(data.error ?? "Could not verify payment.");
      }

      showPaymentStatus(data);
    } catch (err) {
      setPaymentMessage("");
      setPaymentError(
        err instanceof Error ? err.message : "Could not verify payment.",
      );
      setRecheckOrderID(orderID);
    } finally {
      setPaymentLoading(false);
      paymentRequestActive.current = false;
    }
  }

  // After a page refresh, show the saved order's status. This only reads the
  // backend's record; it never captures.
  async function loadPaymentStatus(orderID: string, checkoutToken: string) {
    try {
      const { response, data } = await requestJson<OrderPaymentStatus>(
        `${API_URL}/api/payments/orders/${encodeURIComponent(orderID)}`,
        { headers: { [CHECKOUT_TOKEN_HEADER]: checkoutToken } },
      );

      if (response.status === 404) {
        forgetUnknownOrder(data.error ?? "This order is not known to the server.");
        return;
      }

      if (!response.ok) {
        throw new Error(data.error ?? "Could not load the payment status.");
      }

      // An order whose checkout never finished has nothing to report.
      if (data.paymentStatus !== "CREATED") {
        showPaymentStatus(data);
      }
    } catch (err) {
      setPaymentError(
        err instanceof Error ? err.message : "Could not load the payment status.",
      );
    }
  }

  useEffect(() => {
    const saved = readSavedCheckout(sessionStorage);
    const action = readPaymentReturn(window.location.search, saved?.orderID ?? null);

    if (action.kind === "cancelled") {
      forgetCheckout(sessionStorage);
      setPaymentMessage("");
      setPaymentError("PayPal checkout was cancelled. No payment was confirmed.");
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }

    if (action.kind === "none") {
      // Page refresh: recover the saved order's status from the backend.
      if (saved && action.recoverOrderID === saved.orderID) {
        void loadPaymentStatus(saved.orderID, saved.checkoutToken);
      }
      return;
    }

    // Clear the return parameters first, so a refresh (or React's development
    // double-run) recovers the status instead of starting another capture.
    window.history.replaceState({}, "", window.location.pathname);

    if (action.kind === "mismatch") {
      setPaymentError(
        "Could not verify the returned order. Please check your Sandbox order.",
      );
      return;
    }

    void verifyPayment(action.orderID);
  }, []);

  const navItems: Array<[View, string]> = [
    ["dashboard", "Dashboard"],
    ["workspace", project ? `Workspace · ${project.name.length > 18 ? `${project.name.slice(0, 17)}…` : project.name}` : "Workspace"],
    ["billing", "Account & billing"],
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Main navigation">
        <nav>
          {navItems.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={view === id ? "nav-item active" : "nav-item"}
              aria-current={view === id ? "page" : undefined}
              onClick={() => {
                setDashboardForm(false);
                setView(id);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="usage-meter" aria-live="polite">
          {usage ? (
            <>
              <strong>{usage.plan === "PRO" ? "Pro plan" : "Free plan"}</strong>
              <span>{describeUsage(usage).split(" · ")[1]}</span>
              <div className="usage-bar" role="progressbar" aria-valuemin={0} aria-valuemax={usage.analyses.limit} aria-valuenow={usage.analyses.used}>
                <div style={{ width: `${Math.min(100, (usage.analyses.used / usage.analyses.limit) * 100)}%` }} />
              </div>
              {usage.plan === "FREE" && (
                <button className="text-button" type="button" onClick={() => setView("billing")}>
                  Upgrade to Pro
                </button>
              )}
            </>
          ) : (
            <span className="muted">Sign in to see your plan.</span>
          )}
        </div>
      </aside>
    <main className="app">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark">P</span>
          PayPilot <span className="brand-ai">AI</span>
        </a>
        <span className="local-badge">{providerLabels.badge}</span>
      </header>

      {view === "dashboard" && (
        <Dashboard
          apiUrl={API_URL}
          refreshKey={dataRefresh + accountRefresh}
          workspaceBrief={project ? "" : brief}
          carriesUnsavedWork={!project && Boolean(analysis || proposal)}
          startWithForm={dashboardForm}
          currentProjectId={project?.id ?? null}
          onOpen={(id) => void openProject(id)}
          onCreated={(created) => void projectCreated(created)}
          onSignIn={() => setView("billing")}
        />
      )}

      {view === "billing" && (
        <section className="billing">
          <AccountPanel apiUrl={API_URL} refreshKey={accountRefresh} onAccountChange={refreshData} />
          <div className="plan-grid">
            <div className={usage?.plan === "FREE" ? "plan-card current" : "plan-card"}>
              <h3>Free</h3>
              <p className="plan-price">USD 0</p>
              <ul>
                <li>2 AI brief analyses per month</li>
                <li>Project workspace and saved project history</li>
              </ul>
            </div>
            <div className={usage?.plan === "PRO" ? "plan-card current" : "plan-card"}>
              <h3>Pro</h3>
              <p className="plan-price">7-day free trial, then USD 5.00/month</p>
              <ul>
                <li>30 AI brief analyses per month</li>
                <li>AI proposal drafting and AI risk reviews</li>
                <li>Saved proposals and risk reviews, with proposal status tracking</li>
              </ul>
            </div>
          </div>
          {usage && <p className="muted">{describeUsage(usage)}. Resets {new Date(usage.period.resetsAt).toLocaleDateString()}.</p>}
        </section>
      )}

      {view === "workspace" && (
      <>
      {project ? (
        <section className="project-bar" aria-label="Open project">
          <div>
            <p className="eyebrow">PROJECT</p>
            <h2>{project.name}</h2>
            <p className="muted">
              {project.clientName || "No client name"} · Budget: {formatBudget(project) ?? "not entered"} · Deadline:{" "}
              {project.deadline ?? "not entered"}
            </p>
          </div>
          <ol className="step-tracker" aria-label="Project steps">
            {[
              ["step-brief", "Client brief", brief.trim().length >= 20],
              ["step-analysis", "Scope analysis", Boolean(analysis) && project.hasAnalysis],
              ["step-proposal", "Proposal", project.hasProposal],
              ["step-review", "Risk review", project.hasRiskReview],
              ["step-status", "Project status", project.proposalStatus !== null && project.proposalStatus !== "DRAFT"],
            ].map(([target, label, done], index) => (
              <li key={String(target)} className={done ? "done" : undefined}>
                <button
                  type="button"
                  onClick={() => document.getElementById(String(target))?.scrollIntoView({ behavior: "smooth", block: "start" })}
                >
                  <span className="step-index" aria-hidden="true">{done ? "✓" : index + 1}</span>
                  {String(label)}
                  <span className="visually-hidden">{done ? " (done)" : " (to do)"}</span>
                </button>
              </li>
            ))}
          </ol>
          <div className="project-bar-controls" id="step-status">
            <p className="eyebrow">STEP 05 · PROJECT STATUS</p>
            <label>
              Project status
              <select
                value={project.status}
                disabled={projectSaving}
                onChange={(event) => void changeProjectStatus({ status: event.target.value as ProjectStatus })}
              >
                {Object.entries(PROJECT_STATUS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Proposal status
              <select
                value={project.proposalStatus ?? ""}
                disabled={projectSaving || !project.proposalStatus}
                onChange={(event) => void changeProjectStatus({ proposalStatus: event.target.value as ProposalStatus })}
              >
                {!project.proposalStatus && <option value="">Not saved yet</option>}
                {Object.entries(PROPOSAL_STATUS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="secondary-button"
              type="button"
              disabled={!proposal || !proposalDirty || projectSaving}
              onClick={() => void saveProposal()}
            >
              {projectSaving ? "Saving…" : proposalDirty ? "Save proposal" : project.proposalStatus ? "Proposal saved" : "No proposal yet"}
            </button>
            <button className="text-button" type="button" onClick={closeProject}>
              Close project
            </button>
          </div>
          {projectNotice && <p role="status">{projectNotice}</p>}
          {projectError && (
            <p className="error-message" role="alert">
              {projectError}
            </p>
          )}
        </section>
      ) : (
        <section className="empty-state workspace-empty">
          <div className="empty-icon">✳</div>
          <h2>No project is open</h2>
          <p>
            Each project keeps one client's brief, scope analysis, proposal and risk review together, saved to your
            account.
            {(analysis || proposal) && " This tab also has unsaved work; create a project to keep it."}
          </p>
          <div className="workspace-empty-actions">
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                setDashboardForm(true);
                setView("dashboard");
              }}
            >
              Create a project
            </button>
            <button className="secondary-button" type="button" onClick={() => setView("dashboard")}>
              Open a saved project
            </button>
          </div>
          {projectError && (
            <p className="error-message" role="alert">
              {projectError}
            </p>
          )}
        </section>
      )}
      </>
      )}

      {(paymentMessage || paymentError) && (
        <section className="payment-notice" aria-live="polite">
          {paymentMessage && <p role="status">{paymentMessage}</p>}
          {paymentError && (
            <p className="error-message" role="alert">
              {paymentError}
            </p>
          )}
          {recheckOrderID && (
            <button
              className="text-button"
              type="button"
              onClick={() => void verifyPayment(recheckOrderID)}
              disabled={paymentLoading}
            >
              Check payment status again
            </button>
          )}
        </section>
      )}

      {view === "workspace" && project && (
      <>
      <section className="workspace">
        <div className="panel brief-panel" id="step-brief">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">STEP 01</p>
              <h2>Client brief</h2>
            </div>
            <span className="step-number">01</span>
          </div>

          <label htmlFor="brief">Describe the project</label>
          <textarea
            id="brief"
            value={brief}
            onChange={(event) => {
              setBrief(event.target.value);
              sessionStorage.setItem("paypilot_brief", event.target.value);
            }}
            placeholder="Paste the client's project request..."
            rows={9}
            maxLength={5000}
          />

          {brief.trim() !== project.brief && (
            <p className="muted unsaved-note">
              The brief has unsaved edits.{" "}
              <button className="text-button" type="button" onClick={() => void saveBrief()} disabled={projectSaving}>
                Save brief
              </button>
            </p>
          )}

          <div className="input-footer">
            <span>{brief.length}/5000 characters</span>
            <button
              className="text-button"
              onClick={() => {
                setBrief(exampleBrief);
                sessionStorage.setItem("paypilot_brief", exampleBrief);
              }}
              type="button"
            >
              Load example
            </button>
          </div>

          <button
            className="primary-button"
            onClick={analyzeBrief}
            disabled={loading || brief.trim().length < 20}
            type="button"
          >
            {loading ? "Analyzing brief..." : "Analyze project scope"}
            {!loading && <span aria-hidden="true"> ↗</span>}
          </button>

          <button
            className="secondary-button"
            onClick={() => void generateProposal()}
            disabled={proposalLoading || brief.trim().length < 20}
            type="button"
          >
            {proposalLoading ? "Drafting proposal..." : "Generate proposal draft"}
          </button>

          <p className="privacy-note">{providerLabels.note}</p>

          {error && <p className="error-message">{error}</p>}
          {proposalError && <p className="error-message">{proposalError}</p>}
        </div>

        <div className="results-column" id="step-analysis">
          {!analysis && !loading && (
            <div className="empty-state">
              <div className="empty-icon">✳</div>
              <h2>Your scope report</h2>
              <p>
                Analyze a brief to reveal deliverables, missing terms, project
                risks and questions to ask the client.
              </p>
            </div>
          )}

          {loading && (
            <div className="empty-state">
              <div className="spinner" />
              <h2>Reviewing the project</h2>
              <p>Checking the brief against the required scope fields.</p>
            </div>
          )}

          {analysis && (
            <div className="report">
              <div className="report-heading">
                <div>
                  <p className="eyebrow">STEP 02 · SCOPE ANALYSIS</p>
                  <h2>Project analysis</h2>
                </div>
                <span className="status-pill">Analysis complete</span>
              </div>

              <div className="summary-grid">
                <div className="summary-card">
                  <span>Budget stated</span>
                  <strong>
                    {analysis.budget.amount == null
                      ? "Not specified"
                      : `${analysis.budget.currency ?? ""} ${analysis.budget.amount}`}
                  </strong>
                </div>
                <div className="summary-card">
                  <span>Timeline</span>
                  <strong>{analysis.timeline ?? "Not specified"}</strong>
                </div>
                <div className="summary-card">
                  <span>Revision terms</span>
                  <strong>{analysis.revisions ?? "Not specified"}</strong>
                </div>
              </div>

              <ReportSection
                title="Deliverables"
                items={analysis.deliverables}
              />
              <ReportSection
                title="Missing terms"
                items={analysis.missing_terms}
              />

              <section className="report-section">
                <h3>Risk findings</h3>
                {analysis.risk_findings.length === 0 ? (
                  <p className="muted">No risks were returned by the model.</p>
                ) : (
                  analysis.risk_findings.map((risk, index) => (
                    <div
                      className="risk-item"
                      key={`${risk.issue}-${index}`}
                    >
                      <strong>{risk.issue}</strong>
                      <p>{risk.reason}</p>
                    </div>
                  ))
                )}
              </section>

              <ReportSection
                title="Questions for the client"
                items={analysis.client_questions}
              />

              <p className="disclaimer">
                AI-generated review. Verify all terms before approving a
                proposal.
              </p>
            </div>
          )}
        </div>
      </section>

      {proposalLoading && (
        <section className="proposal-area">
          <div className="empty-state" role="status">
            <div className="spinner" />
            <h2>Drafting your proposal</h2>
            <p>
              {providerLabels.draftLoading} This can take up to a minute.
            </p>
          </div>
        </section>
      )}

      {!proposalLoading && proposal && (
        <>
          <div id="step-proposal">
          <ProposalEditor
            proposal={proposal}
            onChange={(next) => {
              updateProposal(next);
              if (project) setProposalDirty(true);
            }}
          />
          </div>
          <div id="step-review">
          <ProposalRiskReview
            key={project?.id ?? "scratch"}
            proposal={proposal}
            apiUrl={API_URL}
            aiProvider={aiProvider}
            savedReview={project ? ((project.riskReview as AiReview | null) ?? null) : undefined}
            onAiReview={project ? saveAiReview : undefined}
          />
          </div>
        </>
      )}
      </>
      )}
    </main>
    </div>
  );
}

function ReportSection({
  title,
  items,
}: {
  title: string;
  items: string[];
}) {
  return (
    <section className="report-section">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="muted">No items returned.</p>
      ) : (
        <ul>
          {items.map((item, index) => (
            <li key={`${item}-${index}`}>{item}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default App;
