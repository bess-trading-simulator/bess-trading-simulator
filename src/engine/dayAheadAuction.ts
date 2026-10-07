// GB day-ahead auction (EPEX 09:20 UK style): blind, uniform-price, HOURLY products.
//
// Each hour h covers SP 2h and 2h+1. The clearing price of the hour is the mean
// of the two half-hourly DA prices of the delivery day. The player is a price
// taker (a 50 MW battery does not move the GB clearing price).
// Pay-as-cleared: a filled order is settled at the CLEARING price, not its limit.

import type { AuctionResult, DayAheadBid, MarketDay } from './types';
import { OrderSide } from './types';
import type { TradePosition } from './ukMarket';

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
