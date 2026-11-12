// fetch + JSON parsing for backend calls. Network failures and non-JSON
// responses become messages a user can act on, instead of the browser's raw
// "Failed to fetch" or a JSON SyntaxError.

export const SERVER_UNREACHABLE =
  "Cannot reach the PayPilot server. Check that the backend is running, then try again.";

export async function requestJson<T>(
  url: string,
  init?: RequestInit,
): Promise<{ response: Response; data: T & { error?: string } }> {
  let response: Response;
  try {
    // Sends the HttpOnly session cookie to the API, which is on another
    // origin. The backend only allows this for the origins in CLIENT_ORIGINS.
    response = await fetch(url, { credentials: "include", ...init });
  } catch {
    throw new Error(SERVER_UNREACHABLE);
  }

  try {
    return { response, data: (await response.json()) as T & { error?: string } };
  } catch {
    throw new Error(
      `The server sent an unexpected response (HTTP ${response.status}). Try again.`,
    );
  }
}
