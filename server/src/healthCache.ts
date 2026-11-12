// Caches the result of a health check that calls an outside service (PayPal's
// token endpoint, the Gemini API), so health requests can't be used to make
// the server call that service over and over. Within `ttlMs` every caller
// gets the last result, and concurrent callers share one check in progress.
export type HealthResult = { status: number; body: Record<string, unknown> };

export function createCachedCheck(
  run: () => Promise<HealthResult>,
  options: { ttlMs: number; now?: () => number },
): () => Promise<HealthResult> {
  const now = options.now ?? Date.now;
  let cached: { result: HealthResult; expiresAt: number } | undefined;
  let pending: Promise<HealthResult> | undefined;

  return () => {
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.result);
    pending ??= run()
      .catch(
        (): HealthResult => ({
          status: 503,
          body: { status: "error", message: "The health check could not run." },
        }),
      )
      .then((result) => {
        cached = { result, expiresAt: now() + options.ttlMs };
        return result;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
