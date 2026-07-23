// Deriv OAuth (authorisation code + PKCE).
//
// Security model, deliberately: this application holds NO credentials. The app
// ID is public by design and safe to ship in the bundle. Each user authorises
// against Deriv directly and Deriv returns a token scoped to their own account,
// held only in this browser tab's sessionStorage.
//
// A Personal Access Token must never appear in front-end code. Everything Vite
// compiles is downloadable by every visitor, so a PAT in the bundle is a PAT
// given away. PKCE exists precisely so a public client needs no secret.

const AUTH_BASE = 'https://auth.deriv.com/oauth2';
const API_BASE = 'https://api.deriv.com';

export const APP_ID = import.meta.env?.VITE_DERIV_APP_ID ?? '33Tp6JoLuPSaV66IPRpxZ';

/** Must match a redirect URI registered on the Deriv application, exactly. */
export const REDIRECT_URI =
  import.meta.env?.VITE_DERIV_REDIRECT_URI ??
  (typeof window !== 'undefined' ? window.location.origin : '');

const VERIFIER_KEY = 'deriv_pkce_verifier';
const STATE_KEY = 'deriv_oauth_state';
const TOKEN_KEY = 'deriv_access_token';

function randomString(bytes = 32) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64url(buffer);
}

export function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** S256 challenge: SHA-256 of the verifier, base64url encoded. */
export async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return base64url(new Uint8Array(digest));
}

/** Sends the user to Deriv to authorise. Returns nothing; the page navigates. */
export async function beginLogin() {
  const verifier = randomString();
  const state = randomString(16);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const params = new URLSearchParams({
    client_id: APP_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: 'S256',
  });

  window.location.assign(`${AUTH_BASE}/auth?${params}`);
}

/**
 * Handles the redirect back from Deriv. Returns the access token, or null when
 * this is an ordinary page load. Throws with Deriv's own message on failure, so
 * the reason is shown rather than swallowed.
 */
export async function completeLogin() {
  const url = new URL(window.location.href);
  const error = url.searchParams.get('error');
  if (error) {
    const description =
      url.searchParams.get('error_description') ?? 'no description given';
    clearQuery();
    throw new Error(`Deriv rejected the login: ${error} — ${description}`);
  }

  const code = url.searchParams.get('code');
  if (!code) return null;

  const returnedState = url.searchParams.get('state');
  const expectedState = sessionStorage.getItem(STATE_KEY);
  if (!expectedState || returnedState !== expectedState) {
    clearQuery();
    throw new Error('State mismatch — login discarded to prevent CSRF.');
  }

  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) {
    clearQuery();
    throw new Error('Missing PKCE verifier. Start the login again.');
  }

  // The exchange goes through our own /api/exchange relay because Deriv's
  // token endpoint does not answer cross-origin browser requests directly.
  const response = await fetch('/api/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: APP_ID,
      redirect_uri: REDIRECT_URI,
      code,
      code_verifier: verifier,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  clearQuery();
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);

  if (!response.ok || !payload.access_token) {
    throw new Error(
      payload.error_description ??
        payload.error ??
        `Token exchange failed (HTTP ${response.status})`,
    );
  }

  sessionStorage.setItem(TOKEN_KEY, payload.access_token);
  return payload.access_token;
}

function clearQuery() {
  window.history.replaceState({}, '', window.location.pathname);
}

export function storedToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function logout() {
  sessionStorage.removeItem(TOKEN_KEY);
}

function authHeaders(token) {
  return {
    'Deriv-App-ID': APP_ID,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/** The accounts this user holds, demo and real. Relayed to avoid CORS. */
export async function fetchAccounts(token) {
  let response;
  try {
    response = await fetch('/api/accounts', { headers: authHeaders(token) });
  } catch (error) {
    throw new Error(
      `Network error reaching the account relay: ${error.message}`,
    );
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload.error_description ??
        payload.message ??
        `Could not list accounts (HTTP ${response.status})`,
    );
  }
  const list = payload.accounts ?? payload.data ?? payload;
  return Array.isArray(list) ? list : [];
}

/**
 * Exchanges the token for an authenticated trading WebSocket URL.
 * Deriv issues this per account via a one-time-password endpoint.
 */
export async function openTradingSocketUrl(token, accountId) {
  const response = await fetch(
    `${API_BASE}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
    { method: 'POST', headers: authHeaders(token) },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload.message ?? `Could not open trading session (HTTP ${response.status})`,
    );
  }
  const url = payload.url ?? payload.websocket_url ?? payload.ws_url;
  if (!url) throw new Error('Trading session response contained no WebSocket URL.');
  return url;
}

/** True when the account is a demo/virtual one. Used to gate real-money trading. */
export function isDemo(account) {
  const id = String(
    account?.loginid ?? account?.account_id ?? account?.id ?? '',
  );
  const type = String(
    account?.account_type ?? account?.type ?? account?.account_category ?? '',
  ).toLowerCase();
  return (
    Boolean(account?.is_virtual) ||          // true, 1, '1'
    account?.demo === true ||
    type === 'demo' ||
    type === 'virtual' ||
    /^VR/i.test(id)
  );
}

/** Compact diagnostic view of an account object for on-screen debugging. */
export function accountSummary(account) {
  const keep = ['loginid', 'account_id', 'id', 'is_virtual', 'account_type', 'type', 'account_category', 'currency', 'demo'];
  const out = {};
  for (const key of keep) {
    if (account?.[key] !== undefined) out[key] = account[key];
  }
  return JSON.stringify(out);
}
