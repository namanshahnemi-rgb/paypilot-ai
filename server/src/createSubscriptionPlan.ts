// One-time setup: creates the PayPilot AI product and the subscription plan
// (7-day free trial, then USD 5.00 every month) in the PayPal *Sandbox*
// account whose credentials are in server/.env, and prints the plan id to
// put in PAYPAL_SUBSCRIPTION_PLAN_ID.
//
//   cd server && npm run paypal:create-plan
//
// Run it once; each run creates a new product and plan. It never touches the
// live PayPal API (readPayPalBaseUrl refuses anything but the Sandbox), and it
// prints no credential.
import dotenv from "dotenv";
import { readPayPalBaseUrl } from "./config.js";
import { createProductAndPlan, fetchPlan, planProblems } from "./paypalSubscriptions.js";

dotenv.config({ quiet: true });

const baseUrl = readPayPalBaseUrl(process.env.PAYPAL_BASE_URL);
const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  console.error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in server/.env.");
  process.exit(1);
}

async function getAccessToken(): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`PayPal authentication failed: HTTP ${response.status}`);
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("PayPal did not return an access token.");
  return data.access_token;
}

const deps = { fetch, baseUrl, getAccessToken };
try {
  const { productId, planId } = await createProductAndPlan(deps);
  const problems = planProblems(await fetchPlan(deps, planId));
  console.log(`Created Sandbox product ${productId} and plan ${planId}.`);
  if (problems.length > 0) {
    console.error("The created plan does not match the offer:", problems);
    process.exit(1);
  }
  console.log(`Plan verified. Set PAYPAL_SUBSCRIPTION_PLAN_ID=${planId} in server/.env and on Render.`);
} catch (error) {
  console.error("Could not create the plan:", error instanceof Error ? error.message : "unknown error");
  process.exit(1);
}
