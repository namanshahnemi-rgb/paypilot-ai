// The provider badge must follow the backend's GET /api/health answer, and
// must not claim a provider when that answer is missing or unexpected.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { AI_PROVIDER_LABELS, fetchAiProvider, toAiProvider } from "./aiProvider.ts";

async function startServer(t: TestContext, status: number, body: string, type = "application/json") {
  const requested: string[] = [];
  const server = createServer((req, res) => {
    requested.push(`${req.method} ${req.url}`);
    res.writeHead(status, { "Content-Type": type });
    res.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requested };
}

const health = (aiProvider: unknown) =>
  JSON.stringify({ status: "ok", application: "PayPilot AI", aiProvider });

test("the backend's configured provider is read from GET /api/health", async (t) => {
  const gemini = await startServer(t, 200, health("Gemini"));
  assert.equal(await fetchAiProvider(gemini.url), "Gemini");
  assert.deepEqual(gemini.requested, ["GET /api/health"]);

  const ollama = await startServer(t, 200, health("Ollama"));
  assert.equal(await fetchAiProvider(ollama.url), "Ollama");
});

test("an unreachable backend, an error status, or a non-JSON reply gives unknown", async (t) => {
  assert.equal(await fetchAiProvider("http://127.0.0.1:9"), "unknown");

  const failing = await startServer(t, 503, health("Gemini"));
  assert.equal(await fetchAiProvider(failing.url), "unknown");

  const html = await startServer(t, 200, "<!DOCTYPE html><html></html>", "text/html");
  assert.equal(await fetchAiProvider(html.url), "unknown");
});

test("a missing or unrecognized provider gives unknown", () => {
  for (const value of [undefined, null, "", "gemini", "OpenAI", 42, {}]) {
    assert.equal(toAiProvider(value), "unknown");
  }
});

test("each provider has the expected badge", () => {
  assert.equal(AI_PROVIDER_LABELS.Gemini.badge, "CLOUD AI · GEMINI");
  assert.equal(AI_PROVIDER_LABELS.Ollama.badge, "LOCAL AI · OLLAMA");
  assert.equal(AI_PROVIDER_LABELS.unknown.badge, "AI PROVIDER UNKNOWN");
});

test("only the Ollama note claims local processing, and the Gemini note says data leaves", () => {
  assert.match(AI_PROVIDER_LABELS.Ollama.note, /local Ollama/);
  assert.doesNotMatch(AI_PROVIDER_LABELS.Gemini.note, /local|Ollama|no paid|never/i);
  assert.match(AI_PROVIDER_LABELS.Gemini.note, /sent to Google/);
  assert.doesNotMatch(AI_PROVIDER_LABELS.unknown.note, /local|Ollama|Gemini/i);
});

// Matches any wording that says the model or its data stays on this machine.
const LOCAL_CLAIM = /local|your computer|ollama|nothing is sent|never sent|no paid/i;

test("no Gemini or unknown message claims a local model or that data stays local", () => {
  for (const provider of ["Gemini", "unknown"] as const) {
    for (const [field, text] of Object.entries(AI_PROVIDER_LABELS[provider])) {
      assert.doesNotMatch(text, LOCAL_CLAIM, `${provider}.${field}: ${text}`);
    }
  }
});

test("unknown messages name no provider", () => {
  for (const [field, text] of Object.entries(AI_PROVIDER_LABELS.unknown)) {
    if (field === "badge") continue; // "AI PROVIDER UNKNOWN"
    assert.doesNotMatch(text, /gemini|google|ollama|cloud|local/i, `unknown.${field}: ${text}`);
  }
});

test("Gemini messages name Gemini, and the review intro says the proposal goes to Google", () => {
  for (const field of ["draftLoading", "reviewTag", "reviewIntro", "reviewLoading"] as const) {
    assert.match(AI_PROVIDER_LABELS.Gemini[field], /Gemini/, `Gemini.${field}`);
  }
  assert.match(AI_PROVIDER_LABELS.Gemini.reviewIntro, /sent to Google/);
});

test("Ollama keeps the existing wording", () => {
  assert.deepEqual(AI_PROVIDER_LABELS.Ollama, {
    badge: "LOCAL AI · OLLAMA",
    note: "Runs through your local Ollama model. No paid AI API required.",
    draftLoading: "The local model is writing a structured draft.",
    reviewTag: "Local model · recommendations",
    reviewIntro:
      "Ask the local model to look for ambiguous wording and commitments the automatic checks can't detect. Nothing is sent outside your computer.",
    reviewLoading: "Reviewing with the local model...",
  });
});

test("the neutral wording is used while the provider is unknown", () => {
  assert.equal(AI_PROVIDER_LABELS.unknown.draftLoading, "AI is writing a structured draft.");
  assert.match(AI_PROVIDER_LABELS.unknown.reviewIntro, /^Ask AI to review /);
  assert.equal(AI_PROVIDER_LABELS.unknown.reviewLoading, "Reviewing with AI...");
});
