// Serves Deriv's official endpoint documentation to the app, so that when the
// live server rejects every known request shape, the app can display the
// documented schema in its own connection log instead of guessing.
//
// Only a fixed set of documentation pages can be requested.

const PAGES = new Set([
  'ticks',
  'ticks-history',
  'active-symbols',
  'proposal',
  'buy',
  'websocket',
  'api-overview',
]);

export default async function handler(req, res) {
  const page = String(req.query?.page ?? '');
  if (!PAGES.has(page)) {
    res.status(400).json({ error: 'unknown_page', allowed: [...PAGES] });
    return;
  }

  try {
    const upstream = await fetch(
      `https://developers.deriv.com/llms/${page}.md`,
      { headers: { Accept: 'text/markdown, text/plain, */*' } },
    );
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(text.slice(0, 20000));
  } catch (error) {
    res.status(502).json({
      error: 'docs_fetch_failed',
      error_description: String(error?.message ?? error),
    });
  }
}
