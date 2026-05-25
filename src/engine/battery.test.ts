import { describe, it, expect } from 'vitest';
import { createBattery, getMaxChargeableMw, getMaxDischargeableMw, chargeBattery, dischargeBattery } from './battery';

const ts = Date.UTC(2026, 4, 20, 12, 0);

describe('headroom limits', () => {
  it('a full battery cannot charge', () => {
    const full = createBattery({ capacityMwh: 100, maxSocPct: 100 });
    full.currentSocMwh = 100;
    expect(getMaxChargeableMw(full)).toBeCloseTo(0, 5);
  });
  it('an empty battery cannot discharge', () => {
    const empty = createBattery({ capacityMwh: 100, minSocPct: 0 });
    empty.currentSocMwh = 0;
    expect(getMaxDischargeableMw(empty)).toBeCloseTo(0, 5);
  });
  it('caps at the power rating when there is ample headroom', () => {
    const b = createBattery({ capacityMwh: 100, powerRatingMw: 50 });
    b.currentSocMwh = 50;
    expect(getMaxDischargeableMw(b)).toBeLessThanOrEqual(50);
    expect(getMaxChargeableMw(b)).toBeLessThanOrEqual(50);
  });
});

describe('chargeBattery', () => {
  it('raises SoC and books a cost at positive prices', () => {
    const b = createBattery({ capacityMwh: 100, powerRatingMw: 50, efficiencyPct: 90 });
    b.currentSocMwh = 50;
    const r = chargeBattery(b, 40, 60, ts);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.newState.currentSocMwh).toBeGreaterThan(50);
    // grid energy 40*0.5 = 20 MWh @ £60 → entry.cost = -1200 (a spend)
    expect(r.entry.cost).toBeCloseTo(-1200, 5);
  });

  it('pays you to charge when the price is negative', () => {
    const b = createBattery({ capacityMwh: 100, powerRatingMw: 50 });
    b.currentSocMwh = 50;
    const r = chargeBattery(b, 40, -20, ts);
    if ('error' in r) throw new Error('unexpected');
    expect(r.entry.cost).toBeGreaterThan(0); // negative price → positive cashflow
  });
});

describe('dischargeBattery', () => {
  it('lowers SoC and books revenue', () => {
    const b = createBattery({ capacityMwh: 100, powerRatingMw: 50 });
    b.currentSocMwh = 50;
    const r = dischargeBattery(b, 40, 80, ts);
    if ('error' in r) throw new Error('unexpected');
    expect(r.newState.currentSocMwh).toBeLessThan(50);
    // 40*0.5 = 20 MWh @ £80 → revenue 1600
    expect(r.entry.cost).toBeCloseTo(1600, 5);
  });

  it('discharging into a negative price loses money', () => {
    const b = createBattery({ capacityMwh: 100, powerRatingMw: 50 });
    b.currentSocMwh = 50;
    const r = dischargeBattery(b, 40, -20, ts);
    if ('error' in r) throw new Error('unexpected');
    expect(r.entry.cost).toBeLessThan(0);
  });
});
