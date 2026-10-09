// GB electricity market specific types and mechanics

export interface SettlementPeriod {
  period: number;
  startTime: number;
  daPrice: number | null;
  idPrice: number | null;
  sipPrice: number | null;
  niv: number | null;
  bov: number | null;
  sov: number | null;
}

export interface DayView {
  date: number;
  periods: SettlementPeriod[];
  triadRisk: 'low' | 'medium' | 'high';
  windForecastPct: number;
  demandForecastGw: number;
}

export interface TradePosition {
  period: number;
  /** UTC midnight ms of the delivery day for this position */
  deliveryDay: number;
  market: 'da' | 'id' | 'bm' | 'spot';
  action: 'charge' | 'discharge';
  mw: number;
  price: number;
  lockedAt: number;
  delivered?: boolean;
}

export interface OutturnComparison {
  period: number;
  spLabel: string;
  daPrice: number;
  sipPrice: number;
  nivValue: number;
  playerAction: 'charge' | 'discharge' | 'idle';
  playerPrice: number;
  playerMw: number;
  playerMarket: string;
  optimalAction: 'charge' | 'discharge' | 'idle';
  optimalReason: string;
  playerRevenue: number;
  optimalRevenue: number;
  missedRevenue: number;
  explanation: string;
  verdict: 'good' | 'ok' | 'bad' | 'missed' | 'neutral';
}

export interface AnalysisSummary {
  totalPlayerRevenue: number;
  totalOptimalRevenue: number;
  totalMissedRevenue: number;
  score: number; // 0-100
  grade: string;
  overallVerdict: string;
  bestTrade: OutturnComparison | null;
  worstTrade: OutturnComparison | null;
  strategyAdvice: string[];
  periods: OutturnComparison[];
}

// Generate realistic GB day-ahead prices for a given day
export function generateGBDayAhead(seed: number, isWeekday: boolean, windPct: number): number[] {
  const rng = mulberry32(seed);
  const prices: number[] = [];

  for (let sp = 0; sp < 48; sp++) {
    const hour = sp / 2;
    // Scaled to recent GB levels: ~£65 overnight, ~£100 daytime, ~£140 evening peak.
    const base = 35 + gbDemandShape(hour, isWeekday) * 1.25;
    const windEffect = -windPct * 60;
    const noise = (rng() - 0.5) * 8;
    let price = base + windEffect + noise;

    if (hour >= 17 && hour <= 19 && rng() < 0.1) {
      price += 40 + rng() * 100;
    }

    if (windPct > 0.6 && hour >= 1 && hour <= 5) {
      price = Math.min(price, -5 - rng() * 20);
    }

    prices.push(Math.round(price * 100) / 100);
  }

  return prices;
}

/**
 * SIMPLIFIED imbalance price model — used only for synthetic days/scenarios and
 * for the player's *expected* SIP from a NIV forecast. Real days settle at
 * Elexon's actual SIP, which is set by the marginal accepted BM bids/offers
 * (not a formula of NIV) and can be far more extreme.
 *
 * Elexon sign convention: NIV > 0 = system SHORT, NIV < 0 = system LONG.
 *  - Linear coupling at 0.15 £/MWh per MWh of NIV
 *  - Beyond ±500 MWh a stress term kicks in (system runs out of cheap balancing
 *    actions): short → scarcity spike, long → SIP crashes harder negative.
 */
export function imbalanceSettlementPrice(daPrice: number, niv: number): number {
  const linear = niv * 0.15;
  const stressMw = Math.max(0, Math.abs(niv) - 500);
  const stress = stressMw * 0.18 * (niv > 0 ? 1 : -1);
  return Math.round((daPrice + linear + stress) * 100) / 100;
}

// NIV sign follows Elexon: + = system short, − = system long (MWh per SP).
// During an SP traders only have a NIV FORECAST: you see forecast ± band, the
// system settles at the actual NIV/SIP published after the SP. This
// deterministic error (stable per SP + day) is that forecast error.
export const NIV_FORECAST_BAND = 220; // ±MWh shown as the uncertainty band
export function nivForecastError(sp: number, dayIdx: number): number {
  const x = Math.sin((sp + 1) * 12.9898 + dayIdx * 78.233) * 43758.5453;
  return ((x - Math.floor(x)) - 0.5) * 2 * NIV_FORECAST_BAND; // uniform ±BAND
}

/**
 * Real-time NIV estimate during the running SP. Live data (accepted BOAs,
 * frequency, metered output) narrows the error as the SP progresses: at the
 * start you have the forecast, in the last 5-minute interval almost the truth.
 */
export function nivEstimate(actualNiv: number, sp: number, dayIdx: number, subIdx: number): { niv: number; band: number } {
  const remaining = Math.max(0, 1 - subIdx / 6);
  return {
    niv: Math.round(actualNiv + nivForecastError(sp, dayIdx) * remaining),
    band: Math.round(NIV_FORECAST_BAND * remaining),
  };
}

export interface ImbalanceDay {
  niv: number[];
  windForecast: number[];
  windOutturn: number[];
  demandForecast: number[];
  demandOutturn: number[];
  solarForecast: number[];
  solarOutturn: number[];
}

/** Solar generation profile (MW): daytime bell 06:00–18:00, zero at night. */
function solarProfile(sp: number, peak: number): number {
  const hour = sp / 2;
  return Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI)) * peak;
}

/**
 * Generate a day of imbalance drivers as INDEPENDENT, observable signals that
 * together produce NIV — so a trader builds skill by *combining* partial reads
 * (and judging conviction by how well they agree) rather than reading one
 * number:
 *   - wind error (outturn − forecast): surplus → system long  (−NIV)
 *   - demand error (outturn − forecast): above forecast → system short (+NIV)
 *   - residual noise: unobservable → the forecast uncertainty / slippage
 * NIV = demand_excess·0.7 − wind_surplus·0.6 + residual  (Elexon sign: + = short).
 * Wind error is an autocorrelated random walk (skill = read the trend);
 * demand error has a time-of-day bias (evening peaks tend to run short).
 */
export function generateImbalanceDay(seed: number, isWeekday: boolean): ImbalanceDay {
  const rng = mulberry32(seed + 4242);
  const windForecast: number[] = [];
  const windOutturn: number[] = [];
  const demandForecast: number[] = [];
  const demandOutturn: number[] = [];
  const solarForecast: number[] = [];
  const solarOutturn: number[] = [];
  const niv: number[] = [];

  let windErr = (rng() - 0.5) * 300;     // MW, autocorrelated
  const windBase = 4000 + rng() * 9000;  // MW, day's wind level
  const solarPeak = 2500 + rng() * 5000; // MW, day's clear-sky peak

  for (let sp = 0; sp < 48; sp++) {
    const hour = sp / 2;

    // Demand profile (MW): daytime hump + evening peak − overnight trough
    const demandShape = 28000
      + 9000 * Math.max(0, Math.sin(((hour - 6) / 24) * Math.PI * 2))
      + (hour >= 16 && hour <= 20 ? 6000 : 0)
      - (hour >= 1 && hour <= 5 ? 6000 : 0);
    const dFc = Math.round(demandShape * (isWeekday ? 1 : 0.92));
    const demandBias = hour >= 16 && hour <= 20 ? 250 : hour >= 1 && hour <= 5 ? -150 : 0;
    const dErr = Math.round(demandBias + (rng() - 0.5) * 400);

    // Wind: slow random walk around a sinusoidal base
    windErr += (rng() - 0.5) * 300;
    windErr *= 0.85; // mean-revert
    const wFc = Math.round(windBase + 2000 * Math.sin(sp / 6));
    const wErr = Math.round(windErr);

    // Solar: clear-sky bell with cloud noise (does not feed NIV here — wind/demand do)
    const sFc = Math.round(solarProfile(sp, solarPeak));
    const sErr = sFc > 0 ? Math.round((rng() - 0.5) * 0.25 * solarPeak) : 0;

    const residual = (rng() - 0.5) * 150;
    const nivVal = Math.round(dErr * 0.7 - wErr * 0.6 + residual);

    windForecast.push(Math.max(0, wFc));
    windOutturn.push(Math.max(0, wFc + wErr));
    demandForecast.push(dFc);
    demandOutturn.push(dFc + dErr);
    solarForecast.push(sFc);
    solarOutturn.push(Math.max(0, sFc + sErr));
    niv.push(nivVal);
  }
  return { niv, windForecast, windOutturn, demandForecast, demandOutturn, solarForecast, solarOutturn };
}

/**
 * Invert a curated NIV curve into observable wind/demand/solar forecasts whose
 * errors *explain* that NIV — so a scenario with a given NIV shows the player a
 * consistent story (system long ⇒ wind surplus + demand below forecast). Solar
 * is shown for context but, like the synthetic day, is folded into wind here.
 */
export function deriveForecastsFromNiv(
  niv: number[],
  seed: number,
  isWeekday: boolean,
): Omit<ImbalanceDay, 'niv'> {
  const rng = mulberry32(seed + 7777);
  const windForecast: number[] = [];
  const windOutturn: number[] = [];
  const demandForecast: number[] = [];
  const demandOutturn: number[] = [];
  const solarForecast: number[] = [];
  const solarOutturn: number[] = [];

  const windBase = 4000 + rng() * 9000;
  const solarPeak = 2500 + rng() * 5000;

  for (let sp = 0; sp < 48; sp++) {
    const hour = sp / 2;
    const n = niv[sp] ?? 0;

    const demandShape = 28000
      + 9000 * Math.max(0, Math.sin(((hour - 6) / 24) * Math.PI * 2))
      + (hour >= 16 && hour <= 20 ? 6000 : 0)
      - (hour >= 1 && hour <= 5 ? 6000 : 0);
    const dFc = Math.round(demandShape * (isWeekday ? 1 : 0.92));
    // demand above forecast ⇒ short ⇒ +NIV
    const dErr = Math.round(n * 0.35 + (rng() - 0.5) * 180);

    const wFc = Math.round(windBase + 2000 * Math.sin(sp / 6));
    // wind surplus ⇒ long ⇒ −NIV
    const wErr = Math.round(-n * 0.55 + (rng() - 0.5) * 180);

    const sFc = Math.round(solarProfile(sp, solarPeak));
    const sErr = sFc > 0 ? Math.round((rng() - 0.5) * 0.25 * solarPeak) : 0;

    windForecast.push(Math.max(0, wFc));
    windOutturn.push(Math.max(0, wFc + wErr));
    demandForecast.push(dFc);
    demandOutturn.push(dFc + dErr);
    solarForecast.push(sFc);
    solarOutturn.push(Math.max(0, sFc + sErr));
  }
  return { windForecast, windOutturn, demandForecast, demandOutturn, solarForecast, solarOutturn };
}

/**
 * Synthetic SIP outturn curve from the simplified model, for synthetic days and
 * curated scenarios. Real Elexon days use the actual SIP instead. Whichever
 * curve is stored in `dayAhead.sipOutturn` is the single source of truth for
 * settlement, the intraday SIP line and post-trade analysis.
 */
export function generateSIPOutturn(daPrices: number[], niv: number[]): number[] {
  return daPrices.map((da, sp) => imbalanceSettlementPrice(da, niv[sp] ?? 0));
}

export function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gbDemandShape(hour: number, isWeekday: boolean): number {
  const weekdayShape: Record<number, number> = {
    0: 35, 0.5: 33, 1: 31, 1.5: 30, 2: 28, 2.5: 27,
    3: 26, 3.5: 26, 4: 27, 4.5: 28, 5: 32, 5.5: 38,
    6: 45, 6.5: 52, 7: 58, 7.5: 62, 8: 65, 8.5: 63,
    9: 60, 9.5: 58, 10: 56, 10.5: 55, 11: 54, 11.5: 55,
    12: 56, 12.5: 55, 13: 53, 13.5: 52, 14: 51, 14.5: 52,
    15: 54, 15.5: 58, 16: 65, 16.5: 72, 17: 80, 17.5: 85,
    18: 82, 18.5: 75, 19: 68, 19.5: 60, 20: 55, 20.5: 50,
    21: 46, 21.5: 43, 22: 40, 22.5: 38, 23: 36, 23.5: 35,
  };
  const nearest = Math.round(hour * 2) / 2;
  const base = weekdayShape[nearest] ?? 45;
  return isWeekday ? base : base * 0.78;
}
