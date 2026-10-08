// Market data for one delivery day, plus the desk's fundamental DA forecast.
//
// The DA auction is blind: before gate closure a trader only has a forecast.
// The desk forecast here is FUNDAMENTAL and explainable:
//   forecast(sp) = today's cleared DA price(sp)                      (reference)
//                + β · Δresidual load(sp)                            (merit order)
// where residual load = demand − wind − solar (day-ahead forecasts) and β
// (£/MWh per GW) is estimated by regressing today's prices on today's residual
// load. The actual clearing differs by what the model can't see: a steeper or
// flatter merit order, gas/carbon moves, plant outages, interconnector flows
// and other participants' bids.

import type { ForecastModel, MarketDay } from './types';
import type { ElexonDayData } from './elexonApi';
import { generateGBDayAhead, generateImbalanceDay, generateSIPOutturn, deriveForecastsFromNiv, mulberry32 } from './ukMarket';

const DAY_MS = 86_400_000;
const BETA_MIN = 1.5;
const BETA_MAX = 12;
/** Long-run prior for the GB merit-order slope (£/MWh per GW) */
const BETA_PRIOR = 5;
/** Weight of today's fit vs the prior: one day of data is noisy (the evening peak dominates) */
const BETA_FIT_WEIGHT = 0.5;

function round2(v: number): number { return Math.round(v * 100) / 100; }

function isWeekdayUtc(day: number): boolean {
  const dow = new Date(day).getUTCDay();
  return dow > 0 && dow < 6;
}

/** Residual load (MW) per SP from day-ahead forecasts: demand − wind − solar. */
export function residualLoad(d: Pick<MarketDay, 'demandForecast' | 'windForecast' | 'solarForecast'>): number[] {
  return d.demandForecast.map((dem, sp) => dem - (d.windForecast[sp] ?? 0) - (d.solarForecast[sp] ?? 0));
}

function hasDrivers(d: Pick<MarketDay, 'demandForecast'>): boolean {
  return d.demandForecast.some((v) => v > 0);
}

/**
 * Merit-order slope (£/MWh per GW of residual load): least-squares fit on one
 * day of prices, shrunk halfway toward a long-run prior and clamped to a
 * plausible GB range.
 */
export function estimateBeta(day: Pick<MarketDay, 'daClearing' | 'demandForecast' | 'windForecast' | 'solarForecast'>): number {
  if (!hasDrivers(day)) return BETA_PRIOR;
  const x = residualLoad(day).map((v) => v / 1000);
  const y = day.daClearing;
  const n = Math.min(x.length, y.length);
  const mx = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = y.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
  const fit = sxx > 1e-6 ? sxy / sxx : BETA_PRIOR;
  const beta = BETA_FIT_WEIGHT * fit + (1 - BETA_FIT_WEIGHT) * BETA_PRIOR;
  return round2(Math.max(BETA_MIN, Math.min(BETA_MAX, beta)));
}

/** Build the fundamental desk forecast for `next`, made with today's information. */
export function withFundamentalForecast(next: MarketDay, today: MarketDay): MarketDay {
  const beta = estimateBeta(today);
  const usable = hasDrivers(today) && hasDrivers(next);
  const delta = (a: number[], b: number[]) => a.map((v, sp) => (usable ? v - (b[sp] ?? 0) : 0));
  const model: ForecastModel = {
    beta,
    ref: today.daClearing.slice(0, 48),
    demandDelta: delta(next.demandForecast, today.demandForecast),
    windDelta: delta(next.windForecast, today.windForecast),
    solarDelta: delta(next.solarForecast, today.solarForecast),
  };
  const daForecast = model.ref.map((ref, sp) =>
    round2(ref + beta * (model.demandDelta[sp] - model.windDelta[sp] - model.solarDelta[sp]) / 1000));
  return { ...next, daForecast, forecastModel: model };
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
 * demand change, and the actual DA price follows the residual-load change
 * through a "true" merit-order slope plus market shocks the desk can't see.
 * Includes the desk's fundamental forecast.
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
  const windForecast = base.windForecast.map((w, sp) => Math.max(0, Math.round(w * windFactor * (1 + windTilt * (sp / 47 - 0.5)))));
  const demandForecast = base.demandForecast.map((d) => Math.round(d * demandFactor));
  const solarForecast = base.solarForecast.map((s) => Math.max(0, Math.round(s * solarFactor)));

  // Forecast errors (outturn − forecast) and the NIV they produce.
  const err = generateImbalanceDay(seed + 2000, isWeekdayUtc(day));
  const windOutturn = windForecast.map((w, sp) => Math.max(0, w + (err.windOutturn[sp] - err.windForecast[sp])));
  const demandOutturn = demandForecast.map((d, sp) => d + (err.demandOutturn[sp] - err.demandForecast[sp]));
  const solarOutturn = solarForecast.map((s, sp) => Math.max(0, s + (err.solarOutturn[sp] - err.solarForecast[sp])));

  // Actual DA price: reference + true slope × Δresidual load + market shock.
  const betaTrue = round2(estimateBeta(today) * (0.75 + rng() * 0.6));
  const rlToday = residualLoad(base);
  const rlNext = residualLoad({ demandForecast, windForecast, solarForecast });
  const level = (rng() - 0.5) * 2 * Math.max(4, 0.05 * Math.abs(today.daClearing.reduce((a, b) => a + b, 0) / 48)); // gas/carbon day move
  let ar = 0;
  const shock = today.daClearing.map((p) => {
    const sigma = Math.max(3, Math.abs(p) * 0.05);
    ar = 0.75 * ar + (rng() - 0.5) * 2 * sigma * 0.7;
    const event = rng() < 0.03 ? (rng() < 0.65 ? 1 : -1) * (20 + rng() * 50) : 0; // outage / IC trip / surprise
    return round2(level + ar + event);
  });
  const daClearing = today.daClearing.map((p, sp) => round2(p + betaTrue * (rlNext[sp] - rlToday[sp]) / 1000 + shock[sp]));

  const next: MarketDay = {
    day,
    source: 'synthetic',
    daForecast: daClearing,
    daClearing,
    sipOutturn: generateSIPOutturn(daClearing, err.niv),
    niv: err.niv,
    demandForecast, windForecast, solarForecast,
    demandOutturn, windOutturn, solarOutturn,
    truth: { beta: betaTrue, shock },
  };
  // The desk compares tomorrow's forecasts with today's (base supplies drivers if today lacks them).
  return withFundamentalForecast(next, {
    ...today,
    demandForecast: base.demandForecast,
    windForecast: base.windForecast,
    solarForecast: base.solarForecast,
  });
}

/** Real Elexon day: MID as DA price, real SIP/NIV/forecasts/outturns. Forecast is set by withFundamentalForecast. */
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

/** Illustrative scenario day (curated prices/NIV); SIP from model unless real. */
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
    sipOutturn: scenario.realData ? scenario.sipPrices : generateSIPOutturn(scenario.daPrices, scenario.niv),
    niv: scenario.niv,
    ...drivers,
  };
}

/** Rebuild TODAY's MarketDay from the day-ahead state arrays (today = the running delivery day). */
export function todayFromState(s: {
  dayAhead: {
    forecastPrices: number[]; sipOutturn: number[]; niv: number[];
    demandForecast: number[]; windForecast: number[]; solarForecast: number[];
    demandOutturn: number[]; windOutturn: number[]; solarOutturn: number[];
    todaySource?: 'real' | 'synthetic';
  };
  nextDay: MarketDay;
}): MarketDay {
  const d = s.dayAhead;
  return {
    day: s.nextDay.day - DAY_MS,
    source: d.todaySource ?? 'synthetic',
    daForecast: d.forecastPrices,
    daClearing: d.forecastPrices,
    sipOutturn: d.sipOutturn,
    niv: d.niv,
    demandForecast: d.demandForecast,
    windForecast: d.windForecast,
    solarForecast: d.solarForecast,
    demandOutturn: d.demandOutturn,
    windOutturn: d.windOutturn,
    solarOutturn: d.solarOutturn,
  };
}

export function utcDateString(day: number): string {
  return new Date(day).toISOString().slice(0, 10);
}
