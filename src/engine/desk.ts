// Trading-desk views built on the current engine state: a forward risk book
// (next SPs across midnight) and a review (benchmarks + mistake patterns).

import type { GameState } from './types';
import { OrderSide } from './types';
import { getUtcDayStart, getSettlementPeriod, HALF_HOUR_MS, ID_GATE_CLOSURE_MS } from './clock';
import { signedMw } from './settlement';
import { dayPnl, spPnl, boaArrived } from './pnl';

const SP_HOURS = 0.5;
const DAY_MS = 86_400_000;
const round2 = (v: number) => Math.round(v * 100) / 100;

// ===== Risk: forward book =====

export interface RiskRow {
  day: number;
  sp: number;
  /** Net contracted MW (DA + ID + BM), + = sell/discharge */
  netMw: number;
  /** MW still pending (working ID orders, open 30-min auction orders/blocks) by side */
  pendingBuyMw: number;
  pendingSellMw: number;
  /** Projected SoC (%) at the END of the SP if the contract is delivered */
  socPct: number;
  /** Energy that can't be delivered (− = short, + = long), MWh → settles at SIP */
  imbalanceRiskMwh: number;
  /** Minutes until intraday/BM gate closure for this SP (negative = closed) */
  gateMin: number;
}

export interface RiskWarning { level: 'info' | 'warn' | 'danger'; text: string }

/** Net book for the next `count` SPs (including the running one), across midnight. */
export function forwardBook(state: GameState, count = 8): { rows: RiskRow[]; warnings: RiskWarning[] } {
  const now = state.clock.currentTime;
  const today = getUtcDayStart(now);
  const curSp = getSettlementPeriod(now) - 1;
  const { powerRatingMw: P, capacityMwh: cap, efficiencyPct } = state.battery.config;
  const eff = efficiencyPct / 100;
  const rows: RiskRow[] = [];
  let soc = state.battery.currentSocMwh;

  for (let i = 0; i < count; i++) {
    const idx = curSp + i;
    const day = today + Math.floor(idx / 48) * DAY_MS;
    const sp = idx % 48;
    // A BOA only shows once its instruction has arrived (same rule as the P&L).
    const positions = state.dayAhead.playerSchedule.filter(p => p.deliveryDay === day && p.period === sp && boaArrived(state, p));
    const netMw = round2(positions.reduce((a, p) => a + signedMw(p), 0));
    const working = state.intraday.orders.filter(o => (o.status === 'working' || o.status === 'partial') && o.deliveryDay === day && o.period === sp);
    let pendingBuyMw = working.filter(o => o.side === OrderSide.BUY).reduce((a, o) => a + o.qtyMw - o.filledMw, 0);
    let pendingSellMw = working.filter(o => o.side === OrderSide.SELL).reduce((a, o) => a + o.qtyMw - o.filledMw, 0);
    if (state.dayAhead.hhAuctionOpen && day === state.dayAhead.deliveryDay) {
      for (const b of state.dayAhead.hhBids ?? []) if (b.sp === sp) { if (b.side === OrderSide.BUY) pendingBuyMw += b.volumeMw; else pendingSellMw += b.volumeMw; }
      for (const b of (state.dayAhead.blocks ?? []).filter(x => x.auction === 'half' && sp >= x.startSp && sp <= x.endSp)) {
        if (b.side === OrderSide.BUY) pendingBuyMw += b.volumeMw; else pendingSellMw += b.volumeMw;
      }
    }

    // The running SP is already dispatched: its effect is in the current SoC.
    let imbalanceRiskMwh = 0;
    if (i > 0) {
      if (netMw > 0) {
        const need = Math.min(netMw, P) * SP_HOURS;
        if (need > soc + 0.01) imbalanceRiskMwh = -(need - soc);
        soc = Math.max(0, soc - need);
      } else if (netMw < 0) {
        const store = Math.min(-netMw, P) * SP_HOURS * eff;
        if (store > cap - soc + 0.01) imbalanceRiskMwh = (store - (cap - soc)) / eff;
        soc = Math.min(cap, soc + store);
      }
    }
    rows.push({
      day, sp, netMw,
      pendingBuyMw: round2(pendingBuyMw), pendingSellMw: round2(pendingSellMw),
      socPct: round2((soc / cap) * 100),
      imbalanceRiskMwh: round2(imbalanceRiskMwh),
      gateMin: Math.round((day + sp * HALF_HOUR_MS - ID_GATE_CLOSURE_MS - now) / 60_000),
    });
  }

  const warnings: RiskWarning[] = [];
  const t = (r: RiskRow) => `${String(Math.floor(r.sp / 2)).padStart(2, '0')}:${r.sp % 2 === 0 ? '00' : '30'}`;
  for (const r of rows) {
    if (r.imbalanceRiskMwh < -0.05) {
      warnings.push({ level: r.gateMin > 0 ? 'warn' : 'danger', text: `${t(r)}: contract needs ${Math.abs(r.imbalanceRiskMwh).toFixed(1)} MWh more than the battery will hold → short at SIP${r.gateMin > 0 ? ` — buy back intraday (gate in ${r.gateMin} min)` : ' — gate closed'}` });
    } else if (r.imbalanceRiskMwh > 0.05) {
      warnings.push({ level: r.gateMin > 0 ? 'warn' : 'danger', text: `${t(r)}: battery can't absorb ${r.imbalanceRiskMwh.toFixed(1)} MWh of bought energy → long at SIP${r.gateMin > 0 ? ` — sell back intraday (gate in ${r.gateMin} min)` : ' — gate closed'}` });
    }
  }
  // Next market gates.
  const d = state.dayAhead;
  if (d.isAuctionOpen && d.gateClosureTime) {
    const m = Math.round((d.gateClosureTime - now) / 60_000);
    warnings.push({ level: m <= 60 ? 'warn' : 'info', text: `Hourly DA auction closes in ${m} min (09:20) — ${d.bids.length + (d.blocks ?? []).filter(b => b.auction === 'hourly').length} order(s) submitted` });
  } else if (d.hhAuctionOpen && d.hhGateClosureTime) {
    const m = Math.round((d.hhGateClosureTime - now) / 60_000);
    warnings.push({ level: m <= 60 ? 'warn' : 'info', text: `30-min DA auction closes in ${m} min (15:30) — ${(d.hhBids ?? []).length + (d.blocks ?? []).filter(b => b.auction === 'half').length} order(s) submitted` });
  }
  const socNow = state.battery.socPct;
  if (socNow < 5) warnings.push({ level: 'info', text: 'Battery nearly empty — no room to sell more or to deviate upward' });
  if (socNow > 95) warnings.push({ level: 'info', text: 'Battery nearly full — no room to buy more or to absorb a long system' });
  return { rows, warnings };
}

// ===== Review: benchmarks =====

/** SoC at the start of `day`, reconstructed from the current SoC and today's metered dispatch. */
function socAtDayStart(state: GameState, day: number): number {
  const eff = state.battery.config.efficiencyPct / 100;
  let soc = state.battery.currentSocMwh;
  for (const e of state.ledger) {
    if (e.deliveryDay !== day) continue;
    soc += e.meteredMw > 0 ? e.meteredMw * SP_HOURS : -(-e.meteredMw) * SP_HOURS * eff;
  }
  return Math.max(0, Math.min(state.battery.config.capacityMwh, soc));
}

/**
 * Best possible DA arbitrage over SPs [0, end) with perfect hindsight on the DA
 * prices, respecting power, capacity, efficiency, SoC sequencing and wear cost
 * (dynamic programming on a 1 MWh SoC grid).
 */
export function hindsightOptimum(prices: number[], end: number, startSoc: number, cap: number, P: number, eff: number, wear: number): number {
  const step = 1; // MWh
  const n = Math.round(cap / step);
  const NEG = -1e15;
  let value = new Array(n + 1).fill(NEG);
  value[Math.round(startSoc / step)] = 0;
  const maxDis = Math.round((P * SP_HOURS) / step);
  for (let sp = 0; sp < end; sp++) {
    const price = prices[sp] ?? 0;
    const next = new Array(n + 1).fill(NEG);
    for (let s = 0; s <= n; s++) {
      if (value[s] === NEG) continue;
      // idle
      if (value[s] > next[s]) next[s] = value[s];
      // discharge k MWh (to grid)
      for (let k = 1; k <= maxDis && s - k >= 0; k++) {
        const v = value[s] + k * step * (price - wear);
        if (v > next[s - k]) next[s - k] = v;
      }
      // charge: store k MWh, buy k/eff from grid (limited by power)
      for (let k = 1; s + k <= n && (k * step) / eff <= P * SP_HOURS + 1e-9; k++) {
        const grid = (k * step) / eff;
        const v = value[s] - grid * (price + wear);
        if (v > next[s + k]) next[s + k] = v;
      }
    }
    value = next;
  }
  return round2(Math.max(...value));
}

export interface Benchmarks {
  window: string;
  you: number;
  idle: number;
  /** null until the window covers the naive schedule's discharge (19:00) */
  naive: number | null;
  optimum: number;
  /** your result as % of the hindsight optimum (null if optimum ≤ 0) */
  capturePct: number | null;
}

/**
 * Compare today's delivered P&L with: doing nothing, a naive fixed schedule
 * (charge 00:00–02:00, discharge 17:00–19:00 at DA prices) and the hindsight
 * DA optimum — all over the same window of delivered SPs.
 */
export function benchmarks(state: GameState): Benchmarks {
  const now = state.clock.currentTime;
  const today = getUtcDayStart(now);
  const end = getSettlementPeriod(now) - 1; // SPs fully delivered and settled
  const { capacityMwh: cap, powerRatingMw: P, efficiencyPct } = state.battery.config;
  const eff = efficiencyPct / 100;
  const wear = state.battery.config.degradationCostPerMwh ?? 5;
  const prices = state.dayAhead.forecastPrices;
  const start = socAtDayStart(state, today);

  let soc = start, naive = 0;
  for (let sp = 0; sp < end; sp++) {
    const p = prices[sp] ?? 0;
    if (sp < 4) { // charge 00:00–02:00
      const store = Math.min(P * SP_HOURS * eff, cap - soc);
      naive -= (store / eff) * (p + wear); soc += store;
    } else if (sp >= 34 && sp < 38) { // discharge 17:00–19:00
      const out = Math.min(P * SP_HOURS, soc);
      naive += out * (p - wear); soc -= out;
    }
  }
  // Same window as the benchmarks: only SPs that are fully delivered and settled.
  const you = spPnl(state, today).filter(r => r.sp < end).reduce((a, r) => a + r.net, 0);
  const optimum = end > 0 ? hindsightOptimum(prices, end, start, cap, P, eff, wear) : 0;
  return {
    window: end > 0 ? `00:00–${String(Math.floor(end / 2)).padStart(2, '0')}:${end % 2 === 0 ? '00' : '30'}` : '—',
    you: round2(you),
    idle: 0,
    naive: end >= 38 ? round2(naive) : null,
    optimum,
    capturePct: optimum > 1 ? Math.round((you / optimum) * 100) : null,
  };
}

// ===== Review: mistake patterns (from the settlement ledger) =====

export interface Finding { level: 'good' | 'warn' | 'bad'; title: string; detail: string }

export function mistakePatterns(state: GameState): Finding[] {
  const today = getUtcDayStart(state.clock.currentTime);
  const days = [today - DAY_MS, today];
  const entries = state.ledger.filter(e => days.includes(e.deliveryDay) && e.settled);
  const out: Finding[] = [];
  const gbp = (v: number) => `${v >= 0 ? '+' : '−'}£${Math.abs(v).toFixed(0)}`;

  // 1) Undeliverable contracts (shortfalls) — sizing / SoC planning errors.
  const shortfalls = entries.filter(e => Math.abs(e.deliveredMw - e.contractedMw) >= 0.5);
  if (shortfalls.length) {
    const cash = shortfalls.reduce((a, e) => a + (e.deliveredMw - e.contractedMw) * SP_HOURS * (e.imbalancePrice ?? 0), 0);
    out.push({ level: 'bad', title: `${shortfalls.length} SP(s) with undeliverable contract volume`, detail: `Sold energy you didn't have / bought more than fits: ${gbp(cash)} at SIP. Check the SoC projection before the DA gate and buy/sell back intraday before T-60.` });
  }

  // 2) Deliberate deviations: with vs against the system.
  const devs = entries.filter(e => Math.abs(e.deviationMw) >= 0.5);
  if (devs.length) {
    const nivOf = (e: typeof devs[number]) => (e.deliveryDay === today ? state.dayAhead.niv[e.period] : undefined);
    const known = devs.filter(e => nivOf(e) !== undefined);
    const helped = known.filter(e => Math.sign(e.deviationMw) === Math.sign(nivOf(e)!)); // discharge into short (+) / charge into long (−)
    const cash = devs.reduce((a, e) => a + e.deviationMw * SP_HOURS * (e.imbalancePrice ?? 0), 0);
    const hit = known.length ? Math.round((helped.length / known.length) * 100) : null;
    out.push({
      level: hit === null ? 'warn' : hit >= 60 ? 'good' : 'bad',
      title: `Imbalance calls: ${devs.length}${hit !== null ? ` · ${hit}% with the system` : ''}`,
      detail: `Deliberate deviations earned ${gbp(cash)}. ${hit !== null && hit < 60 ? 'Too many calls against the system — trade smaller or only on high-conviction signals.' : 'Keep sizing to conviction.'}`,
    });
  }

  // 3) Unfilled day-ahead orders for today.
  const results = state.dayAhead.todayResults ?? [];
  const unfilled = results.filter(r => (r.buyMw > 0 && !r.buyFilled) || (r.sellMw > 0 && !r.sellFilled)).length;
  const blockRej = (state.dayAhead.todayBlockResults ?? []).filter(r => !r.accepted).length;
  if (unfilled + blockRej > 0) {
    out.push({ level: 'warn', title: `${unfilled} DA order(s) and ${blockRej} block(s) not filled today`, detail: 'Limits too tight vs the clearing price. If only one leg of an arbitrage fills you carry the other leg as risk — linked blocks protect against that.' });
  }

  // 4) Cost drag: fees + wear vs gross.
  const p = dayPnl(state, today);
  const costs = -(p.fees + p.degradation);
  const gross = p.net + costs;
  if (p.throughputMwh > 10) {
    const perMwh = p.net / p.throughputMwh;
    out.push({
      level: perMwh < 5 ? 'bad' : perMwh < 20 ? 'warn' : 'good',
      title: `Net £${perMwh.toFixed(1)} per MWh cycled today`,
      detail: `Costs (fees + wear) ate ${gross > 0 ? Math.round((costs / gross) * 100) : 100}% of gross. ${perMwh < 5 ? 'Cycling for thin spreads mostly wears the battery — sometimes idle is right.' : 'Spread captured comfortably exceeds costs.'}`,
    });
  }

  if (out.length === 0) out.push({ level: 'good', title: 'Nothing to flag yet', detail: 'Patterns appear once SPs with your activity have settled.' });
  return out;
}
