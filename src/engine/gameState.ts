import type { GameState, DayAheadBid, DayAheadState, BmDirection, BmOffer, BmState, MarketDay, DaBlockOrder, HalfHourBid, DeskHints, LiveNews, MarketEvent, AssetType, BmStandingOrder, BmAcceptance } from './types';
import { OrderSide, GameMode } from './types';
import { createClock, tick, getGateClosureTime, getHalfHourGateClosureTime, getSettlementPeriod, getUtcDayStart, SUB_STEP_MS, HALF_HOUR_MS, ID_GATE_CLOSURE_MS } from './clock';
import { createPriceGenerator, generateNextHour } from './priceGenerator';
import type { PriceGeneratorState } from './priceGenerator';
import { createBattery } from './battery';
import { generateFullAnalysis, imbalanceSettlementPrice, nivForecastError } from './ukMarket';
import type { TradePosition } from './ukMarket';
import { maybeGenerateEvent } from './events';
import { modeTickEffects } from './modes';
import type { BatteryConfig } from './battery';
import { syntheticMarketDay, nextDayFrom, scenarioMarketDay, withDeskForecast, leadInDay } from './marketDay';
import { clearHourlyAuction, sanitizeBids, clearBlocks, validateBlock, buildHalfHourForecast, clearHalfHourAuction, sanitizeHalfHourBids, powerViolations, hourlyToSp } from './dayAheadAuction';
import { deliverPeriod, settlePeriod, applyDeviation, analysisPositions, setDeviationSetpoint, signedMw } from './settlement';
import { createIntradayState, tickIntraday, ensureMids, placeIdOrder, cancelIdOrder, workingIdMw } from './intradayBook';
import type { PlaceOrderInput } from './intradayBook';

interface InternalState extends GameState {
  _priceGenState: PriceGeneratorState;
}

const DAY_MS = 86_400_000;

/**
 * Day-ahead/market state at the START of a day: `today` is the delivery day now
 * running (its DA prices cleared yesterday), `next` is the day the auction that
 * opens now is for. The two are kept strictly separate.
 */
function dayAheadForDay(
  today: MarketDay,
  next: MarketDay,
  currentTime: number,
  playerSchedule: TradePosition[],
): DayAheadState {
  return {
    bids: [],
    results: [],
    gateClosureTime: getGateClosureTime(currentTime),
    isAuctionOpen: true,
    deliveryDay: next.day,
    nextDeliveryDay: next.day,
    todaySource: today.source,
    todayNews: today.liveNews ?? [],
    forecastPrices: today.daClearing,
    sipOutturn: today.sipOutturn,
    niv: today.niv,
    demandForecast: today.demandForecast,
    windForecast: today.windForecast,
    solarForecast: today.solarForecast,
    demandOutturn: today.demandOutturn,
    windOutturn: today.windOutturn,
    solarOutturn: today.solarOutturn,
    revealedPeriods: Math.max(0, getSettlementPeriod(currentTime) - 1),
    playerSchedule,
    blocks: [],
    blockResults: [],
    hhBids: [],
    hhResults: [],
    hhGateClosureTime: getHalfHourGateClosureTime(currentTime),
    hhAuctionOpen: false,
  };
}


function createBmState(): BmState {
  return { offers: [], accepted: [] };
}

export function createGameState(): GameState {
  const clock = createClock();
  const priceGen = createPriceGenerator();
  const { price: initialPrice, newState: newPriceGen } = generateNextHour(priceGen, clock.currentTime);
  const day = getUtcDayStart(clock.currentTime);
  const today = syntheticMarketDay(day, priceGen.seed);
  const next = nextDayFrom(today, priceGen.seed + 1);

  const state: InternalState = {
    clock: { ...clock, speed: 'slow' },
    priceHistory: [initialPrice],
    currentPrice: initialPrice,
    battery: createBattery(),
    trades: [],
    events: [],
    mode: GameMode.ARBITRAGE,
    tutorial: { currentStep: 0, isActive: false, completed: true },
    dayAhead: dayAheadForDay(today, next, clock.currentTime, []),
    bm: createBmState(),
    analysis: null,
    triadAlert: false,
    nextDay: next,
    intraday: createIntradayState(),
    ledger: [],
    _priceGenState: newPriceGen,
  };

  return ensureMids(state);
}

/**
 * Start a fresh session on `today` (00:00) with `next` as the auction's
 * delivery day. Used for live data and scenarios.
 */
export function loadMarketDays(state: GameState, today: MarketDay, nextIn: MarketDay): GameState {
  const next = nextIn.signals ? nextIn : withDeskForecast(nextIn, Math.floor(nextIn.day / DAY_MS));
  const clock = createClock(new Date(today.day));
  const firstSip = today.sipOutturn[0] ?? 0;
  const initialPrice = {
    timestamp: clock.currentTime,
    // The cockpit price before the first tick: today's DA price (the SIP of SP1 isn't known yet).
    price: today.daClearing[0] ?? firstSip,
    demandMw: 30000,
    renewablePct: 0.25,
    basePrice: today.daClearing[0] ?? firstSip,
    eventImpact: 0,
  };
  return ensureMids({
    ...state,
    clock: { ...clock, speed: 'slow' },
    priceHistory: [initialPrice],
    currentPrice: initialPrice,
    battery: createBattery(state.battery.config),
    trades: [],
    events: [],
    bm: createBmState(),
    analysis: null,
    triadAlert: false,
    dayAhead: dayAheadForDay(today, next, clock.currentTime, []),
    nextDay: next,
    intraday: createIntradayState(),
    ledger: [],
    scenario: null,
    // A new session starts with an empty BM book (no BOAs from a previous run).
    bmBook: [],
    bmAcceptances: [],
  });
}

/**
 * Replace the next delivery day's data (e.g. with real Elexon data that just
 * arrived). Only while its auction is still open — never after clearing.
 */
export function replaceNextDay(state: GameState, next: MarketDay): GameState {
  if (next.day !== state.nextDay.day || !state.dayAhead.isAuctionOpen) return state;
  return { ...state, nextDay: withDeskForecast(next, Math.floor(next.day / DAY_MS)) };
}

export function tickGameState(state: GameState): GameState {
  const gs = state as InternalState;
  const newClock = tick(gs.clock);
  if (newClock.currentTime === gs.clock.currentTime) return gs;
  const now = newClock.currentTime;

  const priceGenState = gs._priceGenState ?? createPriceGenerator();
  const { price: syntheticPrice, newState: newPriceGen } = generateNextHour(priceGenState, now);

  let s: GameState = { ...gs, clock: newClock as GameState['clock'] };

  // 1) Settle the SP that just ended at its (now published) SIP — using the data
  //    of the day it belonged to, before any day rollover.
  const prevDay = getUtcDayStart(gs.clock.currentTime);
  const prevSp = getSettlementPeriod(gs.clock.currentTime) - 1;
  s = settlePeriod(s, prevDay, prevSp, gs.dayAhead.sipOutturn[prevSp] ?? 0);

  // 2) Midnight: tomorrow becomes today, a new auction opens for the day after.
  const currentDayStart = getUtcDayStart(now);
  if (currentDayStart !== prevDay) {
    const today = s.nextDay.day === currentDayStart ? s.nextDay : syntheticMarketDay(currentDayStart, priceGenState.seed + newPriceGen.tickCount);
    const next = nextDayFrom(today, priceGenState.seed + newPriceGen.tickCount + 1);
    const carried = s.dayAhead.playerSchedule.filter(p => !p.delivered && p.deliveryDay >= currentDayStart);
    const cleared = s.nextDay.day === currentDayStart;
    s = {
      ...s,
      dayAhead: {
        ...dayAheadForDay(today, next, now, carried),
        todayForecast: cleared ? s.nextDay.daForecast : undefined,
        todayResults: cleared ? s.dayAhead.results : undefined,
        todayBids: cleared ? s.dayAhead.bids : undefined,
        todayBlocks: cleared ? s.dayAhead.blocks : undefined,
        todayBlockResults: cleared ? s.dayAhead.blockResults : undefined,
        todayHhBids: cleared ? s.dayAhead.hhBids : undefined,
        todayHhResults: cleared ? s.dayAhead.hhResults : undefined,
      },
      nextDay: next,
      bm: createBmState(),
      ledger: s.ledger.filter(e => e.deliveryDay >= currentDayStart - DAY_MS),
      bmBook: (s.bmBook ?? []).filter(b => b.day >= currentDayStart),
      bmAcceptances: (s.bmAcceptances ?? []).filter(a => a.day >= currentDayStart - DAY_MS),
    };
  }

  // 3) SPs that have ended today are revealed (SIP/NIV published ex-post).
  const currentSp = getSettlementPeriod(now) - 1;
  s = { ...s, dayAhead: { ...s.dayAhead, revealedPeriods: currentSp } };

  // 4) DA gate closure 09:20 UK: clear the blind hourly auction (orders + blocks),
  //    pay-as-cleared. Then the EPEX 30-min auction opens until 15:30 UK.
  if (s.dayAhead.isAuctionOpen && s.dayAhead.gateClosureTime && now >= s.dayAhead.gateClosureTime) {
    const { results, positions } = clearHourlyAuction(s.dayAhead.bids, s.nextDay, now);
    const blocks = clearBlocks(s.dayAhead.blocks ?? [], s.nextDay, 'hourly', now);
    s = {
      ...s,
      nextDay: { ...s.nextDay, daForecastHH: buildHalfHourForecast(s.nextDay, Math.floor(s.nextDay.day / DAY_MS)) },
      dayAhead: {
        ...s.dayAhead,
        results,
        blockResults: blocks.results,
        isAuctionOpen: false,
        hhAuctionOpen: true,
        playerSchedule: [...s.dayAhead.playerSchedule, ...positions, ...blocks.positions],
      },
    };
  }

  // 4b) 30-min auction gate closure 15:30 UK.
  if (s.dayAhead.hhAuctionOpen && s.dayAhead.hhGateClosureTime && now >= s.dayAhead.hhGateClosureTime) {
    const { results, positions } = clearHalfHourAuction(s.dayAhead.hhBids ?? [], s.nextDay, now);
    const blocks = clearBlocks(s.dayAhead.blocks ?? [], s.nextDay, 'half', now);
    s = {
      ...s,
      dayAhead: {
        ...s.dayAhead,
        hhResults: results,
        blockResults: [...(s.dayAhead.blockResults ?? []), ...blocks.results],
        hhAuctionOpen: false,
        playerSchedule: [...s.dayAhead.playerSchedule, ...positions, ...blocks.positions],
      },
    };
  }

  // 5) BM unit: NESO issues BOAs against your standing bids/offers for this SP,
  //    then the SP is delivered (net contracts incl. BOAs, one dispatch).
  s = acceptBmOrders(s, currentDayStart, currentSp, now);
  s = deliverPeriod(s, currentDayStart, currentSp);

  // 6) Intraday market moves; resting orders match or expire at T-60.
  s = ensureMids(tickIntraday(s));

  // 7) News breaking in the SP that starts now (e.g. an interconnector trip).
  const breaking: MarketEvent[] = (s.dayAhead.todayNews ?? [])
    .filter((n: LiveNews) => n.sp === currentSp)
    .map((n: LiveNews, i: number) => ({
      id: `live-${currentDayStart}-${n.sp}-${i}`,
      timestamp: now,
      headline: n.headline,
      description: '',
      priceImpact: 0,
      category: n.category,
    }));

  // Current price shown in the cockpit: today's DA price for the running SP
  // (the SIP is only known after the SP ends).
  const daNow = s.dayAhead.forecastPrices[currentSp];
  const newPrice = Number.isFinite(daNow) && daNow !== 0
    ? { ...syntheticPrice, price: daNow, basePrice: daNow }
    : syntheticPrice;

  const event = maybeGenerateEvent(now, newPrice, newPriceGen.tickCount);
  const newEvents = [...breaking, ...(event ? [event] : []), ...s.events].slice(0, 50);
  let battery = s.battery;
  const dayAhead = s.dayAhead;
  let analysis = gs.analysis;
  const bm = s.bm;
  const newClock_ = newClock;
  // Triad alert (Nov-Feb, 4-7pm weekday, cold/low wind)
  const d = new Date(newClock_.currentTime);
  const month = d.getUTCMonth();
  const dow = d.getUTCDay();
  const hr = d.getUTCHours();
  const isTriadWindow = (month >= 10 || month <= 1) && dow > 0 && dow < 6 && hr >= 16 && hr <= 19;
  const triadAlert = isTriadWindow && newPrice.renewablePct < 0.2;

  // Mode-specific effects (frequency events, BOAs, triad warnings)
  const modeEffects = modeTickEffects(
    { ...s, currentPrice: newPrice, battery },
    newPriceGen.tickCount,
  );

  // Apply mode events
  const allEvents = [...newEvents, ...modeEffects.events].slice(0, 60);

  // Apply frequency response availability payment to battery revenue
  if (modeEffects.availabilityPayment > 0) {
    battery = {
      ...battery,
      totalDischargeRevenue: battery.totalDischargeRevenue + modeEffects.availabilityPayment,
    };
  }

  // Post-trade analysis of today's settled SPs (net position per SP).
  if (dayAhead.revealedPeriods >= 4) {
    analysis = generateFullAnalysis(
      analysisPositions({ ...s, battery }, currentDayStart),
      dayAhead.forecastPrices,
      dayAhead.sipOutturn,
      dayAhead.niv,
      battery.config.capacityMwh,
      battery.config.powerRatingMw,
      battery.config.efficiencyPct / 100,
      dayAhead.revealedPeriods,
    );
  }

  const priceHistory = [...gs.priceHistory, newPrice].slice(-168);

  return {
    ...s,
    priceHistory,
    currentPrice: newPrice,
    battery,
    events: allEvents,
    mode: gs.mode,
    tutorial: gs.tutorial,
    dayAhead,
    bm,
    analysis,
    triadAlert: triadAlert || !!modeEffects.triadWarning,
    _priceGenState: newPriceGen,
  } as InternalState;
}

export function stepForwardAction(state: GameState): GameState {
  const gs = state as InternalState;
  // Use tickGameState but temporarily unpause
  const unpaused = { ...gs, clock: { ...gs.clock, isPaused: false } } as InternalState;
  const result = tickGameState(unpaused);
  // Re-apply the original pause state
  return { ...result, clock: { ...result.clock, isPaused: gs.clock.isPaused } };
}

/**
 * EXPECTED SIP of the running SP (model on the NIV forecast) — for the cycle-log
 * display only. The actual SIP is unknown until the SP ends.
 */
function runningSpSip(state: GameState): number {
  const sp = getSettlementPeriod(state.clock.currentTime) - 1;
  const dayIdx = Math.floor(getUtcDayStart(state.clock.currentTime) / DAY_MS);
  return imbalanceSettlementPrice(state.dayAhead.forecastPrices[sp] ?? 0, (state.dayAhead.niv[sp] ?? 0) + nivForecastError(sp, dayIdx));
}

// ===== Intra-SP control (non-BM assets) =====

/** Advance 5 minutes within the running SP; at the last interval move to the next SP. */
export function subStepAction(state: GameState): GameState {
  const now = state.clock.currentTime;
  const next = now + SUB_STEP_MS;
  if (Math.floor(next / HALF_HOUR_MS) !== Math.floor(now / HALF_HOUR_MS)) return stepForwardAction(state);
  return { ...state, clock: { ...state.clock, currentTime: next } };
}

/**
 * Set the deliberate deviation set point (MW, + = discharge more) for the rest
 * of the running SP — like a real optimiser steering output within the period.
 */
export function setDeviationAction(state: GameState, setpointMw: number): GameState {
  const day = getUtcDayStart(state.clock.currentTime);
  const sp = getSettlementPeriod(state.clock.currentTime) - 1;
  return setDeviationSetpoint(state, day, sp, setpointMw, runningSpSip(state));
}

// ===== Balancing Mechanism (BM units) =====

export function setAssetTypeAction(state: GameState, assetType: AssetType): GameState {
  return { ...state, assetType };
}

/** Set / replace your standing BM bid-offer pair for one SP (until gate closure T-60). */
export function setBmOrderAction(state: GameState, order: BmStandingOrder): GameState {
  const start = order.day + order.sp * HALF_HOUR_MS;
  if (state.clock.currentTime >= start - ID_GATE_CLOSURE_MS) return state; // BM gate closure
  const P = state.battery.config.powerRatingMw;
  const clean: BmStandingOrder = {
    ...order,
    offerMw: Math.max(0, Math.min(P, Number.isFinite(order.offerMw) ? order.offerMw : 0)),
    bidMw: Math.max(0, Math.min(P, Number.isFinite(order.bidMw) ? order.bidMw : 0)),
    offerPrice: order.offerPrice != null && Number.isFinite(order.offerPrice) ? order.offerPrice : null,
    bidPrice: order.bidPrice != null && Number.isFinite(order.bidPrice) ? order.bidPrice : null,
  };
  const book = (state.bmBook ?? []).filter(b => !(b.day === order.day && b.sp === order.sp));
  const empty = (clean.offerMw === 0 || clean.offerPrice === null) && (clean.bidMw === 0 || clean.bidPrice === null);
  return { ...state, bmBook: empty ? book : [...book, clean] };
}

/**
 * NESO's decision at the start of an SP (simplified merit order): when the
 * system is short it accepts offers priced at or below the marginal price
 * (the SIP); when long it accepts bids priced at or above it. Accepted volume
 * is limited by power and SoC. A BOA changes your contracted position (no
 * imbalance) and is paid at YOUR price (pay-as-bid).
 */
function acceptBmOrders(state: GameState, day: number, sp: number, now: number): GameState {
  if (state.assetType !== 'bm') return state;
  const order = (state.bmBook ?? []).find(b => b.day === day && b.sp === sp);
  if (!order) return state;
  const niv = state.dayAhead.niv[sp] ?? 0;
  const sip = state.dayAhead.sipOutturn[sp] ?? 0;
  const { powerRatingMw: P, capacityMwh: cap, efficiencyPct } = state.battery.config;
  const eff = efficiencyPct / 100;
  const net = state.dayAhead.playerSchedule
    .filter(p => !p.delivered && p.deliveryDay === day && p.period === sp)
    .reduce((a, p) => a + signedMw(p), 0);
  const soc = state.battery.currentSocMwh;
  const socAfterContract = net > 0 ? soc - net * 0.5 : soc + -net * 0.5 * eff;
  let kind: 'offer' | 'bid' | null = null;
  let mw = 0;
  let price = 0;
  if (niv > 50 && order.offerMw > 0 && order.offerPrice !== null && order.offerPrice <= sip) {
    kind = 'offer'; price = order.offerPrice;
    mw = Math.min(order.offerMw, P - net, Math.max(0, socAfterContract) / 0.5);
  } else if (niv < -50 && order.bidMw > 0 && order.bidPrice !== null && order.bidPrice >= sip) {
    kind = 'bid'; price = order.bidPrice;
    mw = Math.min(order.bidMw, P + net, Math.max(0, cap - socAfterContract) / (0.5 * eff));
  }
  mw = Math.floor(mw * 10) / 10;
  if (!kind || mw < 1) return state;
  const acc: BmAcceptance = { day, sp, kind, mw, price, time: now };
  const event: MarketEvent = {
    id: `live-boa-${day}-${sp}`,
    timestamp: now,
    headline: kind === 'offer'
      ? `NESO BOA: your offer accepted — discharge +${mw} MW at £${price.toFixed(2)}`
      : `NESO BOA: your bid accepted — charge ${mw} MW at £${price.toFixed(2)}`,
    description: '',
    priceImpact: 0,
    category: 'policy',
  };
  return {
    ...state,
    bmAcceptances: [...(state.bmAcceptances ?? []), acc].slice(-200),
    events: [event, ...state.events].slice(0, 50),
    dayAhead: {
      ...state.dayAhead,
      playerSchedule: [...state.dayAhead.playerSchedule, {
        period: sp, deliveryDay: day, market: 'bm',
        action: kind === 'offer' ? 'discharge' : 'charge', mw, price, lockedAt: now,
      }],
    },
  };
}

/**
 * Imbalance view: deliberately charge MORE than contracted in the running SP.
 * This is not a trade — it is a deviation from your notified position, settled
 * at the SIP once it is published after the SP.
 */
export function chargeBatteryAction(state: GameState, mw: number): GameState {
  const day = getUtcDayStart(state.clock.currentTime);
  const sp = getSettlementPeriod(state.clock.currentTime) - 1;
  return applyDeviation(state, day, sp, -Math.abs(mw), runningSpSip(state));
}

/** Imbalance view: deliberately discharge MORE than contracted in the running SP. */
export function dischargeBatteryAction(state: GameState, mw: number): GameState {
  const day = getUtcDayStart(state.clock.currentTime);
  const sp = getSettlementPeriod(state.clock.currentTime) - 1;
  return applyDeviation(state, day, sp, Math.abs(mw), runningSpSip(state));
}

/**
 * Submit hourly DA orders for the open auction. Orders only become positions
 * when the auction clears at gate closure (and only if the clearing price
 * meets their limit). Rejected after gate closure.
 */
export function submitDayAheadBids(state: GameState, bids: DayAheadBid[]): GameState {
  const { isAuctionOpen, gateClosureTime } = state.dayAhead;
  if (!isAuctionOpen || (gateClosureTime && state.clock.currentTime >= gateClosureTime)) return state;
  const P = state.battery.config.powerRatingMw;
  // Single orders may not push any SP beyond the power rating together with
  // the hourly blocks already submitted.
  const blocks = (state.dayAhead.blocks ?? []).filter(b => b.auction === 'hourly');
  const kept: DayAheadBid[] = [];
  for (const b of sanitizeBids([...state.dayAhead.bids, ...bids], P)) {
    if (powerViolations(hourlyToSp([...kept, b]), blocks, P).length === 0) kept.push(b);
  }
  return { ...state, dayAhead: { ...state.dayAhead, bids: kept } };
}

function auctionOpen(state: GameState, auction: 'hourly' | 'half'): boolean {
  const d = state.dayAhead;
  const now = state.clock.currentTime;
  return auction === 'hourly'
    ? d.isAuctionOpen && !(d.gateClosureTime && now >= d.gateClosureTime)
    : Boolean(d.hhAuctionOpen) && !(d.hhGateClosureTime && now >= d.hhGateClosureTime);
}

/** Submit a (possibly linked) block order to the open hourly or 30-min auction. */
export function submitBlockOrderAction(state: GameState, input: Omit<DaBlockOrder, 'id'>): GameState {
  if (!auctionOpen(state, input.auction)) return state;
  const existing = state.dayAhead.blocks ?? [];
  if (validateBlock(input, existing, state.battery.config.powerRatingMw)) return state;
  const prefix = input.auction === 'hourly' ? 'BH' : 'BQ';
  const used = existing.map(b => Number(b.id.replace(prefix, ''))).filter(Number.isFinite);
  const id = `${prefix}${Math.max(0, ...used) + 1}`;
  return { ...state, dayAhead: { ...state.dayAhead, blocks: [...existing, { ...input, id }] } };
}

/** Cancel a block (and its linked children) while its auction is open. */
export function cancelBlockOrderAction(state: GameState, id: string): GameState {
  const block = (state.dayAhead.blocks ?? []).find(b => b.id === id);
  if (!block || !auctionOpen(state, block.auction)) return state;
  return { ...state, dayAhead: { ...state.dayAhead, blocks: (state.dayAhead.blocks ?? []).filter(b => b.id !== id && b.parentId !== id) } };
}

/** Net DA position per SP already held for the auction's delivery day (+ = sell). */
function deliveryDayNet(state: GameState): number[] {
  const day = state.dayAhead.deliveryDay;
  return Array.from({ length: 48 }, (_, sp) => state.dayAhead.playerSchedule
    .filter(p => p.deliveryDay === day && p.period === sp)
    .reduce((a, p) => a + (p.action === 'discharge' ? p.mw : -p.mw), 0));
}

/** Working intraday orders for the auction's delivery day, as per-SP volumes (they may still fill). */
function workingIdOrders(state: GameState): { sp: number; side: OrderSide; volumeMw: number }[] {
  const day = state.dayAhead.deliveryDay;
  const out: { sp: number; side: OrderSide; volumeMw: number }[] = [];
  for (let sp = 0; sp < 48; sp++) {
    for (const side of [OrderSide.BUY, OrderSide.SELL]) {
      const mw = workingIdMw(state, day, sp, side);
      if (mw > 0) out.push({ sp, side, volumeMw: mw });
    }
  }
  return out;
}

/**
 * Set the full list of block orders for one auction (submitted together with
 * the auction's single orders). Blocks are validated in order — parents must
 * come before their children — and dropped if they break product rules or push
 * any SP beyond the power rating together with the auction's other orders.
 */
export function setBlockOrdersAction(state: GameState, auction: 'hourly' | 'half', blocks: DaBlockOrder[]): GameState {
  if (!auctionOpen(state, auction)) return state;
  const P = state.battery.config.powerRatingMw;
  const others = (state.dayAhead.blocks ?? []).filter(b => b.auction !== auction);
  const singles = auction === 'hourly'
    ? hourlyToSp(state.dayAhead.bids)
    : [...(state.dayAhead.hhBids ?? []), ...workingIdOrders(state)];
  const net = auction === 'half' ? deliveryDayNet(state) : [];
  const kept: DaBlockOrder[] = [];
  for (const b of blocks) {
    if (b.auction !== auction || !b.id || kept.some(k => k.id === b.id)) continue;
    if (validateBlock(b, [...others, ...kept], P)) continue;
    if (powerViolations(singles, [...kept, b], P, net).length) continue;
    kept.push(b);
  }
  return { ...state, dayAhead: { ...state.dayAhead, blocks: [...others, ...kept] } };
}

/** Replace your orders in the 30-min auction (open between 09:20 results and 15:30 UK). */
export function submitHalfHourBidsAction(state: GameState, bids: HalfHourBid[]): GameState {
  if (!auctionOpen(state, 'half')) return state;
  const reserved: Record<string, number> = {};
  for (const o of workingIdOrders(state)) reserved[`${o.sp}:${o.side}`] = (reserved[`${o.sp}:${o.side}`] ?? 0) + o.volumeMw;
  const P = state.battery.config.powerRatingMw;
  const net = deliveryDayNet(state);
  const halfBlocks = (state.dayAhead.blocks ?? []).filter(b => b.auction === 'half');
  const kept: HalfHourBid[] = [];
  for (const b of sanitizeHalfHourBids(bids, P, net, reserved)) {
    if (powerViolations([...kept, b, ...workingIdOrders(state)], halfBlocks, P, net).length === 0) kept.push(b);
  }
  return { ...state, dayAhead: { ...state.dayAhead, hhBids: kept } };
}

/** Withdraw submitted DA orders (all, or those of one hour) before gate closure. */
export function withdrawDayAheadBids(state: GameState, hour?: number): GameState {
  const { isAuctionOpen, gateClosureTime } = state.dayAhead;
  if (!isAuctionOpen || (gateClosureTime && state.clock.currentTime >= gateClosureTime)) return state;
  const bids = hour === undefined ? [] : state.dayAhead.bids.filter(b => b.hour !== hour);
  return { ...state, dayAhead: { ...state.dayAhead, bids } };
}

export function placeIntradayOrderAction(state: GameState, input: PlaceOrderInput): GameState {
  return placeIdOrder(state, input);
}

export function cancelIntradayOrderAction(state: GameState, orderId: string): GameState {
  return cancelIdOrder(state, orderId);
}

// Simple intraday helpers (used by the training lessons): market order on today's SP.
export function intradayChargeAction(state: GameState, sp: number, mw: number): GameState {
  return placeIdOrder(state, { deliveryDay: getUtcDayStart(state.clock.currentTime), period: sp, side: OrderSide.BUY, type: 'market', qtyMw: mw });
}

export function intradayDischargeAction(state: GameState, sp: number, mw: number): GameState {
  return placeIdOrder(state, { deliveryDay: getUtcDayStart(state.clock.currentTime), period: sp, side: OrderSide.SELL, type: 'market', qtyMw: mw });
}

function seededAcceptance(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function assessBmOffer(state: GameState, direction: BmDirection, period: number, price: number): { accepted: boolean; reason: string; acceptanceProbability: number; stackRank: number } {
  const forecast = state.dayAhead.forecastPrices[period] ?? state.currentPrice?.price ?? 50;
  const sip = period < state.dayAhead.revealedPeriods ? state.dayAhead.sipOutturn[period] : forecast;
  const reference = (forecast + sip) / 2;
  const premium = price - reference;
  const niv = state.dayAhead.niv[period] ?? 0;
  // Elexon sign: + = system short (needs generation), − = long (needs demand)
  const systemNeedsDischarge = niv > 100;
  const systemNeedsCharge = niv < -100;
  const tightnessBoost = direction === 'offer' && systemNeedsDischarge ? 0.25 : direction === 'bid' && systemNeedsCharge ? 0.25 : 0;

  if (direction === 'offer') {
    if (state.battery.socPct < 20) {
      return { accepted: false, reason: 'Rejected: not enough stored energy for a discharge instruction.', acceptanceProbability: 0, stackRank: 99 };
    }
    const competitiveness = Math.max(0, Math.min(1, 1 - ((premium - 5) / 90)));
    const acceptanceProbability = Math.max(0.05, Math.min(0.95, competitiveness + tightnessBoost));
    const stackRank = Math.max(1, Math.min(40, Math.round((1 - acceptanceProbability) * 40)));
    const accepted = seededAcceptance(state.clock.currentTime + period + price) < acceptanceProbability;
    return {
      accepted,
      reason: accepted
        ? `Accepted: ranked ${stackRank}/40 in the simulated BM offer stack.`
        : `Skipped: ranked ${stackRank}/40. Price was not competitive enough for this system need.`,
      acceptanceProbability,
      stackRank,
    };
  }

  if (state.battery.socPct > 85) {
    return { accepted: false, reason: 'Rejected: not enough headroom to charge.', acceptanceProbability: 0, stackRank: 99 };
  }
  const discount = reference - price;
  const competitiveness = Math.max(0, Math.min(1, (discount + 10) / 80));
  const acceptanceProbability = Math.max(0.05, Math.min(0.95, competitiveness + tightnessBoost));
  const stackRank = Math.max(1, Math.min(40, Math.round((1 - acceptanceProbability) * 40)));
  const accepted = seededAcceptance(state.clock.currentTime + period + price + 17) < acceptanceProbability;
  return {
    accepted,
    reason: accepted
      ? `Accepted: ranked ${stackRank}/40 in the simulated BM bid stack.`
      : `Skipped: ranked ${stackRank}/40. Charge bid was not competitive enough.`,
    acceptanceProbability,
    stackRank,
  };
}

export function submitBmOfferAction(
  state: GameState,
  input: { period: number; direction: BmDirection; mw: number; price: number },
): GameState {
  const period = Math.max(0, Math.min(47, input.period));
  const mw = Math.max(0, Math.min(state.battery.config.powerRatingMw, input.mw));
  if (mw <= 0) return state;
  // Only future SPs: a position for the running/past SP would never be delivered.
  if (period <= getSettlementPeriod(state.clock.currentTime) - 1) return state;

  const assessment = assessBmOffer(state, input.direction, period, input.price);
  const offer: BmOffer = {
    id: `bm-${state.clock.currentTime}-${period}-${state.bm?.offers.length ?? 0}`,
    period,
    direction: input.direction,
    mw,
    price: input.price,
    accepted: assessment.accepted,
    submittedAt: state.clock.currentTime,
    reason: assessment.reason,
    acceptanceProbability: assessment.acceptanceProbability,
    stackRank: assessment.stackRank,
  };

  const acceptedPosition: TradePosition | null = assessment.accepted ? {
    period,
    deliveryDay: getUtcDayStart(state.clock.currentTime),
    market: 'bm',
    action: input.direction === 'bid' ? 'charge' : 'discharge',
    mw,
    price: input.price,
    lockedAt: state.clock.currentTime,
  } : null;

  return {
    ...state,
    bm: {
      offers: [offer, ...(state.bm?.offers ?? [])].slice(0, 30),
      accepted: assessment.accepted ? [offer, ...(state.bm?.accepted ?? [])].slice(0, 20) : (state.bm?.accepted ?? []),
    },
    dayAhead: {
      ...state.dayAhead,
      playerSchedule: acceptedPosition
        ? [...state.dayAhead.playerSchedule, acceptedPosition]
        : state.dayAhead.playerSchedule,
    },
  };
}

export interface ScenarioInput {
  id?: string;
  title?: string;
  description?: string;
  teachingPoints?: string[];
  daPrices: number[];
  sipPrices: number[];
  niv: number[];
  date: string;
  realData?: boolean;
  /** Key events as news at their SP (1-based SP numbers, as in the scenario data) */
  keyEvents?: { sp: number; text: string }[];
  /** Unforeseen shock window (1-based SPs): intraday only prices it in once the first news breaks */
  shock?: { fromSp: number; toSp: number };
  deskHints?: DeskHints;
}

/**
 * Load a scenario: the session starts on a normal lead-in day and the scenario
 * day is the DAY-AHEAD AUCTION's delivery day — you bid for it on D-1 (with
 * desk signals that hint at the story), then live through it: intraday,
 * imbalance, live news (e.g. a trip) and settlement.
 */
export function loadScenario(state: GameState, scenario: ScenarioInput, leadIn?: MarketDay): GameState {
  const day = Date.parse(scenario.date + 'T00:00:00Z');
  const seed = scenario.daPrices.reduce((a, p) => a + Math.abs(Math.round(p)), 0);
  const shock = scenario.shock ? { fromSp: scenario.shock.fromSp - 1, toSp: scenario.shock.toSp - 1 } : undefined;
  const liveNews: LiveNews[] = (scenario.keyEvents ?? []).map((e, i) => ({
    sp: Math.max(0, Math.min(47, e.sp - 1)),
    headline: e.text,
    category: 'demand',
    ...(i === 0 && shock ? { shock, category: 'outage' as const } : {}),
  }));
  const scenarioDay = withDeskForecast({ ...scenarioMarketDay(day, scenario), liveNews }, seed, scenario.deskHints);
  const lead = leadIn ?? leadInDay(scenario.daPrices, day - DAY_MS, seed + 7);
  return {
    ...loadMarketDays(state, lead, scenarioDay),
    scenario: {
      id: scenario.id ?? `scenario-${scenario.date}`,
      title: scenario.title ?? scenario.date,
      description: scenario.description ?? '',
      teachingPoints: scenario.teachingPoints ?? [],
      day,
      realData: scenario.realData,
    },
  };
}

export function reconfigureBattery(state: GameState, config: Partial<BatteryConfig>): GameState {
  const newConfig = { ...state.battery.config, ...config };
  const capacityRatio = newConfig.capacityMwh / state.battery.config.capacityMwh;
  const newSocMwh = Math.min(state.battery.currentSocMwh * capacityRatio, newConfig.capacityMwh);

  return {
    ...state,
    battery: {
      ...state.battery,
      config: newConfig,
      currentSocMwh: newSocMwh,
      socPct: Math.round((newSocMwh / newConfig.capacityMwh) * 10000) / 100,
    },
  };
}
