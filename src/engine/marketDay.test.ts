import { describe, it, expect } from 'vitest';
import { withDeskForecast, nextDayFrom, syntheticMarketDay } from './marketDay';

const DAY = 86_400_000;
const D0 = Date.UTC(2026, 4, 20);

describe('desk forecast = actual − causal errors', () => {
  const base = syntheticMarketDay(D0, 7);

  it('forecast + gas + wind + temperature + event + noise = actual', () => {
    const d = withDeskForecast(base, 42);
    const e = d.forecastErrors!;
    for (let sp = 0; sp < 48; sp++) {
      const sum = d.daForecast[sp] + e.gas[sp] + e.wind[sp] + e.temperature[sp] + e.event[sp] + e.noise[sp];
      expect(sum).toBeCloseTo(d.daClearing[sp], 1);
    }
  });

  it('is deterministic per seed and leaves the actual price untouched', () => {
    const a = withDeskForecast(base, 5), b = withDeskForecast(base, 5);
    expect(a.daForecast).toEqual(b.daForecast);
    expect(a.daClearing).toEqual(base.daClearing);
  });

  it('signals point the right way: more wind → negative wind error, gas up → positive gas error', () => {
    let windAgree = 0, windN = 0, gasAgree = 0, gasN = 0;
    for (let seed = 0; seed < 200; seed++) {
      const d = withDeskForecast(base, seed);
      const s = d.signals!, e = d.forecastErrors!;
      for (const sp of [10, 30]) {
        if (Math.abs(s.windRevisionMw[sp]) > 600) { windN++; if (Math.sign(e.wind[sp]) === -Math.sign(s.windRevisionMw[sp])) windAgree++; }
      }
      if (Math.abs(s.gasPct) > 2) { gasN++; if (Math.sign(e.gas[20]) === Math.sign(s.gasPct)) gasAgree++; }
    }
    expect(windAgree / windN).toBeGreaterThan(0.9);
    expect(gasAgree / gasN).toBeGreaterThan(0.9);
  });

  it('false alarms are unconfirmed and have no price effect', () => {
    for (let seed = 0; seed < 300; seed++) {
      for (const ev of withDeskForecast(base, seed).signals!.events) {
        if (ev.effect === 0) expect(ev.confirmed).toBe(false);
        expect(ev.endSp).toBeGreaterThanOrEqual(ev.startSp);
      }
    }
  });

  it('simulated next days come with signals and a forecast that differs from the actual', () => {
    const next = nextDayFrom(base, 12);
    expect(next.day).toBe(D0 + DAY);
    expect(next.signals).toBeDefined();
    expect(next.daForecast.some((f, sp) => Math.abs(f - next.daClearing[sp]) > 0.5)).toBe(true);
  });
});
