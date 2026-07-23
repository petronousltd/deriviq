// Relays the trading-session OTP request to Deriv server-side (CORS, as with
// the other relays). Forwards the user's own bearer token; stores nothing.
// The front end only ever calls this for demo accounts, and the account's
// virtual status is enforced again by Deriv itself when the token is scoped.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  const auth = req.headers.authorization ?? '';
  const appId = req.headers['deriv-app-id'] ?? '';
  const account = String(req.query?.account ?? '');
  if (!auth.startsWith('Bearer ') || !appId || !account) {
    res.status(401).json({
      error: 'unauthorized',
      error_description: 'Bearer token, Deriv-App-ID and account are required',
    });
    return;
  }

  try {
    const upstream = await fetch(
      `https://api.deriv.com/trading/v1/options/accounts/${encodeURIComponent(account)}/otp`,
      { method: 'POST', headers: { Authorization: auth, 'Deriv-App-ID': appId } },
    );
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
