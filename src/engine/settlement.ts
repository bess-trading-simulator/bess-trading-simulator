// Physical delivery and settlement per settlement period (GB style).
//
// For each (delivery day, SP):
//  - contracted position = Σ DA + ID (+ BM) trades, netted (+ = sell/discharge)
//  - at the start of the SP the battery dispatches the NET contract once,
//    limited by power and SoC  → deliveredMw
//  - during the SP the trader may deliberately deviate (NIV chasing) → deviationMw
//  - metered = delivered + deviation
//  - contracts settle at their trade prices on the contracted volume
//  - imbalance (metered − contracted) × 0.5 h settles at the SIP once it is
//    published after the SP. Undeliverable contracts therefore cost imbalance.

import type { GameState, SettlementEntry, Trade } from './types';
import { MarketType, OrderSide } from './types';
import { dispatchBattery, redispatchBattery, bookCash } from './battery';
import type { TradePosition } from './ukMarket';

const SP_HOURS = 0.5;

function round2(v: number): number { return Math.round(v * 100) / 100; }

export function findEntry(ledger: SettlementEntry[], day: number, sp: number): SettlementEntry | undefined {
  return ledger.find((e) => e.deliveryDay === day && e.period === sp);
}

function emptyEntry(day: number, sp: number): SettlementEntry {
  return {
    deliveryDay: day, period: sp, contractedMw: 0, deliveredMw: 0, deviationMw: 0, meteredMw: 0,
    contractCash: 0, imbalanceMwh: 0, imbalancePrice: null, imbalanceCash: 0, settled: false,
  };
}

function upsert(ledger: SettlementEntry[], entry: SettlementEntry): SettlementEntry[] {
  const i = ledger.findIndex((e) => e.deliveryDay === entry.deliveryDay && e.period === entry.period);
  if (i < 0) return [...ledger, entry];
  const copy = ledger.slice();
  copy[i] = entry;
  return copy;
}

const marketType: Record<TradePosition['market'], Trade['marketType']> = {
  da: MarketType.DAY_AHEAD,
  id: MarketType.INTRADAY,
  bm: MarketType.BM,
  spot: MarketType.SPOT,
};

/** Signed MW of a position: + = discharge/sell, − = charge/buy. */
export function signedMw(p: Pick<TradePosition, 'action' | 'mw'>): number {
  return p.action === 'discharge' ? p.mw : -p.mw;
}

/**
 * Deliver an SP at its start: net all undelivered contracts, dispatch once,
 * settle contract cash. Contracts added later (none, after T-60) are ignored.
 */
export function deliverPeriod(state: GameState, day: number, sp: number): GameState {
  const now = state.clock.currentTime;
  const due = state.dayAhead.playerSchedule.filter((p) => !p.delivered && p.deliveryDay === day && p.period === sp);
  if (due.length === 0) return state;

  const netMw = due.reduce((a, p) => a + signedMw(p), 0);
  const cash = due.reduce((a, p) => a + signedMw(p) * SP_HOURS * p.price, 0);
  const avgPrice = due.reduce((a, p) => a + p.mw * p.price, 0) / Math.max(1e-9, due.reduce((a, p) => a + p.mw, 0));

  const { newState, actualMw } = dispatchBattery(state.battery, netMw, now, avgPrice);
  const battery = bookCash(newState, cash);

  const prev = findEntry(state.ledger, day, sp) ?? emptyEntry(day, sp);
  const entry: SettlementEntry = {
    ...prev,
    contractedMw: round2(prev.contractedMw + netMw),
    deliveredMw: round2(prev.deliveredMw + actualMw),
    meteredMw: round2(prev.meteredMw + actualMw),
    contractCash: round2(prev.contractCash + cash),
  };

  const trades: Trade[] = due.map((p) => ({
    orderId: `${p.market}-${p.action}-${p.period}-${p.lockedAt}`,
    side: p.action === 'charge' ? OrderSide.BUY : OrderSide.SELL,
    volumeMw: p.mw,
    price: p.price,
    timestamp: now,
    marketType: marketType[p.market],
  }));

  return {
    ...state,
    battery,
    trades: [...state.trades, ...trades],
    ledger: upsert(state.ledger, entry),
    dayAhead: {
      ...state.dayAhead,
      playerSchedule: state.dayAhead.playerSchedule.map((p) => (due.includes(p) ? { ...p, delivered: true } : p)),
    },
  };
}

/**
 * SoC at the start of the running SP, i.e. before this SP's dispatch so far
 * (the contract plus any deviation already applied) — the basis for re-dispatch.
 */
function spStartSoc(state: GameState, meteredMw: number): number {
  const eff = state.battery.config.efficiencyPct / 100;
  const soc = state.battery.currentSocMwh;
  return meteredMw > 0 ? soc + meteredMw * SP_HOURS : soc - -meteredMw * SP_HOURS * eff;
}

/**
 * Allowed extra MW of deliberate deviation in the running SP (by direction),
 * measured against the NET dispatch: offsetting the contract first frees power
 * and energy, then the battery's limits apply to the resulting net.
 */
export function deviationRoom(state: GameState, day: number, sp: number): { charge: number; discharge: number } {
  const e = findEntry(state.ledger, day, sp);
  const metered = e?.meteredMw ?? 0;
  const { powerRatingMw: p, capacityMwh: cap, minSocPct, maxSocPct, efficiencyPct } = state.battery.config;
  const eff = efficiencyPct / 100;
  const start = spStartSoc(state, metered);
  const maxNetDischarge = Math.min(p, Math.max(0, start - cap * minSocPct / 100) / SP_HOURS);
  const maxNetCharge = Math.min(p, Math.max(0, cap * maxSocPct / 100 - start) / (SP_HOURS * eff));
  return {
    discharge: Math.max(0, round2(maxNetDischarge - metered)),
    charge: Math.max(0, round2(metered + maxNetCharge)),
  };
}

/**
 * Deliberately deviate from the contracted position in the running SP
 * (+ = discharge more / charge less, − = charge more). The SP is re-dispatched
 * with the new NET (contract + deviation); settled at SIP later.
 */
export function applyDeviation(state: GameState, day: number, sp: number, signed: number, logPrice: number): GameState {
  if (!Number.isFinite(signed)) return state;
  const room = deviationRoom(state, day, sp);
  const want = signed > 0 ? Math.min(signed, room.discharge) : -Math.min(-signed, room.charge);
  if (Math.abs(want) < 0.01) return state;
  const prev = findEntry(state.ledger, day, sp) ?? emptyEntry(day, sp);
  const { newState, actualMw } = redispatchBattery(state.battery, prev.meteredMw, prev.meteredMw + want, state.clock.currentTime, logPrice);
  const change = actualMw - prev.meteredMw;
  if (Math.abs(change) < 0.01) return state;
  const entry: SettlementEntry = {
    ...prev,
    deviationMw: round2(prev.deviationMw + change),
    meteredMw: round2(actualMw),
  };
  return { ...state, battery: newState, ledger: upsert(state.ledger, entry) };
}

/**
 * Settle an SP once its SIP is published: imbalance = metered − contracted,
 * cash = imbalance MWh × SIP. Books an imbalance trade for the records.
 */
export function settlePeriod(state: GameState, day: number, sp: number, sip: number): GameState {
  const e = findEntry(state.ledger, day, sp);
  if (!e || e.settled) return state;
  // Ignore sub-0.01 MWh rounding dust (no £0 phantom trades).
  const rawMwh = round2((e.meteredMw - e.contractedMw) * SP_HOURS);
  const imbalanceMwh = Math.abs(rawMwh) < 0.01 ? 0 : rawMwh;
  const imbalanceMw = imbalanceMwh / SP_HOURS;
  const imbalanceCash = round2(imbalanceMwh * sip);
  const entry: SettlementEntry = { ...e, imbalanceMwh, imbalancePrice: sip, imbalanceCash, settled: true };
  const trades = imbalanceMwh !== 0
    ? [...state.trades, {
        orderId: `imb-${day}-${sp}`,
        side: imbalanceMw > 0 ? OrderSide.SELL : OrderSide.BUY,
        volumeMw: Math.abs(imbalanceMw),
        price: sip,
        // Timestamp at the SP start so per-SP views attribute it correctly.
        timestamp: day + sp * 1_800_000,
        marketType: MarketType.SPOT,
      } satisfies Trade]
    : state.trades;
  return { ...state, battery: bookCash(state.battery, imbalanceCash), trades, ledger: upsert(state.ledger, entry) };
}

/**
 * Per-SP summary of TODAY for post-trade analysis: one net position per SP with
 * the effective price (all cash of that SP / metered MWh).
 */
export function analysisPositions(state: GameState, day: number): TradePosition[] {
  const out: TradePosition[] = [];
  for (const e of state.ledger) {
    if (e.deliveryDay !== day || Math.abs(e.meteredMw) < 0.01) continue;
    const mwh = Math.abs(e.meteredMw) * SP_HOURS;
    const cash = e.contractCash + e.imbalanceCash;
    const action = e.meteredMw > 0 ? 'discharge' : 'charge';
    const price = action === 'discharge' ? cash / mwh : -cash / mwh;
    const hasId = state.dayAhead.playerSchedule.some((p) => p.deliveryDay === day && p.period === e.period && p.market === 'id');
    const market: TradePosition['market'] = Math.abs(e.deviationMw) > 0.01 && Math.abs(e.contractedMw) < 0.01
      ? 'spot'
      : hasId ? 'id' : 'da';
    out.push({ period: e.period, deliveryDay: day, market, action, mw: Math.abs(e.meteredMw), price: round2(price), lockedAt: day, delivered: true });
  }
  return out;
}
