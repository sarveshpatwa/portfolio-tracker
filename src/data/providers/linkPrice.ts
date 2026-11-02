/**
 * Fetches a fund's daily price through your relay (relay/worker.js).
 * Parsing lives in the domain (pricing/priceLink.ts); this file only does the
 * network call and turns failures into plain-language messages.
 */

import { feedUrl, parseFeedPrice, relayRequestUrl, type FeedPrice } from '../../domain/pricing/priceLink';

export type LinkErrorKind = 'no-relay' | 'offline' | 'unreachable' | 'refused' | 'format';

export class LinkFetchError extends Error {
  constructor(
    readonly kind: LinkErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'LinkFetchError';
  }
}

export type FetchFn = (url: string) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>;

export async function fetchLinkPrice(
  relayUrl: string,
  template: string,
  fundId: string,
  fetchFn: FetchFn = (url) => fetch(url, { cache: 'no-store' }),
): Promise<FeedPrice> {
  if (!relayUrl.trim()) throw new LinkFetchError('no-relay', 'Set up the price relay in Settings → Price links.');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new LinkFetchError('offline', 'Offline.');

  let res: Awaited<ReturnType<FetchFn>>;
  try {
    res = await fetchFn(relayRequestUrl(relayUrl, feedUrl(template, fundId)));
  } catch {
    // A network failure and a blocked (CORS) answer look the same to a web page.
    throw new LinkFetchError(
      'unreachable',
      'Couldn’t reach your price relay. Check its address in Settings, and that the relay lists this app’s address.',
    );
  }
  const body = await res.text();
  if (!res.ok) {
    const relayMsg = relayMessage(body);
    if (relayMsg) throw new LinkFetchError('refused', `Relay: ${relayMsg}`);
    if (res.status === 404) throw new LinkFetchError('refused', `Vanguard has no price data for fund ${fundId} at the data address in Settings.`);
    throw new LinkFetchError('refused', `Vanguard refused the request (HTTP ${res.status}).`);
  }
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new LinkFetchError('format', 'Vanguard sent a web page instead of price data. The data address in Settings may have changed.');
  }
  const price = parseFeedPrice(data);
  if (!price) throw new LinkFetchError('format', 'Vanguard’s data didn’t include a price. The data address in Settings may have changed.');
  return price;
}

/** The relay answers its own errors as {"relayError": "..."}. */
function relayMessage(body: string): string | null {
  try {
    const j = JSON.parse(body) as unknown;
    if (j && typeof j === 'object' && typeof (j as { relayError?: unknown }).relayError === 'string') return (j as { relayError: string }).relayError;
  } catch {
    /* not JSON */
  }
  return null;
}
