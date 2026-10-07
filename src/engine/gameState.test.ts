import { describe, it, expect } from 'vitest';
import {
  createGameState, loadMarketDays, loadScenario, submitDayAheadBids, stepForwardAction,
  chargeBatteryAction, placeIntradayOrderAction, intradayChargeAction,
} from './gameState';
import { OrderSide } from './types';
import type { GameState, MarketDay } from './types';
import { findEntry } from './settlement';
import { buildBook, isProductOpen } from './intradayBook';

const DAY = 86_400_000;
const D0 = Date.UTC(2026, 4, 20); // Wed 20 May 2026 (BST → gate 08:20 UTC)
const flat = (v: number) => new Array(48).fill(v);

function day(d: number, opts: Partial<MarketDay> = {}): MarketDay {
  return {
    day: d, source: 'synthetic',
    daForecast: flat(50), daClearing: flat(50), sipOutturn: flat(80), niv: flat(200),
    demandForecast: flat(30000), windForecast: flat(5000), solarForecast: flat(0),
    demandOutturn: flat(30000), windOutturn: flat(5000), solarOutturn: flat(0),
    ...opts,
  };
}

function fresh(today = day(D0), next = day(D0 + DAY)): GameState {
  return loadMarketDays(createGameState(), today, next);
}

/** Advance n half-hour ticks. */
function step(s: GameState, n: number): GameState {
  for (let i = 0; i < n; i++) s = stepForwardAction(s);
  return s;
}

/** Jump the clock (without ticking) to hh:mm UTC on the session's first day. */
function at(s: GameState, h: number, m: number): GameState {
  return { ...s, clock: { ...s.clock, currentTime: D0 + (h * 60 + m) * 60000 } };
}

describe('day-ahead auction (hourly, blind, pay-as-cleared)', () => {
  it('stores orders until gate closure — no positions before clearing', () => {
    const s = submitDayAheadBids(fresh(), [{ hour: 3, side: OrderSide.BUY, volumeMw: 20, price: 60 }]);
    expect(s.dayAhead.bids).toHaveLength(1);
    expect(s.dayAhead.playerSchedule).toHaveLength(0);
  });

  it('fills at the CLEARING price, not the limit; rejects orders whose limit is not met', () => {
    const next = day(D0 + DAY, { daClearing: flat(50).map((v, sp) => (sp >= 36 ? 120 : v)) });
    let s = fresh(day(D0), next);
    s = submitDayAheadBids(s, [
      { hour: 2, side: OrderSide.BUY, volumeMw: 50, price: 1000 },  // fills at 50
      { hour: 3, side: OrderSide.BUY, volumeMw: 50, price: 40 },    // 50 > 40 → no fill
      { hour: 18, side: OrderSide.SELL, volumeMw: 50, price: 100 }, // 120 ≥ 100 → fills at 120
    ]);
    s = step(s, 18); // past 08:20 UTC gate
    expect(s.dayAhead.isAuctionOpen).toBe(false);
    const pos = s.dayAhead.playerSchedule.filter(p => p.deliveryDay === D0 + DAY);
    expect(pos).toHaveLength(4); // 2 hours × 2 half-hours
    expect(pos.filter(p => p.action === 'charge').every(p => p.price === 50 && (p.period === 4 || p.period === 5))).toBe(true);
    expect(pos.filter(p => p.action === 'discharge').every(p => p.price === 120)).toBe(true);
    const r3 = s.dayAhead.results.find(r => r.hour === 3)!;
    expect(r3.buyFilled).toBe(false);
  });

  it('rejects orders after gate closure', () => {
    const s0 = at(fresh(), 9, 0);
    expect(submitDayAheadBids(s0, [{ hour: 1, side: OrderSide.BUY, volumeMw: 10, price: 99 }])).toBe(s0);
  });

  it('caps each side of an hour at the power rating', () => {
    let s = fresh();
    const P = s.battery.config.powerRatingMw;
    s = submitDayAheadBids(s, [{ hour: 1, side: OrderSide.BUY, volumeMw: P, price: 99 }]);
    s = submitDayAheadBids(s, [{ hour: 1, side: OrderSide.BUY, volumeMw: P, price: 99 }]);
    expect(s.dayAhead.bids.reduce((a, b) => a + b.volumeMw, 0)).toBe(P);
  });

  it('after midnight the auction day becomes today with its cleared prices', () => {
    const next = day(D0 + DAY, { daClearing: flat(77) });
    const s = step(fresh(day(D0), next), 48);
    expect(s.clock.currentTime).toBe(D0 + DAY);
    expect(s.dayAhead.forecastPrices[10]).toBe(77);
    expect(s.dayAhead.isAuctionOpen).toBe(true);
    expect(s.nextDay.day).toBe(D0 + 2 * DAY);
  });
});

describe('settlement: netting, delivery and imbalance', () => {
  it('nets DA and ID positions in the same SP — battery stays idle', () => {
    let s = fresh();
    const sp = 20;
    s = {
      ...s,
      dayAhead: {
        ...s.dayAhead,
        playerSchedule: [
          { period: sp, deliveryDay: D0, market: 'da', action: 'charge', mw: 50, price: 40, lockedAt: 0 },
          { period: sp, deliveryDay: D0, market: 'id', action: 'discharge', mw: 50, price: 55, lockedAt: 0 },
        ],
      },
    };
    const soc0 = s.battery.currentSocMwh;
    s = step(s, sp); // tick into SP 20 → delivery
    expect(s.battery.currentSocMwh).toBeCloseTo(soc0, 5);
    const e = findEntry(s.ledger, D0, sp)!;
    expect(e.contractedMw).toBe(0);
    expect(e.contractCash).toBeCloseTo(50 * 0.5 * (55 - 40), 5); // locked-in spread
  });

  it('undeliverable contract volume is settled as imbalance at SIP', () => {
    let s = fresh(day(D0, { sipOutturn: flat(300) }));
    s = { ...s, battery: { ...s.battery, currentSocMwh: 5, socPct: 5 } };
    const sp = 2;
    s = {
      ...s,
      dayAhead: {
        ...s.dayAhead,
        playerSchedule: [{ period: sp, deliveryDay: D0, market: 'da', action: 'discharge', mw: 50, price: 60, lockedAt: 0 }],
      },
    };
    s = step(s, sp + 1); // deliver SP2, then settle it
    const e = findEntry(s.ledger, D0, sp)!;
    expect(e.deliveredMw).toBeCloseTo(10, 5); // 5 MWh in half an hour
    expect(e.settled).toBe(true);
    expect(e.imbalanceMwh).toBeCloseTo(-20, 5); // short 40 MW × 0.5 h
    expect(e.imbalanceCash).toBeCloseTo(-20 * 300, 5);
  });

  it('a deliberate deviation is settled at the SIP after the SP', () => {
    let s = step(fresh(day(D0, { sipOutturn: flat(-20) })), 10);
    s = chargeBatteryAction(s, 30); // charge into a long system with negative SIP
    const e0 = findEntry(s.ledger, D0, 10)!;
    expect(e0.deviationMw).toBe(-30);
    expect(e0.settled).toBe(false);
    s = step(s, 1);
    const e = findEntry(s.ledger, D0, 10)!;
    expect(e.imbalanceMwh).toBe(-15);
    expect(e.imbalanceCash).toBe(300); // paid to charge
  });
});

describe('intraday continuous order book', () => {
  it('market buy walks the asks and pays at least the best ask', () => {
    const s = at(fresh(), 6, 0);
    const book = buildBook(s, D0, 30)!;
    const r = intradayChargeAction(s, 30, 40);
    const fills = r.intraday.fills;
    expect(fills.length).toBeGreaterThan(0);
    expect(Math.min(...fills.map(f => f.price))).toBeGreaterThanOrEqual(book.asks[0].price);
    const pos = r.dayAhead.playerSchedule.filter(p => p.market === 'id');
    expect(pos.reduce((a, p) => a + p.mw, 0)).toBeCloseTo(fills.reduce((a, f) => a + f.mw, 0), 5);
  });

  it('FOK larger than the book is cancelled with nothing filled', () => {
    const s = at(fresh(), 6, 0);
    const book = buildBook(s, D0, 30)!;
    const r = placeIntradayOrderAction(s, { deliveryDay: D0, period: 30, side: OrderSide.BUY, type: 'fok', qtyMw: 50, limitPrice: book.asks[0].price });
    const o = r.intraday.orders.at(-1)!;
    if (book.asks[0].mw < 50) {
      expect(o.status).toBe('cancelled');
      expect(r.intraday.fills).toHaveLength(0);
    }
  });

  it('a passive limit order rests and expires at gate closure (T-60)', () => {
    let s = at(fresh(), 6, 0);
    const book = buildBook(s, D0, 20)!; // SP 20 = 10:00, gate 09:00
    s = placeIntradayOrderAction(s, { deliveryDay: D0, period: 20, side: OrderSide.BUY, type: 'limit', qtyMw: 10, limitPrice: book.bids[0].price - 40 });
    expect(s.intraday.orders.at(-1)!.status).toBe('working');
    s = step(s, 6); // → 09:00
    const o = s.intraday.orders.at(-1)!;
    expect(o.status).toBe('expired');
  });

  it('rejects orders beyond the power rating and on closed products', () => {
    const s = at(fresh(), 6, 0);
    const big = placeIntradayOrderAction(s, { deliveryDay: D0, period: 30, side: OrderSide.SELL, type: 'market', qtyMw: 999 });
    expect(big.intraday.orders.at(-1)!.status).toBe('rejected');
    const closed = placeIntradayOrderAction(s, { deliveryDay: D0, period: 13, side: OrderSide.SELL, type: 'market', qtyMw: 5 }); // 06:30 SP at 06:00
    expect(closed.intraday.orders.at(-1)!.status).toBe('rejected');
  });

  it("tomorrow's products open only after the DA auction cleared", () => {
    let s = fresh();
    expect(isProductOpen(s, D0 + DAY, 20)).toBe(false);
    s = step(s, 18);
    expect(isProductOpen(s, D0 + DAY, 20)).toBe(true);
  });
});

describe('scenario SIP source', () => {
  it('uses real SIP for real Elexon days and the model for illustrative ones', () => {
    const args = { date: '2026-05-20', daPrices: flat(50), sipPrices: flat(123), niv: flat(300) };
    const real = loadScenario(createGameState(), { ...args, realData: true });
    const fake = loadScenario(createGameState(), args);
    expect(real.dayAhead.sipOutturn[5]).toBe(123);
    expect(fake.dayAhead.sipOutturn[5]).toBeGreaterThan(50); // NIV +300 = short ⇒ above DA
    expect(fake.dayAhead.sipOutturn[5]).not.toBe(123);
  });
});
