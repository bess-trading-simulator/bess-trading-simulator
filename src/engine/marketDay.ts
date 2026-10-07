// Market data for one delivery day, plus the desk's DA price forecast.
//
// The DA auction is blind: before gate closure a trader only has a forecast.
// `daForecast` therefore carries a realistic, autocorrelated forecast error
// (with occasional fat-tail misses) around the actual price `daClearing`,
// which is only revealed when the auction clears.

import type { MarketDay } from './types';
import type { ElexonDayData } from './elexonApi';
import { generateGBDayAhead, generateImbalanceDay, generateSIPOutturn, deriveForecastsFromNiv, mulberry32 } from './ukMarket';

const DAY_MS = 86_400_000;

function isWeekdayUtc(day: number): boolean {
  const dow = new Date(day).getUTCDay();
  return dow > 0 && dow < 6;
}

/**
 * Desk forecast of DA prices: actual + AR(1) error (σ ≈ 8% of price, min £5)
 * with ~4% chance per SP of a large miss (£20-60). Deterministic per seed.
 */
export function buildDaForecast(actual: number[], seed: number): number[] {
  const rng = mulberry32(seed + 9157);
  let err = 0;
  return actual.map((p) => {
    const sigma = Math.max(5, Math.abs(p) * 0.08);
    err = 0.7 * err + (rng() - 0.5) * 2 * sigma * 0.75;
    let tail = 0;
    if (rng() < 0.04) tail = (rng() < 0.5 ? -1 : 1) * (20 + rng() * 40);
    return Math.round((p + err + tail) * 100) / 100;
  });
}

/** Fully synthetic day (stylised GB shape, NIV from wind/demand drivers, model SIP). */
export function syntheticMarketDay(day: number, seed: number): MarketDay {
  const isWeekday = isWeekdayUtc(day);
  const windPct = 0.2 + Math.sin(seed * 0.1) * 0.15;
  const daClearing = generateGBDayAhead(seed, isWeekday, windPct);
  const drivers = generateImbalanceDay(seed + 2000, isWeekday);
  return {
    day,
    source: 'synthetic',
    daForecast: buildDaForecast(daClearing, seed),
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
 * Synthetic day shaped like a template day (e.g. when the next real day isn't
 * published yet): template DA prices with a level shift + noise, fresh drivers.
 */
export function templatedMarketDay(day: number, template: number[], seed: number): MarketDay {
  const rng = mulberry32(seed + 31);
  const shift = (rng() - 0.5) * 0.2; // ±10% level
  const daClearing = template.map((p) => Math.round((p * (1 + shift) + (rng() - 0.5) * 12) * 100) / 100);
  const base = syntheticMarketDay(day, seed);
  return {
    ...base,
    daForecast: buildDaForecast(daClearing, seed),
    daClearing,
    sipOutturn: generateSIPOutturn(daClearing, base.niv),
  };
}

/** Real Elexon day: MID as DA price, real SIP/NIV/forecasts/outturns. */
export function realMarketDay(day: number, data: ElexonDayData): MarketDay {
  const seed = Math.floor(day / DAY_MS);
  return {
    day,
    source: 'real',
    date: data.date,
    daForecast: buildDaForecast(data.daPrices, seed),
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
    daForecast: buildDaForecast(scenario.daPrices, seed),
    daClearing: scenario.daPrices,
    sipOutturn: scenario.realData ? scenario.sipPrices : generateSIPOutturn(scenario.daPrices, scenario.niv),
    niv: scenario.niv,
    ...drivers,
  };
}

export function utcDateString(day: number): string {
  return new Date(day).toISOString().slice(0, 10);
}
