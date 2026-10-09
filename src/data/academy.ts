// Academy lessons: short guided missions on the REAL sandbox views. Each step is
// checked against the live game state (ledger, auction results, orders, BOAs),
// so a lesson is complete when you've actually done it in the market.

import type { GameState } from '../engine/types';
import { OrderSide } from '../engine/types';
import { getUtcDayStart } from '../engine/clock';
import { visibleBoas } from '../engine/gameState';

export type AcademyView = 'imbalance' | 'dayahead' | 'intraday';

export interface LessonContext {
  state: GameState;
  /** Clock time when the lesson was opened */
  startedAt: number;
}

export interface LessonStep {
  title: string;
  hint: string;
  done: (c: LessonContext) => boolean;
}

export interface Lesson {
  id: number;
  title: string;
  subtitle: string;
  view: AcademyView;
  /** Battery registration the lesson needs (switched on when the lesson opens) */
  assetType: 'non-bm' | 'bm';
  ideas: string[];
  steps: LessonStep[];
}

const HH = 30 * 60 * 1000;
/** Start of the SP the lesson was opened in — activity from then on counts. */
const lessonSpStart = (startedAt: number) => Math.floor(startedAt / HH) * HH;
/** Ledger entries for SPs from the one the lesson was opened in. */
const ledgerSince = ({ state, startedAt }: LessonContext) =>
  state.ledger.filter(e => e.deliveryDay + e.period * HH >= lessonSpStart(startedAt));
const deviated = (e: GameState['ledger'][number]) => Math.abs(e.deviationMw) >= 0.5;

export const LESSONS: Lesson[] = [
  {
    id: 1,
    title: 'Battery & settlement basics',
    subtitle: 'MW vs MWh, settlement periods, SoC and how energy is settled',
    view: 'imbalance',
    assetType: 'non-bm',
    ideas: [
      'GB settles electricity in 48 half-hour settlement periods (SP). 50 MW for one SP = 25 MWh.',
      'Charging stores only part of the energy (round-trip efficiency, here 90 %); discharging delivers it.',
      'Whatever you deliver that is not covered by a contract is imbalance — paid or charged at the System Imbalance Price (SIP), published after the SP.',
      'NIV (Elexon sign): + = system short (needs energy, SIP usually high), − = system long.',
    ],
    steps: [
      {
        title: 'Let time run one settlement period',
        hint: 'Use the step button (⏭) in the header — the clock moves to the next SP.',
        done: ({ state, startedAt }) => state.clock.currentTime >= lessonSpStart(startedAt) + HH,
      },
      {
        title: 'Charge or discharge in the running SP',
        hint: 'In the action panel, move the slider and click "Apply from …". With no contract, everything you do is imbalance.',
        done: c => ledgerSince(c).some(deviated),
      },
      {
        title: 'See it settle at the SIP',
        hint: 'Step past the end of that SP. The table "Today\'s imbalance trades" shows the SIP and your P&L.',
        done: c => ledgerSince(c).some(e => deviated(e) && e.settled),
      },
    ],
  },
  {
    id: 2,
    title: 'Day-ahead auction',
    subtitle: 'Blind, pay-as-cleared: bid for tomorrow before 09:20, deliver it the next day',
    view: 'dayahead',
    assetType: 'non-bm',
    ideas: [
      'The hourly auction (EPEX GB) closes at 09:20 UK for tomorrow. You only see a desk forecast — the clearing price is hidden until the gate.',
      'A buy fills if the clearing price is at or below your max, a sell if it is at or above your min — and you are paid the CLEARING price, not your limit.',
      'Read the desk signals (gas, wind revision, temperature, news) to judge where the forecast is wrong.',
      'Only part of an arbitrage may fill. Linked block orders make the discharge depend on the charge.',
      'At 15:30 a second, half-hourly auction lets you reshape the hourly position.',
    ],
    steps: [
      {
        title: 'Submit buy AND sell orders for tomorrow before 09:20',
        hint: 'Day Ahead → Hourly auction. Try "Arbitrage · safe", then Submit. If it is already past 09:20, step to midnight for the next auction.',
        done: ({ state }) => {
          const d = state.dayAhead;
          const sides = new Set([...d.bids.map(b => b.side), ...(d.blocks ?? []).filter(b => b.auction === 'hourly').map(b => b.side)]);
          const todaySides = new Set([...(d.todayBids ?? []).map(b => b.side), ...(d.todayBlocks ?? []).map(b => b.side)]);
          return (sides.has(OrderSide.BUY) && sides.has(OrderSide.SELL)) || (todaySides.has(OrderSide.BUY) && todaySides.has(OrderSide.SELL));
        },
      },
      {
        title: 'Let the auction clear at 09:20 and check your results',
        hint: 'Step past 09:20. Each order shows the clearing price and whether it filled — hover for the forecast error by cause.',
        done: ({ state }) => (state.dayAhead.results.length > 0 || (state.dayAhead.blockResults ?? []).length > 0) || (state.dayAhead.todayResults ?? []).length > 0,
      },
      {
        title: 'Deliver your schedule the next day',
        hint: 'Step past midnight and open Day Ahead → Today · delivery. Watch delivered vs contracted and any imbalance.',
        done: c => ledgerSince(c).some(e => Math.abs(e.contractedMw) >= 0.5 && e.settled
          && c.state.dayAhead.playerSchedule.some(p => p.deliveryDay === e.deliveryDay && p.period === e.period && p.market === 'da')),
      },
    ],
  },
  {
    id: 3,
    title: 'Intraday re-optimisation',
    subtitle: 'Continuous order book: adjust your position as new information arrives',
    view: 'intraday',
    assetType: 'non-bm',
    ideas: [
      'Every half-hour has its own order book: bids (buyers) and asks (sellers). Crossing the spread fills now but costs the spread.',
      'A limit order rests in the book and may fill later at your price — or never. Market/IOC/FOK fill immediately or are cancelled.',
      'Trading stops 1 hour before delivery (gate closure T-60). Tomorrow\'s products open after the 15:30 auction.',
      'Typical use: buy back a DA sale you can\'t deliver, or sell more when prices rise after news.',
    ],
    steps: [
      {
        title: 'Place an intraday order',
        hint: 'Click an open half-hour, choose side and type, submit. Watch the fills table.',
        done: ({ state, startedAt }) => state.intraday.orders.some(o => o.status !== 'rejected' && o.createdAt >= startedAt),
      },
      {
        title: 'Get a fill',
        hint: 'A market order fills immediately against the ladder; a limit order at the touch usually fills within a few steps.',
        done: ({ state, startedAt }) => state.intraday.fills.some(f => f.time >= startedAt),
      },
      {
        title: 'Re-optimise a day-ahead position',
        hint: 'Trade a half-hour where you already hold a DA position (e.g. buy back part of a DA sale) — your net position changes.',
        done: ({ state, startedAt }) => state.intraday.fills.some(f => f.time >= startedAt && state.dayAhead.playerSchedule.some(p => p.market === 'da' && p.deliveryDay === f.deliveryDay && p.period === f.period)),
      },
    ],
  },
  {
    id: 4,
    title: 'Imbalance & NIV chasing',
    subtitle: 'Deliberately deviate in the direction that helps the system',
    view: 'imbalance',
    assetType: 'non-bm',
    ideas: [
      'A non-BM battery can run long or short of its contract on purpose and is settled at the SIP after the SP.',
      'Help the system: discharge when it is short (NIV > 0), charge when it is long (NIV < 0). The SIP usually rewards this.',
      'You never see the SIP in advance — only signals. The live NIV estimate sharpens every 5 minutes.',
      'Size to conviction: aligned signals → bigger, conflicting signals → small or nothing.',
    ],
    steps: [
      {
        title: 'Steer within an SP using 5-minute set points',
        hint: 'Apply a set point, click "Next 5 min", change it — the boxes show your profile for the SP.',
        // at least two different non-zero set points within one SP
        done: c => ledgerSince(c).some(e => new Set((e.deviationProfile ?? []).map(v => Math.round(v)).filter(v => v !== 0)).size >= 2),
      },
      {
        title: 'Make a call WITH the system and let it settle',
        hint: 'Discharge into a short system (NIV estimate > 0) or charge into a long one, then step past the SP.',
        done: c => ledgerSince(c).some(e => e.settled && deviated(e) && e.deliveryDay === getUtcDayStart(c.state.clock.currentTime)
          && Math.sign(e.deviationMw) === Math.sign(c.state.dayAhead.niv[e.period] ?? 0)),
      },
      {
        title: 'Review your calls',
        hint: 'Check hit rate and slippage at the top of the Imbalance view and the Desk → Review patterns.',
        done: c => ledgerSince(c).filter(e => e.settled && deviated(e)).length >= 3,
      },
    ],
  },
  {
    id: 5,
    title: 'Balancing Mechanism',
    subtitle: 'As a BM unit: follow your FPN and offer flexibility to NESO',
    view: 'imbalance',
    assetType: 'bm',
    ideas: [
      'A BM unit must follow its Final Physical Notification (FPN) — no deliberate deviation.',
      'Instead you post an OFFER (paid to discharge more) and a BID (pay to charge more) per SP, changeable until gate closure (T-60).',
      'NESO accepts when the system needs you and your price is in merit: offers when short, bids when long. You are paid YOUR price (pay-as-bid).',
      'In-merit batteries are often still "skipped" by the control room, and acceptances can be partial or start mid-SP.',
    ],
    steps: [
      {
        title: 'Register as a BM unit',
        hint: 'In the Imbalance action panel, set Asset → BM unit (the lesson does this for you).',
        done: ({ state }) => state.assetType === 'bm',
      },
      {
        title: 'Post an offer or bid for an upcoming SP',
        hint: 'Enter MW and £ for an SP more than an hour ahead and click Save. Evening peaks are often short.',
        done: ({ state, startedAt }) => (state.bmBook ?? []).some(o => o.day + o.sp * HH > startedAt && (o.offerMw > 0 || o.bidMw > 0)),
      },
      {
        title: 'Get a decision from NESO',
        hint: 'Step through your SPs. A BOA appears when its instruction arrives; a skip (in merit but passed over) shows after the SP. If the system doesn\'t need you, nothing happens — offer on several SPs, e.g. the evening peak.',
        done: ({ state, startedAt }) => visibleBoas(state).some(a => a.day + a.sp * HH >= lessonSpStart(startedAt)),
      },
    ],
  },
];
