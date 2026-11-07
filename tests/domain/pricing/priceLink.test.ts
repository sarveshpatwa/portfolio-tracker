import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEED_TEMPLATE,
  checkFeedTemplate,
  feedUrl,
  linkFetchDue,
  linkPricePoint,
  newestSettledDate,
  parseFeedPrice,
  parsePriceLink,
  relayRequestUrl,
  toIsoDate,
  toPrice,
} from '../../../src/domain/pricing/priceLink';
import { d } from '../../../src/domain/money/decimal';
import type { PricePoint } from '../../../src/domain/types';

const USER_LINK =
  'https://investor.vanguard.com/mutual-funds/profile/pe/overview/0066?dbOnly=false&crossover=false&planSummaryMask=425886&FundIntExt=INT&InstFund=false&RedemptionFee=true&intPort=0066&SelectedPlanId=093238';

describe('parsePriceLink', () => {
  it('finds the fund number in a Vanguard overview link', () => {
    const r = parsePriceLink(USER_LINK);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.link.fundId).toBe('0066');
      expect(r.link.url).toBe(USER_LINK);
    }
  });
  it('uses intPort when the path has no number', () => {
    const r = parsePriceLink('https://investor.vanguard.com/some/page?intPort=1695');
    expect(r.ok && r.link.fundId).toBe('1695');
  });
  it('accepts a bare fund number', () => {
    const r = parsePriceLink(' 0066 ');
    expect(r.ok && r.link.fundId).toBe('0066');
    expect(r.ok && r.link.url).toBe('');
  });
  it('accepts fund codes with a letter prefix (trust/plan funds), as typed or in a link', () => {
    expect(parsePriceLink('N467').ok && (parsePriceLink('N467') as { link: { fundId: string } }).link.fundId).toBe('N467');
    const typed = parsePriceLink(' n886 ');
    expect(typed.ok && typed.link.fundId).toBe('N886');
    const link = parsePriceLink('https://investor.vanguard.com/mutual-funds/profile/pe/overview/N467?intPort=N467&SelectedPlanId=093238');
    expect(link.ok && link.link.fundId).toBe('N467');
    expect(parsePriceLink('NAV').ok).toBe(false);
    expect(feedUrl('', 'N467')).toBe('https://api.vanguard.com/rs/ire/01/pe/fund/N467/price.json');
  });
  it('rejects non-Vanguard and non-https links, and junk', () => {
    expect(parsePriceLink('https://example.com/overview/0066').ok).toBe(false);
    expect(parsePriceLink('https://vanguard.com.evil.io/overview/0066').ok).toBe(false);
    expect(parsePriceLink('http://investor.vanguard.com/overview/0066').ok).toBe(false);
    expect(parsePriceLink('not a link').ok).toBe(false);
    expect(parsePriceLink('').ok).toBe(false);
    expect(parsePriceLink('https://investor.vanguard.com/home').ok).toBe(false);
  });
});

describe('feed and relay addresses', () => {
  it('fills the fund number into the template (default when empty)', () => {
    expect(feedUrl('', '0066')).toBe('https://api.vanguard.com/rs/ire/01/pe/fund/0066/price.json');
    expect(feedUrl('https://x.vanguard.com/f/{id}/p?id={id}', '12')).toBe('https://x.vanguard.com/f/12/p?id=12');
  });
  it('checks custom templates', () => {
    expect(checkFeedTemplate('')).toBeNull();
    expect(checkFeedTemplate(DEFAULT_FEED_TEMPLATE)).toBeNull();
    expect(checkFeedTemplate('https://api.vanguard.com/x.json')).toContain('{id}');
    expect(checkFeedTemplate('https://evil.com/{id}')).toContain('vanguard.com');
  });
  it('builds the relay request with the target encoded', () => {
    expect(relayRequestUrl('https://r.me.workers.dev/', 'https://api.vanguard.com/a?b=1')).toBe(
      'https://r.me.workers.dev/?url=https%3A%2F%2Fapi.vanguard.com%2Fa%3Fb%3D1',
    );
  });
});

describe('parseFeedPrice', () => {
  it('reads the shape used by Vanguard’s fund page', () => {
    const r = parseFeedPrice({
      currentPrice: {
        dailyPrice: {
          regular: { asOfDate: '2026-10-30T00:00:00-04:00', price: '1.00' },
          dailyMarketValue: { asOfDate: '2026-10-30T00:00:00-04:00', price: '0.99' },
        },
        yield: { yieldPct: '4.1' },
      },
    });
    expect(r?.date).toBe('2026-10-30');
    expect(r?.price.eq('1')).toBe(true);
  });
  it('falls back to market value, then to any price + date pair', () => {
    expect(parseFeedPrice({ currentPrice: { dailyPrice: { dailyMarketValue: { asOfDate: '10/29/2026', price: 25.5 } } } })?.date).toBe('2026-10-29');
    const deep = parseFeedPrice({ fund: { items: [{ label: 'x' }, { nav: '$1,234.56', effectiveDate: '2026-10-28' }] } });
    expect(deep?.price.eq('1234.56')).toBe(true);
    expect(deep?.date).toBe('2026-10-28');
  });
  it('returns null when there is no usable price', () => {
    expect(parseFeedPrice(null)).toBeNull();
    expect(parseFeedPrice('<html>')).toBeNull();
    expect(parseFeedPrice({ currentPrice: { dailyPrice: { regular: { price: '0', asOfDate: '2026-10-30' } } } })).toBeNull();
    expect(parseFeedPrice({ price: '1.00' })).toBeNull(); // no date
  });
  it('normalises prices and dates', () => {
    expect(toPrice('  $12.3456 ')?.eq('12.3456')).toBe(true);
    expect(toPrice(-1)).toBeNull();
    expect(toIsoDate('2026-02-30')).toBeNull();
    expect(toIsoDate('2/3/2026')).toBe('2026-02-03');
  });
});

describe('linkFetchDue', () => {
  const now = Date.UTC(2026, 10, 2, 12);
  it('is due when the newest price is older than the latest trading day', () => {
    expect(linkFetchDue('2026-10-29', undefined, now, '2026-10-30')).toBe(true);
    expect(linkFetchDue(undefined, undefined, now, '2026-10-30')).toBe(true);
  });
  it('is not due once the latest trading day’s price is stored', () => {
    expect(linkFetchDue('2026-10-30', undefined, now, '2026-10-30')).toBe(false);
  });
  it('waits 2 hours between attempts', () => {
    expect(linkFetchDue('2026-10-29', now - 3_600_000, now, '2026-10-30')).toBe(false);
    expect(linkFetchDue('2026-10-29', now - 2 * 3_600_000, now, '2026-10-30')).toBe(true);
  });
});

describe('linkPricePoint', () => {
  const fetched = { price: d('1.02'), date: '2026-10-30' };
  const at = '2026-10-31T00:00:00Z';
  it('stores a new fetched price as a link point', () => {
    expect(linkPricePoint([], 'F', fetched, at, '2026-10-31')).toEqual({ instrumentId: 'F', date: '2026-10-30', close: '1.02', source: 'link', updatedAt: at });
  });
  it('never replaces a price typed for the same date', () => {
    const typed: PricePoint = { instrumentId: 'F', date: '2026-10-30', close: '1.01', source: 'manual' };
    expect(linkPricePoint([typed], 'F', fetched, at, '2026-10-31')).toBeNull();
  });
  it('skips an identical fetched price, replaces a changed one', () => {
    const same: PricePoint = { instrumentId: 'F', date: '2026-10-30', close: '1.020', source: 'link' };
    expect(linkPricePoint([same], 'F', fetched, at, '2026-10-31')).toBeNull();
    expect(linkPricePoint([{ ...same, close: '1.00' }], 'F', fetched, at, '2026-10-31')?.close).toBe('1.02');
  });
  it('replaces a price typed before the link was set up, keeps one typed after', () => {
    const typed: PricePoint = { instrumentId: 'F', date: '2026-10-30', close: '1.01', source: 'manual', updatedAt: '2026-10-30T09:00:00Z' };
    expect(linkPricePoint([typed], 'F', fetched, at, '2026-10-31', '2026-10-30T12:00:00Z')?.close).toBe('1.02');
    expect(linkPricePoint([typed], 'F', fetched, at, '2026-10-31', '2026-10-30T08:00:00Z')).toBeNull();
  });
  it('newestSettledDate ignores prices typed before the link', () => {
    const pts: PricePoint[] = [
      { instrumentId: 'F', date: '2026-11-02', close: '1', source: 'manual', updatedAt: '2026-11-02T10:00:00Z' },
      { instrumentId: 'F', date: '2026-10-30', close: '1', source: 'link' },
    ];
    expect(newestSettledDate(pts, '2026-11-02T12:00:00Z')).toBe('2026-10-30');
    expect(newestSettledDate(pts, '2026-11-01T00:00:00Z')).toBe('2026-11-02');
    expect(newestSettledDate(pts)).toBe('2026-11-02');
  });
  it('ignores a date after today', () => {
    expect(linkPricePoint([], 'F', fetched, at, '2026-10-29')).toBeNull();
  });
});

describe('Vanguard price data — real response for fund 0066 (Nov 6, 2026)', async () => {
  const { parseFeedBody, parseFeedHistory, parseFeedYield } = await import('../../../src/domain/pricing/priceLink');
  const { VANGUARD_0066_JSONP: raw } = await import('../../fixtures/vanguard0066');
  const data = parseFeedBody(raw);

  it('unwraps the JSONP callback and still reads plain JSON', () => {
    expect(parseFeedPrice(data)).toEqual({ price: d('1.00'), date: '2026-11-06' });
    expect(parseFeedPrice(parseFeedBody('{"currentPrice":{"dailyPrice":{"regular":{"price":"2","asOfDate":"2026-11-06"}}}}'))?.date).toBe('2026-11-06');
  });
  it('reads the 7-day SEC yield from the footnote', () => {
    expect(parseFeedYield(data)).toEqual({
      pct: '3.89',
      date: '2026-11-05',
      compoundPct: '3.96',
      days: 7,
      note: 'AVERAGE ANNUALIZED INCOME DIVIDEND OVER THE PAST 7 DAYS',
    });
  });
  it('recognises a 30-day SEC yield (stable value / bond funds) and missing yields', () => {
    const y = parseFeedYield({ currentPrice: { yield: { asOfDate: '2026-10-31T00:00:00-04:00', yieldPct: '3.12', yieldNote: [{ footnoteText: '30-DAY SEC YIELD' }] } } });
    expect(y?.days).toBe(30);
    expect(parseFeedYield({ currentPrice: { dailyPrice: {} } })).toBeNull();
  });
  it('reads the recent price history, oldest first', () => {
    const h = parseFeedHistory(data);
    expect(h).toHaveLength(11);
    expect(h[0]!.date).toBe('2026-10-23');
    expect(h[10]!.date).toBe('2026-11-06');
  });
});
