import type { SandboxView } from '../components/SandboxLauncher';

export interface Strategy {
  // Stable id (used as the React key).
  id: string;
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
  // Part of another stream's view (not a tab of its own) — follows that tab's selection.
  includedIn?: SandboxView;
}

export const STRATEGIES: Strategy[] = [
  {
    id: 'dayahead',
    name: 'Day-Ahead Auctions',
    streamLabel: 'Day-Ahead',
    tagline: 'Blind auctions for tomorrow: hourly 09:20, half-hourly 15:30',
    description: 'Bid for tomorrow in the GB day-ahead auctions: 24 hourly products (gate 09:20 UK), block orders and the half-hourly auction at 15:30. Uniform pricing — everyone pays or receives the clearing price. Your fills become the schedule you must deliver the next day.',
    howItWorks: 'Before the gate you only see a desk forecast and signals (gas, wind revision, temperature, news). A buy fills when the clearing price is at or below your max, a sell when it is at or above your min. Linked block orders make discharge depend on the charge. The 15:30 half-hourly auction lets you reshape the hourly position. After midnight you deliver it — anything you cannot deliver settles as imbalance.',
    keyMetrics: 'Spread captured vs the hindsight optimum, fill rate, imbalance from undeliverable schedules.',
    tip: 'Price where you would really be happy to trade, not at the forecast — the forecast is wrong by several £/MWh on most hours. Respect power and SoC across both auctions.',
    difficulty: 'Beginner',
    realWorld: 'Most GB battery energy is still traded day-ahead and intraday. EPEX and N2EX run the hourly auctions; EPEX also runs the 30-min auction at 15:30.',
    view: 'dayahead',
    markets: ['dayahead'],
  },
  {
    id: 'intraday',
    name: 'Intraday Continuous',
    streamLabel: 'Intraday',
    tagline: 'Order book per half-hour until one hour before delivery',
    description: 'Continuous trading on an order book for each half-hour of today and (after the 15:30 auction) tomorrow. Market, limit, IOC and FOK orders; trading closes at T-60. Use it to re-optimise your day-ahead position as forecasts and news change.',
    howItWorks: 'Crossing the spread fills immediately but costs the spread; a resting limit order may fill later at your price — or never. Example: you sold DA at £60 for 17:30, a wind revision pushes ID to £85 — sell more, or buy back a position you cannot deliver before the gate closes.',
    keyMetrics: 'P&L from ID fills, spread paid, position changes vs DA-only.',
    tip: 'Liquidity and prices move most after news and as the gate approaches. Check the Desk risk book before trading: power and SoC limits apply to your NET position.',
    difficulty: 'Intermediate',
    realWorld: 'GB intraday is a continuous market (EPEX). Battery optimisers trade it algorithmically around the clock.',
    view: 'intraday',
    markets: ['intraday'],
  },
  {
    id: 'imbalance',
    name: 'Imbalance (NIV chasing)',
    streamLabel: 'Imbalance',
    tagline: 'Deliberately deviate in the system\'s direction, settle at SIP',
    description: 'As a non-BM battery you may run long or short of your contracts on purpose. The deviation settles at the single imbalance price (SIP) after the SP. When the system is short (NIV > 0, Elexon sign) the SIP is usually high — discharging helps and pays; when long, charging does.',
    howItWorks: 'Read the live NIV estimate and signals, set your deviation for the running SP and steer it in 5-minute steps. The SIP is only published after the SP, so every call carries risk. Size to conviction.',
    keyMetrics: 'Hit rate (deviation in the system\'s direction), imbalance P&L, slippage vs expected SIP.',
    tip: 'Don\'t chase every SP — trade where signals agree. Keep SoC headroom for evening peaks.',
    difficulty: 'Advanced',
    realWorld: 'NIV chasing by non-BM units is legal and common in GB; it helps the system when done in the right direction, but the SIP can move against you.',
    view: 'imbalance',
    markets: ['imbalance'],
  },
  {
    id: 'bm',
    name: 'Balancing Mechanism (BM)',
    streamLabel: 'Balancing Mechanism',
    tagline: 'Part of the Imbalance tab: switch the asset to "BM unit"',
    description: 'As a BM unit you follow your FPN and post offers (paid to discharge more) and bids (pay to charge more) per SP until T-60. NESO accepts when the system needs you and your price is in merit — pay-as-bid, often partial, and batteries are frequently skipped.',
    howItWorks: 'Switch Asset → BM unit in the Imbalance action panel, enter MW and £ for upcoming SPs and watch the BOAs: accepted (with cash), partial, or skipped.',
    keyMetrics: 'Acceptance rate, BM revenue, skips.',
    tip: 'Offers are taken when the system is short and bids when it is long. Price too high and you are never taken; too low and you leave money on the table.',
    difficulty: 'Intermediate',
    realWorld: 'Batteries are a growing share of BM actions, but skip rates remain a known issue for storage in the NESO control room.',
    includedIn: 'imbalance',
    markets: ['imbalance'],
  },
  {
    id: 'ancillary',
    name: 'Frequency Response (DC/DM/DR)',
    streamLabel: 'Ancillary services',
    tagline: 'Availability payments for frequency response — not simulated',
    description: 'NESO\'s dynamic frequency response services pay for keeping capacity available. Real optimisers stack them with trading; this simulator focuses on the energy markets.',
    howItWorks: 'Not simulated.',
    keyMetrics: '—',
    tip: '—',
    difficulty: 'Intermediate',
    realWorld: 'Frequency response revenues for GB batteries have compressed as the fleet grew; most revenue now comes from trading and the BM.',
    markets: [],
    comingSoon: true,
  },
];
