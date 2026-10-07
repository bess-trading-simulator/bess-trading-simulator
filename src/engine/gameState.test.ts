import { describe, it, expect } from 'vitest';
import { createGameState, loadScenario, submitDayAheadBids, intradayChargeAction, intradayDischargeAction } from './gameState';
import { OrderSide } from './types';
import type { GameState } from './types';

const flat = (v: number) => new Array(48).fill(v);

function stateAt(h: number, m: number): GameState {
  const base = loadScenario(createGameState(), {
    date: '2026-05-20', daPrices: flat(50), sipPrices: flat(60), niv: flat(100),
  });
  const t = Date.UTC(2026, 4, 20, h, m);
  return { ...base, clock: { ...base.clock, currentTime: t } };
}

describe('day-ahead gate closure', () => {
  const bid = { period: 10, side: OrderSide.BUY, volumeMw: 20, price: -15 };

  it('accepts bids (incl. negative prices) before 09:20 UK', () => {
    const s = submitDayAheadBids(stateAt(7, 0), [bid]); // 08:00 BST
    expect(s.dayAhead.playerSchedule).toHaveLength(1);
    expect(s.dayAhead.playerSchedule[0].price).toBe(-15);
  });

  it('rejects bids after gate closure', () => {
    const s0 = stateAt(9, 0); // 10:00 BST, past 09:20 UK
    expect(submitDayAheadBids(s0, [bid])).toBe(s0);
    const closed = { ...stateAt(7, 0), dayAhead: { ...stateAt(7, 0).dayAhead, isAuctionOpen: false } };
    expect(submitDayAheadBids(closed, [bid])).toBe(closed);
  });
});

describe('intraday gate closure and position limits', () => {
  it('rejects SPs inside the T-60 window', () => {
    const s = stateAt(11, 0);
    expect(intradayChargeAction(s, 24, 10)).toBe(s); // 12:00 SP, gate 11:00
    expect(intradayChargeAction(s, 25, 10).dayAhead.playerSchedule).toHaveLength(1);
  });

  it('caps the net position per SP at the power rating', () => {
    let s = stateAt(0, 0);
    const p = s.battery.config.powerRatingMw;
    s = intradayChargeAction(s, 30, p);
    s = intradayChargeAction(s, 30, p); // no room left
    expect(s.dayAhead.playerSchedule).toHaveLength(1);
    s = intradayDischargeAction(s, 30, 3 * p); // can swing to +P net: 2P
    const last = s.dayAhead.playerSchedule[s.dayAhead.playerSchedule.length - 1];
    expect(last.mw).toBe(2 * p);
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
