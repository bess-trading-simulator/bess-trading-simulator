import { describe, it, expect } from 'vitest';
import { imbalanceSettlementPrice, generateImbalanceDay, generateSIPOutturn } from './ukMarket';

describe('imbalanceSettlementPrice', () => {
  it('returns DA when the system is balanced (NIV 0)', () => {
    expect(imbalanceSettlementPrice(50, 0)).toBe(50);
  });

  it('long system (NIV > 0) settles below DA — charging is cheap', () => {
    expect(imbalanceSettlementPrice(50, 200)).toBeLessThan(50);
  });

  it('short system (NIV < 0) settles above DA — discharging pays', () => {
    expect(imbalanceSettlementPrice(50, -200)).toBeGreaterThan(50);
  });

  it('is symmetric around DA for opposite NIV within the linear band', () => {
    const da = 80;
    const up = imbalanceSettlementPrice(da, -150);
    const down = imbalanceSettlementPrice(da, 150);
    expect(up - da).toBeCloseTo(da - down, 5);
  });

  it('can go negative when the system is very long', () => {
    // da 50, niv 1000: linear -150, stress -(500)*0.18 = -90 → -190
    expect(imbalanceSettlementPrice(50, 1000)).toBeLessThan(0);
  });

  it('adds a stress term only beyond ±500 MW', () => {
    const da = 50;
    // at 400 MW it is purely linear; at 600 MW the stress term makes it more extreme
    const linearOnly = da - 400 * 0.15;
    expect(imbalanceSettlementPrice(da, 400)).toBeCloseTo(linearOnly, 5);
    const withStress = imbalanceSettlementPrice(da, 600);
    expect(withStress).toBeLessThan(da - 600 * 0.15 + 0.001); // strictly below the pure-linear value
  });
});

describe('generateImbalanceDay', () => {
  it('is deterministic for a given seed', () => {
    const a = generateImbalanceDay(123, true);
    const b = generateImbalanceDay(123, true);
    expect(a).toEqual(b);
  });

  it('produces full 48-period arrays of finite integers', () => {
    const d = generateImbalanceDay(7, true);
    for (const key of ['niv', 'windForecast', 'windOutturn', 'demandForecast', 'demandOutturn'] as const) {
      expect(d[key]).toHaveLength(48);
      expect(d[key].every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  it('wind/demand outturn differ from forecast (real observable error)', () => {
    const d = generateImbalanceDay(42, true);
    const windErrs = d.windOutturn.map((o, i) => o - d.windForecast[i]);
    const demandErrs = d.demandOutturn.map((o, i) => o - d.demandForecast[i]);
    expect(windErrs.some((e) => e !== 0)).toBe(true);
    expect(demandErrs.some((e) => e !== 0)).toBe(true);
  });
});

describe('generateSIPOutturn', () => {
  it('equals imbalanceSettlementPrice per period — one canonical curve', () => {
    const da = [40, 55, 70, 120, 30];
    const niv = [0, 200, -300, 800, -50];
    const sip = generateSIPOutturn(da, niv);
    sip.forEach((v, i) => {
      expect(v).toBe(imbalanceSettlementPrice(da[i], niv[i]));
    });
  });
});
