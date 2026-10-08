import { describe, it, expect } from 'vitest';
import {
  createGameState, loadMarketDays, loadScenario, submitDayAheadBids, stepForwardAction,
  chargeBatteryAction, dischargeBatteryAction, placeIntradayOrderAction, intradayChargeAction, submitBmOfferAction,
  submitBlockOrderAction, submitHalfHourBidsAction, setBlockOrdersAction,
  subStepAction, setDeviationAction, setAssetTypeAction, setBmOrderAction,
} from './gameState';
import { OrderSide } from './types';
import type { GameState, MarketDay } from './types';
import { findEntry } from './settlement';
import { dayPnl } from './pnl';
import { buildBook, isProductOpen } from './intradayBook';

const DAY = 86_400_000;
const D0 = Date.UTC(2026, 4, 20); // Wed 20 May 2026 (clock = UK wall time, gate 09:20)
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
    s = step(s, 19); // past the 09:20 UK gate
    expect(s.dayAhead.isAuctionOpen).toBe(false);
    const pos = s.dayAhead.playerSchedule.filter(p => p.deliveryDay === D0 + DAY);
    expect(pos).toHaveLength(4); // 2 hours × 2 half-hours
    expect(pos.filter(p => p.action === 'charge').every(p => p.price === 50 && (p.period === 4 || p.period === 5))).toBe(true);
    expect(pos.filter(p => p.action === 'discharge').every(p => p.price === 120)).toBe(true);
    const r3 = s.dayAhead.results.find(r => r.hour === 3)!;
    expect(r3.buyFilled).toBe(false);
  });

  it('rejects orders after gate closure', () => {
    const s0 = at(fresh(), 9, 30); // past the 09:20 UK gate
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
    const bids = [
      { hour: 2, side: OrderSide.BUY, volumeMw: 20, price: 80 },  // 77 ≤ 80 → filled
      { hour: 5, side: OrderSide.SELL, volumeMw: 20, price: 90 }, // 77 < 90 → not filled
    ];
    const s = step(submitDayAheadBids(fresh(day(D0), next), bids), 48);
    expect(s.dayAhead.todayBids).toEqual(bids);
    expect(s.dayAhead.todayResults?.find(r => r.hour === 2)?.buyFilled).toBe(true);
    expect(s.dayAhead.todayResults?.find(r => r.hour === 5)?.sellFilled).toBe(false);
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
    s = step(s, 19);
    expect(isProductOpen(s, D0 + DAY, 20)).toBe(true);
  });
});

describe('scenario SIP source', () => {
  it('scenario days settle at their own (curated or real) SIP', () => {
    const args = { date: '2026-05-20', daPrices: flat(50), sipPrices: flat(123), niv: flat(300) };
    const real = loadScenario(createGameState(), { ...args, realData: true });
    const fake = loadScenario(createGameState(), args);
    // The scenario day is the auction's delivery day
    expect(real.nextDay.sipOutturn[5]).toBe(123);
    expect(fake.nextDay.sipOutturn[5]).toBe(123);
  });
});

describe('block orders (all-or-nothing, linked families)', () => {
  // Tomorrow: night 40, evening (SP 34-37) 150
  const next = day(D0 + DAY, { daClearing: flat(40).map((v, sp) => (sp >= 34 && sp <= 37 ? 150 : v)) });

  it('accepts a block when the AVERAGE clearing meets the limit, settles each SP at its price', () => {
    let s = fresh(day(D0), next);
    s = submitBlockOrderAction(s, { auction: 'hourly', side: OrderSide.SELL, startSp: 34, endSp: 37, volumeMw: 50, price: 140 });
    s = step(s, 19);
    expect(s.dayAhead.blockResults?.[0].accepted).toBe(true);
    const pos = s.dayAhead.playerSchedule.filter(p => p.deliveryDay === D0 + DAY);
    expect(pos).toHaveLength(4);
    expect(pos.every(p => p.price === 150 && p.action === 'discharge')).toBe(true);
  });

  it('rejects the whole block (no partial fill) when the average misses the limit', () => {
    let s = fresh(day(D0), next);
    // SP 30-37: avg = (4×40 + 4×150)/8 = 95 < 120
    s = submitBlockOrderAction(s, { auction: 'hourly', side: OrderSide.SELL, startSp: 30, endSp: 37, volumeMw: 50, price: 120 });
    s = step(s, 19);
    expect(s.dayAhead.blockResults?.[0].accepted).toBe(false);
    expect(s.dayAhead.playerSchedule.filter(p => p.deliveryDay === D0 + DAY)).toHaveLength(0);
  });

  it('linked child only with parent; a profitable child can carry the parent', () => {
    let s = fresh(day(D0), next);
    // Parent: charge 02-04 with max £35 (clears at 40 → −£5 × 100 MWh = −£500 surplus)
    s = submitBlockOrderAction(s, { auction: 'hourly', side: OrderSide.BUY, startSp: 4, endSp: 7, volumeMw: 50, price: 35 });
    const parentId = s.dayAhead.blocks![0].id;
    // Child: discharge 17-19 min £100 (clears 150 → +£50 × 100 MWh = +£5000)
    s = submitBlockOrderAction(s, { auction: 'hourly', side: OrderSide.SELL, startSp: 34, endSp: 37, volumeMw: 50, price: 100, parentId });
    s = step(s, 19);
    const r = s.dayAhead.blockResults!;
    expect(r.every(x => x.accepted)).toBe(true);

    // Same child alone with an unfillable parent (max £10, surplus −£3000; child +£5000 still carries it)
    let t = fresh(day(D0), next);
    t = submitBlockOrderAction(t, { auction: 'hourly', side: OrderSide.BUY, startSp: 4, endSp: 7, volumeMw: 50, price: -200 });
    const pid = t.dayAhead.blocks![0].id;
    t = submitBlockOrderAction(t, { auction: 'hourly', side: OrderSide.SELL, startSp: 34, endSp: 37, volumeMw: 50, price: 100, parentId: pid });
    t = step(t, 19);
    expect(t.dayAhead.blockResults!.every(x => !x.accepted)).toBe(true); // −£24000 parent can't be carried → child rejected too
    expect(t.dayAhead.playerSchedule.filter(p => p.deliveryDay === D0 + DAY)).toHaveLength(0);
  });

  it('rejects invalid hourly blocks (not whole hours)', () => {
    const s = fresh(day(D0), next);
    const r = submitBlockOrderAction(s, { auction: 'hourly', side: OrderSide.SELL, startSp: 35, endSp: 37, volumeMw: 50, price: 100 });
    expect(r.dayAhead.blocks).toHaveLength(0);
  });
});

describe('EPEX GB 30-min auction (15:30 UK)', () => {
  const next = day(D0 + DAY, { daClearing: flat(50).map((_, sp) => (sp % 2 === 0 ? 40 : 60)) });

  it('opens after the hourly auction cleared and clears per half-hour at 15:30', () => {
    let s = fresh(day(D0), next);
    expect(submitHalfHourBidsAction(s, [{ sp: 3, side: OrderSide.SELL, volumeMw: 20, price: 55 }])).toBe(s); // not open yet
    s = step(s, 19); // 09:30 → after the 09:20 gate
    expect(s.dayAhead.hhAuctionOpen).toBe(true);
    expect(s.nextDay.daForecastHH).toHaveLength(48);
    s = submitHalfHourBidsAction(s, [
      { sp: 3, side: OrderSide.SELL, volumeMw: 20, price: 55 }, // clears 60 → filled
      { sp: 4, side: OrderSide.SELL, volumeMw: 20, price: 55 }, // clears 40 → not
    ]);
    s = step(s, 14); // → past the 15:30 gate
    expect(s.dayAhead.hhAuctionOpen).toBe(false);
    const pos = s.dayAhead.playerSchedule.filter(p => p.deliveryDay === D0 + DAY);
    expect(pos).toHaveLength(1);
    expect(pos[0]).toMatchObject({ period: 3, price: 60, action: 'discharge' });
  });

  it('caps 30-min orders so the net position stays within the power rating', () => {
    let s = fresh(day(D0), next);
    s = submitDayAheadBids(s, [{ hour: 1, side: OrderSide.BUY, volumeMw: 50, price: 999 }]); // charge 50 MW in SP 2-3
    s = step(s, 19);
    s = submitHalfHourBidsAction(s, [
      { sp: 2, side: OrderSide.BUY, volumeMw: 20, price: 999 },  // already charging 50 → no room
      { sp: 3, side: OrderSide.SELL, volumeMw: 80, price: 0 },   // can sell back up to 100
    ]);
    expect(s.dayAhead.hhBids).toEqual([{ sp: 3, side: OrderSide.SELL, volumeMw: 80, price: 0 }]);
  });
});

describe('submitting blocks together with single orders', () => {
  it('drops blocks that would push an SP beyond the power rating with the single orders', () => {
    let s = fresh();
    s = submitDayAheadBids(s, [{ hour: 1, side: OrderSide.BUY, volumeMw: 50, price: 180 }]);
    s = setBlockOrdersAction(s, 'hourly', [
      { id: 'A', auction: 'hourly', side: OrderSide.BUY, startSp: 2, endSp: 9, volumeMw: 50, price: 180 }, // overlaps hour 1 → 100 MW
      { id: 'B', auction: 'hourly', side: OrderSide.SELL, startSp: 34, endSp: 37, volumeMw: 50, price: 100 },
    ]);
    expect(s.dayAhead.blocks?.map(b => b.id)).toEqual(['B']);
  });

  it('keeps linked children only after their parent, and replaces the previous list', () => {
    let s = fresh();
    s = setBlockOrdersAction(s, 'hourly', [
      { id: 'P', auction: 'hourly', side: OrderSide.BUY, startSp: 4, endSp: 7, volumeMw: 40, price: 60 },
      { id: 'C', auction: 'hourly', side: OrderSide.SELL, startSp: 34, endSp: 37, volumeMw: 40, price: 90, parentId: 'P' },
    ]);
    expect(s.dayAhead.blocks?.map(b => b.id)).toEqual(['P', 'C']);
    s = setBlockOrdersAction(s, 'hourly', [{ id: 'C2', auction: 'hourly', side: OrderSide.SELL, startSp: 34, endSp: 37, volumeMw: 40, price: 90, parentId: 'P' }]);
    expect(s.dayAhead.blocks).toHaveLength(0); // parent no longer in the list → orphan child dropped
  });
});

describe('power limit across DA auctions and D+1 intraday', () => {
  it('intraday D+1 room counts pending 30-min orders', () => {
    let s = step(fresh(), 19);
    s = submitHalfHourBidsAction(s, [{ sp: 10, side: OrderSide.BUY, volumeMw: 50, price: 1000 }]);
    s = placeIntradayOrderAction(s, { deliveryDay: D0 + DAY, period: 10, side: OrderSide.BUY, type: 'market', qtyMw: 30 });
    expect(s.intraday.orders.at(-1)!.status).toBe('rejected');
  });

  it('30-min orders count working intraday orders and submitted 30-min blocks', () => {
    let s = step(fresh(), 19);
    s = setBlockOrdersAction(s, 'half', [{ id: 'Q', auction: 'half', side: OrderSide.SELL, startSp: 30, endSp: 33, volumeMw: 40, price: 0 }]);
    s = submitHalfHourBidsAction(s, [{ sp: 31, side: OrderSide.SELL, volumeMw: 20, price: 0 }]); // 40 + 20 > 50
    expect(s.dayAhead.hhBids).toHaveLength(0);
  });

  it('hourly orders submitted after blocks are checked against them', () => {
    let s = fresh();
    s = setBlockOrdersAction(s, 'hourly', [{ id: 'A', auction: 'hourly', side: OrderSide.BUY, startSp: 4, endSp: 7, volumeMw: 50, price: 1000 }]);
    s = submitDayAheadBids(s, [{ hour: 2, side: OrderSide.BUY, volumeMw: 50, price: 1000 }]);
    expect(s.dayAhead.bids).toHaveLength(0);
  });
});

describe('scenarios: auction day, live news, unforeseen shocks', () => {
  const S = '2026-05-21';
  const SDAY = Date.parse(S + 'T00:00:00Z');
  const scen = {
    id: 'trip', title: 'Trip', date: S,
    daPrices: flat(100), sipPrices: flat(100).map((v, i) => (i >= 30 && i <= 37 ? 600 : v)), niv: flat(0).map((v, i) => (i >= 30 && i <= 37 ? 700 : v)),
    keyEvents: [{ sp: 31, text: 'Interconnector TRIPPED' }, { sp: 37, text: 'Recovering' }],
    shock: { fromSp: 31, toSp: 38 },
    deskHints: { tempAnomalyC: -4, gasPct: 5 },
  };

  it('starts on the lead-in day and the scenario day is tomorrow (the auction day)', () => {
    const s = loadScenario(createGameState(), scen);
    expect(s.clock.currentTime).toBe(SDAY - DAY);
    expect(s.nextDay.day).toBe(SDAY);
    expect(s.dayAhead.deliveryDay).toBe(SDAY);
    expect(s.scenario?.title).toBe('Trip');
    expect(s.nextDay.signals?.tempAnomalyC).toBeLessThan(-3); // story visible at D-1
  });

  it('breaks key events as news at their SP on the scenario day', () => {
    let s = loadScenario(createGameState(), scen);
    s = step(s, 48 + 30); // scenario day, SP index 30 (= SP31)
    expect(s.events.some(e => e.headline === 'Interconnector TRIPPED')).toBe(true);
    expect(s.events.some(e => e.headline === 'Recovering')).toBe(false);
  });

  it('intraday does not price the shock before the news, then reprices', () => {
    let s = loadScenario(createGameState(), scen);
    s = step(s, 48 + 20); // 10:00 on scenario day, product SP index 34 (17:00) open
    const before = buildBook(s, SDAY, 34)!.mid;
    expect(before).toBeLessThan(150); // anchored to DA (100), no knowledge of the trip
    s = step(s, 10); // 15:00 → news broke at SP index 30
    const after = buildBook(s, SDAY, 34);
    // Curated SIP 600 → anchor DA + 0.8 × (SIP − DA) ≈ £500
    if (after) expect(after.mid).toBeGreaterThan(300); // still open until 16:00 gate
  });
});

describe('imbalance deviations re-dispatch the NET position', () => {
  const withContract = (mw: number, action: 'charge' | 'discharge') => {
    const s = fresh();
    return {
      ...s,
      dayAhead: { ...s.dayAhead, playerSchedule: [{ period: 4, deliveryDay: D0, market: 'da' as const, action, mw, price: 50, lockedAt: 0 }] },
    };
  };

  it('offsetting a discharge contract leaves the battery idle (no phantom round-trip losses)', () => {
    let s = step(withContract(50, 'discharge'), 4); // SP4 delivered: SoC 50 → 25
    expect(s.battery.currentSocMwh).toBeCloseTo(25, 5);
    s = chargeBatteryAction(s, 50);
    expect(s.battery.currentSocMwh).toBeCloseTo(50, 5);
    expect(s.battery.totalDischargedMwh).toBeCloseTo(0, 5);
    expect(s.battery.totalChargedMwh).toBeCloseTo(0, 5);
    expect(findEntry(s.ledger, D0, 4)).toMatchObject({ meteredMw: 0, deviationMw: -50 });
  });

  it('a charging contract can be flipped into a full discharge', () => {
    let s = step(withContract(50, 'charge'), 4);
    s = dischargeBatteryAction(s, 100);
    expect(findEntry(s.ledger, D0, 4)!.meteredMw).toBe(50);
    expect(s.battery.currentSocMwh).toBeCloseTo(25, 5); // started at 50, net discharge 25 MWh
  });

  it('ignores non-finite deviations', () => {
    const s = step(fresh(), 4);
    expect(dischargeBatteryAction(s, NaN)).toBe(s);
  });

  it('rejects BM offers for the running or past SP', () => {
    const s = step(fresh(), 10);
    const r = submitBmOfferAction(s, { period: 10, direction: 'offer', mw: 20, price: 1 });
    expect(r).toBe(s);
  });
});

describe('intra-SP control (5-minute set points)', () => {
  it('steps 5 minutes inside the SP and snaps to the next SP after the last interval', () => {
    let s = step(fresh(), 10); // 05:00
    for (let i = 0; i < 5; i++) s = subStepAction(s);
    expect(s.clock.currentTime).toBe(D0 + (5 * 60 + 25) * 60000);
    s = subStepAction(s);
    expect(s.clock.currentTime).toBe(D0 + (5 * 60 + 30) * 60000);
  });

  it('metered energy = mean of the set point profile; past intervals stay fixed', () => {
    let s = step(fresh(), 10);
    s = setDeviationAction(s, 30);           // 05:00 → 30 MW for the whole SP
    s = subStepAction(subStepAction(s));     // 05:10 (interval 2)
    s = setDeviationAction(s, -30);          // from now on charge 30
    const e = findEntry(s.ledger, D0, 10)!;
    expect(e.deviationProfile).toEqual([30, 30, -30, -30, -30, -30]);
    expect(e.deviationMw).toBeCloseTo(-10, 5);
    expect(e.meteredMw).toBeCloseTo(-10, 5);
    // battery only ran the net: 50 MWh start, net charge 10 MW × 0.5 h × 0.9
    expect(s.battery.currentSocMwh).toBeCloseTo(54.5, 5);
    s = step(s, 1);
    expect(findEntry(s.ledger, D0, 10)!.imbalanceMwh).toBeCloseTo(-5, 5);
  });
});

describe('intra-SP power limit', () => {
  it('caps each 5-minute set point at the power rating', () => {
    let s = step(fresh(), 10);
    s = setDeviationAction(s, 30);
    s = subStepAction(subStepAction(s));
    s = setDeviationAction(s, -999);
    const e = findEntry(s.ledger, D0, 10)!;
    expect(Math.min(...e.deviationProfile!)).toBeGreaterThanOrEqual(-50);
  });
});

describe('BM unit: standing bids/offers and BOAs', () => {
  const shortDay = day(D0, { niv: flat(400), sipOutturn: flat(200) });
  const longDay = day(D0, { niv: flat(-400), sipOutturn: flat(-10) });
  const SPS = Array.from({ length: 30 }, (_, i) => 10 + i);
  const withOffers = (base: MarketDay, offer: number | null, bid: number | null) => {
    let s = setAssetTypeAction(fresh(base), 'bm');
    for (const sp of SPS) s = setBmOrderAction(s, { day: D0, sp, offerMw: offer !== null ? 20 : 0, offerPrice: offer, bidMw: bid !== null ? 20 : 0, bidPrice: bid });
    return s;
  };

  it('in-merit offers are mostly accepted, some skipped; BOAs are partial, pay-as-bid, no imbalance', () => {
    // Keep the battery charged so offers are always feasible.
    let s = withOffers(shortDay, 50, null);
    s = { ...s, battery: { ...s.battery, config: { ...s.battery.config, capacityMwh: 1000 }, currentSocMwh: 900 } };
    s = step(s, 41);
    const acc = s.bmAcceptances ?? [];
    const accepted = acc.filter(a => a.status === 'accepted');
    const skipped = acc.filter(a => a.status === 'skipped');
    expect(accepted.length).toBeGreaterThan(10);
    expect(skipped.length).toBeGreaterThan(2);
    for (const a of accepted) {
      expect(a.mw).toBeLessThanOrEqual(20);
      expect(a.mw).toBeCloseTo(a.instructedMw! * (6 - a.startSubIdx!) / 6, 1);
      const e = findEntry(s.ledger, D0, a.sp)!;
      expect(e.contractedMw).toBeCloseTo(a.mw, 5);
      expect(e.imbalanceMwh).toBe(0);
      expect(e.contractCash).toBeCloseTo(a.mw * 0.5 * 50, 5);
    }
    for (const k of skipped) expect(findEntry(s.ledger, D0, k.sp)?.contractedMw ?? 0).toBe(0);
    expect(s.events.some(ev => ev.id.startsWith('live-boa'))).toBe(true);
  });

  it('never accepts offers priced above the marginal price, nor for non-BM assets', () => {
    expect(step(withOffers(shortDay, 250, null), 41).bmAcceptances ?? []).toHaveLength(0);
    let t = fresh(shortDay);
    t = setBmOrderAction(t, { day: D0, sp: 10, offerMw: 30, offerPrice: 0, bidMw: 0, bidPrice: null });
    expect(step(t, 11).bmAcceptances ?? []).toHaveLength(0);
  });

  it('accepts bids when long (charge at your bid)', () => {
    let s = withOffers(longDay, null, 5);
    s = { ...s, battery: { ...s.battery, config: { ...s.battery.config, capacityMwh: 1000 }, currentSocMwh: 10 } };
    s = step(s, 41);
    const accepted = (s.bmAcceptances ?? []).filter(a => a.status === 'accepted');
    expect(accepted.length).toBeGreaterThan(5);
    const e = findEntry(s.ledger, D0, accepted[0].sp)!;
    expect(e.contractedMw).toBeCloseTo(-accepted[0].mw, 5);
    expect(e.contractCash).toBeCloseTo(-accepted[0].mw * 0.5 * 5, 5);
  });

  it('orders can only be changed before BM gate closure (T-60)', () => {
    const s = setAssetTypeAction(step(fresh(shortDay), 9), 'bm'); // 04:30
    expect(setBmOrderAction(s, { day: D0, sp: 10, offerMw: 30, offerPrice: 1, bidMw: 0, bidPrice: null })).toBe(s); // 05:00 SP, gate 04:00
  });

  it('a new session starts with an empty BM book (no BOAs from a previous run)', () => {
    const s = step(withOffers(shortDay, 50, null), 41);
    expect((s.bmAcceptances ?? []).length).toBeGreaterThan(0);
    const again = loadMarketDays(s, shortDay, day(D0 + DAY));
    expect(again.bmAcceptances).toHaveLength(0);
    expect(again.bmBook).toHaveLength(0);
  });
});


describe('P&L incl. exchange fees and degradation', () => {
  it('cash identity holds and the finished day is archived at midnight', () => {
    let s = submitDayAheadBids(fresh(), [
      { hour: 3, side: OrderSide.BUY, volumeMw: 40, price: 999 },
      { hour: 18, side: OrderSide.SELL, volumeMw: 40, price: 0 },
    ]);
    s = step(s, 48 + 40); // deliver the auction day up to 20:00
    s = chargeBatteryAction(s, 10);
    s = step(s, 9); // past midnight of day 2 → day 2 archived
    const ledgerSum = s.ledger.reduce((a, e) => a + e.contractCash + e.imbalanceCash + (e.feesCash ?? 0) + (e.degradationCash ?? 0), 0);
    const archived = (s.pnlHistory ?? []).reduce((a, d) => a + d.net, 0);
    const battery = s.battery.totalDischargeRevenue - s.battery.totalChargeCost;
    expect(battery).toBeCloseTo(ledgerSum, 0);
    const d2 = s.pnlHistory!.find(d => d.day === D0 + DAY)!;
    expect(d2.fees).toBeCloseTo(-(40 * 0.5 * 4) * 0.05, 5); // 4 SPs × 20 MWh × £0.05
    expect(d2.degradation).toBeLessThan(0);
    expect(d2.net).toBeCloseTo(d2.da + d2.id + d2.bm + d2.imbalance + d2.fees + d2.degradation, 5);
    expect(archived).toBeCloseTo(battery, 0);
  });

  it('dayPnl of today reflects delivered SPs only', () => {
    let s = submitDayAheadBids(fresh(), [{ hour: 20, side: OrderSide.SELL, volumeMw: 20, price: 0 }]);
    s = step(s, 48 + 10);
    expect(dayPnl(s, D0 + DAY).da).toBe(0); // 20:00 not delivered yet
  });
});
