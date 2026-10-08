// GB day-ahead auction (EPEX 09:20 UK style): blind, uniform-price, HOURLY products.
//
// Each hour h covers SP 2h and 2h+1. The clearing price of the hour is the mean
// of the two half-hourly DA prices of the delivery day. The player is a price
// taker (a 50 MW battery does not move the GB clearing price).
// Pay-as-cleared: a filled order is settled at the CLEARING price, not its limit.

import type { AuctionResult, BlockResult, DaBlockOrder, DayAheadBid, HalfHourBid, HalfHourResult, MarketDay } from './types';
import { OrderSide } from './types';
import type { TradePosition } from './ukMarket';
import { mulberry32 } from './ukMarket';

export const DA_HOURS = 24;

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function hourlyPrices(halfHourly: number[]): number[] {
  return Array.from({ length: DA_HOURS }, (_, h) => {
    const a = halfHourly[2 * h];
    const b = halfHourly[2 * h + 1];
    const vals = [a, b].filter((v) => Number.isFinite(v));
    return vals.length ? round2(vals.reduce((x, y) => x + y, 0) / vals.length) : 0;
  });
}

/** Does a limit order fill at this clearing price? */
export function bidFills(bid: Pick<DayAheadBid, 'side' | 'price'>, clearingPrice: number): boolean {
  return bid.side === OrderSide.BUY ? clearingPrice <= bid.price : clearingPrice >= bid.price;
}

/**
 * Clear the auction for `day`: returns per-hour results plus the DA positions
 * (two half-hour positions per filled hourly order, at the clearing price).
 */
export function clearHourlyAuction(
  bids: DayAheadBid[],
  day: MarketDay,
  clearedAt: number,
): { results: AuctionResult[]; positions: TradePosition[] } {
  const clearing = hourlyPrices(day.daClearing);
  const forecast = hourlyPrices(day.daForecast);
  const positions: TradePosition[] = [];
  const results: AuctionResult[] = [];

  for (let h = 0; h < DA_HOURS; h++) {
    const hourBids = bids.filter((b) => b.hour === h);
    let buyMw = 0, sellMw = 0, buyFilledMw = 0, sellFilledMw = 0;
    for (const b of hourBids) {
      const fills = bidFills(b, clearing[h]);
      if (b.side === OrderSide.BUY) { buyMw += b.volumeMw; if (fills) buyFilledMw += b.volumeMw; }
      else { sellMw += b.volumeMw; if (fills) sellFilledMw += b.volumeMw; }
      if (!fills) continue;
      for (const sp of [2 * h, 2 * h + 1]) {
        positions.push({
          period: sp,
          deliveryDay: day.day,
          market: 'da',
          action: b.side === OrderSide.BUY ? 'charge' : 'discharge',
          mw: b.volumeMw,
          price: clearing[h],
          lockedAt: clearedAt,
        });
      }
    }
    if (hourBids.length === 0) continue;
    results.push({
      hour: h,
      clearingPrice: clearing[h],
      forecastPrice: forecast[h],
      filledMw: sellFilledMw - buyFilledMw,
      buyMw,
      buyFilled: buyMw > 0 && buyFilledMw > 0,
      sellMw,
      sellFilled: sellMw > 0 && sellFilledMw > 0,
    });
  }
  return { results, positions };
}

/**
 * Validate a set of bids: volumes positive and per hour each side ≤ power rating.
 * Returns the cleaned bids (invalid ones dropped, volumes capped).
 */
export function sanitizeBids(bids: DayAheadBid[], powerMw: number): DayAheadBid[] {
  const used: Record<string, number> = {};
  const out: DayAheadBid[] = [];
  for (const b of bids) {
    if (!Number.isInteger(b.hour) || b.hour < 0 || b.hour >= DA_HOURS) continue;
    if (!Number.isFinite(b.price) || !Number.isFinite(b.volumeMw) || b.volumeMw <= 0) continue;
    const key = `${b.hour}:${b.side}`;
    const room = powerMw - (used[key] ?? 0);
    const mw = Math.min(b.volumeMw, room);
    if (mw <= 0) continue;
    used[key] = (used[key] ?? 0) + mw;
    out.push({ ...b, volumeMw: mw });
  }
  return out;
}

// ===== Block orders =====

export const MAX_BLOCKS = 80;

/** Clearing price of one SP in a given auction (hourly products: the hour's price). */
export function spClearingPrice(day: MarketDay, auction: 'hourly' | 'half', sp: number): number {
  if (auction === 'half') return day.daClearing[sp] ?? 0;
  const h = Math.floor(sp / 2);
  return hourlyPrices(day.daClearing)[h];
}

function blockAvg(block: DaBlockOrder, priceAt: (sp: number) => number): number {
  let sum = 0;
  for (let sp = block.startSp; sp <= block.endSp; sp++) sum += priceAt(sp);
  return round2(sum / (block.endSp - block.startSp + 1));
}

/** Surplus (£) of a block at given prices: how much better than its limit it would clear. */
export function blockSurplus(block: DaBlockOrder, avg: number): number {
  const mwh = block.volumeMw * 0.5 * (block.endSp - block.startSp + 1);
  return (block.side === OrderSide.BUY ? block.price - avg : avg - block.price) * mwh;
}

/** Validate a block against product rules. Returns an error message or null. */
export function validateBlock(block: Omit<DaBlockOrder, 'id'>, existing: DaBlockOrder[], powerMw: number): string | null {
  if (!(block.volumeMw > 0) || block.volumeMw > powerMw) return `Volume must be between 0 and ${powerMw} MW`;
  if (!Number.isFinite(block.price)) return 'Limit price required';
  if (block.startSp < 0 || block.endSp > 47 || block.endSp < block.startSp) return 'Invalid period range';
  if (block.auction === 'hourly' && (block.startSp % 2 !== 0 || block.endSp % 2 !== 1)) return 'Hourly blocks must cover whole hours';
  if (block.endSp - block.startSp < 1) return 'A block needs at least two periods';
  if (existing.filter(b => b.auction === block.auction).length >= MAX_BLOCKS) return `Max ${MAX_BLOCKS} blocks per auction`;
  if (block.parentId) {
    const parent = existing.find(b => b.id === block.parentId);
    if (!parent) return 'Parent block not found';
    if (parent.parentId) return 'Only one level of linking (parent → children)';
    if (parent.auction !== block.auction) return 'Parent must be in the same auction';
  }
  return null;
}

/**
 * Clear the block orders of one auction against the day's actual prices.
 * Families: a parent with its linked children. A parent is accepted if its own
 * surplus ≥ 0, or if parent + its profitable children together have surplus ≥ 0.
 * Children are only accepted with their parent and only if profitable.
 */
export function clearBlocks(
  blocks: DaBlockOrder[],
  day: MarketDay,
  auction: 'hourly' | 'half',
  clearedAt: number,
): { results: BlockResult[]; positions: TradePosition[] } {
  const mine = blocks.filter(b => b.auction === auction);
  const priceAt = (sp: number) => spClearingPrice(day, auction, sp);
  const results: BlockResult[] = [];
  const accepted = new Set<string>();
  const fmt = (v: number) => `£${v.toFixed(2)}`;

  for (const parent of mine.filter(b => !b.parentId)) {
    const children = mine.filter(b => b.parentId === parent.id);
    const pAvg = blockAvg(parent, priceAt);
    const pSur = blockSurplus(parent, pAvg);
    const kids = children.map(c => { const avg = blockAvg(c, priceAt); return { c, avg, sur: blockSurplus(c, avg) }; });
    const goodKids = kids.filter(k => k.sur >= 0);
    const family = pSur + goodKids.reduce((a, k) => a + k.sur, 0);
    const parentOk = pSur >= 0 || (goodKids.length > 0 && family >= 0);
    const cmp = (b: DaBlockOrder) => (b.side === OrderSide.BUY ? 'max' : 'min');
    results.push({
      id: parent.id, avgClearing: pAvg, accepted: parentOk,
      reason: pSur >= 0
        ? `Avg clearing ${fmt(pAvg)} meets your ${cmp(parent)} ${fmt(parent.price)}`
        : parentOk
          ? `Avg clearing ${fmt(pAvg)} misses your ${cmp(parent)} ${fmt(parent.price)} by £${Math.abs(pSur).toFixed(0)}, but linked children add £${(family - pSur).toFixed(0)} → family accepted`
          : `Avg clearing ${fmt(pAvg)} misses your ${cmp(parent)} ${fmt(parent.price)} → rejected${children.length ? ' (children rejected with it)' : ''}`,
    });
    if (parentOk) accepted.add(parent.id);
    for (const k of kids) {
      const ok = parentOk && k.sur >= 0;
      if (ok) accepted.add(k.c.id);
      results.push({
        id: k.c.id, avgClearing: k.avg, accepted: ok,
        reason: !parentOk
          ? `Parent ${parent.id} rejected → linked child can't be accepted`
          : ok ? `Avg clearing ${fmt(k.avg)} meets your ${cmp(k.c)} ${fmt(k.c.price)}`
            : `Avg clearing ${fmt(k.avg)} misses your ${cmp(k.c)} ${fmt(k.c.price)} → rejected`,
      });
    }
  }

  const positions: TradePosition[] = [];
  for (const b of mine) {
    if (!accepted.has(b.id)) continue;
    for (let sp = b.startSp; sp <= b.endSp; sp++) {
      positions.push({
        period: sp, deliveryDay: day.day, market: 'da',
        action: b.side === OrderSide.BUY ? 'charge' : 'discharge',
        mw: b.volumeMw, price: round2(priceAt(sp)), lockedAt: clearedAt,
      });
    }
  }
  return { results, positions };
}

// ===== EPEX GB 30-min auction (15:30 UK) =====

/**
 * Desk forecast per half-hour, made after the hourly auction cleared: the
 * hourly clearing price is known, so only the shape within each hour (and a
 * little level noise) is uncertain.
 */
export function buildHalfHourForecast(day: MarketDay, seed: number): number[] {
  const rng = mulberry32(seed + 3030);
  const hourly = hourlyPrices(day.daClearing);
  return day.daClearing.map((p, sp) => {
    const h = hourly[Math.floor(sp / 2)];
    const shapeKnown = 0.5 + rng() * 0.4; // part of the intra-hour shape the desk gets right
    const noise = (rng() + rng() + rng() - 1.5) * Math.max(1.5, Math.abs(p) * 0.025);
    return round2(h + (p - h) * shapeKnown + noise);
  });
}

/**
 * Validate 30-min orders: per SP and side, the position after this order may
 * not exceed the power rating. `netBySp` is the position already held from the
 * hourly auction (+ = sell): with 50 MW sold you may buy back up to 100 MW.
 */
export function sanitizeHalfHourBids(bids: HalfHourBid[], powerMw: number, netBySp: number[] = []): HalfHourBid[] {
  const used: Record<string, number> = {};
  const out: HalfHourBid[] = [];
  for (const b of bids) {
    if (!Number.isInteger(b.sp) || b.sp < 0 || b.sp > 47) continue;
    if (!Number.isFinite(b.price) || !Number.isFinite(b.volumeMw) || b.volumeMw <= 0) continue;
    const key = `${b.sp}:${b.side}`;
    const net = netBySp[b.sp] ?? 0;
    const room = b.side === OrderSide.SELL ? powerMw - net : powerMw + net;
    const mw = Math.min(b.volumeMw, room - (used[key] ?? 0));
    if (mw <= 0) continue;
    used[key] = (used[key] ?? 0) + mw;
    out.push({ ...b, volumeMw: mw });
  }
  return out;
}

export function clearHalfHourAuction(
  bids: HalfHourBid[],
  day: MarketDay,
  clearedAt: number,
): { results: HalfHourResult[]; positions: TradePosition[] } {
  const results: HalfHourResult[] = [];
  const positions: TradePosition[] = [];
  for (let sp = 0; sp < 48; sp++) {
    const spBids = bids.filter(b => b.sp === sp);
    if (spBids.length === 0) continue;
    const clearing = round2(day.daClearing[sp] ?? 0);
    let buyMw = 0, sellMw = 0, buyFilled = false, sellFilled = false;
    for (const b of spBids) {
      const fills = bidFills(b, clearing);
      if (b.side === OrderSide.BUY) { buyMw += b.volumeMw; buyFilled = buyFilled || fills; }
      else { sellMw += b.volumeMw; sellFilled = sellFilled || fills; }
      if (fills) {
        positions.push({
          period: sp, deliveryDay: day.day, market: 'da',
          action: b.side === OrderSide.BUY ? 'charge' : 'discharge',
          mw: b.volumeMw, price: clearing, lockedAt: clearedAt,
        });
      }
    }
    results.push({ sp, clearingPrice: clearing, forecastPrice: day.daForecastHH?.[sp] ?? clearing, buyMw, buyFilled, sellMw, sellFilled });
  }
  return { results, positions };
}
