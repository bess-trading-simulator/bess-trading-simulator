import { describe, it, expect } from 'vitest';
import { hindsightOptimum, forwardBook, benchmarks, mistakePatterns } from './desk';
import { createGameState, loadMarketDays, stepForwardAction, submitDayAheadBids } from './gameState';
import { OrderSide } from './types';
import type { MarketDay } from './types';

const DAY = 86_400_000;
const D0 = Date.UTC(2026, 4, 20);
const flat = (v: number) => new Array(48).fill(v);
const day = (d: number, o: Partial<MarketDay> = {}): MarketDay => ({
  day: d, source: 'synthetic', daForecast: flat(50), daClearing: flat(50), sipOutturn: flat(50), niv: flat(0),
  demandForecast: flat(30000), windForecast: flat(5000), solarForecast: flat(0),
  demandOutturn: flat(30000), windOutturn: flat(5000), solarOutturn: flat(0), ...o,
});

describe('hindsight DA optimum (SoC-feasible DP)', () => {
  it('charges cheap first, discharges dear later, with efficiency and wear', () => {
    // 2 SPs at £0 then 2 SPs at £100, empty 100 MWh / 50 MW battery, 90 % eff, no wear
    const v = hindsightOptimum([0, 0, 100, 100], 4, 0, 100, 50, 0.9, 0);
    // charge 2 × 22 MWh stored (≤ 25 grid MWh each), discharge 2 × 22 → ≈ 44 × 100
    expect(v).toBeGreaterThan(4300);
    expect(v).toBeLessThanOrEqual(4500);
  });
  it('cannot discharge before charging (order matters)', () => {
    expect(hindsightOptimum([100, 100, 0, 0], 4, 0, 100, 50, 0.9, 0)).toBe(0);
  });
});

describe('desk risk + review', () => {
  it('flags undeliverable contract volume in the forward book', () => {
    let s = loadMarketDays(createGameState(), day(D0), day(D0 + DAY));
    s = { ...s, dayAhead: { ...s.dayAhead, playerSchedule: [
      { period: 3, deliveryDay: D0, market: 'da', action: 'discharge', mw: 50, price: 60, lockedAt: 0 },
      { period: 4, deliveryDay: D0, market: 'da', action: 'discharge', mw: 50, price: 60, lockedAt: 0 },
      { period: 5, deliveryDay: D0, market: 'da', action: 'discharge', mw: 50, price: 60, lockedAt: 0 },
    ] } };
    const { rows, warnings } = forwardBook(s, 8);
    expect(rows[5].imbalanceRiskMwh).toBeCloseTo(-25, 5); // 50 MWh in battery, 75 sold
    expect(warnings.some(w => w.text.includes('short at SIP'))).toBe(true);
  });

  it('benchmarks and patterns run on a played day', () => {
    let s = submitDayAheadBids(loadMarketDays(createGameState(), day(D0), day(D0 + DAY, { daClearing: flat(50).map((v, i) => (i >= 34 && i < 38 ? 150 : v)) })), [
      { hour: 1, side: OrderSide.BUY, volumeMw: 40, price: 999 },
      { hour: 17, side: OrderSide.SELL, volumeMw: 40, price: 0 },
    ]);
    for (let i = 0; i < 48 + 40; i++) s = stepForwardAction(s);
    const b = benchmarks(s);
    expect(Number.isFinite(b.you) && Number.isFinite(b.optimum)).toBe(true);
    expect(b.optimum).toBeGreaterThanOrEqual((b.naive ?? 0) - 1);
    expect(mistakePatterns(s).length).toBeGreaterThan(0);
  });
});
