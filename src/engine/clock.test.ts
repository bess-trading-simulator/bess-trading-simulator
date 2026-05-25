import { describe, it, expect } from 'vitest';
import { getSettlementPeriod, getUtcDayStart, getNextDeliveryDay } from './clock';

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
