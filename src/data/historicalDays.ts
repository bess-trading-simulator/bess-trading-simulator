// Bundled ILLUSTRATIVE GB market scenarios.
// These are fictional, hand-shaped days inspired by typical GB market patterns —
// NOT real Elexon data. The `date` only sets weekday/season for the simulation;
// events and numbers are invented for teaching. For real days use the Elexon
// date picker (ids starting with `elexon-`, which carry `realData: true`).
// Each scenario has 48 half-hourly DA prices, SIP outturns, NIV, and context.
// NIV uses Elexon's sign convention: + = system short, − = system long (MWh).

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

export const HISTORICAL_DAYS: HistoricalDay[] = [
  {
    id: 'calm-winter-weekday',
    date: '2024-01-15',
    title: 'Calm Winter Weekday',
    description: 'A typical January weekday with moderate demand, light winds, and a clear evening peak. Good for learning basic arbitrage.',
    difficulty: 'easy',
    daPrices: dailyCurve(28, 58, 48, 85, 38, 4, 100),
    sipPrices: (() => {
      const da = dailyCurve(28, 58, 48, 85, 38, 4, 100);
      return addDeviations(da, 12, 200);
    })(),
    niv: (() => {
      const da = dailyCurve(28, 58, 48, 85, 38, 4, 100);
      const sip = addDeviations(da, 12, 200);
      return generateNiv(da, sip, 300);
    })(),
    windPct: 0.18,
    peakDemandGw: 44.2,
    isTriadRisk: false,
    keyEvents: [
      { sp: 14, text: 'Morning demand ramp — prices rising as offices open' },
      { sp: 34, text: 'Evening peak — highest prices of the day' },
    ],
    optimalRevenue: 8500,
    teachingPoints: [
      'Classic arbitrage day: charge SP3-8 (£26-30), discharge SP33-36 (£82-87)',
      'The DA-SIP spread was small — DA forecast was fairly accurate',
      'Evening peak is predictable on calm winter days',
    ],
  },
  {
    id: 'high-wind-day',
    date: '2024-02-22',
    title: 'Storm Day — Extreme Wind',
    description: 'Illustrative: a major storm system brings wind generation to record levels. Prices collapse overnight and go negative during low demand. Excellent charging opportunity.',
    difficulty: 'easy',
    daPrices: dailyCurve(-5, 25, 8, 45, 15, 6, 400),
    sipPrices: (() => {
      const da = dailyCurve(-5, 25, 8, 45, 15, 6, 400);
      const sip = addDeviations(da, 18, 500);
      // Force some negative SPs
      sip[3] = -15; sip[4] = -22; sip[5] = -18; sip[6] = -12;
      return sip;
    })(),
    niv: (() => {
      const da = dailyCurve(-5, 25, 8, 45, 15, 6, 400);
      const sip = addDeviations(da, 18, 500);
      sip[3] = -15; sip[4] = -22; sip[5] = -18; sip[6] = -12;
      return generateNiv(da, sip, 600);
    })(),
    windPct: 0.78,
    peakDemandGw: 38.5,
    isTriadRisk: false,
    keyEvents: [
      { sp: 4, text: 'Negative prices! Wind output exceeds demand — get paid to charge' },
      { sp: 22, text: 'Solar adds to oversupply — prices near zero' },
      { sp: 34, text: 'Evening peak still elevated but lower than normal' },
    ],
    optimalRevenue: 12000,
    teachingPoints: [
      'Negative prices = free money. Always charge during negative prices',
      'High wind compresses the overall price shape — lower peaks too',
      'The spread is still good: charge at -£20, discharge at £45 = £65/MWh spread',
      'SIP was more volatile than DA forecast — system struggled to balance with so much wind',
    ],
  },
  {
    id: 'beast-from-east',
    date: '2024-01-17',
    title: 'Cold Snap — Scarcity Peak',
    description: 'Illustrative: temperatures drop to -5°C with low wind. Demand surges and the evening peak spikes to £300+.',
    difficulty: 'hard',
    daPrices: (() => {
      const base = dailyCurve(42, 95, 75, 180, 55, 8, 700);
      // Spike SP33-36
      base[33] = 220; base[34] = 310; base[35] = 280; base[36] = 195;
      return base;
    })(),
    sipPrices: (() => {
      const base = dailyCurve(42, 95, 75, 180, 55, 8, 700);
      base[33] = 220; base[34] = 310; base[35] = 280; base[36] = 195;
      const sip = addDeviations(base, 25, 800);
      // SIP even higher during peak — system stress
      sip[33] = 280; sip[34] = 450; sip[35] = 380; sip[36] = 250;
      return sip;
    })(),
    niv: (() => {
      const da = dailyCurve(42, 95, 75, 180, 55, 8, 700);
      da[33] = 220; da[34] = 310; da[35] = 280; da[36] = 195;
      const sip = addDeviations(da, 25, 800);
      sip[33] = 280; sip[34] = 450; sip[35] = 380; sip[36] = 250;
      const niv = generateNiv(da, sip, 900);
      // System short during peak
      niv[33] = 350; niv[34] = 580; niv[35] = 420; niv[36] = 280;
      return niv;
    })(),
    windPct: 0.06,
    peakDemandGw: 51.8,
    isTriadRisk: false,
    keyEvents: [
      { sp: 12, text: 'Demand forecast revised up to 51 GW — tight margins expected' },
      { sp: 30, text: 'Capacity market notice — reserve margins thin' },
      { sp: 34, text: 'System short — SIP spikes to £450/MWh. Discharge now!' },
      { sp: 38, text: 'Peak passes — prices dropping but still elevated' },
    ],
    optimalRevenue: 28000,
    teachingPoints: [
      'Scarcity peaks are among the most valuable periods for batteries (note: demand Triad charges were removed by the TCR in April 2023 — today the value comes from energy prices and imbalance)',
      'Even the overnight trough was expensive (£40+) — cold weather lifts the whole curve',
      'SIP massively exceeded DA forecast at the peak — system was short by 580 MWh',
      'NIV chasing would have been very profitable: system short from SP30 onward',
      'If you had 100% SoC going into SP33, discharging at £450 earns £22,500 in one period',
    ],
  },
  {
    id: 'spring-solar-day',
    date: '2024-04-14',
    title: 'Spring Solar Sunday',
    description: 'Bright spring Sunday with strong solar output. Low demand + high solar = near-zero midday prices. Classic duck curve.',
    difficulty: 'medium',
    daPrices: dailyCurve(18, 35, 5, 55, 25, 5, 1100),
    sipPrices: (() => {
      const da = dailyCurve(18, 35, 5, 55, 25, 5, 1100);
      const sip = addDeviations(da, 10, 1200);
      // Midday collapse even worse than forecast
      sip[21] = -8; sip[22] = -12; sip[23] = -5; sip[24] = 2;
      return sip;
    })(),
    niv: (() => {
      const da = dailyCurve(18, 35, 5, 55, 25, 5, 1100);
      const sip = addDeviations(da, 10, 1200);
      sip[21] = -8; sip[22] = -12; sip[23] = -5; sip[24] = 2;
      return generateNiv(da, sip, 1300);
    })(),
    windPct: 0.22,
    peakDemandGw: 30.5,
    isTriadRisk: false,
    keyEvents: [
      { sp: 20, text: 'Solar output peaks — prices approaching zero' },
      { sp: 22, text: 'Negative prices as solar exceeds demand. Charge!' },
      { sp: 32, text: 'Solar fading — prices ramping into evening peak' },
    ],
    optimalRevenue: 6500,
    teachingPoints: [
      'The "duck curve": prices dip at midday from solar, then spike at sunset when solar drops off',
      'Weekend demand is ~20% lower — reduces the peak price',
      'Two charging windows: overnight AND midday solar trough',
      'Best strategy: partial charge overnight, top up during solar trough, discharge at sunset',
    ],
  },
  {
    id: 'interconnector-trip',
    date: '2024-03-08',
    title: 'Interconnector Trip — BM Stress',
    description: 'Illustrative: an interconnector trips at 3pm, removing 1GW of imports. Prices spike sharply. BM dispatch rates hit £500+.',
    difficulty: 'hard',
    daPrices: dailyCurve(30, 55, 45, 72, 35, 5, 1500),
    sipPrices: (() => {
      const da = dailyCurve(30, 55, 45, 72, 35, 5, 1500);
      const sip = addDeviations(da, 15, 1600);
      // Interconnector trip at SP31 causes spike
      sip[31] = 180; sip[32] = 280; sip[33] = 350; sip[34] = 420;
      sip[35] = 380; sip[36] = 250; sip[37] = 150; sip[38] = 95;
      return sip;
    })(),
    niv: (() => {
      const da = dailyCurve(30, 55, 45, 72, 35, 5, 1500);
      const sip = addDeviations(da, 15, 1600);
      sip[31] = 180; sip[32] = 280; sip[33] = 350; sip[34] = 420;
      sip[35] = 380; sip[36] = 250; sip[37] = 150; sip[38] = 95;
      const niv = generateNiv(da, sip, 1700);
      niv[31] = 400; niv[32] = 600; niv[33] = 750; niv[34] = 800;
      niv[35] = 650; niv[36] = 400; niv[37] = 200;
      return niv;
    })(),
    windPct: 0.20,
    peakDemandGw: 42.0,
    isTriadRisk: false,
    keyEvents: [
      { sp: 31, text: 'Interconnector TRIPS — 1 GW of imports lost instantly' },
      { sp: 32, text: 'NESO takes emergency BM actions — prices spiking' },
      { sp: 34, text: 'BM prices hit £420/MWh — batteries being dispatched at premium' },
      { sp: 37, text: 'Situation stabilising — other interconnectors increasing flow' },
    ],
    optimalRevenue: 22000,
    teachingPoints: [
      'Unplanned outages cause the biggest DA-SIP divergence — this is where NIV chasing pays off',
      'DA forecast was £72 at peak; SIP hit £420 — a £350/MWh gap',
      'Batteries with capacity available for BM earned massive premiums',
      'Key lesson: always keep some discharge headroom for unexpected events',
      'If you\'d sold your full position in DA at £72, you missed out on £420 from SIP',
    ],
  },
  {
    id: 'summer-baseload',
    date: '2024-07-20',
    title: 'Quiet Summer Saturday',
    description: 'Low demand summer weekend. Prices flat and spread is thin. Tests your patience — sometimes the best trade is no trade.',
    difficulty: 'medium',
    daPrices: dailyCurve(20, 32, 22, 42, 25, 3, 1900),
    sipPrices: (() => {
      const da = dailyCurve(20, 32, 22, 42, 25, 3, 1900);
      return addDeviations(da, 8, 2000);
    })(),
    niv: (() => {
      const da = dailyCurve(20, 32, 22, 42, 25, 3, 1900);
      const sip = addDeviations(da, 8, 2000);
      return generateNiv(da, sip, 2100);
    })(),
    windPct: 0.30,
    peakDemandGw: 28.0,
    isTriadRisk: false,
    keyEvents: [
      { sp: 16, text: 'Morning ramp barely noticeable — weekend demand is flat' },
      { sp: 34, text: 'Evening "peak" is only £42 — thin spread' },
    ],
    optimalRevenue: 2800,
    teachingPoints: [
      'Not every day is profitable for arbitrage. Summer weekends have thin spreads',
      'Peak-trough spread of ~£20 barely covers efficiency losses (10% of charge cost)',
      'On days like this, frequency response (DC/DM) is more valuable than arbitrage',
      'Revenue stacking: commit to DC during the day, only arbitrage if spread exceeds £15/MWh',
      'Cycling the battery for minimal spread accelerates degradation — sometimes idle is correct',
    ],
  },
];
