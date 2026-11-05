import { useMemo, useState } from "react";
import { requestJson } from "./api";
import { AI_PROVIDER_LABELS, type AiProvider } from "./aiProvider";
import type { EditableProposal } from "./proposal";
import {
  aiReviewStatus,
  proposalFingerprint,
  reviewedKey,
  runRiskChecks,
  sortFindings,
  summarizeFindings,
  toReviewRequest,
  type AiReview,
  type ReviewFinding,
} from "./riskReview";

type ProposalRiskReviewProps = {
  proposal: EditableProposal;
  apiUrl: string;
  aiProvider: AiProvider; // From GET /api/health; "unknown" names no provider.
};

const REVIEWED_STORAGE_KEY = "paypilot_reviewed_findings";
const AI_REVIEW_STORAGE_KEY = "paypilot_ai_review";

function loadReviewed(): Set<string> {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(REVIEWED_STORAGE_KEY) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((k) => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

function loadAiReview(): AiReview | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(AI_REVIEW_STORAGE_KEY) ?? "null") as AiReview | null;
    return saved && typeof saved.fingerprint === "string" && Array.isArray(saved.findings)
      ? saved
      : null;
  } catch {
    return null;
  }
}

function save(key: string, value: unknown) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: state still works for this page view.
  }
}

// Scroll to and focus the editor field a finding refers to.
function jumpToSection(sectionId: string) {
  const id = sectionId === "budget" ? "proposal-total" : `proposal-${sectionId}`;
  const field = document.getElementById(id);
  field?.scrollIntoView({ behavior: "smooth", block: "center" });
  field?.focus({ preventScroll: true });
}

function ProposalRiskReview({ proposal, apiUrl, aiProvider }: ProposalRiskReviewProps) {
  const providerLabels = AI_PROVIDER_LABELS[aiProvider];
  const [reviewed, setReviewed] = useState(loadReviewed);
  const [aiReview, setAiReview] = useState<AiReview | null>(loadAiReview);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");

  // Automatic checks are recalculated on every edit, so they are always current.
  const checks = useMemo(() => sortFindings(runRiskChecks(proposal)), [proposal]);
  const fingerprint = useMemo(() => proposalFingerprint(proposal), [proposal]);
  const aiStatus = aiReviewStatus(aiReview, fingerprint);
  // AI findings for an older version of the proposal are never shown as current.
  const aiFindings =
    aiStatus === "current" && aiReview ? sortFindings(aiReview.findings) : [];

  const isReviewed = (finding: ReviewFinding) =>
    reviewed.has(reviewedKey(proposal, finding));
  const summary = summarizeFindings([...checks, ...aiFindings], isReviewed);
  const canRunAi = (proposal.sourceBrief?.trim().length ?? 0) >= 20;

  function toggleReviewed(finding: ReviewFinding) {
    const key = reviewedKey(proposal, finding);
    const next = new Set(reviewed);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setReviewed(next);
    save(REVIEWED_STORAGE_KEY, [...next]);
  }

  async function runAiReview() {
    // Results are tied to the version that was sent; edits made while the
    // review runs make it stale.
    const requestFingerprint = fingerprint;
    setAiLoading(true);
    setAiError("");

    try {
      const { response, data } = await requestJson<{ findings?: ReviewFinding[] }>(
        `${apiUrl}/api/proposals/review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(toReviewRequest(proposal)),
        },
      );

      if (!response.ok || !Array.isArray(data.findings)) {
        throw new Error(data.error ?? "The AI review failed.");
      }

      const review: AiReview = {
        fingerprint: requestFingerprint,
        findings: data.findings,
        ranAt: new Date().toISOString(),
      };
      setAiReview(review);
      save(AI_REVIEW_STORAGE_KEY, review);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "Could not connect to the backend.");
    } finally {
      setAiLoading(false);
    }
  }

  const renderFindings = (findings: ReviewFinding[]) => (
    <div className="finding-list">
      {findings.map((finding) => (
        <FindingItem
          key={finding.id}
          finding={finding}
          reviewed={isReviewed(finding)}
          onToggle={() => toggleReviewed(finding)}
        />
      ))}
    </div>
  );

  return (
    <section className="proposal-area" aria-labelledby="risk-review-heading">
      <div className="report risk-review">
        <div className="report-heading">
          <div>
            <p className="eyebrow">BEFORE YOU SHARE</p>
            <h2 id="risk-review-heading">Proposal risk review</h2>
          </div>
          <span className="status-pill">Updates as you edit</span>
        </div>

        <div className="summary-grid" aria-label="Open findings by severity">
          {(["High", "Medium", "Low"] as const).map((severity) => (
            <div className={`summary-card risk-count risk-count-${severity.toLowerCase()}`} key={severity}>
              <span>{severity} severity</span>
              <strong>{summary[severity]} open</strong>
            </div>
          ))}
        </div>
        <p className="risk-meta">
          {summary.total === 0
            ? "No findings for the current proposal."
            : `${summary.reviewed} of ${summary.total} findings marked as reviewed by you.`}
        </p>
        <p className="muted">
          Findings are recommendations to support your own judgment, not legal
          advice. Marking a finding as reviewed records your check only; it is
          not client approval.
        </p>

        <div className="label-row">
          <h3>Automatic checks</h3>
          <span className="tag tag-from-brief">Current</span>
        </div>
        {checks.length === 0 ? (
          <p className="muted">The automatic checks found no issues.</p>
        ) : (
          renderFindings(checks)
        )}

        <div className="label-row">
          <h3>AI review</h3>
          <span className={`tag ${aiStatus === "stale" ? "tag-needs-confirmation" : "tag-suggested"}`}>
            {aiStatus === "stale" ? "Out of date" : providerLabels.reviewTag}
          </span>
        </div>

        {aiStatus === "none" && (
          <p className="muted">
            {providerLabels.reviewIntro} This can take up to a minute.
          </p>
        )}
        {aiStatus === "stale" && (
          <p className="money-check warn" role="status">
            The proposal changed after the last AI review, so its findings are
            hidden. Run the AI review again to check the current version.
          </p>
        )}
        {aiStatus === "current" && aiReview && (
          <>
            {aiFindings.length === 0 ? (
              <p className="muted">The AI review found no additional issues.</p>
            ) : (
              renderFindings(aiFindings)
            )}
            <p className="risk-meta">
              Reviewed the current version at{" "}
              {new Date(aiReview.ranAt).toLocaleTimeString()}.
            </p>
          </>
        )}

        {!canRunAi && (
          <p className="muted">
            The AI review needs the original brief. Generate the proposal again
            to enable it.
          </p>
        )}

        <button
          className="secondary-button risk-ai-button"
          type="button"
          onClick={() => void runAiReview()}
          disabled={aiLoading || !canRunAi}
        >
          {aiLoading
            ? providerLabels.reviewLoading
            : aiStatus === "none"
              ? "Run AI review"
              : "Run AI review again"}
        </button>

        {aiError && <p className="error-message">{aiError}</p>}
      </div>
    </section>
  );
}

function FindingItem({
  finding,
  reviewed,
  onToggle,
}: {
  finding: ReviewFinding;
  reviewed: boolean;
  onToggle: () => void;
}) {
  const severity = finding.severity.toLowerCase();
  return (
    <details
      className={`finding finding-${severity}${reviewed ? " is-reviewed" : ""}`}
      open={finding.severity === "High" && !reviewed}
    >
      <summary>
        <span className={`severity-badge severity-${severity}`}>{finding.severity}</span>
        <span className="finding-title">{finding.title}</span>
        {reviewed && <span className="tag tag-from-brief">Reviewed by you</span>}
      </summary>
      <div className="finding-body">
        <p className="finding-meta">
          {finding.category} · Basis: {finding.basis} ·{" "}
          {finding.source === "ai" ? "AI recommendation" : "Automatic check"}
        </p>
        <p>
          <strong>Why it matters:</strong> {finding.why}
        </p>
        <p>
          <strong>Suggested action:</strong> {finding.suggestion}
        </p>
        <div className="finding-actions">
          {finding.sectionId && (
            <button
              className="text-button"
              type="button"
              onClick={() => jumpToSection(finding.sectionId ?? "")}
            >
              Go to section
            </button>
          )}
          <label className="reviewed-toggle">
            <input type="checkbox" checked={reviewed} onChange={onToggle} />
            I've reviewed this (not client approval)
          </label>
        </div>
      </div>
    </details>
  );
}

export default ProposalRiskReview;
