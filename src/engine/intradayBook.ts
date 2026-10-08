// GB continuous intraday market (EPEX/Nord Pool style), educational scale.
//
// - One product per half-hour SP (today, and tomorrow once the DA auction cleared).
// - Each product has a limit order book around a mid price. The mid follows an
//   AR(1) process around a fundamental anchor: the product's DA price, drifting
//   partly toward the eventual imbalance outcome as delivery approaches (the
//   market aggregates new wind/demand information). Noise is large far out and
//   shrinks near delivery, so the mid is informative but never an oracle.
// - Spreads widen and depth thins toward gate closure and overnight.
// - Market / IOC / FOK orders cross the book (walk the levels, VWAP fills).
//   Limit orders cross what they can and rest; resting orders fill when the
//   market moves through them or probabilistically against simulated flow
//   (pay-as-bid: a resting order fills at its own limit).
// - Trading stops at gate closure T-60 (BM Gate Closure): working orders expire.

import type { GameState, IdOrder, IdOrderType, IdFill, IntradayState, LiveNews } from './types';
import { OrderSide } from './types';
import type { TradePosition } from './ukMarket';
import { mulberry32 } from './ukMarket';
import { ID_GATE_CLOSURE_MS, HALF_HOUR_MS, HOUR_MS, getUtcDayStart } from './clock';

export const BOOK_LEVELS = 5;
const HISTORY_LEN = 24;

export interface BookLevel { price: number; mw: number }
export interface OrderBook {
  bids: BookLevel[]; // best first (highest)
  asks: BookLevel[]; // best first (lowest)
  mid: number;
  halfSpread: number;
}

export function productKey(day: number, sp: number): string {
  return `${day}:${sp}`;
}

export function productStart(day: number, sp: number): number {
  return day + sp * HALF_HOUR_MS;
}

export function createIntradayState(): IntradayState {
  return { mids: {}, devs: {}, midHistory: {}, orders: [], fills: [], taken: {}, seq: 0 };
}

function hashSeed(key: string, time: number): number {
  let h = 2166136261 ^ Math.floor(time / 60000);
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 0;
}

function round2(v: number): number { return Math.round(v * 100) / 100; }
function round1(v: number): number { return Math.round(v * 10) / 10; }

/** Reference data for a product: its DA price and the (hidden) imbalance outcome. */
type ShockState = 'none' | 'hidden' | 'known';

/** Is this product inside an unforeseen shock window, and has the news broken yet? */
function shockState(news: LiveNews[] | undefined, day: number, sp: number, now: number): ShockState {
  const n = (news ?? []).find(x => x.shock && sp >= x.shock.fromSp && sp <= x.shock.toSp);
  if (!n) return 'none';
  return now >= day + n.sp * HALF_HOUR_MS ? 'known' : 'hidden';
}

export function productRef(state: GameState, day: number, sp: number): { da: number; sip: number; shock: ShockState } | null {
  const today = getUtcDayStart(state.clock.currentTime);
  const now = state.clock.currentTime;
  if (day === today) {
    return { da: state.dayAhead.forecastPrices[sp] ?? 0, sip: state.dayAhead.sipOutturn[sp] ?? 0, shock: shockState(state.dayAhead.todayNews, day, sp, now) };
  }
  if (day === state.nextDay.day) {
    if (state.dayAhead.isAuctionOpen) return null; // D+1 products open once the DA auction cleared
    return { da: state.nextDay.daClearing[sp] ?? 0, sip: state.nextDay.sipOutturn[sp] ?? 0, shock: shockState(state.nextDay.liveNews, day, sp, now) };
  }
  return null;
}

/** Is the product open for trading now? (exists and before gate closure T-60) */
export function isProductOpen(state: GameState, day: number, sp: number): boolean {
  if (sp < 0 || sp > 47) return false;
  if (!productRef(state, day, sp)) return false;
  return state.clock.currentTime < productStart(day, sp) - ID_GATE_CLOSURE_MS;
}

/** All products currently open, in delivery order. */
export function openProducts(state: GameState): { day: number; sp: number }[] {
  const today = getUtcDayStart(state.clock.currentTime);
  const days = state.nextDay.day !== today ? [today, state.nextDay.day] : [today];
  const out: { day: number; sp: number }[] = [];
  for (const day of days) {
    for (let sp = 0; sp < 48; sp++) if (isProductOpen(state, day, sp)) out.push({ day, sp });
  }
  return out;
}

function hoursToDelivery(now: number, day: number, sp: number): number {
  return Math.max(0, (productStart(day, sp) - now) / HOUR_MS);
}

function anchorPrice(da: number, sip: number, h: number, shock: ShockState = 'none'): number {
  // An unforeseen shock (e.g. a trip) is invisible to the market until the news
  // breaks — then intraday reprices hard toward the new system state.
  if (shock === 'hidden') return da;
  if (shock === 'known') return da + 0.8 * (sip - da);
  // Otherwise information about the imbalance outcome arrives as delivery approaches.
  const w = 1 / (1 + h / 2);
  return da + 0.5 * w * (sip - da);
}

function liquidity(sp: number, h: number): number {
  const night = sp < 12 ? 0.6 : 1; // 00:00-06:00 thinner
  const nearGate = h < 3 ? 0.55 + 0.15 * h : 1;
  return night * nearGate;
}

/** Build the order book of a product at time `now` (pure; depends on mid + time). */
export function buildBook(state: GameState, day: number, sp: number, now = state.clock.currentTime): OrderBook | null {
  const ref = productRef(state, day, sp);
  if (!ref) return null;
  const key = productKey(day, sp);
  const h = hoursToDelivery(now, day, sp);
  const mid = state.intraday.mids[key] ?? anchorPrice(ref.da, ref.sip, h, ref.shock);
  const liq = liquidity(sp, h);
  const halfSpread = round2((0.4 + 0.012 * Math.abs(mid)) * (1 + 2 / (1 + h)) / Math.max(0.5, liq));
  const step = 0.5 + 0.004 * Math.abs(mid);
  const rng = mulberry32(hashSeed(key, now));
  const taken = state.intraday.taken[key];
  let takenBid = taken && taken.time === now ? taken.bid : 0;
  let takenAsk = taken && taken.time === now ? taken.ask : 0;
  const bids: BookLevel[] = [];
  const asks: BookLevel[] = [];
  for (let i = 0; i < BOOK_LEVELS; i++) {
    const baseVol = 12 * liq * (1 + 0.6 * i);
    let bidMw = round1(baseVol * (0.7 + 0.6 * rng()));
    let askMw = round1(baseVol * (0.7 + 0.6 * rng()));
    const useBid = Math.min(bidMw, takenBid); bidMw = round1(bidMw - useBid); takenBid -= useBid;
    const useAsk = Math.min(askMw, takenAsk); askMw = round1(askMw - useAsk); takenAsk -= useAsk;
    bids.push({ price: round2(mid - halfSpread - i * step), mw: bidMw });
    asks.push({ price: round2(mid + halfSpread + i * step), mw: askMw });
  }
  return { bids: bids.filter((l) => l.mw > 0), asks: asks.filter((l) => l.mw > 0), mid: round2(mid), halfSpread };
}

/** Net contracted MW (DA + ID) of a product: + = sell/discharge, − = buy/charge. */
export function netPositionMw(state: GameState, day: number, sp: number): number {
  return state.dayAhead.playerSchedule
    .filter((p) => p.deliveryDay === day && p.period === sp)
    .reduce((acc, p) => acc + (p.action === 'discharge' ? p.mw : -p.mw), 0);
}

/** MW of working (resting) intraday orders on one side of a product. */
export function workingIdMw(state: GameState, day: number, sp: number, side: OrderSide): number {
  return state.intraday.orders
    .filter((o) => o.status === 'working' || o.status === 'partial')
    .filter((o) => o.deliveryDay === day && o.period === sp && o.side === side)
    .reduce((a, o) => a + (o.qtyMw - o.filledMw), 0);
}

/** MW still pending in the open 30-min DA auction (orders + blocks) for one side of an SP. */
function pendingHalfHourMw(state: GameState, day: number, sp: number, side: OrderSide): number {
  const d = state.dayAhead;
  if (!d.hhAuctionOpen || day !== d.deliveryDay) return 0;
  const bids = (d.hhBids ?? []).filter((b) => b.sp === sp && b.side === side).reduce((a, b) => a + b.volumeMw, 0);
  const blocks = (d.blocks ?? []).filter((b) => b.auction === 'half' && b.side === side && sp >= b.startSp && sp <= b.endSp)
    .reduce((a, b) => a + b.volumeMw, 0);
  return bids + blocks;
}

/**
 * Room for a new order in MW given the power rating, contracts, working
 * intraday orders and orders still pending in the 30-min DA auction — every
 * one of them could fill, so all of them count against the limit.
 */
export function orderRoomMw(state: GameState, day: number, sp: number, side: OrderSide): number {
  const p = state.battery.config.powerRatingMw;
  const net = netPositionMw(state, day, sp);
  const reserved = workingIdMw(state, day, sp, side) + pendingHalfHourMw(state, day, sp, side);
  const room = side === OrderSide.SELL ? p - net : p + net;
  return Math.max(0, round1(room - reserved));
}

interface FillResult { fills: { mw: number; price: number }[]; filled: number }

function walkBook(levels: BookLevel[], side: OrderSide, qty: number, limit: number | null): FillResult {
  const fills: { mw: number; price: number }[] = [];
  let remaining = qty;
  for (const lvl of levels) {
    if (remaining <= 0) break;
    if (limit !== null && (side === OrderSide.BUY ? lvl.price > limit : lvl.price < limit)) break;
    const mw = round1(Math.min(remaining, lvl.mw));
    if (mw <= 0) continue;
    fills.push({ mw, price: lvl.price });
    remaining = round1(remaining - mw);
  }
  return { fills, filled: round1(qty - remaining) };
}

function applyFills(
  state: GameState,
  order: IdOrder,
  fills: { mw: number; price: number }[],
  aggressor: boolean,
): GameState {
  if (fills.length === 0) return state;
  const now = state.clock.currentTime;
  const positions: TradePosition[] = fills.map((f) => ({
    period: order.period,
    deliveryDay: order.deliveryDay,
    market: 'id',
    action: order.side === OrderSide.BUY ? 'charge' : 'discharge',
    mw: f.mw,
    price: f.price,
    lockedAt: now,
  }));
  const idFills: IdFill[] = fills.map((f) => ({
    orderId: order.id, deliveryDay: order.deliveryDay, period: order.period,
    side: order.side, mw: f.mw, price: f.price, time: now, aggressor,
  }));
  const key = productKey(order.deliveryDay, order.period);
  const prevTaken = state.intraday.taken[key];
  const base = prevTaken && prevTaken.time === now ? prevTaken : { time: now, bid: 0, ask: 0 };
  const takenMw = fills.reduce((a, f) => a + f.mw, 0);
  const taken = aggressor
    ? { ...state.intraday.taken, [key]: order.side === OrderSide.BUY ? { ...base, ask: base.ask + takenMw } : { ...base, bid: base.bid + takenMw } }
    : state.intraday.taken;
  return {
    ...state,
    dayAhead: { ...state.dayAhead, playerSchedule: [...state.dayAhead.playerSchedule, ...positions] },
    intraday: { ...state.intraday, fills: [...state.intraday.fills, ...idFills].slice(-500), taken },
  };
}

function withOrderFill(order: IdOrder, fills: { mw: number; price: number }[], now: number): IdOrder {
  const add = fills.reduce((a, f) => a + f.mw, 0);
  if (add <= 0) return order;
  const filledMw = round1(order.filledMw + add);
  const avgFillPrice = round2((order.avgFillPrice * order.filledMw + fills.reduce((a, f) => a + f.mw * f.price, 0)) / filledMw);
  return { ...order, filledMw, avgFillPrice, updatedAt: now, status: filledMw >= order.qtyMw - 0.05 ? 'filled' : 'partial' };
}

export interface PlaceOrderInput {
  deliveryDay: number;
  period: number;
  side: OrderSide;
  type: IdOrderType;
  qtyMw: number;
  limitPrice?: number | null;
}

/** Place an intraday order. Always records the order (rejected ones with a note). */
export function placeIdOrder(state: GameState, input: PlaceOrderInput): GameState {
  const now = state.clock.currentTime;
  const seq = state.intraday.seq + 1;
  let order: IdOrder = {
    id: `ID-${seq}`,
    deliveryDay: input.deliveryDay,
    period: input.period,
    side: input.side,
    type: input.type,
    limitPrice: input.type === 'market' ? null : (input.limitPrice ?? null),
    qtyMw: round1(input.qtyMw),
    filledMw: 0,
    avgFillPrice: 0,
    status: 'working',
    createdAt: now,
    updatedAt: now,
  };
  const reject = (note: string): GameState => ({
    ...state,
    intraday: { ...state.intraday, seq, orders: [...state.intraday.orders, { ...order, status: 'rejected', note }] },
  });

  if (!(order.qtyMw > 0)) return reject('Quantity must be positive');
  if (order.type !== 'market' && (order.limitPrice === null || !Number.isFinite(order.limitPrice))) return reject('Limit price required');
  if (!isProductOpen(state, order.deliveryDay, order.period)) return reject('Product closed (gate closure T-60 or not open yet)');
  const room = orderRoomMw(state, order.deliveryDay, order.period, order.side);
  if (order.qtyMw > room + 1e-9) return reject(`Exceeds power limit: max ${room.toFixed(1)} MW on this side`);

  const book = buildBook(state, order.deliveryDay, order.period);
  if (!book) return reject('No order book');
  const levels = order.side === OrderSide.BUY ? book.asks : book.bids;
  const crossLimit = order.type === 'market' ? null : order.limitPrice;
  const walk = walkBook(levels, order.side, order.qtyMw, crossLimit);

  if (order.type === 'fok' && walk.filled < order.qtyMw - 0.05) {
    order = { ...order, status: 'cancelled', note: 'FOK: not enough liquidity at your limit — nothing filled' };
    return { ...state, intraday: { ...state.intraday, seq, orders: [...state.intraday.orders, order] } };
  }

  order = withOrderFill(order, walk.fills, now);
  const next = applyFills(state, order, walk.fills, true);
  if (order.status !== 'filled' && (order.type === 'market' || order.type === 'ioc')) {
    // Market/IOC never rest: whatever the book couldn't fill is cancelled.
    const why = order.type === 'market' ? 'book exhausted' : 'no more liquidity at your limit';
    order = {
      ...order,
      status: 'cancelled',
      note: order.filledMw > 0 ? `Filled ${order.filledMw} MW, rest cancelled (${why})` : `Nothing filled (${why})`,
    };
  }
  // Limit orders: the remainder rests in the book (status working/partial).
  return { ...next, intraday: { ...next.intraday, seq, orders: [...next.intraday.orders, order] } };
}

export function cancelIdOrder(state: GameState, orderId: string): GameState {
  const now = state.clock.currentTime;
  return {
    ...state,
    intraday: {
      ...state.intraday,
      orders: state.intraday.orders.map((o) =>
        o.id === orderId && (o.status === 'working' || o.status === 'partial')
          ? { ...o, status: 'cancelled', updatedAt: now, note: o.filledMw > 0 ? `Cancelled after ${o.filledMw} MW filled` : 'Cancelled' }
          : o),
    },
  };
}

/**
 * Advance the intraday market by one tick: move every open product's mid,
 * expire orders past gate closure, and match resting orders against the new book.
 */
export function tickIntraday(state: GameState): GameState {
  const now = state.clock.currentTime;
  const mids = { ...state.intraday.mids };
  const devs = { ...state.intraday.devs };
  const midHistory = { ...state.intraday.midHistory };
  const today = getUtcDayStart(now);

  // Drop products of past days.
  for (const key of Object.keys(mids)) {
    const day = Number(key.split(':')[0]);
    if (day < today) { delete mids[key]; delete devs[key]; delete midHistory[key]; }
  }

  for (const { day, sp } of openProducts(state)) {
    const ref = productRef(state, day, sp)!;
    const key = productKey(day, sp);
    const h = hoursToDelivery(now, day, sp);
    const rng = mulberry32(hashSeed(key, now) + 77);
    const sigma = (1 + 0.02 * Math.abs(ref.da)) * (0.8 + 1.2 / (1 + h));
    const dev = 0.85 * (devs[key] ?? 0) + (rng() - 0.5) * 2 * sigma;
    devs[key] = dev;
    mids[key] = round2(anchorPrice(ref.da, ref.sip, h, ref.shock) + dev);
    midHistory[key] = [...(midHistory[key] ?? []), mids[key]].slice(-HISTORY_LEN);
  }

  let next: GameState = { ...state, intraday: { ...state.intraday, mids, devs, midHistory, taken: {} } };

  for (const o of state.intraday.orders) {
    if (o.status !== 'working' && o.status !== 'partial') continue;
    if (!isProductOpen(next, o.deliveryDay, o.period)) {
      next = updateOrder(next, { ...o, status: 'expired', updatedAt: now, note: o.filledMw > 0 ? `Gate closed — ${o.filledMw} MW filled, rest expired` : 'Gate closed (T-60) — expired' });
      continue;
    }
    const book = buildBook(next, o.deliveryDay, o.period);
    if (!book || o.limitPrice === null) continue;
    const remaining = round1(o.qtyMw - o.filledMw);
    // 1) Market moved through the limit: fill at the order's limit (pay-as-bid).
    const crossing = o.side === OrderSide.BUY ? book.asks : book.bids;
    const crossed = walkBook(crossing, o.side, remaining, o.limitPrice);
    let fills = crossed.fills.map((f) => ({ mw: f.mw, price: o.limitPrice! }));
    const left = round1(remaining - crossed.filled);
    // 2) Passive fill against simulated counter-flow; likelier the closer to the touch.
    if (left > 0) {
      const touch = o.side === OrderSide.BUY ? (book.bids[0]?.price ?? book.mid) : (book.asks[0]?.price ?? book.mid);
      const behind = o.side === OrderSide.BUY ? touch - o.limitPrice : o.limitPrice - touch; // >0 = behind the touch
      const p = behind <= 0 ? 0.55 : 0.4 * Math.exp(-behind / Math.max(0.5, book.halfSpread));
      const rng = mulberry32(hashSeed(o.id, now) + 5);
      if (rng() < p) {
        const mw = Math.max(0.1, round1(left * (0.3 + 0.7 * rng())));
        fills = [...fills, { mw: Math.min(mw, left), price: o.limitPrice }];
      }
    }
    if (fills.length) {
      const updated = withOrderFill(o, fills, now);
      next = applyFills(next, updated, fills, false);
      next = updateOrder(next, updated);
    }
  }
  return next;
}

function updateOrder(state: GameState, order: IdOrder): GameState {
  return {
    ...state,
    intraday: { ...state.intraday, orders: state.intraday.orders.map((o) => (o.id === order.id ? order : o)) },
  };
}

/** Initialise mids for products that have none yet (e.g. right after load or DA clearing). */
export function ensureMids(state: GameState): GameState {
  const now = state.clock.currentTime;
  let mids = state.intraday.mids;
  let changed = false;
  for (const { day, sp } of openProducts(state)) {
    const key = productKey(day, sp);
    if (mids[key] !== undefined) continue;
    const ref = productRef(state, day, sp)!;
    if (!changed) { mids = { ...mids }; changed = true; }
    mids[key] = round2(anchorPrice(ref.da, ref.sip, hoursToDelivery(now, day, sp), ref.shock));
  }
  return changed ? { ...state, intraday: { ...state.intraday, mids } } : state;
}
