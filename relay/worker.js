/**
 * Vanguard price relay — a free Cloudflare Worker.
 *
 * Why it exists: browsers don't let a web app read data from another site
 * unless that site allows it (CORS). Vanguard doesn't, so the Portfolio
 * Tracker asks this relay, which fetches Vanguard's price data and hands it
 * back with permission for your app's address only.
 *
 * Safety:
 *  - Only fetches https://…vanguard.com addresses (it is not an open proxy).
 *  - Only answers web pages from ALLOWED_ORIGINS (your app), so other
 *    websites can't use your relay.
 *  - GET only, no cookies, nothing stored. It sees fund numbers, never your
 *    holdings.
 *  - Answers are cached for 15 minutes, so repeated requests don't reach Vanguard.
 *
 * Setup: see README → "Price links (Vanguard funds without a ticker)".
 * Free plan: 100,000 requests/day; the app uses a few per fund per day.
 */

// Your app's address(es). Add another line if you host the app elsewhere.
const ALLOWED_ORIGINS = [
  'https://sarveshpatwa.github.io',
  'http://localhost:5173', // npm run dev
  'http://localhost:4173', // npm run preview
];

const ALLOWED_HOST = /(^|\.)vanguard\.com$/i;
const MAX_BYTES = 1_000_000;

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
    }
    if (request.method !== 'GET') return error(405, 'Only GET is supported.', cors);
    if (!allowed) return error(403, `This relay doesn't serve ${origin || 'requests without an Origin'}. Add it to ALLOWED_ORIGINS.`, cors);

    const target = new URL(request.url).searchParams.get('url');
    let url;
    try {
      url = new URL(target || '');
    } catch {
      return error(400, 'Missing or invalid ?url= parameter.', cors);
    }
    if (url.protocol !== 'https:' || !ALLOWED_HOST.test(url.hostname)) {
      return error(400, 'Only https://…vanguard.com addresses are relayed.', cors);
    }

    let upstream;
    try {
      upstream = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: 'https://investor.vanguard.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        },
        cf: { cacheTtl: 900, cacheEverything: true },
      });
    } catch {
      return error(502, 'Couldn’t reach Vanguard.', cors);
    }
    const body = await upstream.text();
    if (body.length > MAX_BYTES) return error(502, 'Vanguard’s answer was unexpectedly large.', cors);
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...cors,
        'Content-Type': upstream.headers.get('Content-Type') || 'text/plain; charset=utf-8',
        'Cache-Control': 'max-age=900',
      },
    });
  },
};

function error(status, message, cors) {
  return new Response(JSON.stringify({ relayError: message }), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
