import { createAuthClient } from "better-auth/react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const authClient = createAuthClient();

type Account = { id: string; name: string; email: string };
type Setup = { googleSignIn: boolean; environment: string };

function App() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    new URLSearchParams(window.location.search).has("error")
      ? "Google sign-in was not completed. Please try again."
      : null,
  );

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const configuration = await fetch("/api/setup", {
          signal: controller.signal,
        });
        if (!configuration.ok) throw new Error("Setup unavailable");
        const state = (await configuration.json()) as Setup;
        setSetup(state);
        if (state.googleSignIn) {
          const response = await fetch("/api/me", {
            signal: controller.signal,
          });
          if (response.ok) {
            const result = (await response.json()) as { user: Account };
            setAccount(result.user);
          } else if (response.status !== 401) {
            throw new Error("Session unavailable");
          }
        }
      } catch {
        if (!controller.signal.aborted) {
          setError(
            "We could not connect to Outpredict. Please refresh to try again.",
          );
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  async function signIn() {
    setError(null);
    setBusy(true);
    try {
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: "/",
        errorCallbackURL: "/?error=sign-in",
      });
      if (result.error) throw new Error("Sign-in unavailable");
    } catch {
      setError("Google sign-in could not start. Please try again.");
      setBusy(false);
    }
  }

  async function signOut() {
    setError(null);
    setBusy(true);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("Sign-out unavailable");
      setAccount(null);
    } catch {
      setError("We could not sign you out. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header>
        <a className="wordmark" href="/" aria-label="Outpredict home">
          <span className="mark" aria-hidden="true">
            o
          </span>
          outpredict
        </a>
        <span className="preview">Early preview</span>
      </header>
      <main>
        <div className="eyebrow">YOUR NEXT CHAPTER, WITH EVIDENCE.</div>
        <h1>
          A clearer path to
          <br />
          medical school.
        </h1>
        <p className="intro">
          Free, data-driven admissions advice, built around your questions.
        </p>
        <section className="account-card" aria-labelledby="account-heading">
          {loading ? (
            <p role="status">Connecting to Outpredict…</p>
          ) : account ? (
            <>
              <div className="status">
                <span />
                Google account connected
              </div>
              <h2 id="account-heading">
                Welcome, {account.name.split(" ")[0]}.
              </h2>
              <p className="email">{account.email}</p>
              <p>
                Your account is ready. The admissions advisor is being built.
              </p>
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => void signOut()}
              >
                {busy ? "Signing out…" : "Sign out"}
              </button>
            </>
          ) : (
            <>
              <h2 id="account-heading">Welcome to Outpredict</h2>
              <p>Connect your Google account to get ready.</p>
              <button
                type="button"
                disabled={loading || busy || !setup?.googleSignIn}
                onClick={() => void signIn()}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  width="20"
                  height="20"
                >
                  <path
                    fill="currentColor"
                    d="M21.6 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.8 3-4.3 3-7.4ZM12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1a6 6 0 0 1-5.6-4.2H3.1v2.6A10 10 0 0 0 12 22ZM6.4 13.9a6 6 0 0 1 0-3.8V7.5H3.1a10 10 0 0 0 0 9l3.3-2.6ZM12 5.9c1.5 0 2.8.5 3.8 1.5l2.8-2.8A9.5 9.5 0 0 0 12 2a10 10 0 0 0-8.9 5.5l3.3 2.6A6 6 0 0 1 12 5.9Z"
                  />
                </svg>
                {busy ? "Opening Google…" : "Continue with Google"}
              </button>
              {setup && !setup.googleSignIn && (
                <p className="notice" role="status">
                  Google sign-in is being connected. Please check back soon.
                </p>
              )}
              <p className="footnote">
                This preview connects your account. Chat and applicant research
                are coming next.
              </p>
            </>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>
      </main>
      <footer>
        <span>Outpredict</span>
        <span>
          <a href="/privacy">Privacy</a> · <a href="/terms">Using Outpredict</a>
        </span>
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
