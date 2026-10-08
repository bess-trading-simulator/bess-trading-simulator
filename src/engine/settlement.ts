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
import { SUB_STEPS_PER_SP, subStepIndex } from './clock';
import { MarketType, OrderSide } from './types';
import { dispatchBattery, redispatchBattery, bookCash } from './battery';
import type { TradePosition } from './ukMarket';

const SP_HOURS = 0.5;
/** Exchange fee on day-ahead and intraday volume, £/MWh (illustrative, order of magnitude of EPEX/N2EX fees) */
export const EXCHANGE_FEE_PER_MWH = 0.05;

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
  // Exchange fees on every DA / ID MWh traded for this SP (BM acceptances carry no exchange fee).
  const fees = -due.filter((p) => p.market === 'da' || p.market === 'id').reduce((a, p) => a + p.mw * SP_HOURS, 0) * EXCHANGE_FEE_PER_MWH;
  const battery = bookCash(bookCash(newState, cash), fees);

  const prev = findEntry(state.ledger, day, sp) ?? emptyEntry(day, sp);
  const entry: SettlementEntry = {
    ...prev,
    contractedMw: round2(prev.contractedMw + netMw),
    deliveredMw: round2(prev.deliveredMw + actualMw),
    meteredMw: round2(prev.meteredMw + actualMw),
    contractCash: round2(prev.contractCash + cash),
    feesCash: round2((prev.feesCash ?? 0) + fees),
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
    deviationProfile: undefined,
  };
  return { ...state, battery: newState, ledger: upsert(state.ledger, entry) };
}

/**
 * Range of the AVERAGE deliberate deviation (MW) possible in the running SP,
 * given the contract already delivered and the SoC at the SP start.
 */
export function deviationRange(state: GameState, day: number, sp: number): { min: number; max: number } {
  const e = findEntry(state.ledger, day, sp);
  const metered = e?.meteredMw ?? 0;
  const delivered = e?.deliveredMw ?? 0;
  const { powerRatingMw: p, capacityMwh: cap, minSocPct, maxSocPct, efficiencyPct } = state.battery.config;
  const eff = efficiencyPct / 100;
  const start = spStartSoc(state, metered);
  const maxNetDischarge = Math.min(p, Math.max(0, start - cap * minSocPct / 100) / SP_HOURS);
  const maxNetCharge = Math.min(p, Math.max(0, cap * maxSocPct / 100 - start) / (SP_HOURS * eff));
  return { min: round2(-maxNetCharge - delivered), max: round2(maxNetDischarge - delivered) };
}

/**
 * Intra-SP control: set the deliberate deviation set point (MW, + = discharge
 * more) from the current 5-minute interval to the end of the SP. Past intervals
 * are fixed. The SP's metered energy = contract delivered + mean of the profile;
 * the battery is re-dispatched to that net. Returns the state unchanged if the
 * set point is invalid; clips it to what power/SoC allow.
 */
export function setDeviationSetpoint(state: GameState, day: number, sp: number, setpointMw: number, logPrice: number): GameState {
  if (!Number.isFinite(setpointMw)) return state;
  const now = state.clock.currentTime;
  if (now < day + sp * 1_800_000 || now >= day + (sp + 1) * 1_800_000) return state; // only the running SP
  const k = subStepIndex(now);
  const prev = findEntry(state.ledger, day, sp) ?? emptyEntry(day, sp);
  const profile = prev.deviationProfile?.slice() ?? new Array(SUB_STEPS_PER_SP).fill(prev.deviationMw);
  const past = profile.slice(0, k).reduce((a, v) => a + v, 0);
  const n = SUB_STEPS_PER_SP - k;
  const range = deviationRange(state, day, sp);
  // mean = (past + x·n)/6 must stay within [min, max]
  // mean = (past + x·n)/6 within [min, max] (energy), and the net output in each
  // interval (contract delivered + x) within ±power rating.
  const P = state.battery.config.powerRatingMw;
  const xMin = Math.max((range.min * SUB_STEPS_PER_SP - past) / n, -P - prev.deliveredMw);
  const xMax = Math.min((range.max * SUB_STEPS_PER_SP - past) / n, P - prev.deliveredMw);
  const x = round2(Math.max(xMin, Math.min(xMax, setpointMw)));
  for (let i = k; i < SUB_STEPS_PER_SP; i++) profile[i] = x;
  const newDev = profile.reduce((a, v) => a + v, 0) / SUB_STEPS_PER_SP;
  const { newState, actualMw } = redispatchBattery(state.battery, prev.meteredMw, prev.deliveredMw + newDev, now, logPrice);
  const entry: SettlementEntry = {
    ...prev,
    deviationProfile: profile,
    deviationMw: round2(actualMw - prev.deliveredMw),
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
  // Wear cost on the metered (net) throughput of the SP.
  const degradationCash = -round2(Math.abs(e.meteredMw) * SP_HOURS * (state.battery.config.degradationCostPerMwh ?? 5));
  const entry: SettlementEntry = { ...e, imbalanceMwh, imbalancePrice: sip, imbalanceCash, degradationCash, settled: true };
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
  return { ...state, battery: bookCash(bookCash(state.battery, imbalanceCash), degradationCash), trades, ledger: upsert(state.ledger, entry) };
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
