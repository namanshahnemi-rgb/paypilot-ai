import { useState } from "react";
import {
  MONEY_AFTER_SECTION,
  checkMoneyRows,
  formatMoney,
  proposalFileName,
  toCents,
  totalMatchesBrief,
  toHtml,
  toMarkdown,
  toPlainText,
  type EditableProposal,
  type MoneyRow,
  type SectionTag,
} from "./proposal";
import { syncSchedule } from "./riskReview";

type ProposalEditorProps = {
  proposal: EditableProposal;
  onChange: (proposal: EditableProposal) => void;
};

// Download a generated file. Runs in the user's own browser; nothing is
// uploaded or sent anywhere.
function downloadFile(fileName: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// When another line of the field being typed in is rewritten (the schedule
// summary), keep the caret on the text the user is editing: positions after
// the rewritten part move by the change in length.
function keepCaret(field: HTMLTextAreaElement, before: string, after: string) {
  const caret = field.selectionStart;
  let prefix = 0;
  while (prefix < before.length && before[prefix] === after[prefix]) prefix++;
  const position = caret <= prefix ? caret : caret + (after.length - before.length);
  requestAnimationFrame(() => field.setSelectionRange(position, position));
}

function Tag({ tag }: { tag: SectionTag }) {
  const slug = tag.toLowerCase().replace(/[^a-z]+/g, "-");
  return <span className={`tag tag-${slug}`}>{tag}</span>;
}

function ProposalEditor({ proposal, onChange }: ProposalEditorProps) {
  const [actionMessage, setActionMessage] = useState("");

  const update = (patch: Partial<EditableProposal>) =>
    onChange({ ...proposal, ...patch });

  const updateSection = (id: string, text: string, field: HTMLTextAreaElement) => {
    const edited = {
      ...proposal,
      sections: proposal.sections.map((section) =>
        section.id === id ? { ...section, text } : section,
      ),
    };
    // Editing milestones recalculates the schedule summary, tag, and stored result.
    const next = id === MONEY_AFTER_SECTION ? syncSchedule(edited) : edited;
    onChange(next);
    const synced = next.sections.find((section) => section.id === id)?.text ?? text;
    if (synced !== text) keepCaret(field, text, synced);
  };

  async function copyProposal() {
    try {
      await navigator.clipboard.writeText(toPlainText(proposal));
      setActionMessage("Proposal copied to the clipboard as plain text.");
    } catch {
      setActionMessage(
        "Could not copy automatically. Download the Markdown file instead.",
      );
    }
  }

  return (
    <section className="proposal-area" aria-labelledby="proposal-heading">
      <div className="report proposal-editor">
        <div className="report-heading">
          <div>
            <p className="eyebrow">STEP 03 · PROPOSAL</p>
            <h2 id="proposal-heading">Proposal draft</h2>
          </div>
          <span className="status-pill">Draft · not sent</span>
        </div>

        <div className="proposal-warnings" role="note">
          <h3>Review before sharing</h3>
          <p>
            Live checks for missing terms, totals, and unrequested commitments
            are in the{" "}
            <button
              className="text-button"
              type="button"
              onClick={() =>
                document
                  .getElementById("risk-review-heading")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
            >
              proposal risk review
            </button>{" "}
            below.
          </p>
          {proposal.generationNotes.length > 0 && (
              <>
                <h3>Notes from the AI draft</h3>
                <ul>
                  {proposal.generationNotes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </>
            )}
        </div>

        <p className="tag-legend">
          <Tag tag="From brief" /> quoted from the brief
          <Tag tag="AI-extracted" /> AI reading of the brief; verify
          <Tag tag="Suggested" /> proposed terms
          <Tag tag="Needs confirmation" /> ask the client
        </p>

        <div className="label-row">
          <label htmlFor="proposal-title">Title</label>
        </div>
        <input
          id="proposal-title"
          value={proposal.title}
          maxLength={160}
          onChange={(event) => update({ title: event.target.value })}
        />

        <div className="label-row">
          <label htmlFor="proposal-summary">Executive summary</label>
          <Tag tag="AI-extracted" />
        </div>
        <textarea
          id="proposal-summary"
          rows={4}
          value={proposal.summary}
          onChange={(event) => update({ summary: event.target.value })}
        />

        {proposal.sections.map((section) => (
          <div key={section.id}>
            <div className="label-row">
              <label htmlFor={`proposal-${section.id}`}>{section.heading}</label>
              <Tag tag={section.tag} />
            </div>
            <textarea
              id={`proposal-${section.id}`}
              rows={Math.min(10, Math.max(3, section.text.split("\n").length + 1))}
              value={section.text}
              placeholder="Nothing returned by the AI. Add details or leave empty to omit."
              onChange={(event) => updateSection(section.id, event.target.value, event.target)}
            />

            {section.id === MONEY_AFTER_SECTION && (
              <>
                <div className="label-row">
                  <h3>Budget</h3>
                  <Tag tag={proposal.totalFromBrief ? "From brief" : "Needs confirmation"} />
                </div>
                <div className="money-block">
                  <div className="money-total">
                    <label htmlFor="proposal-currency">Currency</label>
                    <label htmlFor="proposal-total">Total</label>
                    <input
                      id="proposal-currency"
                      value={proposal.currency}
                      maxLength={3}
                      placeholder="USD"
                      onChange={(event) =>
                        update({ currency: event.target.value.toUpperCase() })
                      }
                    />
                    <input
                      id="proposal-total"
                      inputMode="decimal"
                      value={proposal.total}
                      placeholder="Unspecified"
                      onChange={(event) =>
                        update({
                          total: event.target.value,
                          totalFromBrief: totalMatchesBrief(proposal, event.target.value),
                        })
                      }
                    />
                  </div>
                  <MoneyRows
                    title="Budget line"
                    rows={proposal.budgetItems}
                    total={proposal.total}
                    currency={proposal.currency}
                    onChange={(budgetItems) => update({ budgetItems })}
                  />
                </div>

                <div className="label-row">
                  <h3>Payment schedule</h3>
                  <Tag tag="Suggested" />
                </div>
                <div className="money-block">
                  <MoneyRows
                    title="Payment"
                    rows={proposal.payments}
                    total={proposal.total}
                    currency={proposal.currency}
                    onChange={(payments) => update({ payments })}
                  />
                </div>
              </>
            )}
          </div>
        ))}

        <div className="proposal-actions">
          <button className="primary-button" type="button" onClick={() => void copyProposal()}>
            Copy to clipboard
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              downloadFile(
                proposalFileName(proposal, "md"),
                toMarkdown(proposal),
                "text/markdown;charset=utf-8",
              );
              setActionMessage("Markdown file downloaded.");
            }}
          >
            Download Markdown
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              downloadFile(
                proposalFileName(proposal, "html"),
                toHtml(proposal),
                "text/html;charset=utf-8",
              );
              setActionMessage(
                "HTML file downloaded. Open it in a browser to print or save as PDF.",
              );
            }}
          >
            Download HTML
          </button>
        </div>

        {actionMessage && (
          <p className="action-message" role="status">
            {actionMessage}
          </p>
        )}

        <p className="disclaimer">
          AI-assisted draft. Review every section before sharing. Suggested
          terms, estimates, and amounts are not agreed until the client
          confirms them. This is not legal advice. Generating or editing a
          proposal does not send it or charge anyone.
        </p>
      </div>
    </section>
  );
}

function MoneyRows({
  title,
  rows,
  total,
  currency,
  onChange,
}: {
  title: string;
  rows: MoneyRow[];
  total: string;
  currency: string;
  onChange: (rows: MoneyRow[]) => void;
}) {
  const totalCents = toCents(total);
  const check = checkMoneyRows(total, rows);

  const updateRow = (index: number, patch: Partial<MoneyRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  function shareText(row: MoneyRow): string {
    const cents = toCents(row.amount);
    if (cents !== null && totalCents) {
      return `${Math.round((cents / totalCents) * 100)}% of total`;
    }
    return row.suggestedPercent !== null ? `${row.suggestedPercent}% suggested` : "";
  }

  return (
    <>
      {rows.map((row, index) => (
        <div className="money-row" key={index}>
          <input
            aria-label={`${title} ${index + 1} description`}
            value={row.label}
            placeholder="Description"
            onChange={(event) => updateRow(index, { label: event.target.value })}
          />
          <input
            aria-label={`${title} ${index + 1} amount`}
            inputMode="decimal"
            value={row.amount}
            placeholder={totalCents === null ? "To be agreed" : "0.00"}
            onChange={(event) => updateRow(index, { amount: event.target.value })}
          />
          <span className="money-share">{shareText(row)}</span>
          <button
            className="text-button"
            type="button"
            aria-label={`Remove ${title.toLowerCase()} ${index + 1}`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </div>
      ))}

      <button
        className="text-button add-row"
        type="button"
        onClick={() =>
          onChange([...rows, { label: "", amount: "", suggestedPercent: null }])
        }
      >
        + Add {title.toLowerCase()}
      </button>

      {check.state === "ok" && (
        <p className="money-check">
          Adds up to the total of {formatMoney(check.totalCents, currency)}.
        </p>
      )}
      {check.state === "mismatch" && (
        <p className="money-check warn">
          Adds up to {formatMoney(check.sumCents, currency)}, but the total is{" "}
          {formatMoney(check.totalCents, currency)}.
        </p>
      )}
      {check.state === "invalid" && (
        <p className="money-check warn">Use numbers only, such as 250 or 250.50.</p>
      )}
      {check.state === "no-total" && (
        <p className="money-check warn">
          No total yet. Shares are suggestions until a total is agreed.
        </p>
      )}
    </>
  );
}

export default ProposalEditor;
