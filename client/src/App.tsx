
import { useEffect, useState } from "react";
import "./App.css";
import ProposalEditor from "./ProposalEditor";
import ProposalRiskReview from "./ProposalRiskReview";
import { requestJson } from "./api";
import { syncSchedule } from "./riskReview";
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

type PayPalOrder = {
  orderID?: string;
  amount?: string;
  currency?: string;
  approveUrl?: string;
  error?: string;
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

const API_URL = "http://localhost:4000";
const PAYMENT_AMOUNT = "5.00";
const PAYMENT_CURRENCY = "USD";

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
        throw new Error(data.error ?? "Analysis failed.");
      }

      const result = data.analysis;
      setAnalysis(result);
      sessionStorage.setItem("paypilot_analysis", JSON.stringify(result));
      sessionStorage.setItem("paypilot_brief", brief);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not connect to the backend.",
      );
    } finally {
      setLoading(false);
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
        throw new Error(data.error ?? "Could not draft the proposal.");
      }

      updateProposal(toEditableProposal(data.proposal, brief));
      sessionStorage.setItem("paypilot_brief", brief);
    } catch (err) {
      setProposalError(
        err instanceof Error ? err.message : "Could not connect to the backend.",
      );
    } finally {
      setProposalLoading(false);
    }
  }

  async function startPayPalCheckout() {
    setPaymentLoading(true);
    setPaymentMessage("");
    setPaymentError("");
    setRecheckOrderID(null);

    try {
      const { response, data } = await requestJson<PayPalOrder>(
        `${API_URL}/api/payments/create-order`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      if (!response.ok || !data.orderID || !data.approveUrl) {
        throw new Error(data.error ?? "Could not create PayPal order.");
      }

      sessionStorage.setItem("paypilot_order_id", data.orderID);
      window.location.assign(data.approveUrl);
    } catch (err) {
      setPaymentError(
        err instanceof Error ? err.message : "PayPal checkout failed.",
      );
      setPaymentLoading(false);
    }
  }

  // Show the backend's verified status. The success message uses only the
  // amount and currency the backend reports; never frontend values.
  function showPaymentStatus(data: OrderPaymentStatus) {
    const confirmed = Boolean(
      data.paymentStatus === "PAID" &&
        data.paid === true &&
        data.captureStatus === "COMPLETED" &&
        data.amount &&
        data.currency,
    );

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

  // The backend no longer knows the order (for example, after a restart).
  function forgetUnknownOrder(message: string) {
    sessionStorage.removeItem("paypilot_order_id");
    setPaymentMessage("");
    setPaymentError(message);
    setRecheckOrderID(null);
  }

  // Capture an order the backend registered, or safely check it again.
  // Repeating this for the same order never creates a new order or a second
  // payment: the backend answers settled orders itself and reuses PayPal's
  // idempotent request for the rest.
  async function verifyPayment(orderID: string) {
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
          body: JSON.stringify({ orderID }),
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
    }
  }

  // After a page refresh, show the saved order's status. This only reads the
  // backend's record; it never captures.
  async function loadPaymentStatus(orderID: string) {
    try {
      const { response, data } = await requestJson<OrderPaymentStatus>(
        `${API_URL}/api/payments/orders/${encodeURIComponent(orderID)}`,
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
    const params = new URLSearchParams(window.location.search);
    const paymentStatus = params.get("payment");
    const savedOrderID = sessionStorage.getItem("paypilot_order_id");

    if (paymentStatus === "cancel") {
      sessionStorage.removeItem("paypilot_order_id");
      setPaymentMessage("");
      setPaymentError("PayPal checkout was cancelled. No payment was confirmed.");
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }

    if (paymentStatus !== "return") {
      // Page refresh: recover the saved order's status from the backend.
      if (savedOrderID) void loadPaymentStatus(savedOrderID);
      return;
    }

    const returnedToken = params.get("token");

    // Clear the return parameters first, so a refresh (or React's development
    // double-run) recovers the status instead of starting another capture.
    window.history.replaceState({}, "", window.location.pathname);

    if (!savedOrderID || !returnedToken || returnedToken !== savedOrderID) {
      setPaymentError(
        "Could not verify the returned order. Please check your Sandbox order.",
      );
      return;
    }

    void verifyPayment(savedOrderID);
  }, []);

  return (
    <main className="app">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark">P</span>
          PayPilot <span className="brand-ai">AI</span>
        </a>
        <span className="local-badge">LOCAL AI · OLLAMA</span>
      </header>

      <section className="hero">
        <p className="eyebrow">FREELANCER WORKSPACE</p>
        <h1>
          Clear scope.
          <br />
          Confident payments.
        </h1>
        <p className="subtitle">
          Turn client requests into structured proposals. Find missing terms
          before approving work or requesting payment.
        </p>
      </section>

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

      <section className="workspace">
        <div className="panel brief-panel">
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

          <p className="privacy-note">
            Runs through your local Ollama model. No paid AI API required.
          </p>

          {error && <p className="error-message">{error}</p>}
          {proposalError && <p className="error-message">{proposalError}</p>}
        </div>

        <div className="results-column">
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
                  <p className="eyebrow">SCOPEGUARD REPORT</p>
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

              <section className="payment-panel">
                <p className="eyebrow">STEP 03</p>
                <h3>Test your checkout</h3>
                <p>
                  Create a {PAYMENT_CURRENCY} {PAYMENT_AMOUNT} PayPal Sandbox
                  order. This is a test payment, not a real charge.
                </p>

                <button
                  className="primary-button"
                  type="button"
                  onClick={startPayPalCheckout}
                  disabled={paymentLoading}
                >
                  {paymentLoading
                    ? "Processing..."
                    : `Continue with PayPal · ${PAYMENT_CURRENCY} ${PAYMENT_AMOUNT}`}
                </button>

                {paymentLoading && (
                  <p role="status">Waiting for PayPal...</p>
                )}
              </section>

              <p className="disclaimer">
                AI-generated review. Verify all terms before approving a
                proposal. Sandbox checkout is for testing only.
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
              The local model is writing a structured draft. This can take
              up to a minute.
            </p>
          </div>
        </section>
      )}

      {!proposalLoading && proposal && (
        <>
          <ProposalEditor proposal={proposal} onChange={updateProposal} />
          <ProposalRiskReview proposal={proposal} apiUrl={API_URL} />
        </>
      )}
    </main>
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
