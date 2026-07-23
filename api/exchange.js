// Relays the OAuth token exchange to Deriv server-side.
//
// Why this exists: browsers block cross-origin POSTs to token endpoints that
// don't send CORS headers, so the exchange must happen from a server. This
// function holds no secrets — PKCE provides the proof-of-possession — it only
// forwards the browser's own parameters and returns Deriv's response verbatim.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const { code, code_verifier, client_id, redirect_uri } = req.body ?? {};
  if (!code || !code_verifier || !client_id || !redirect_uri) {
    res.status(400).json({
      error: 'invalid_request',
      error_description:
        'code, code_verifier, client_id and redirect_uri are all required',
    });
    return;
  }

  try {
    const upstream = await fetch('https://auth.deriv.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id,
        redirect_uri,
        code,
        code_verifier,
      }),
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    try {
      res.json(JSON.parse(text));
    } catch {
      res.json({ error: 'bad_upstream', error_description: text.slice(0, 500) });
    }
  } catch (error) {
    res.status(502).json({
      error: 'relay_failed',
      error_description: String(error?.message ?? error),
    });
  }
}
