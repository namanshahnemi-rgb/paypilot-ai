import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  canStartSubscription,
  cancelSubscription,
  describeOffer,
  describeSubscription,
  DEFAULT_OFFER,
  fetchCurrentUser,
  fetchSubscription,
  readSubscriptionReturn,
  SessionNotKeptError,
  signInAndConfirm,
  signOut,
  startSubscription,
  syncSubscription,
  type SubscriptionState,
  type User,
} from "./account";
import { isPayPalApprovalUrl } from "./paymentFlow";

type Props = {
  apiUrl: string;
  // Changes when an AI request was refused for access reasons, so the panel
  // reloads what the server says about the account.
  refreshKey: number;
  // Called after the account or subscription changes (sign-in, sign-out,
  // a status read from PayPal), so the rest of the app can reload.
  onAccountChange?: () => void;
};

// Sign-in, registration and the PayPal subscription. Everything shown here
// comes from the backend; hiding or showing controls is only convenience,
// the backend enforces access on every request.
export default function AccountPanel({ apiUrl, refreshKey, onAccountChange }: Props) {
  const [user, setUser] = useState<User | null>(null);
  const [state, setState] = useState<SubscriptionState>({ subscription: null, offer: DEFAULT_OFFER });
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  // Blocks a second request while one runs, before React re-renders.
  const active = useRef(false);
  // The signed-in user as last confirmed by the server, for the refresh
  // effect to notice a session that has disappeared.
  const userRef = useRef<User | null>(null);
  // The latest callback, read by the load effect without re-running it.
  const onAccountChangeRef = useRef(onAccountChange);
  useEffect(() => {
    onAccountChangeRef.current = onAccountChange;
  }, [onAccountChange]);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  async function run(task: () => Promise<void>) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const returned = readSubscriptionReturn(window.location.search);
    if (returned.kind !== "none") {
      // Clear the PayPal parameters first, so a refresh doesn't repeat this.
      window.history.replaceState({}, "", window.location.pathname);
    }
    void (async () => {
      try {
        const current = await fetchCurrentUser(apiUrl);
        if (cancelled) return;
        setUser(current);
        if (!current) {
          if (returned.kind === "returned") setError("Sign in again to finish setting up your subscription.");
          return;
        }
        if (returned.kind === "cancelled") {
          setMessage("PayPal subscription checkout was cancelled. Nothing was set up.");
          setState(await fetchSubscription(apiUrl));
        } else if (returned.kind === "returned") {
          // The return URL proves nothing; the server asks PayPal.
          const synced = await syncSubscription(apiUrl, returned.subscriptionId);
          if (cancelled) return;
          setState(synced);
          setMessage(
            synced.subscription?.entitled
              ? "PayPal confirmed your subscription. The AI features are unlocked."
              : "PayPal has not confirmed the subscription yet. Select \"Check status\" in a moment.",
          );
        } else {
          setState(await fetchSubscription(apiUrl));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load your account.");
      } finally {
        if (!cancelled) {
          setLoaded(true);
          onAccountChangeRef.current?.();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiUrl]);

  useEffect(() => {
    if (refreshKey === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const current = await fetchCurrentUser(apiUrl);
        const next = current ? await fetchSubscription(apiUrl) : { subscription: null, offer: DEFAULT_OFFER };
        if (cancelled) return;
        if (userRef.current && !current) {
          // The server no longer recognises this browser: show the sign-in
          // form instead of an account that is not signed in.
          setMessage("");
          setError("You are not signed in any more (the session expired, was revoked, or the browser dropped its cookie). Sign in again.");
        }
        setUser(current);
        setState(next);
      } catch {
        // Keep what is shown; the next action reports any error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, refreshKey]);

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      setMessage("");
      let signedIn: User;
      try {
        // Shown as signed in only once the server confirms the session with
        // the cookie the browser kept.
        signedIn = await signInAndConfirm(apiUrl, mode, email.trim(), password);
      } catch (err) {
        setUser(null);
        if (err instanceof SessionNotKeptError) {
          setPassword("");
          // The account exists now; registering again would be refused.
          if (err.mode === "register") setMode("login");
        }
        throw err;
      }
      setPassword("");
      setUser(signedIn);
      setMessage(mode === "register" ? "Account created. You are signed in." : "Signed in.");
      setState(await fetchSubscription(apiUrl));
      onAccountChange?.();
    });
  }

  const subscription = state.subscription;
  const offerText = describeOffer(state.offer);

  if (!loaded) {
    return (
      <section className="account-panel" aria-busy="true">
        <p className="muted">Loading your account…</p>
      </section>
    );
  }

  return (
    <section className="account-panel" aria-labelledby="account-heading">
      <div className="account-heading">
        <div>
          <p className="eyebrow">ACCOUNT</p>
          <h2 id="account-heading">{user ? user.email : "Sign in to use the AI features"}</h2>
        </div>
        {user?.roles.includes("admin") && <span className="status-pill">ADMIN</span>}
      </div>

      {message && <p role="status">{message}</p>}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}

      {!user ? (
        <form className="account-form" onSubmit={submit}>
          <label htmlFor="account-email">Email</label>
          <input
            id="account-email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <label htmlFor="account-password">Password</label>
          <input
            id="account-password"
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
            minLength={mode === "register" ? 12 : 1}
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {mode === "register" && <p className="muted">At least 12 characters. Use a test address; there is no email verification.</p>}
          <button className="primary-button" type="submit" disabled={busy}>
            {mode === "login" ? "Sign in" : "Create account"}
          </button>
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError("");
            }}
          >
            {mode === "login" ? "New here? Create an account" : "Already have an account? Sign in"}
          </button>
        </form>
      ) : (
        <div className="account-subscription">
          <p>
            <strong>Subscription:</strong> {describeSubscription(subscription)}
            {subscription?.entitled && subscription.nextBillingTime && (
              <> · next billing {new Date(subscription.nextBillingTime).toLocaleDateString()}</>
            )}
          </p>
          <p className="muted">PayPilot AI Pro: {offerText}. Cancel any time.</p>
          {subscription && !subscription.entitled && subscription.status !== "APPROVAL_PENDING" && (
            <p className="error-message" role="alert">
              {subscription.status === "SUSPENDED"
                ? "The AI features are paused while the subscription is suspended."
                : "The AI features are locked until you subscribe again."}
            </p>
          )}
          <div className="account-actions">
            {canStartSubscription(subscription) && (
              <button
                className="primary-button"
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const approveUrl = await startSubscription(apiUrl);
                    // Only ever leave the app for a PayPal page.
                    if (!isPayPalApprovalUrl(approveUrl)) {
                      throw new Error("The server returned an unexpected approval address. Nothing was started.");
                    }
                    window.location.assign(approveUrl);
                  })
                }
              >
                {subscription?.status === "CANCELLED" || subscription?.status === "EXPIRED"
                  ? "Subscribe again with PayPal"
                  : `Start ${state.offer.trialDays}-day free trial with PayPal`}
              </button>
            )}
            {subscription && (
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const synced = await syncSubscription(apiUrl, null);
                    setState(synced);
                    setMessage(`PayPal reports: ${describeSubscription(synced.subscription)}.`);
                    onAccountChange?.();
                  })
                }
              >
                Check status
              </button>
            )}
            {subscription && ["ACTIVE", "APPROVED", "SUSPENDED"].includes(subscription.status) && (
              <button
                className="text-button"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm("Cancel the PayPilot AI subscription? The AI features stop immediately.")) return;
                  void run(async () => {
                    setState(await cancelSubscription(apiUrl));
                    setMessage("Subscription cancelled.");
                    onAccountChange?.();
                  });
                }}
              >
                Cancel subscription
              </button>
            )}
            <button
              className="text-button"
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await signOut(apiUrl);
                  setUser(null);
                  setState({ subscription: null, offer: state.offer });
                  setMessage("Signed out.");
                  onAccountChange?.();
                })
              }
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
