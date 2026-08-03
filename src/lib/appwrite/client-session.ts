const SESSION_SECRET_KEY = 'wacrm_session_secret'

/**
 * Persists the Appwrite session secret (returned by the server-side login
 * routes, where Appwrite includes `secret` in the body because the request
 * carries an API key) so the web SDK can re-attach it on page loads via
 * `client.setSession()`. This replaces the cookieFallback/X-Fallback-Cookies
 * mechanism, which Appwrite 1.8.1 suppresses for same-registerable-domain
 * origins (e.g. app and API under *.fjueze.easypanel.host).
 */
export function persistClientSession(secret: string) {
  if (typeof window === 'undefined') return
  localStorage.setItem(SESSION_SECRET_KEY, secret)
}

export function clearClientSession() {
  if (typeof window === 'undefined') return
  localStorage.removeItem(SESSION_SECRET_KEY)
}

export function getClientSessionSecret(): string | null {
  if (typeof window === 'undefined') return null
  const secret = localStorage.getItem(SESSION_SECRET_KEY)
  return typeof secret === 'string' && secret.length >= 16 ? secret : null
}
