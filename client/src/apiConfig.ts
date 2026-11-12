// The backend base URL that every API request uses. VITE_API_URL is fixed at
// build time from client/.env.production (or a VITE_API_URL environment
// variable in the build environment). Only `npm run dev` falls back to the
// local backend; a production build without a valid URL is refused by
// vite.config.ts instead of quietly shipping http://localhost:4000.

export function resolveApiUrl(configured: string | undefined, devFallback?: string): string {
  const value = configured?.trim().replace(/\/+$/, "");
  if (value) return value;
  if (devFallback) return devFallback;
  throw new Error("VITE_API_URL was not set when this frontend was built.");
}

// Why a production API URL is unusable, or null when it is fine. Production
// needs https: the session cookie is Secure and SameSite=None.
export function productionApiUrlProblem(configured: string | undefined): string | null {
  const value = configured?.trim();
  if (!value) return "VITE_API_URL is not set";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "VITE_API_URL is not a valid URL";
  }
  if (url.protocol !== "https:") return "VITE_API_URL must use https in production";
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return "VITE_API_URL points at this computer, not the deployed backend";
  }
  return null;
}
