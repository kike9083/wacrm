const FALLBACK_KEY = "cookieFallback";

/**
 * Appwrite 1.8+ delivers the session credential via the X-Fallback-Cookies
 * response header (a JSON map of `a_session_<projectId>` cookies), which the
 * web SDK stores verbatim in localStorage under 'cookieFallback' (sdk.js
 * prepareResponse). The session creation response body carries `secret: ""`,
 * so callers must read the credential from this fallback.
 *
 * The credential is the base64 envelope `{"id": "...", "secret": "..."}`.
 * The Appwrite REST API accepts the envelope itself in X-Appwrite-Session
 * (verified empirically against the server), so we return the envelope.
 */
export function getClientSessionSecret(): string | null {
  if (typeof window === "undefined") return null;
  const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID;
  if (!projectId) return null;

  const raw = window.localStorage.getItem(FALLBACK_KEY);
  if (!raw) return null;

  try {
    const fallback = JSON.parse(raw);
    const envelope = fallback[`a_session_${projectId}`];
    if (typeof envelope !== "string" || envelope.length < 16) return null;
    const payload = JSON.parse(atob(envelope));
    if (typeof payload.secret !== "string" || payload.secret.length < 16) {
      return null;
    }
    return envelope;
  } catch {
    return null;
  }
}
