import type { BatteryState } from './battery';
import type { TradePosition, AnalysisSummary } from './ukMarket';

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

export const OrderType = {
  MARKET: 'market',
  LIMIT: 'limit',
} as const;
export type OrderType = typeof OrderType[keyof typeof OrderType];

export const OrderStatus = {
  PENDING: 'pending',
  FILLED: 'filled',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
} as const;
export type OrderStatus = typeof OrderStatus[keyof typeof OrderStatus];

export const GameMode = {
  ARBITRAGE: 'arbitrage',
  NIV_CHASING: 'niv_chasing',
  INTRADAY: 'intraday',
  TRIAD_MANAGEMENT: 'triad_management',
  FREQUENCY_RESPONSE: 'frequency_response',
  BM_PARTICIPATION: 'bm_participation',
  REVENUE_STACKING: 'revenue_stacking',
} as const;
export type GameMode = typeof GameMode[keyof typeof GameMode];

// Re-export Order and Position interfaces used by market.ts, portfolio.ts, and components
export interface Order {
  id: string;
  marketType: MarketType;
  side: OrderSide;
  orderType: OrderType;
  volumeMw: number;
  priceLimit: number | null;
  targetHour: number;
  createdAt: number;
  status: OrderStatus;
  filledPrice: number | null;
  filledVolume: number;
}

export interface Position {
  hourLabel: string;
  volumeMw: number;
  avgEntryPrice: number;
  marketType: MarketType;
  currentPrice: number;
  unrealizedPnl: number;
}

export type SpeedPreset = 'manual' | 'slow' | 'normal' | 'fast' | 'ultra';

export const SPEED_MS: Record<SpeedPreset, number> = {
  manual: 0,
  slow: 3000,
  normal: 2500,
  fast: 500,
  ultra: 100,
};

export type AppView = 'imbalance' | 'intraday' | 'dayahead' | 'forecast' | 'analysis';

export interface HourlyPrice {
  timestamp: number;
  price: number; // £/MWh
  demandMw: number;
  renewablePct: number;
  basePrice: number;
  eventImpact: number;
}

export interface Trade {
  orderId: string;
  side: OrderSide;
  volumeMw: number;
  price: number;
  timestamp: number;
  marketType: MarketType;
}

export interface DayAheadBid {
  period: number; // 0-indexed settlement period
  side: OrderSide;
  volumeMw: number;
  price: number;
}

export interface AuctionResult {
  period: number; // 0-indexed settlement period
  clearingPrice: number;
  playerVolume: number;
  accepted: boolean;
}

export interface MarketEvent {
  id: string;
  timestamp: number;
  headline: string;
  description: string;
  priceImpact: number;
  category: 'weather' | 'outage' | 'demand' | 'renewable' | 'policy' | 'triad';
}

export interface TutorialState {
  currentStep: number;
  isActive: boolean;
  completed: boolean;
}

export interface DayAheadState {
  bids: DayAheadBid[];
  results: AuctionResult[];
  gateClosureTime: number | null;
  isAuctionOpen: boolean;
  /** UTC midnight ms of the day this auction's bids will deliver on */
  deliveryDay: number;
  nextDeliveryDay: number;
  forecastPrices: number[]; // 48 half-hourly DA prices
  sipOutturn: number[]; // 48 half-hourly SIP outturns (revealed as time passes)
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

export type BmDirection = 'bid' | 'offer';

export interface BmOffer {
  id: string;
  period: number;
  direction: BmDirection;
  mw: number;
  price: number;
  accepted: boolean;
  submittedAt: number;
  reason: string;
  acceptanceProbability: number;
  stackRank: number;
}

export interface BmState {
  offers: BmOffer[];
  accepted: BmOffer[];
}

export interface GameState {
  clock: {
    currentTime: number;
    isPaused: boolean;
    speed: SpeedPreset;
    startTime: number;
  };
  priceHistory: HourlyPrice[];
  currentPrice: HourlyPrice | null;
  battery: BatteryState;
  trades: Trade[];
  events: MarketEvent[];
  mode: GameMode;
  tutorial: TutorialState;
  dayAhead: DayAheadState;
  bm: BmState;
  analysis: AnalysisSummary | null;
  triadAlert: boolean;
}

export const GLOSSARY: Record<string, string> = {
  'BESS': 'Battery Energy Storage System — a large-scale battery that charges and discharges electricity for profit.',
  'SoC': 'State of Charge — how full your battery is (0-100%). Manage this carefully across markets.',
  'Capacity (MWh)': 'Total energy storage. A 100 MWh battery fully charged holds 100 megawatt-hours.',
  'Power Rating (MW)': 'Maximum charge/discharge rate. 50 MW means 50 megawatts in or out per settlement period.',
  'Round-trip Efficiency': 'Energy lost during cycling. At 90%, storing 100 MWh means 90 MWh available to sell.',
  'Cycle': 'One full charge-discharge. Batteries degrade over cycles — manage cycle count vs revenue.',
  'Settlement Period (SP)': 'Half-hourly block (48 per day) — the fundamental unit of GB electricity trading.',
  'EPEX SPOT': 'The main day-ahead auction exchange for GB power. Gate closure at 09:20 UK time (08:20 UTC in BST, 09:20 UTC in GMT). Results ~30 min later.',
  'Day-Ahead (DA)': 'Auction market: bid before gate closure (09:20 UK time) for each half-hour of tomorrow. Clearing price set per SP.',
  'Intraday (ID)': 'Continuous trading market. Revise your DA positions as forecasts update. Trades until 1hr before delivery.',
  'SIP': 'System Imbalance Price — the actual settlement price from Elexon. This is what you pay/receive for any imbalance.',
  'NIV': 'Net Imbalance Volume — whether the system was long (oversupplied) or short (undersupplied) in each SP. Key for NIV chasing.',
  'NIV Chasing': 'Strategy: predict which direction the system will be imbalanced, then deliberately leave a position in that direction to profit from SIP.',
  'Balancing Mechanism (BM)': 'National Grid ESO dispatches batteries in real-time via BOAs. Premium prices but they choose when.',
  'BOA': 'Bid-Offer Acceptance — an instruction from NGESO to increase or decrease output in the BM.',
  'Arbitrage': 'Charge when price is cheap relative to recent/forecast conditions, discharge when price is expensive relative to that range.',
  'Intraday Trading': 'Adjusting positions after DA results as new information arrives. Capture value from forecast changes.',
  'Within-Day Optimisation': 'Continuously re-optimising battery schedule through the delivery day based on latest market data.',
  'Triad': 'Historically, the 3 highest half-hours of GB peak demand between Nov-Feb. Useful context for understanding winter peak behaviour, though residual charging reforms changed its role.',
  'Triad Management': 'Monitoring demand forecasts and preserving battery optionality for winter peak scarcity periods.',
  'TNUoS': 'Transmission Network Use of System charges. Network charging reforms mean this should be treated carefully when modelling modern BESS revenue.',
  'Frequency Response': 'Dynamic Containment (DC), Dynamic Moderation (DM), Dynamic Regulation (DR) — ancillary services.',
  'DC/DM/DR': 'Frequency response products. Battery must respond within 1s/0.5s. Revenue from availability (£/MW/hr).',
  'Revenue Stacking': 'Combining DA, ID, BM, frequency response, and Triad management to maximise total asset value. Overview only in this simulator — full simulation coming later.',
  'Gate Closure': 'Deadline for DA bids (09:20 UK time D-1, i.e. 08:20 UTC in summer / 09:20 UTC in winter). After this, trade intraday or BM only.',
  'Spread': 'Difference between charge and discharge price. Bigger spread = more profit per cycle.',
  'Baseload': 'Minimum overnight demand. Cheapest prices, best time to charge.',
  'Peak': 'Highest demand periods (7-9am, 4-7pm weekdays). Most expensive, best to discharge.',
  'Negative Prices': 'Oversupply (high wind). You get PAID to charge. Always charge during negative prices.',
  'Merit Order': 'Plants dispatched cheapest to most expensive. The marginal plant sets the price.',
  'System Price': 'The cash-out price for imbalanced parties, calculated by Elexon after delivery.',
  'Forecast vs Outturn': 'DA prices are forecasts. SIP is the actual outturn. The gap between them is where money is made or lost.',
};

export const TUTORIAL_STEPS = [
  {
    title: 'Welcome to BESS Trader Training',
    content: 'You\'re a trainee battery trader at a GB power trading company. You operate a 50 MW / 100 MWh grid-scale battery. Your job: maximise revenue by trading across GB electricity markets — day-ahead, intraday, and balancing mechanism.',
    target: null,
  },
  {
    title: 'The GB Electricity Price',
    content: 'This shows the spot electricity price in £/MWh. Do not trade only from clock time: compare the current price to recent moves, the day range, volatility, SoC, and market signals. High wind, low demand, outages, and forecast errors can shift the right action at any time.',
    target: 'price-chart',
  },
  {
    title: 'Your Battery',
    content: 'Your BESS: 100 MWh capacity, 50 MW power rating, 90% round-trip efficiency. Starting at 50% SoC. It takes 2 hours to fully charge or discharge. Managing SoC is critical — you need stored energy for relative price spikes and headroom for relative price dips.',
    target: 'battery-status',
  },
  {
    title: 'Charging & Discharging',
    content: 'CHARGE = buy electricity from the grid (costs money, fills battery). DISCHARGE = sell electricity back (earns money, empties battery). The controls show live cost/revenue estimates. Charge when the price is in the green zone, discharge in the red zone.',
    target: 'controls',
  },
  {
    title: 'Day-Ahead Market',
    content: 'The EPEX day-ahead auction is where you plan tomorrow\'s schedule. Before gate closure (09:20 UK time), submit bids for each settlement period. The tab shows forecast prices — bid to charge at cheap SPs and discharge at expensive ones. This is your primary market.',
    target: 'dayahead-tab',
  },
  {
    title: 'Revenue & Performance',
    content: 'Track your P&L here. Net Profit = discharge revenue minus charge cost. The spread (avg discharge vs avg charge price) is your key metric. A good GB battery earns £5-15k per day.',
    target: 'revenue',
  },
  {
    title: 'Post-Trade Analysis',
    content: 'After delivery, the Analysis tab compares your trades against the SIP outturn. It shows what actually happened vs what you expected, explains where you made or lost money, and shows the optimal strategy with perfect hindsight. This is how real traders learn.',
    target: 'analysis-tab',
  },
  {
    title: 'Market News & Events',
    content: 'Weather, outages, demand shifts, and Triad alerts. Read these to anticipate price moves. A cold snap + low wind = price spike. High wind = negative prices. November to February: watch for Triad warnings!',
    target: 'news',
  },
  {
    title: 'Trading Strategies',
    content: 'Open the Strategy Guide to learn: Arbitrage, NIV Chasing, Intraday Trading, Triad Management, BM Participation, Frequency Response, and Market Context. Each has detailed explanations and a playable mode. Start with Arbitrage, then try NIV Chasing once you understand SIP.',
    target: 'strategies',
  },
  {
    title: 'You\'re Ready to Trade!',
    content: 'Start with simple arbitrage: charge into relative weakness, discharge into relative strength, and preserve optionality when the signal is unclear. Use Step Forward while learning. Check Day-Ahead to schedule tomorrow. Review your performance in Analysis. Good luck, trader!',
    target: null,
  },
];
