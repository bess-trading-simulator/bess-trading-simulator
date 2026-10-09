import type { DeskHints } from '../engine/types';

// Bundled ILLUSTRATIVE GB market scenarios.
// These are fictional, hand-shaped days inspired by typical GB market patterns —
// NOT real Elexon data. The `date` only sets weekday/season for the simulation;
// events and numbers are invented for teaching. For real days use the Elexon
// date picker (ids starting with `elexon-`, which carry `realData: true`).
// Each scenario has 48 half-hourly DA prices, SIP outturns, NIV, and context.
// NIV uses Elexon's sign convention: + = system short, − = system long (MWh).
// Price levels reflect recent GB markets (~£60-80 overnight, ~£150 evening peak).
// The scenario day is the DAY-AHEAD AUCTION's delivery day: the session starts on
// a normal lead-in day, you bid for the scenario day with deskHints visible, then
// trade/deliver it with keyEvents breaking as live news at their SP.

export interface HistoricalDay {
  id: string;
  date: string;
  title: string;
  description: string;
  difficulty: 'easy' | 'medium' | 'hard';
  daPrices: number[]; // 48 SPs
  sipPrices: number[]; // 48 SPs
  niv: number[]; // 48 SPs
  windPct: number;
  peakDemandGw: number;
  isTriadRisk: boolean;
  keyEvents: { sp: number; text: string }[];
  optimalRevenue: number; // £ with perfect foresight on 50MW battery
  teachingPoints: string[];
  /** true only for days loaded from Elexon: sipPrices are the real settled SIP. */
  realData?: boolean;
  /** Unforeseen shock (1-based SPs): intraday prices it in only after the first key event */
  shock?: { fromSp: number; toSp: number };
  /** What the desk sees on D-1 before the auction (gas, temperature, wind, news) */
  deskHints?: DeskHints;
}

// Helper to generate smooth daily price curves
function dailyCurve(
  overnightLow: number,
  morningPeak: number,
  middayDip: number,
  eveningPeak: number,
  lateEvening: number,
  noise: number,
  seed: number,
): number[] {
  const rng = seededRng(seed);
  const shape = [
    // SP1-10 (00:00-05:00): overnight trough
    overnightLow + 2, overnightLow + 1, overnightLow, overnightLow - 1,
    overnightLow - 2, overnightLow - 2, overnightLow - 1, overnightLow,
    overnightLow + 2, overnightLow + 5,
    // SP11-18 (05:00-09:00): morning ramp
    overnightLow + 10, overnightLow + 18, morningPeak - 10, morningPeak - 5,
    morningPeak, morningPeak - 2, morningPeak - 5, morningPeak - 8,
    // SP19-28 (09:00-14:00): midday
    middayDip + 5, middayDip + 3, middayDip, middayDip - 2,
    middayDip - 1, middayDip + 1, middayDip + 3, middayDip + 5,
    middayDip + 8, middayDip + 12,
    // SP29-38 (14:00-19:00): afternoon ramp to evening peak
    middayDip + 15, middayDip + 20, eveningPeak - 15, eveningPeak - 8,
    eveningPeak - 3, eveningPeak, eveningPeak + 2, eveningPeak,
    eveningPeak - 5, eveningPeak - 12,
    // SP39-48 (19:00-00:00): evening decline
    lateEvening + 10, lateEvening + 8, lateEvening + 5, lateEvening + 3,
    lateEvening, lateEvening - 2, lateEvening - 3, lateEvening - 2,
    lateEvening, lateEvening + 1,
  ];

  return shape.map(v => Math.round((v + (rng() - 0.5) * noise) * 100) / 100);
}

function seededRng(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addDeviations(base: number[], maxDev: number, seed: number): number[] {
  const rng = seededRng(seed);
  return base.map(v => Math.round((v + (rng() - 0.48) * maxDev) * 100) / 100);
}

function generateNiv(da: number[], sip: number[], seed: number): number[] {
  const rng = seededRng(seed);
  // SIP above DA ⇒ system short ⇒ positive NIV (Elexon convention)
  return da.map((d, i) => Math.round((sip[i] - d) * 3 + (rng() - 0.5) * 200));
}

/** Build a scenario's DA/SIP/NIV from a curve plus explicit SIP overrides (1-based SPs → value). */
function scenarioData(
  curve: Parameters<typeof dailyCurve>,
  sipDev: number,
  seeds: [number, number],
  daOverrides: Record<number, number> = {},
  sipOverrides: Record<number, number> = {},
  nivOverrides: Record<number, number> = {},
) {
  const da = dailyCurve(...curve);
  for (const [sp, v] of Object.entries(daOverrides)) da[Number(sp) - 1] = v;
  const sip = addDeviations(da, sipDev, seeds[0]);
  for (const [sp, v] of Object.entries(sipOverrides)) sip[Number(sp) - 1] = v;
  const niv = generateNiv(da, sip, seeds[1]);
  for (const [sp, v] of Object.entries(nivOverrides)) niv[Number(sp) - 1] = v;
  return { daPrices: da, sipPrices: sip, niv };
}

export const HISTORICAL_DAYS: HistoricalDay[] = [
  {
    id: 'calm-winter-weekday',
    date: '2024-01-15',
    title: 'Calm Winter Weekday',
    description: 'A typical January weekday with moderate demand, light winds and a clear evening peak. Good for learning the basic day-ahead arbitrage.',
    difficulty: 'easy',
    ...scenarioData([65, 112, 97, 156, 81, 6, 100], 18, [200, 300]),
    windPct: 0.18,
    peakDemandGw: 44.2,
    isTriadRisk: false,
    keyEvents: [
      { sp: 14, text: 'Morning demand ramp — prices rising as offices open' },
      { sp: 34, text: 'Evening peak under way — highest prices of the day' },
    ],
    optimalRevenue: 8500,
    deskHints: { gasPct: 0.8, tempAnomalyC: -0.5 },
    teachingPoints: [
      'Classic arbitrage day: charge overnight (~£63-68), discharge into the evening peak (~£150-160)',
      'Signals were quiet — the desk forecast was close, so tight limits worked',
      'Evening peaks on calm winter weekdays are predictable: a linked charge/discharge block is the safe way to bid them',
    ],
  },
  {
    id: 'high-wind-day',
    date: '2024-02-22',
    title: 'Storm Day — Extreme Wind',
    description: 'Illustrative: a major storm system brings wind generation to record levels. Prices collapse overnight and go negative at low demand. Excellent charging opportunity.',
    difficulty: 'easy',
    ...scenarioData([-15, 40, 15, 85, 30, 8, 400], 26, [500, 600], {}, { 4: -35, 5: -45, 6: -38, 7: -25 }),
    windPct: 0.78,
    peakDemandGw: 38.5,
    isTriadRisk: false,
    keyEvents: [
      { sp: 4, text: 'Negative prices — wind output exceeds demand, get paid to charge' },
      { sp: 22, text: 'Solar adds to oversupply — prices near zero' },
      { sp: 34, text: 'Evening peak still elevated but lower than normal' },
    ],
    optimalRevenue: 12000,
    deskHints: {
      gasPct: -2.5, windRevisionMw: 3500, tempAnomalyC: 1,
      events: [{ kind: 'imports', startSp: 2, endSp: 13, confirmed: true, headline: 'Storm front arriving early: wind fleet at maximum overnight', effectPct: -0.25 }],
    },
    teachingPoints: [
      'Negative prices pay you to charge — bid generous buy limits overnight',
      'The wind revision signal was large and positive: the desk forecast was too HIGH, actual prices came in lower',
      'High wind compresses the whole curve — lower peaks too, so the spread is smaller than it looks',
      'SIP was more volatile than DA — the system struggled to balance with so much wind',
    ],
  },
  {
    id: 'beast-from-east',
    date: '2024-01-17',
    title: 'Cold Snap — Scarcity Peak',
    description: 'Illustrative: temperatures drop to -5°C with low wind. Demand surges and the evening peak spikes far above normal.',
    difficulty: 'hard',
    ...scenarioData(
      [87, 172, 140, 290, 108, 12, 700], 40, [800, 900],
      { 34: 372, 35: 516, 36: 468, 37: 332 },
      { 34: 468, 35: 740, 36: 628, 37: 420 },
      { 34: 350, 35: 580, 36: 420, 37: 280 },
    ),
    windPct: 0.06,
    peakDemandGw: 51.8,
    isTriadRisk: false,
    keyEvents: [
      { sp: 12, text: 'Demand forecast revised up to 51 GW — tight margins expected' },
      { sp: 30, text: 'NESO Capacity Market Notice — reserve margins thin this evening' },
      { sp: 34, text: 'System short — imbalance prices spiking' },
      { sp: 38, text: 'Peak passes — prices dropping but still elevated' },
    ],
    optimalRevenue: 28000,
    deskHints: {
      gasPct: 5, tempAnomalyC: -4, windRevisionMw: -2500,
      events: [{ kind: 'outage', startSp: 32, endSp: 37, confirmed: true, headline: 'NESO: Electricity Margin Notice expected for 16:00–19:00', effectPct: 0.6 }],
    },
    teachingPoints: [
      'Every signal pointed UP: colder, less wind, gas higher, a margin notice — the desk forecast was far too low at the peak',
      'Sell limits set at the forecast left money on the table; the auction cleared well above it',
      'Cold weather lifts the whole curve — even overnight charging was expensive',
      'SIP exceeded DA massively at the peak (system short by ~580 MWh): energy held back for imbalance earned the most',
      'Scarcity peaks are among the most valuable periods for batteries (demand Triad charges were removed by the TCR in April 2023)',
    ],
  },
  {
    id: 'spring-solar-day',
    date: '2024-04-14',
    title: 'Spring Solar Sunday',
    description: 'Bright spring Sunday with strong solar output. Low demand + high solar = near-zero midday prices. Classic duck curve.',
    difficulty: 'medium',
    ...scenarioData([49, 76, 4, 108, 60, 8, 1100], 16, [1200, 1300], {}, { 22: -15, 23: -22, 24: -10, 25: 2 }),
    windPct: 0.22,
    peakDemandGw: 30.5,
    isTriadRisk: false,
    keyEvents: [
      { sp: 20, text: 'Solar output peaks — prices approaching zero' },
      { sp: 22, text: 'Negative prices as solar exceeds demand. Charge!' },
      { sp: 32, text: 'Solar fading — prices ramping into the evening peak' },
    ],
    optimalRevenue: 6500,
    deskHints: { gasPct: -1, tempAnomalyC: 2.5, windRevisionMw: 800 },
    teachingPoints: [
      'The duck curve: prices dip at midday from solar, then jump at sunset when solar drops off',
      'Two charging windows: overnight AND the midday solar trough',
      'The 30-min auction is ideal for the steep evening ramp: the two half-hours of an hour can differ a lot',
      'Weekend demand is ~20 % lower — that caps the evening peak',
    ],
  },
  {
    id: 'interconnector-trip',
    date: '2024-03-08',
    title: 'Ordinary Weekday — Watch the News',
    description: 'Illustrative: an ordinary-looking spring weekday. Bid it like any other — then keep an eye on the news during delivery.',
    difficulty: 'hard',
    ...scenarioData(
      [68, 108, 92, 135, 76, 8, 1500], 24, [1600, 1700], {},
      { 31: 308, 32: 468, 33: 580, 34: 692, 35: 628, 36: 420, 37: 260, 38: 172 },
      { 31: 400, 32: 600, 33: 750, 34: 800, 35: 650, 36: 400, 37: 200 },
    ),
    shock: { fromSp: 31, toSp: 38 },
    // A quiet D-1: no real news — the trip is unforeseeable.
    deskHints: { gasPct: -1, tempAnomalyC: 0.5, windRevisionMw: 300, events: [] },
    windPct: 0.20,
    peakDemandGw: 42.0,
    isTriadRisk: false,
    keyEvents: [
      { sp: 31, text: 'Interconnector TRIPPED — 1 GW of imports lost instantly (unplanned)' },
      { sp: 32, text: 'NESO taking emergency BM actions — imbalance prices spiking' },
      { sp: 34, text: 'System still very short — BM offers accepted at £500+' },
      { sp: 37, text: 'Situation stabilising — other interconnectors increasing flow' },
    ],
    optimalRevenue: 22000,
    teachingPoints: [
      'Unplanned outages cause the biggest DA-SIP divergence: the auction cleared ~£135 at the peak, SIP hit ~£690',
      'Nothing in the D-1 signals warned of it — you can only be prepared, not predict it',
      'Keep some discharge headroom (energy in the battery) for unexpected events',
      'Intraday repriced the moment the trip was announced — speed matters',
      'If you had sold your whole battery in DA at ~£135, you missed the imbalance spike',
    ],
  },
  {
    id: 'summer-baseload',
    date: '2024-07-20',
    title: 'Quiet Summer Saturday',
    description: 'Low demand summer weekend. Prices flat and the spread is thin. Tests your patience — sometimes the best trade is no trade.',
    difficulty: 'medium',
    ...scenarioData([52, 71, 55, 87, 60, 5, 1900], 13, [2000, 2100]),
    windPct: 0.30,
    peakDemandGw: 28.0,
    isTriadRisk: false,
    keyEvents: [
      { sp: 16, text: 'Morning ramp barely noticeable — weekend demand is flat' },
      { sp: 34, text: 'Evening "peak" is shallow — thin spread' },
    ],
    optimalRevenue: 2800,
    deskHints: { gasPct: -1, windRevisionMw: 1000, tempAnomalyC: 0.5 },
    teachingPoints: [
      'Not every day pays: a peak-trough spread of ~£35 barely covers efficiency losses and degradation',
      'With a thin spread, a single wrong fill (only one leg of your arbitrage) wipes out the day',
      'Frequency response would usually be worth more than arbitrage on a day like this',
      'Sometimes idle is correct — cycling for a minimal spread only wears the battery',
    ],
  },
];
