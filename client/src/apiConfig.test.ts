// Tests for the API base URL: the configured URL wins, only development falls
// back to the local backend, and a production build refuses unusable URLs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { productionApiUrlProblem, resolveApiUrl } from "./apiConfig.ts";

const RENDER = "https://paypilot-api-latest.onrender.com";

test("the configured URL is used, without trailing slashes or spaces", () => {
  assert.equal(resolveApiUrl(RENDER), RENDER);
  assert.equal(resolveApiUrl(`  ${RENDER}//  `, "http://localhost:4000"), RENDER);
});

test("development falls back to the local backend when no URL is configured", () => {
  assert.equal(resolveApiUrl(undefined, "http://localhost:4000"), "http://localhost:4000");
  assert.equal(resolveApiUrl("   ", "http://localhost:4000"), "http://localhost:4000");
});

test("without a configured URL or a development fallback it fails instead of guessing", () => {
  assert.throws(() => resolveApiUrl(undefined), /VITE_API_URL/);
  assert.throws(() => resolveApiUrl(""), /VITE_API_URL/);
});

test("a production build accepts an https backend URL", () => {
  assert.equal(productionApiUrlProblem(RENDER), null);
});

test("a production build refuses a missing, invalid, http or local URL", () => {
  assert.match(productionApiUrlProblem(undefined) ?? "", /not set/);
  assert.match(productionApiUrlProblem("  ") ?? "", /not set/);
  assert.match(productionApiUrlProblem("paypilot-api") ?? "", /not a valid URL/);
  assert.match(productionApiUrlProblem("http://paypilot-api-latest.onrender.com") ?? "", /https/);
  assert.match(productionApiUrlProblem("https://localhost:4000") ?? "", /this computer/);
  assert.match(productionApiUrlProblem("https://127.0.0.1:4000") ?? "", /this computer/);
});
