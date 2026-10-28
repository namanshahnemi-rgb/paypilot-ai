// Regression tests: backend calls must not surface "Failed to fetch" or JSON
// SyntaxErrors to the user.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { SERVER_UNREACHABLE, requestJson } from "./api.ts";

async function startServer(t: TestContext, status: number, body: string, type: string) {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "Content-Type": type });
    res.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("an unreachable backend gives a clear message, not 'Failed to fetch'", async () => {
  await assert.rejects(requestJson("http://127.0.0.1:9/api/health"), {
    message: SERVER_UNREACHABLE,
  });
});

test("an HTML error page gives a clear message, not a JSON SyntaxError", async (t) => {
  const url = await startServer(t, 500, "<!DOCTYPE html><html><body>Error</body></html>", "text/html");
  await assert.rejects(requestJson(url), {
    message: "The server sent an unexpected response (HTTP 500). Try again.",
  });
});

test("JSON responses, including API errors, are returned for the caller to handle", async (t) => {
  const url = await startServer(t, 400, JSON.stringify({ error: "Provide a brief." }), "application/json");
  const { response, data } = await requestJson<{ analysis?: unknown }>(url);

  assert.equal(response.status, 400);
  assert.equal(data.error, "Provide a brief.");
});
