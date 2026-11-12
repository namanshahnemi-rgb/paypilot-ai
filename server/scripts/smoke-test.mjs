// Smoke test for a running PayPilot API. Read-only by default: it sends
// GET requests only, which never create orders, call PayPal, or call Gemini.
//
//   node scripts/smoke-test.mjs <base URL> [allowed origin]
//
// Set SMOKE_ALLOW_POST=1 to also check that a non-JSON POST to create-order
// is refused with 415. Only do that against a test container: an API from
// before the JSON-only rule would treat it as a real checkout.
const [base = "http://127.0.0.1:4000", allowedOrigin] = process.argv.slice(2);
const allowPost = process.env.SMOKE_ALLOW_POST === "1";

async function waitForApi() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`The API at ${base} did not answer /api/health within 60 seconds.`);
}

const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` (${detail})`}`);
}

await waitForApi();

const health = await fetch(`${base}/api/health`, allowedOrigin ? { headers: { Origin: allowedOrigin } } : {});
check("GET /api/health returns 200", health.status === 200, `HTTP ${health.status}`);
check("no X-Powered-By header", !health.headers.get("x-powered-by"));
check("X-Content-Type-Options: nosniff", health.headers.get("x-content-type-options") === "nosniff");
check("Strict-Transport-Security is set", Boolean(health.headers.get("strict-transport-security")));
check("Cache-Control: no-store", health.headers.get("cache-control") === "no-store");
if (allowedOrigin) {
  check(
    "CORS allows the configured frontend origin",
    health.headers.get("access-control-allow-origin") === allowedOrigin,
    String(health.headers.get("access-control-allow-origin")),
  );
}

const foreign = await fetch(`${base}/api/health`, { headers: { Origin: "https://smoke-test.invalid" } });
check("a foreign Origin is refused with 403", foreign.status === 403, `HTTP ${foreign.status}`);
check("a foreign Origin gets no CORS header", !foreign.headers.get("access-control-allow-origin"));

const noToken = await fetch(`${base}/api/payments/orders/SMOKETEST00000001`);
check("an order lookup without a checkout token is refused with 400", noToken.status === 400, `HTTP ${noToken.status}`);

const missing = await fetch(`${base}/smoke-test-unknown-route`);
check(
  "unknown routes get a JSON 404",
  missing.status === 404 && (missing.headers.get("content-type") ?? "").includes("application/json"),
  `HTTP ${missing.status}`,
);

if (allowPost) {
  const form = await fetch(`${base}/api/payments/create-order`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "{}",
  });
  check("a non-JSON POST to create-order is refused with 415", form.status === 415, `HTTP ${form.status}`);
}

const failed = results.filter((ok) => !ok).length;
console.log(failed === 0 ? `Smoke test passed (${results.length} checks).` : `Smoke test FAILED: ${failed} of ${results.length} checks.`);
process.exit(failed === 0 ? 0 : 1);
