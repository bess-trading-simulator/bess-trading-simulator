// P&L by source for a delivery day: contracts (DA, ID, BM) at their prices,
// imbalance at SIP, exchange fees and battery wear (degradation).

import type { DayPnl, GameState } from './types';
import type { TradePosition } from './ukMarket';
import { signedMw } from './settlement';
import { HALF_HOUR_MS, SUB_STEP_MS } from './clock';

/**
 * A BOA position only counts once its instruction has arrived (start of its
 * 5-min interval) — before that the unit doesn't know it was called.
 */
export function boaArrived(state: GameState, p: TradePosition): boolean {
  if (p.market !== 'bm') return true;
  const a = (state.bmAcceptances ?? []).find(x => x.day === p.deliveryDay && x.sp === p.period);
  if (!a) return true;
  return state.clock.currentTime >= p.deliveryDay + p.period * HALF_HOUR_MS + (a.startSubIdx ?? 0) * SUB_STEP_MS;
}

const SP_HOURS = 0.5;
const round2 = (v: number) => Math.round(v * 100) / 100;

export interface SpPnl { sp: number; da: number; id: number; bm: number; imbalance: number; costs: number; net: number }

/** Per-SP breakdown of a day (only delivered contracts / settled imbalance count). */
export function spPnl(state: GameState, day: number): SpPnl[] {
  return Array.from({ length: 48 }, (_, sp) => {
    const pos = state.dayAhead.playerSchedule.filter(p => p.deliveryDay === day && p.period === sp && p.delivered && boaArrived(state, p));
    const cash = (m: string) => pos.filter(p => p.market === m).reduce((a, p) => a + signedMw(p) * SP_HOURS * p.price, 0);
    const e = state.ledger.find(x => x.deliveryDay === day && x.period === sp);
    const imbalance = e?.imbalanceCash ?? 0;
    const costs = (e?.feesCash ?? 0) + (e?.degradationCash ?? 0);
    const da = cash('da'), id = cash('id'), bm = cash('bm');
    return { sp, da: round2(da), id: round2(id), bm: round2(bm), imbalance: round2(imbalance), costs: round2(costs), net: round2(da + id + bm + imbalance + costs) };
  });
}

export function dayPnl(state: GameState, day: number): DayPnl {
  const rows = spPnl(state, day);
  const sum = (f: (r: SpPnl) => number) => round2(rows.reduce((a, r) => a + f(r), 0));
  const entries = state.ledger.filter(e => e.deliveryDay === day);
  const fees = round2(entries.reduce((a, e) => a + (e.feesCash ?? 0), 0));
  const degradation = round2(entries.reduce((a, e) => a + (e.degradationCash ?? 0), 0));
  return {
    day,
    da: sum(r => r.da),
    id: sum(r => r.id),
    bm: sum(r => r.bm),
    imbalance: sum(r => r.imbalance),
    fees,
    degradation,
    net: sum(r => r.net),
    throughputMwh: round2(entries.reduce((a, e) => a + Math.abs(e.meteredMw) * SP_HOURS, 0)),
  };
}
