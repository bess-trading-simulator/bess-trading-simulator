import { describe, it, expect } from 'vitest';
import { getSettlementPeriod, getUtcDayStart, getNextDeliveryDay, isIntradayGateOpen, firstIntradayTradableSp } from './clock';

const DAY = 86400000;

describe('getSettlementPeriod (1–48)', () => {
  it('maps UTC half-hours to the right SP', () => {
    expect(getSettlementPeriod(Date.UTC(2026, 4, 20, 0, 0))).toBe(1);
    expect(getSettlementPeriod(Date.UTC(2026, 4, 20, 0, 30))).toBe(2);
    expect(getSettlementPeriod(Date.UTC(2026, 4, 20, 12, 0))).toBe(25);
    expect(getSettlementPeriod(Date.UTC(2026, 4, 20, 23, 30))).toBe(48);
  });
});

describe('getUtcDayStart', () => {
  it('returns UTC midnight of the containing day', () => {
    const t = Date.UTC(2026, 4, 20, 14, 37, 12);
    expect(getUtcDayStart(t)).toBe(Date.UTC(2026, 4, 20, 0, 0, 0));
  });
  it('is idempotent', () => {
    const mid = Date.UTC(2026, 4, 20, 0, 0, 0);
    expect(getUtcDayStart(mid)).toBe(mid);
  });
});

describe('getNextDeliveryDay', () => {
  it('always returns a future UTC midnight', () => {
    const t = Date.UTC(2026, 4, 20, 14, 0);
    const d = getNextDeliveryDay(t);
    expect(d % DAY).toBe(0);
    expect(d).toBeGreaterThan(t);
  });

  it('after gate closure delivers one day later than before gate closure', () => {
    const before = getNextDeliveryDay(Date.UTC(2026, 4, 20, 3, 0));  // pre-gate (early morning)
    const after = getNextDeliveryDay(Date.UTC(2026, 4, 20, 14, 0));  // post-gate (afternoon)
    expect(after - before).toBe(DAY);
  });
});

describe('intraday gate closure (T-60)', () => {
  const day = Date.UTC(2026, 4, 20);
  const at = (h: number, m: number) => day + (h * 60 + m) * 60000;

  it('closes exactly one hour before the SP starts', () => {
    // SP index 24 starts 12:00 → gate 11:00
    expect(isIntradayGateOpen(at(10, 59), 24)).toBe(true);
    expect(isIntradayGateOpen(at(11, 0), 24)).toBe(false);
  });

  it('first tradable SP is the first one starting more than 60 min ahead', () => {
    expect(firstIntradayTradableSp(at(11, 0))).toBe(25);   // 12:30
    expect(firstIntradayTradableSp(at(11, 10))).toBe(25);
    expect(firstIntradayTradableSp(at(0, 0))).toBe(3);     // 01:30
    const first = firstIntradayTradableSp(at(11, 10));
    expect(isIntradayGateOpen(at(11, 10), first)).toBe(true);
    expect(isIntradayGateOpen(at(11, 10), first - 1)).toBe(false);
  });
});
