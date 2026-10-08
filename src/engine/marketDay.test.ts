import { describe, it, expect } from 'vitest';
import { estimateBeta, withFundamentalForecast, nextDayFrom, residualLoad, syntheticMarketDay } from './marketDay';
import type { MarketDay } from './types';

const DAY = 86_400_000;
const D0 = Date.UTC(2026, 4, 20);

function day(opts: Partial<MarketDay>): MarketDay {
  const z = new Array(48).fill(0);
  return {
    day: D0, source: 'synthetic', daForecast: z, daClearing: z, sipOutturn: z, niv: z,
    demandForecast: z, windForecast: z, solarForecast: z, demandOutturn: z, windOutturn: z, solarOutturn: z,
    ...opts,
  };
}

describe('fundamental DA forecast', () => {
  // Today: price = 20 + 5 £/GW × residual load (GW)
  const demand = Array.from({ length: 48 }, (_, sp) => 25000 + 300 * sp);
  const wind = Array.from({ length: 48 }, (_, sp) => 8000 + 100 * Math.sin(sp));
  const solar = new Array(48).fill(0);
  const rl = residualLoad({ demandForecast: demand, windForecast: wind, solarForecast: solar });
  const today = day({ demandForecast: demand, windForecast: wind, solarForecast: solar, daClearing: rl.map((v) => 20 + 5 * v / 1000) });

  it('estimates the merit-order slope from today, shrunk toward the £5/GW prior', () => {
    expect(estimateBeta(today)).toBeCloseTo(5, 1); // fit 5, prior 5
    const steep = { ...today, daClearing: rl.map((v) => 20 + 9 * v / 1000) };
    expect(estimateBeta(steep)).toBeCloseTo(7, 1); // halfway between fit 9 and prior 5
  });

  it('forecast = today price + β × Δresidual load, with the components stored', () => {
    const next = day({ day: D0 + DAY, demandForecast: demand, windForecast: wind.map((w) => w - 2000), solarForecast: solar });
    const f = withFundamentalForecast(next, today);
    // 2 GW less wind → +2 GW residual load → +£10 at β = 5
    expect(f.daForecast[10]).toBeCloseTo(today.daClearing[10] + 10, 1);
    expect(f.forecastModel!.windDelta[10]).toBe(-2000);
    expect(f.forecastModel!.ref[10]).toBe(today.daClearing[10]);
  });

  it('falls back to persistence (Δ = 0) when driver forecasts are missing', () => {
    const t = day({ daClearing: new Array(48).fill(70) });
    const f = withFundamentalForecast(day({ day: D0 + DAY }), t);
    expect(f.daForecast.every((v) => v === 70)).toBe(true);
  });

  it('simulated next day: actual − forecast = (β_true − β)·ΔRL + shock', () => {
    const base = syntheticMarketDay(D0, 11);
    const next = nextDayFrom(base, 12);
    const m = next.forecastModel!, t = next.truth!;
    for (const sp of [0, 17, 35]) {
      const dRl = (m.demandDelta[sp] - m.windDelta[sp] - m.solarDelta[sp]) / 1000;
      const expected = (t.beta - m.beta) * dRl + t.shock[sp];
      expect(next.daClearing[sp] - next.daForecast[sp]).toBeCloseTo(expected, 0);
    }
    expect(next.day).toBe(D0 + DAY);
  });
});
