import type { BatteryState } from './battery';
import type { TradePosition } from './ukMarket';

export const MarketType = {
  SPOT: 'spot',
  DAY_AHEAD: 'day_ahead',
  INTRADAY: 'intraday',
  BM: 'balancing_mechanism',
} as const;
export type MarketType = typeof MarketType[keyof typeof MarketType];

export const OrderSide = {
  BUY: 'buy',
  SELL: 'sell',
} as const;
export type OrderSide = typeof OrderSide[keyof typeof OrderSide];

export type SpeedPreset = 'manual' | 'slow' | 'normal' | 'fast' | 'ultra';

export const SPEED_MS: Record<SpeedPreset, number> = {
  manual: 0,
  slow: 3000,
  normal: 2500,
  fast: 500,
  ultra: 100,
};

export type AppView = 'imbalance' | 'intraday' | 'dayahead' | 'forecast' | 'pnl';

export interface Trade {
  orderId: string;
  side: OrderSide;
  volumeMw: number;
  price: number;
  timestamp: number;
  marketType: MarketType;
}

/**
 * A day-ahead order for one HOURLY product (hour 0-23 = SP 2h and 2h+1).
 * BUY = charge: filled if clearing price ≤ limit. SELL = discharge: filled if
 * clearing price ≥ limit. A buy and a sell on the same hour form a 2-step curve.
 */
export interface DayAheadBid {
  hour: number;
  side: OrderSide;
  volumeMw: number;
  price: number; // limit £/MWh
}

/**
 * Block order: one volume and one limit for a run of consecutive SPs, filled
 * all-or-nothing. Accepted if the AVERAGE clearing price over the block meets
 * the limit (buy: avg ≤ limit, sell: avg ≥ limit); each SP then settles at its
 * own clearing price. A linked (child) block can only be accepted together
 * with its parent; a profitable child can carry a slightly unprofitable parent
 * (accepted if their combined surplus ≥ 0).
 */
export interface DaBlockOrder {
  id: string;
  auction: 'hourly' | 'half';
  side: OrderSide;
  startSp: number;
  endSp: number; // inclusive
  volumeMw: number;
  price: number;
  parentId?: string;
}

export interface BlockResult {
  id: string;
  avgClearing: number;
  accepted: boolean;
  reason: string;
}

/** Order in the EPEX GB 30-min auction (15:30 UK) for one half-hour SP. */
export interface HalfHourBid {
  sp: number;
  side: OrderSide;
  volumeMw: number;
  price: number;
}

export interface HalfHourResult {
  sp: number;
  clearingPrice: number;
  forecastPrice: number;
  buyMw: number;
  buyFilled: boolean;
  sellMw: number;
  sellFilled: boolean;
}

/** Result of one hourly product after the auction cleared (pay-as-cleared). */
export interface AuctionResult {
  hour: number;
  clearingPrice: number;
  forecastPrice: number;
  /** Net filled MW: + = sell/discharge, − = buy/charge */
  filledMw: number;
  buyMw: number;
  buyFilled: boolean;
  sellMw: number;
  sellFilled: boolean;
}

/** A news item the desk sees before gate closure (effect on price is hidden). */
export interface DeskEvent {
  kind: 'interconnector' | 'outage' | 'imports';
  startSp: number;
  endSp: number; // inclusive
  headline: string;
  confirmed: boolean;
  /** £/MWh effect on the actual price while active (0 = false alarm). Hidden in the UI before clearing. */
  effect: number;
}

/**
 * What changed since the desk's price model ran — visible before gate closure,
 * slightly noisy. Each signal explains part of (actual − forecast).
 */
export interface DeskSignals {
  /** Overnight gas (NBP day-ahead) move, % */
  gasPct: number;
  /** Latest weather run vs the model's wind, per SP, MW (+ = more wind) */
  windRevisionMw: number[];
  /** Temperature vs seasonal normal, °C (− = colder → more demand) */
  tempAnomalyC: number;
  events: DeskEvent[];
}

/** actual − forecast per SP, split by cause (£/MWh). */
export interface ForecastErrorBreakdown {
  gas: number[];
  wind: number[];
  temperature: number[];
  event: number[];
  noise: number[];
}

/**
 * News that breaks DURING the delivery day (e.g. an interconnector trip).
 * Shown when its SP starts. If it carries a shock window, the intraday market
 * only prices the shock in after the news broke; NIV/SIP already contain it.
 */
export interface LiveNews {
  sp: number; // 0-indexed SP when the news breaks
  headline: string;
  category: 'outage' | 'demand' | 'weather' | 'renewable' | 'policy';
  shock?: { fromSp: number; toSp: number };
}

/** Desk-signal overrides for a scenario's auction day (the "story" visible at D-1). */
export interface DeskHints {
  gasPct?: number;
  tempAnomalyC?: number;
  windRevisionMw?: number;
  /** Events with their effect as a share of the day's average price */
  events?: (Omit<DeskEvent, 'effect'> & { effectPct: number })[];
}

/** Scenario metadata kept in the game state for briefing / debrief. */
export interface ScenarioInfo {
  id: string;
  title: string;
  description: string;
  teachingPoints: string[];
  /** UTC midnight of the scenario (= auction) day */
  day: number;
  realData?: boolean;
}

/** All market data for one delivery day (48 SPs, UK settlement day). */
export interface MarketDay {
  /** UTC midnight ms of the delivery day */
  day: number;
  source: 'real' | 'synthetic';
  /** ISO date (YYYY-MM-DD) for real days */
  date?: string;
  /** Desk forecast of the DA price, visible before the auction */
  daForecast: number[];
  /** Desk forecast per half-hour for the 15:30 auction (set once the hourly auction cleared) */
  daForecastHH?: number[];
  /** Market signals since the desk model ran (visible before clearing) */
  signals?: DeskSignals;
  /** Why the forecast differs from the actual price (revealed after clearing) */
  forecastErrors?: ForecastErrorBreakdown;
  /** News breaking during this delivery day */
  liveNews?: LiveNews[];
  /** Actual DA price per SP (real: Market Index Price). Hidden until the auction clears. */
  daClearing: number[];
  sipOutturn: number[];
  niv: number[];
  demandForecast: number[];
  windForecast: number[];
  solarForecast: number[];
  demandOutturn: number[];
  windOutturn: number[];
  solarOutturn: number[];
}

// ===== Intraday continuous market =====

export type IdOrderType = 'market' | 'limit' | 'ioc' | 'fok';

export interface IdOrder {
  id: string;
  deliveryDay: number;
  period: number;
  side: OrderSide; // BUY = charge, SELL = discharge
  type: IdOrderType;
  limitPrice: number | null;
  qtyMw: number;
  filledMw: number;
  avgFillPrice: number;
  status: 'working' | 'filled' | 'partial' | 'cancelled' | 'expired' | 'rejected';
  createdAt: number;
  updatedAt: number;
  note?: string;
}

export interface IdFill {
  orderId: string;
  deliveryDay: number;
  period: number;
  side: OrderSide;
  mw: number;
  price: number;
  time: number;
  aggressor: boolean; // true = you crossed the spread, false = your resting order was hit
}

export interface IntradayState {
  /** Mid price per product, key `${deliveryDay}:${period}` */
  mids: Record<string, number>;
  /** AR(1) deviation of the mid from its fundamental anchor, per product */
  devs: Record<string, number>;
  /** Mid history per product (last N ticks) for sparklines */
  midHistory: Record<string, number[]>;
  orders: IdOrder[];
  fills: IdFill[];
  /** Book volume taken by the player in the current tick, so the same depth can't be hit twice */
  taken: Record<string, { time: number; bid: number; ask: number }>;
  seq: number;
}

// ===== Settlement ledger (per delivery day + SP) =====

export interface SettlementEntry {
  deliveryDay: number;
  period: number;
  /** Net contracted MW (DA + ID): + = sell/discharge, − = buy/charge */
  contractedMw: number;
  /** MW actually delivered for the contract part (after SoC/power limits) */
  deliveredMw: number;
  /** Deliberate deviation from contract set in the Imbalance view (MW, + = extra discharge) */
  deviationMw: number;
  /** Metered MW = deliveredMw + deviationMw */
  meteredMw: number;
  /** Cash from DA + ID contracts (+ = received) */
  contractCash: number;
  /** (metered − contracted) × 0.5 h, + = long (spilled), settled at SIP */
  imbalanceMwh: number;
  imbalancePrice: number | null;
  imbalanceCash: number;
  settled: boolean;
  /** Deliberate deviation set point per 5-min interval (6 values, MW); its mean is deviationMw */
  deviationProfile?: number[];
  /** Exchange fees on DA/ID volume delivered in this SP (negative £) */
  feesCash?: number;
  /** Battery wear cost on metered throughput (negative £) */
  degradationCash?: number;
  /** Expected SIP shown when you last set the deviation (for slippage review) */
  expectedSip?: number;
}

/** P&L of one delivery day, by source (£, + = gain). */
export interface DayPnl {
  day: number;
  da: number;
  id: number;
  bm: number;
  imbalance: number;
  fees: number;
  degradation: number;
  net: number;
  throughputMwh: number;
}

/** Asset registration: a Balancing Mechanism unit must follow its FPN; a non-BM asset can spill. */
export type AssetType = 'non-bm' | 'bm';

/**
 * Standing BM bid/offer for one SP of a BM unit (changeable until gate closure T-60).
 * Offer = paid to INCREASE export (discharge more); bid = you pay to DECREASE
 * export / charge more (negative bid = you get paid). Pay-as-bid.
 */
export interface BmStandingOrder {
  day: number;
  sp: number;
  offerMw: number;
  offerPrice: number | null;
  bidMw: number;
  bidPrice: number | null;
}

/** A Bid-Offer Acceptance (BOA) issued by NESO for your unit. */
export interface BmAcceptance {
  day: number;
  sp: number;
  kind: 'offer' | 'bid';
  /** SP-average MW delivered (instructed MW × share of the SP it ran) — 0 if skipped */
  mw: number;
  price: number;
  time: number;
  /** 'skipped' = in merit but passed over by the control room */
  status?: 'accepted' | 'skipped';
  /** MW instructed in the BOA and the 5-minute interval it started in */
  instructedMw?: number;
  startSubIdx?: number;
}

export interface MarketEvent {
  id: string;
  timestamp: number;
  headline: string;
  description: string;
  priceImpact: number;
  category: 'weather' | 'outage' | 'demand' | 'renewable' | 'policy';
}

export interface DayAheadState {
  bids: DayAheadBid[];
  results: AuctionResult[];
  gateClosureTime: number | null;
  isAuctionOpen: boolean;
  /** UTC midnight ms of the day this auction's bids will deliver on (= nextDay.day) */
  deliveryDay: number;
  /** Source of TODAY's market data */
  todaySource?: 'real' | 'synthetic';
  /** Yesterday's auction for TODAY: the desk forecast it was bid on, and its results */
  todayForecast?: number[];
  todayResults?: AuctionResult[];
  /** The orders you submitted in yesterday's auction for TODAY */
  todayBids?: DayAheadBid[];
  /** Block orders (hourly + 30-min auction) for the delivery day, and their results */
  blocks?: DaBlockOrder[];
  blockResults?: BlockResult[];
  /** EPEX GB 30-min auction (15:30 UK): opens once the hourly auction cleared */
  hhBids?: HalfHourBid[];
  hhResults?: HalfHourResult[];
  hhGateClosureTime?: number;
  hhAuctionOpen?: boolean;
  /** News breaking during TODAY's delivery (shown when each SP starts) */
  todayNews?: LiveNews[];
  /** Yesterday's blocks / 30-min auction for TODAY */
  todayBlocks?: DaBlockOrder[];
  todayBlockResults?: BlockResult[];
  todayHhBids?: HalfHourBid[];
  todayHhResults?: HalfHourResult[];
  nextDeliveryDay: number;
  /** TODAY's DA prices (cleared in yesterday's auction; real days: Market Index Price) */
  forecastPrices: number[];
  sipOutturn: number[]; // 48 half-hourly SIP outturns of TODAY (revealed as time passes)
  niv: number[]; // 48 NIV values
  demandForecast: number[]; // 48 half-hourly demand forecast MW
  windForecast: number[]; // 48 half-hourly wind forecast MW
  solarForecast: number[]; // 48 half-hourly solar forecast MW
  demandOutturn: number[]; // 48 half-hourly actual demand MW
  windOutturn: number[]; // 48 half-hourly actual wind generation MW
  solarOutturn: number[]; // 48 half-hourly actual solar generation MW
  revealedPeriods: number; // how many SPs have been revealed
  playerSchedule: TradePosition[];
}

export interface GameState {
  clock: {
    currentTime: number;
    isPaused: boolean;
    speed: SpeedPreset;
    startTime: number;
  };
  battery: BatteryState;
  trades: Trade[];
  events: MarketEvent[];
  dayAhead: DayAheadState;
  /** Market data of the NEXT delivery day — the day the open DA auction is for. */
  nextDay: MarketDay;
  intraday: IntradayState;
  /** Settlement ledger, one entry per (deliveryDay, period) that saw activity. */
  ledger: SettlementEntry[];
  /** Active scenario (illustrative or a chosen real day), if any */
  scenario?: ScenarioInfo | null;
  /** How the battery is registered (default non-BM) */
  assetType?: AssetType;
  /** BM unit: standing bids/offers per SP and the BOAs NESO issued */
  bmBook?: BmStandingOrder[];
  bmAcceptances?: BmAcceptance[];
  /** Archived P&L of completed delivery days in this session */
  pnlHistory?: DayPnl[];
}

export const GLOSSARY: Record<string, string> = {
  'BESS': 'Battery Energy Storage System — a large-scale battery that charges and discharges electricity for profit.',
  'SoC': 'State of Charge — how full your battery is (0-100%). Every market position must fit within it.',
  'Capacity (MWh)': 'Total energy storage. A 100 MWh battery fully charged holds 100 megawatt-hours.',
  'Power Rating (MW)': 'Maximum charge/discharge rate. 50 MW for one half-hour SP moves 25 MWh.',
  'Round-trip Efficiency': 'Energy lost during cycling. At 90%, buying 100 MWh lets you sell about 90 MWh.',
  'Cycle': 'One full charge-discharge. Wear is charged per MWh of throughput (see Degradation).',
  'Settlement Period (SP)': 'Half-hourly block (48 per day) — the unit in which GB energy is settled.',
  'Day-Ahead (DA)': 'Blind auctions for tomorrow: 24 hourly products closing 09:20 UK (EPEX; N2EX 09:50) and a half-hourly auction at 15:30. Uniform clearing price per product.',
  'Half-hourly auction': 'EPEX GB 30-min auction at 15:30 D-1 — reshapes the hourly position for each half-hour.',
  'Block order': 'An all-or-nothing order over several consecutive hours at one limit price. A linked block only executes if its parent does (e.g. discharge only if the charge filled).',
  'MID': 'Market Index Price (Elexon, APX/N2EX) — a volume-weighted short-term price used here as the real-day day-ahead reference.',
  'Gate Closure': 'DA auctions close 09:20 (hourly) and 15:30 (half-hourly) UK time on D-1. Intraday and BM gate closure is one hour before delivery (T-60).',
  'Intraday (ID)': 'Continuous order book per half-hour. Trade until T-60 to re-optimise DA positions.',
  'Order types': 'Limit (rests in the book), Market (fills now against the ladder), IOC (fill what you can now, cancel the rest), FOK (all now or nothing).',
  'SIP': 'System (single) Imbalance Price — published by Elexon after the SP; settles every MWh you deliver beyond or below your contracts.',
  'NIV': 'Net Imbalance Volume per SP. Elexon sign: + = system short (needs energy, SIP usually high), − = system long.',
  'NIV Chasing': 'A non-BM unit deliberately deviates in the system\'s direction (discharge when short, charge when long) and is settled at the SIP.',
  'Balancing Mechanism (BM)': 'NESO\'s real-time market. BM units submit offers (more generation) and bids (more demand) per SP; NESO accepts them as BOAs and pays as bid.',
  'BOA': 'Bid-Offer Acceptance — NESO instruction to a BM unit to move away from its FPN. Can be partial; in-merit batteries are sometimes skipped.',
  'BM unit / FPN': 'A BM-registered asset must follow its Final Physical Notification (FPN); deviations are only by NESO instruction.',
  'Exchange fees': 'Per-MWh trading fees on DA and ID volume (here £0.05/MWh, illustrative).',
  'Degradation': 'Battery wear cost per MWh of throughput (here £5/MWh, illustrative).',
  'Arbitrage': 'Buy energy when it is cheap and sell when it is expensive, net of efficiency, fees and wear.',
  'Spread': 'Difference between sell and buy price. It must cover efficiency losses, fees and wear.',
  'Negative Prices': 'Oversupply (e.g. high wind, low demand). You are paid to consume — attractive for charging if you have headroom.',
  'Merit Order': 'Plants dispatched cheapest to most expensive. The marginal plant sets the price.',
  'Forecast error': 'The gap between the desk forecast and the cleared price — the reason DA bidding is risky.',
};

