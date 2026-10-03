import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

function CallbackContent() {
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState("processing");

  // Read here as well as inside the effect: the error panel is rendered by the
  // component, outside that closure, and reaching into it would be a ReferenceError.
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  useEffect(() => {
    const code = searchParams.get("code");
    const state = searchParams.get("state");

    const callbackData = {
      code,
      state,
      error,
      errorDescription,
      fullUrl: window.location.href,
    };

    const expectedOrigins = [
      window.location.origin,
      "http://localhost:1455", // Codex specific port
      "http://localhost:51121", // Antigravity specific port
    ];

    if (window.opener) {
      for (const origin of expectedOrigins) {
        try {
          window.opener.postMessage({ type: "oauth_callback", data: callbackData }, origin);
        } catch (e) {
          console.log("postMessage failed:", e);
        }
      }
    }

    try {
      const channel = new BroadcastChannel("oauth_callback");
      channel.postMessage(callbackData);
      channel.close();
    } catch (e) {
      console.log("BroadcastChannel failed:", e);
    }

    // The authorization code is a credential. Persisting it on every load of this route
    // left it readable by anything on the origin until the user cleared it by hand, so
    // it is written only when a code actually arrived.
    if (code) {
      try {
        localStorage.setItem("oauth_callback", JSON.stringify({ ...callbackData, timestamp: Date.now() }))
      } catch (e) {
        console.log("localStorage failed:", e)
      }
    }

    // A denied authorization arrives as ?error=... with no code. The old check was
    // `if (!(code || error))`, which let an error fall through to "success" -- pressing
    // Allow and then refusing at the provider showed a green tick.
    if (error) {
      setStatus("error")
      return
    }

    if (!code) {
      setTimeout(() => setStatus("manual"), 0)
      return
    }

    setStatus("success");
    setTimeout(() => {
      window.close();
      setTimeout(() => setStatus("done"), 500);
    }, 1500);
  }, [searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <div className="text-center p-8 max-w-md">
        {status === "processing" && (
          <>
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-primary animate-spin">progress_activity</span>
            </div>
            <h1 className="text-xl font-semibold mb-2">Processing...</h1>
            <p className="text-text-muted">Please wait while we complete the authorization.</p>
          </>
        )}

        {(status === "success" || status === "done") && (
          <>
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-green-600">check_circle</span>
            </div>
            <h1 className="text-xl font-semibold mb-2">Authorization Successful!</h1>
            <p className="text-text-muted">
              {status === "success" ? "This window will close automatically..." : "You can close this tab now."}
            </p>
          </>
        )}

        {status === "error" && (
          <>
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-red-600">cancel</span>
            </div>
            <h1 className="text-xl font-semibold mb-2">Authorization Failed</h1>
            <p className="text-text-muted">
              {errorDescription || error || "The provider refused the authorization."}
            </p>
          </>
        )}

        {status === "manual" && (
          <>
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-yellow-100 dark:bg-yellow-900/30 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-yellow-600">info</span>
            </div>
            <h1 className="text-xl font-semibold mb-2">Copy This URL</h1>
            <p className="text-text-muted mb-4">
              Please copy the URL from the address bar and paste it in the application.
            </p>
            <div className="bg-surface border border-border rounded-lg p-3 text-left">
              <code className="text-xs break-all">{typeof window !== "undefined" ? window.location.href : ""}</code>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function CallbackPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <div className="text-center p-8">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
            <span className="material-symbols-outlined text-3xl text-primary animate-spin">progress_activity</span>
          </div>
          <p className="text-text-muted">Loading...</p>
        </div>
      </div>
    }>
      <CallbackContent />
    </Suspense>
  );
}
