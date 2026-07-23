// Relays the authenticated accounts listing to Deriv server-side, for the same
// CORS reason as the token exchange. The bearer token comes from the user's own
// browser session and is forwarded, never stored.

export default async function handler(req, res) {
  const auth = req.headers.authorization ?? '';
  const appId = req.headers['deriv-app-id'] ?? '';
  if (!auth.startsWith('Bearer ') || !appId) {
    res.status(401).json({
      error: 'unauthorized',
      error_description: 'Authorization bearer token and Deriv-App-ID are required',
    });
    return;
  }

  try {
    const upstream = await fetch(
      'https://api.deriv.com/trading/v1/options/accounts',
      { headers: { Authorization: auth, 'Deriv-App-ID': appId } },
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
