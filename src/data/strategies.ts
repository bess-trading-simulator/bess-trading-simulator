import { GameMode } from '../engine/types';
import type { SandboxView } from '../components/SandboxLauncher';

export interface Strategy {
  mode: GameMode;
  name: string;
  // Short market/revenue-stream label used in the launcher + revenue-streams menu.
  streamLabel: string;
  tagline: string;
  description: string;
  howItWorks: string;
  keyMetrics: string;
  tip: string;
  difficulty: 'Beginner' | 'Intermediate' | 'Advanced';
  realWorld: string;
  // The sandbox view this revenue stream maps to (undefined = not selectable yet).
  view?: SandboxView;
  // Markets this strategy needs — used to filter the strategy list.
  markets: SandboxView[];
  // Not yet simulated — shown greyed-out, can't be selected/activated.
  comingSoon?: boolean;
}

export const STRATEGIES: Strategy[] = [
  {
    mode: GameMode.ARBITRAGE,
    name: 'Arbitrage (DA + Spot)',
    streamLabel: 'Day-Ahead',
    tagline: 'Charge cheap, discharge expensive — the foundation',
    description: 'The core battery strategy. Buy electricity when price is cheap relative to the available market range and sell when it is expensive relative to that range. Profit = discharge revenue minus charge cost minus efficiency losses.',
    howItWorks: 'GB prices often have daily patterns, but good arbitrage is relative, not just clock-based. Compare the current price to recent price movement, forecast distribution, volatility, SoC, and upcoming optionality. Charge after relative dips when you have headroom; discharge into relative strength when you have stored energy.',
    keyMetrics: 'Available spread, recent percentile rank, volatility, cycles per day, revenue per cycle, £/MW/day.',
    tip: 'Use the Market Signal panel rather than fixed times. A midday solar dip, wind-driven overnight negative price, or unexpected scarcity spike can all be the right trade depending on relative price and SoC.',
    difficulty: 'Beginner',
    realWorld: 'Every BESS operator does arbitrage. It\'s the baseline revenue stream. Professional optimisers use AI to time charge/discharge decisions beyond simple peak/trough.',
    view: 'dayahead',
    markets: ['dayahead'],
  },
  {
    mode: GameMode.INTRADAY,
    name: 'Intraday Trading',
    streamLabel: 'Intraday',
    tagline: 'Revise your position as forecasts update',
    description: 'After the DA auction, continue trading on the intraday continuous market (EPEX/Nordpool). As weather forecasts update, demand outturns become clearer, and plant availability changes, intraday prices move. Capture value by adjusting your battery schedule.',
    howItWorks: 'Your DA schedule is your starting position. Through the delivery day, new information arrives: updated wind forecasts, actual demand data, plant trip announcements. If conditions change, adjust on the ID market. Example: you sold DA at £60 for SP35, but wind drops and ID price rises to £80 — buy back your DA position and resell at £80, or just discharge at the higher spot price.',
    keyMetrics: 'ID profit vs DA-only profit, number of position changes, average improvement per trade.',
    tip: 'The first hour of ID trading after DA results often has the best opportunities — the market hasn\'t fully digested the new information yet. Also watch the 1-hour-ahead gate closure for last-minute price moves.',
    difficulty: 'Intermediate',
    realWorld: 'Intraday liquidity in GB has grown significantly. Automated trading algorithms continuously adjust positions. Professional optimisers use ML to forecast intraday price movements.',
    view: 'intraday',
    markets: ['intraday'],
  },
  {
    mode: GameMode.NIV_CHASING,
    name: 'NIV Chasing',
    streamLabel: 'Imbalance',
    tagline: 'Predict system imbalance, profit from SIP',
    description: 'Net Imbalance Volume (NIV) is whether the GB grid was over- or under-supplied in each settlement period. When the system is short (undersupplied), SIP spikes. If you predict this correctly, you can leave positions that settle at favourable SIP prices.',
    howItWorks: 'After your DA schedule is set, you can adjust in the intraday market. If you think the system will be SHORT (negative NIV) in a period, hold or increase your discharge position — you\'ll be paid the high SIP. If you think it\'ll be LONG (positive NIV), the SIP will be low — good for charging. Key signals: weather forecast errors, demand forecast errors, plant trips, interconnector flows.',
    keyMetrics: 'NIV prediction accuracy, SIP vs DA spread captured, net imbalance profit/loss.',
    tip: 'Watch for: (1) wind forecast drops → system likely short → hold discharge positions, (2) mild weather unexpectedly → demand lower → system likely long → prices drop. Don\'t chase NIV on every period — pick the ones where you have conviction.',
    difficulty: 'Advanced',
    realWorld: 'NIV chasing is controversial but widely practiced. Some argue it destabilises the system; others say it provides valuable price signals. Elexon\'s P305 reforms aimed to reduce NIV chasing profitability.',
    view: 'imbalance',
    markets: ['imbalance'],
  },
  {
    mode: GameMode.TRIAD_MANAGEMENT,
    name: 'Triad Management',
    streamLabel: 'Triad Management',
    tagline: 'Historic winter peak-demand risk and network-cost context',
    description: 'Triads were the 3 highest demand half-hours between November and February, separated by at least 10 days. They are useful to understand because they shaped UK flexibility behaviour for years, but residual charging reforms mean they should be treated mainly as historical/contextual training rather than the core modern BESS revenue stream.',
    howItWorks: 'Monitor peak-risk signals: cold weather forecasts, low wind, high demand projections, weekday 4-7pm. When multiple signals align, ensure your battery is charged and ready to discharge into scarcity periods. The transferable skill is preserving optionality before tight winter peaks.',
    keyMetrics: 'Peak periods correctly identified, battery availability during risk windows, opportunity cost of holding charge.',
    tip: 'Use this mode to practise scarcity discipline: avoid selling all optionality too early, keep SoC available before likely evening stress, and compare the value of peak discharge against earlier DA/ID opportunities.',
    difficulty: 'Intermediate',
    realWorld: 'Triad avoidance is no longer the clean headline revenue story it once was after network charging reforms. The modern lesson is broader: winter peak scarcity, network signals, and the value of holding battery optionality.',
    markets: [],
    comingSoon: true,
  },
  {
    mode: GameMode.BM_PARTICIPATION,
    name: 'Balancing Mechanism (BM)',
    streamLabel: 'Balancing Mechanism',
    tagline: 'Real-time dispatch at premium prices',
    description: 'National Grid ESO uses the BM to balance supply and demand in real-time. They send Bid-Offer Acceptances (BOAs) to batteries, instructing them to increase or decrease output. BM prices can be significantly higher than DA or ID prices.',
    howItWorks: 'Submit bid/offer prices for each SP. If NGESO needs more power, they accept your offer (you discharge at your offer price). If they need less, they accept your bid (you charge at your bid price). You don\'t control WHEN you\'re dispatched — NGESO decides based on system needs. Keep capacity available to maximise acceptance likelihood.',
    keyMetrics: 'BOA acceptance rate, BM premium over DA/ID, total BM revenue, capacity availability.',
    tip: 'Set competitive but profitable bid/offer prices. Too expensive → never dispatched. Too cheap → dispatched often but low margin. Watch the BM stack to see where other participants are pricing. Keep 20-30% capacity reserved for BM.',
    difficulty: 'Intermediate',
    realWorld: 'BM participation is growing for BESS. Average BM prices for batteries can be 2-3x spot prices during system stress. NGESO\'s dispatch algorithms favour flexible, fast-responding units.',
    markets: [],
    comingSoon: true,
  },
  {
    mode: GameMode.FREQUENCY_RESPONSE,
    name: 'Frequency Response (DC/DM/DR)',
    streamLabel: 'Frequency Response',
    tagline: 'Grid stability services — steady availability revenue',
    description: 'Dynamic Containment (DC), Dynamic Moderation (DM), and Dynamic Regulation (DR) are frequency response services. Your battery must respond within 1 second to frequency deviations. Revenue comes from availability payments — you\'re paid for being ready, not just for energy delivered.',
    howItWorks: 'Commit your battery to a frequency response service for a block of hours. During that time, maintain SoC near 50% so you can respond in either direction. If frequency drops below 49.95Hz, discharge. If it rises above 50.05Hz, charge. The automatic response is handled by your BMS; you just need the right SoC and contracted capacity.',
    keyMetrics: 'Contracted hours, availability payment rate (£/MW/hr), SoC management accuracy, response performance.',
    tip: 'DC pays the most (~£5-15/MW/hr) but requires the fastest response. Combine with arbitrage: do frequency response during off-peak hours (when arbitrage spread is thin) and switch to arbitrage during peak spread hours.',
    difficulty: 'Beginner',
    realWorld: 'Frequency response is the second-largest revenue stream for UK BESS after arbitrage. DC revenues have compressed as more batteries enter the market, but remain significant. The key skill is knowing when to commit to DC vs saving capacity for arbitrage.',
    markets: [],
    comingSoon: true,
  },
  {
    mode: GameMode.REVENUE_STACKING,
    name: 'Market Context',
    streamLabel: 'Revenue Stacking',
    tagline: 'Overview of all revenue streams',
    description: 'Real BESS optimisers dynamically allocate battery capacity across DA, ID, BM, frequency response, and Triad management. This mode shows the full context. Full simulation of combined services is coming in a future update.',
    howItWorks: 'Example day: 00:00-06:00 → DC frequency response (availability payments). 06:00-07:00 → charge on DA (cheap morning prices). 07:00-16:00 → DC frequency response. 16:00-19:00 → discharge on DA (peak prices, Triad cover). 19:00-00:00 → BM offers + ID trading. Each hour is optimised across all available markets.',
    keyMetrics: 'Total blended revenue (£/MW/day), capacity utilisation across services, revenue mix (% from each market).',
    tip: 'Start by mastering arbitrage, then add frequency response during low-spread hours. Layer in BM as you understand dispatch patterns. Triad management is seasonal but critical Nov-Feb.',
    difficulty: 'Advanced',
    realWorld: 'Professional BESS optimisers use AI/ML to allocate capacity across markets in real-time. A well-stacked battery earns £200-350/MW/day. The best operators earn 30-50% more than those running pure arbitrage.',
    markets: [],
    comingSoon: true,
  },
];
