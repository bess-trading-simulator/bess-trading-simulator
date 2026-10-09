// Market data for one delivery day, plus the desk's DA forecast and signals.
//
// The DA auction is blind: before gate closure a trader only has the desk's
// price forecast — plus news of what changed since that model ran. Here the
// actual price is the truth (real Elexon MID, or a simulated day), and the
// desk forecast is the truth MINUS a set of causal errors:
//   gas move · wind forecast revision · temperature vs normal · events
//   (interconnector / outage / extra imports) · unexplained noise.
// Each cause has a visible, slightly noisy SIGNAL, so a trader can reason about
// which way the forecast is likely wrong. After clearing, the error is shown
// split by cause. (Signals are simulated, also on real-data days.)

import type { DeskEvent, DeskHints, DeskSignals, ForecastErrorBreakdown, LiveNews, MarketDay } from './types';
import type { ElexonDayData } from './elexonApi';
import { generateGBDayAhead, generateImbalanceDay, generateSIPOutturn, deriveForecastsFromNiv, mulberry32 } from './ukMarket';

const DAY_MS = 86_400_000;

/** Rules of thumb (also shown to the player). */
export const RULES = {
  /** £/MWh per GW of residual load at a ~£100 price (merit-order slope) */
  meritSlope: 5,
  /** The merit order is convex: steeper when prices are high (peaker plant on the margin). */
  slopeAt: (price: number) => 5 * Math.max(0.6, Math.min(2.5, Math.abs(price) / 100)),
  /** GW of extra demand per °C colder than normal */
  demandPerDegree: 0.6,
  /** share of the price set by gas plant in an SP (peaks/daytime ≈ gas-marginal) */
  gasShare: (sp: number) => (sp >= 14 && sp <= 41 ? 0.9 : 0.6),
  /** temperature effect is stronger at the evening peak */
  peakWeight: (sp: number) => (sp >= 32 && sp <= 39 ? 1.4 : 1),
};

function round2(v: number): number { return Math.round(v * 100) / 100; }

/** Approx. standard normal from a uniform RNG (Irwin–Hall). */
function gauss(rng: () => number): number {
  return rng() + rng() + rng() + rng() + rng() + rng() - 3;
}

function isWeekdayUtc(day: number): boolean {
  const dow = new Date(day).getUTCDay();
  return dow > 0 && dow < 6;
}

function hasDrivers(d: Pick<MarketDay, 'demandForecast'>): boolean {
  return d.demandForecast.some((v) => v > 0);
}

const spTime = (sp: number) => `${String(Math.floor(sp / 2)).padStart(2, '0')}:${sp % 2 === 0 ? '00' : '30'}`;

const INTERCONNECTORS = ['IFA', 'IFA2', 'BritNed', 'NSL', 'Nemo', 'ElecLink', 'Viking'];

function eventHeadline(kind: DeskEvent['kind'], startSp: number, endSp: number, rng: () => number): string {
  const when = `${spTime(startSp)}–${spTime(endSp + 1)}`;
  if (kind === 'interconnector') {
    const ic = INTERCONNECTORS[Math.floor(rng() * INTERCONNECTORS.length)];
    return `${ic} interconnector: import capacity cut ${when}`;
  }
  if (kind === 'outage') return `CCGT unit tripped / unavailable ${when}`;
  return `Continental prices low: higher GB imports expected ${when}`;
}

/**
 * News the desk sees before gate closure. Real events are usually confirmed
 * (a REMIT UMM / operator notice) but some are still unconfirmed; false alarms
 * are always unconfirmed and look exactly like real news — so an unconfirmed
 * item is genuinely uncertain (≈ 50 % real in this model).
 */
function makeEvents(rng: () => number, prices: number[]): DeskEvent[] {
  const events: DeskEvent[] = [];
  const window = () => {
    const start = 8 + Math.floor(rng() * 34);
    return { startSp: start, endSp: Math.min(47, start + 3 + Math.floor(rng() * 9)) };
  };
  const level = Math.max(30, prices.reduce((a, b) => a + Math.abs(b), 0) / prices.length);
  const add = (kind: DeskEvent['kind'], confirmed: boolean, effect: number) => {
    const w = window();
    events.push({ kind, ...w, confirmed, headline: eventHeadline(kind, w.startSp, w.endSp, rng), effect: round2(effect) });
  };
  const r = rng();
  if (r < 0.25) add('interconnector', rng() < 0.8, level * (0.15 + rng() * 0.25));
  else if (r < 0.45) add('outage', rng() < 0.75, level * (0.12 + rng() * 0.2));
  else if (r < 0.57) add('imports', rng() < 0.7, -level * (0.08 + rng() * 0.14));
  // False alarm: indistinguishable headline, no price effect, always unconfirmed.
  if (rng() < 0.15) {
    const k = rng();
    add(k < 0.5 ? 'interconnector' : k < 0.85 ? 'outage' : 'imports', false, 0);
  }
  return events;
}

/**
 * Build the desk forecast for a day whose actual DA price is known to the
 * engine: forecast = actual − (gas + wind + temperature + event + noise).
 * Deterministic per seed.
 */
export function withDeskForecast(day: MarketDay, seed: number, hints?: DeskHints): MarketDay {
  const rng = mulberry32(seed + 31337);
  const actual = day.daClearing;

  // True causes (the desk model doesn't know these yet). Scenarios can fix
  // them to tell a story (e.g. a cold snap: much colder, less wind).
  const gasRandom = Math.max(-10, Math.min(10, gauss(rng) * 4));          // %
  const tempRandom = Math.max(-5, Math.min(5, gauss(rng) * 1.5));         // °C
  const gasTrue = hints?.gasPct ?? gasRandom;
  const tempTrue = hints?.tempAnomalyC ?? tempRandom;
  let w = hints?.windRevisionMw ?? gauss(rng) * 1200;
  const windTrue = actual.map(() => { w = 0.92 * w + gauss(rng) * 350; return Math.round(w); }); // MW
  const level = Math.max(30, actual.reduce((a, b) => a + Math.abs(b), 0) / actual.length);
  const randomEvents = makeEvents(rng, actual);
  const events: DeskEvent[] = hints?.events
    ? [
      ...hints.events.map(({ effectPct, ...e }) => ({ ...e, effect: round2(level * effectPct) })),
      ...randomEvents.filter(e => e.effect === 0), // keep the odd false alarm
    ]
    : randomEvents;

  const gas = actual.map((p, sp) => round2((gasTrue / 100) * RULES.gasShare(sp) * Math.abs(p)));
  const wind = windTrue.map((mw, sp) => round2(-RULES.slopeAt(actual[sp]) * mw / 1000));
  const temperature = actual.map((p, sp) => round2(-tempTrue * RULES.demandPerDegree * RULES.slopeAt(p) * RULES.peakWeight(sp)));
  const event = actual.map((_, sp) => round2(events.reduce((a, e) => a + (sp >= e.startSp && sp <= e.endSp ? e.effect : 0), 0)));
  const noise = actual.map((p) => round2(gauss(rng) * Math.max(2, Math.abs(p) * 0.03)));
  const errors: ForecastErrorBreakdown = { gas, wind, temperature, event, noise };

  const daForecast = actual.map((p, sp) => round2(p - gas[sp] - wind[sp] - temperature[sp] - event[sp] - noise[sp]));

  // What the trader sees: the causes, measured with a little noise.
  const signals: DeskSignals = {
    gasPct: round2(gasTrue + gauss(rng) * 0.8),
    windRevisionMw: windTrue.map((mw) => Math.round(mw + gauss(rng) * 300)),
    tempAnomalyC: round2(tempTrue + gauss(rng) * 0.3),
    events,
  };
  return { ...day, daForecast, signals, forecastErrors: errors };
}

/** Fully synthetic first day (stylised GB shape, NIV from wind/demand drivers, model SIP). */
export function syntheticMarketDay(day: number, seed: number): MarketDay {
  const isWeekday = isWeekdayUtc(day);
  const windPct = 0.2 + Math.sin(seed * 0.1) * 0.15;
  const daClearing = generateGBDayAhead(seed, isWeekday, windPct);
  const drivers = generateImbalanceDay(seed + 2000, isWeekday);
  return {
    day,
    source: 'synthetic',
    daForecast: daClearing,
    daClearing,
    sipOutturn: generateSIPOutturn(daClearing, drivers.niv),
    niv: drivers.niv,
    demandForecast: drivers.demandForecast,
    windForecast: drivers.windForecast,
    solarForecast: drivers.solarForecast,
    demandOutturn: drivers.demandOutturn,
    windOutturn: drivers.windOutturn,
    solarOutturn: drivers.solarOutturn,
  };
}

/**
 * Simulated next day derived from `today` (real or synthetic): weather and
 * demand change and the actual DA price follows the residual-load change along
 * the merit order, plus a day-level move and noise. Includes the desk forecast.
 */
export function nextDayFrom(today: MarketDay, seed: number): MarketDay {
  const day = today.day + DAY_MS;
  const rng = mulberry32(seed + 4711);
  const weekdayAdj = isWeekdayUtc(day) === isWeekdayUtc(today.day) ? 1 : isWeekdayUtc(day) ? 1 / 0.92 : 0.92;
  const windFactor = 0.55 + rng() * 0.95;              // calmer … much windier
  const windTilt = (rng() - 0.5) * 0.6;                 // weather front moving through
  const demandFactor = (0.97 + rng() * 0.06) * weekdayAdj;
  const solarFactor = 0.5 + rng();

  const base = hasDrivers(today) ? today : syntheticMarketDay(today.day, seed);
  const windForecast = base.windForecast.map((v, sp) => Math.max(0, Math.round(v * windFactor * (1 + windTilt * (sp / 47 - 0.5)))));
  const demandForecast = base.demandForecast.map((v) => Math.round(v * demandFactor));
  const solarForecast = base.solarForecast.map((v) => Math.max(0, Math.round(v * solarFactor)));

  // Forecast errors (outturn − forecast) and the NIV they produce.
  const err = generateImbalanceDay(seed + 2000, isWeekdayUtc(day));
  const windOutturn = windForecast.map((v, sp) => Math.max(0, v + (err.windOutturn[sp] - err.windForecast[sp])));
  const demandOutturn = demandForecast.map((v, sp) => v + (err.demandOutturn[sp] - err.demandForecast[sp]));
  const solarOutturn = solarForecast.map((v, sp) => Math.max(0, v + (err.solarOutturn[sp] - err.solarForecast[sp])));

  // Actual DA price: today + merit-order slope × Δresidual load + day move + noise.
  const rl = (dem: number[], wnd: number[], sol: number[]) => dem.map((v, sp) => v - wnd[sp] - sol[sp]);
  const rlToday = rl(base.demandForecast, base.windForecast, base.solarForecast);
  const rlNext = rl(demandForecast, windForecast, solarForecast);
  const slope = RULES.meritSlope * (0.75 + rng() * 0.6);
  const avg = today.daClearing.reduce((a, b) => a + Math.abs(b), 0) / 48;
  const level = (rng() - 0.5) * 2 * Math.max(4, 0.05 * avg);
  let ar = 0;
  const daClearing = today.daClearing.map((p, sp) => {
    ar = 0.75 * ar + (rng() - 0.5) * 2 * Math.max(3, Math.abs(p) * 0.05) * 0.7;
    return round2(p + slope * (rlNext[sp] - rlToday[sp]) / 1000 + level + ar);
  });

  // Unplanned interconnector trip during delivery (~20 % of days): not in the DA
  // price (nobody knew), but it makes the system short → NIV and SIP spike,
  // and intraday reprices once the news breaks.
  const niv = err.niv.slice();
  const liveNews: LiveNews[] = [];
  if (rng() < 0.2) {
    const from = 12 + Math.floor(rng() * 28);
    const to = Math.min(47, from + 3 + Math.floor(rng() * 6));
    const lostMw = Math.round(700 + rng() * 800);
    for (let sp = from; sp <= to; sp++) {
      const fade = 1 - 0.6 * ((sp - from) / Math.max(1, to - from)); // operators re-dispatch over time
      niv[sp] = Math.round(niv[sp] + lostMw * 0.5 * fade);          // MWh per SP
    }
    const ic = INTERCONNECTORS[Math.floor(rng() * INTERCONNECTORS.length)];
    liveNews.push({ sp: from, category: 'outage', shock: { fromSp: from, toSp: to },
      headline: `${ic} interconnector TRIPPED — ${lostMw} MW of imports lost (unplanned)` });
    if (to < 47) liveNews.push({ sp: to + 1, category: 'outage', headline: `${ic} back to normal flow` });
  }

  return withDeskForecast({
    day,
    source: 'synthetic',
    daForecast: daClearing,
    daClearing,
    sipOutturn: generateSIPOutturn(daClearing, niv),
    niv,
    demandForecast, windForecast, solarForecast,
    demandOutturn, windOutturn, solarOutturn,
    liveNews,
  }, seed);
}

/** Real Elexon day: MID as DA price, real SIP/NIV/forecasts/outturns. The desk forecast is added by withDeskForecast. */
export function realMarketDay(day: number, data: ElexonDayData): MarketDay {
  return {
    day,
    source: 'real',
    date: data.date,
    daForecast: data.daPrices,
    daClearing: data.daPrices,
    sipOutturn: data.sipPrices,
    niv: data.niv,
    demandForecast: data.demandForecast,
    windForecast: data.windForecast,
    solarForecast: data.solarForecast,
    demandOutturn: data.demandOutturn,
    windOutturn: data.windOutturn,
    solarOutturn: data.solarOutturn,
  };
}

/**
 * A "normal" lead-in day before a scenario day: the scenario's typical price
 * level and shape without its extremes, plus noise; fresh wind/demand drivers.
 */
export function leadInDay(scenarioPrices: number[], day: number, seed: number): MarketDay {
  const rng = mulberry32(seed + 1999);
  const sorted = [...scenarioPrices].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.1)], hi = sorted[Math.floor(sorted.length * 0.75)];
  const daClearing = scenarioPrices.map(p => round2(Math.max(lo, Math.min(hi, p)) * (0.92 + rng() * 0.16) + (rng() - 0.5) * 6));
  const base = syntheticMarketDay(day, seed);
  return { ...base, daForecast: daClearing, daClearing, sipOutturn: generateSIPOutturn(daClearing, base.niv) };
}

/** Scenario day (curated or real prices/SIP/NIV). */
export function scenarioMarketDay(
  day: number,
  scenario: { daPrices: number[]; sipPrices: number[]; niv: number[]; realData?: boolean },
): MarketDay {
  const seed = scenario.daPrices.reduce((a, p) => a + Math.abs(Math.round(p)), 0);
  const drivers = deriveForecastsFromNiv(scenario.niv, seed, isWeekdayUtc(day));
  return {
    day,
    source: scenario.realData ? 'real' : 'synthetic',
    daForecast: scenario.daPrices,
    daClearing: scenario.daPrices,
    // Curated scenarios carry their own SIP story (e.g. a trip spike), real days the real SIP.
    sipOutturn: scenario.sipPrices,
    niv: scenario.niv,
    ...drivers,
  };
}


export function utcDateString(day: number): string {
  return new Date(day).toISOString().slice(0, 10);
}
