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
    const base = gbDemandShape(hour, isWeekday);
    const windEffect = -windPct * 40;
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
 * Educational imbalance settlement price.
 * Derived from NIV so the visible signal matches the trade outcome:
 *  - Linear coupling at 0.15 £/MWh per MW of NIV (inverse)
 *  - Beyond ±500 MW a stress term kicks in (system runs out of cheap balancing
 *    actions): long → SIP crashes harder negative, short → scarcity spike.
 * Decoupled from raw Elexon SIP, so charging into a long system pays you and
 * discharging into a long system costs you, regardless of what real SIP did.
 */
export function imbalanceSettlementPrice(daPrice: number, niv: number): number {
  const linear = -niv * 0.15;
  const stressMw = Math.max(0, Math.abs(niv) - 500);
  const stress = stressMw * 0.18 * (niv > 0 ? -1 : 1);
  return Math.round((daPrice + linear + stress) * 100) / 100;
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
 *   - wind error (outturn − forecast): surplus → system long  (+NIV)
 *   - demand error (outturn − forecast): above forecast → system short (−NIV)
 *   - residual noise: unobservable → the forecast uncertainty / slippage
 * NIV = wind_surplus·0.6 − demand_excess·0.7 + residual.
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
    const nivVal = Math.round(wErr * 0.6 - dErr * 0.7 + residual);

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
    // demand above forecast ⇒ short ⇒ −NIV, so explain +NIV with demand below forecast
    const dErr = Math.round(-n * 0.35 + (rng() - 0.5) * 180);

    const wFc = Math.round(windBase + 2000 * Math.sin(sp / 6));
    // wind surplus ⇒ long ⇒ +NIV
    const wErr = Math.round(n * 0.55 + (rng() - 0.5) * 180);

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
 * The single canonical SIP outturn curve: the NIV-derived settlement price per
 * SP, identical to what a trade settles at. Used by spot/imbalance settlement,
 * the intraday SIP line, and post-trade analysis — one source of truth so the
 * price you settle at always matches the price you're graded against.
 *
 * (Even with live Elexon data we derive SIP from the real NIV rather than using
 * Elexon's raw SIP, so the NIV signal the player reads always drives outcomes.)
 */
export function generateSIPOutturn(daPrices: number[], niv: number[]): number[] {
  return daPrices.map((da, sp) => imbalanceSettlementPrice(da, niv[sp] ?? 0));
}

// Comprehensive analysis: compare ALL player activity against SIP outturn
// Only analyses up to `revealedPeriods` — future SPs are excluded
export function generateFullAnalysis(
  playerTrades: TradePosition[],
  daPrices: number[],
  sipPrices: number[],
  niv: number[],
  batteryCapacityMwh: number,
  powerRatingMw: number,
  efficiency: number,
  revealedPeriods = 48,
): AnalysisSummary {
  // Only analyse revealed SPs
  const maxSp = Math.min(revealedPeriods, sipPrices.length);

  // Calculate optimal strategy using only revealed SIP data
  const revealedSip = sipPrices.slice(0, maxSp);
  const sortedBySip = revealedSip.map((p, i) => ({ price: p, sp: i })).sort((a, b) => a.price - b.price);

  const spHours = 0.5;
  const dischargePeriodsAvailable = batteryCapacityMwh / (powerRatingMw * spHours);
  const chargePeriodsNeeded = batteryCapacityMwh / Math.max(0.01, efficiency) / (powerRatingMw * spHours);
  const numChargeSps = Math.min(Math.ceil(chargePeriodsNeeded), maxSp);
  const numDischargeSps = Math.min(Math.ceil(dischargePeriodsAvailable), maxSp);

  const optimalChargeSps = new Set(sortedBySip.slice(0, numChargeSps).map(s => s.sp));
  const optimalDischargeSps = new Set(sortedBySip.slice(-numDischargeSps).map(s => s.sp));

  let totalPlayerRevenue = 0;
  let totalOptimalRevenue = 0;

  const periods: OutturnComparison[] = revealedSip.map((sip, sp) => {
    const da = daPrices[sp] ?? 0;
    const nivVal = niv[sp] ?? 0;
    const hour = sp / 2;
    const spLabel = `${String(Math.floor(hour)).padStart(2, '0')}:${sp % 2 === 0 ? '00' : '30'}`;

    // What the player did
    const playerTrade = playerTrades.find(t => t.period === sp);
    let playerAction: 'charge' | 'discharge' | 'idle' = 'idle';
    let playerPrice = 0;
    let playerMw = 0;
    let playerMarket = '';
    let playerRevenue = 0;

    if (playerTrade) {
      playerAction = playerTrade.action;
      playerPrice = playerTrade.price;
      playerMw = playerTrade.mw;
      playerMarket = playerTrade.market.toUpperCase();

      // Match the battery's actual half-hour cost/revenue calculation.
      if (playerTrade.action === 'discharge') {
        playerRevenue = playerTrade.price * playerTrade.mw * spHours;
      } else {
        playerRevenue = -(playerTrade.price * playerTrade.mw * spHours);
      }
      totalPlayerRevenue += playerRevenue;
    }

    // What was optimal
    let optimalAction: 'charge' | 'discharge' | 'idle' = 'idle';
    let optimalReason: string;
    let optimalRevenue = 0;

    if (optimalChargeSps.has(sp)) {
      optimalAction = 'charge';
      optimalRevenue = -(sip * powerRatingMw * spHours);
      optimalReason = `SIP £${sip.toFixed(2)} was one of the ${numChargeSps} cheapest periods — charging here minimises cost.`;
    } else if (optimalDischargeSps.has(sp)) {
      optimalAction = 'discharge';
      optimalRevenue = sip * powerRatingMw * spHours;
      optimalReason = `SIP £${sip.toFixed(2)} was one of the ${numDischargeSps} most expensive periods — discharging here maximises revenue.`;
    } else {
      optimalReason = `SIP £${sip.toFixed(2)} was mid-range — idling preserves battery cycles for better opportunities.`;
    }
    totalOptimalRevenue += optimalRevenue;

    const missedRevenue = Math.max(0, optimalRevenue - playerRevenue);

    // Generate detailed explanation
    let explanation: string;
    let verdict: 'good' | 'ok' | 'bad' | 'missed' | 'neutral';

    if (playerAction !== 'idle') {
      const daSipDiff = sip - da;
      const daSipDirection = daSipDiff > 0 ? 'higher' : 'lower';

      if (playerAction === 'discharge') {
        if (optimalAction === 'discharge') {
          if (playerPrice >= sip * 0.9) {
            verdict = 'good';
            explanation = `Correct call — you discharged at £${playerPrice.toFixed(2)} (${playerMarket}) during an expensive period. SIP was £${sip.toFixed(2)} (${daSipDirection} than DA forecast of £${da.toFixed(2)}). `;
            if (nivVal < -100) explanation += `The system was short by ${Math.abs(nivVal)} MWh, driving prices up.`;
            else if (nivVal > 100) explanation += `Despite the system being long, prices held up well.`;
          } else {
            verdict = 'ok';
            explanation = `Right idea (discharge during peak) but your price £${playerPrice.toFixed(2)} was below the SIP of £${sip.toFixed(2)}. `;
            explanation += `You left £${((sip - playerPrice) * playerMw * 0.5).toFixed(2)} on the table. `;
            if (playerMarket === 'DA') {
            explanation += `Waiting for intraday or spot might have captured the higher relative price as the system tightened.`;
            } else {
              explanation += `The market moved after your trade — consider waiting closer to delivery when you have more information.`;
            }
          }
        } else if (optimalAction === 'charge') {
          verdict = 'bad';
          explanation = `You discharged but this was actually one of the cheapest periods (SIP £${sip.toFixed(2)}). `;
          explanation += `The DA forecast of £${da.toFixed(2)} was misleading — the outturn was ${Math.abs(daSipDiff).toFixed(2)} ${daSipDirection}. `;
          if (nivVal > 100) explanation += `The system was oversupplied (NIV: +${nivVal} MWh), which pushed SIP down. Charging here would have been optimal.`;
          else explanation += `Better strategy: charge during relatively cheap periods and save discharge capacity for stronger price moves.`;
        } else {
          verdict = 'ok';
          explanation = `You discharged at £${playerPrice.toFixed(2)} during a mid-range period (SIP: £${sip.toFixed(2)}). Not bad, but the battery cycles might have been better used during a stronger relative price move when SIP hit £${Math.max(...sipPrices).toFixed(2)}.`;
        }
      } else {
        // Player charged
        if (optimalAction === 'charge') {
          if (playerPrice <= sip * 1.1) {
            verdict = 'good';
            explanation = `Smart charging — you bought at £${playerPrice.toFixed(2)} (${playerMarket}) during one of the cheapest periods. SIP was £${sip.toFixed(2)}. `;
            if (sip < 0) explanation += `Negative price — you were paid to charge! `;
            if (nivVal > 100) explanation += `System was long (NIV: +${nivVal} MWh), keeping prices low.`;
          } else {
            verdict = 'ok';
            explanation = `You charged at £${playerPrice.toFixed(2)} but could have got it cheaper — SIP was only £${sip.toFixed(2)}. `;
            explanation += `Your DA bid was above the outturn. Consider bidding closer to forecast or waiting for intraday.`;
          }
        } else if (optimalAction === 'discharge') {
          verdict = 'bad';
          explanation = `You charged during one of the most expensive periods! SIP was £${sip.toFixed(2)} — this was a discharge opportunity, not a charge. `;
          explanation += `DA forecast was £${da.toFixed(2)} which looked ${da < sip ? 'cheaper than it turned out' : 'expensive already'}. `;
          explanation += `Charging here cost you the spread — you paid high to charge AND missed high discharge revenue.`;
        } else {
          verdict = 'ok';
          explanation = `Charging at £${playerPrice.toFixed(2)} during a mid-range period. Adequate, but the cheapest available periods had prices as low as £${Math.min(...sipPrices).toFixed(2)}.`;
        }
      }
    } else {
      // Player was idle
      if (optimalAction === 'charge') {
        verdict = 'missed';
        explanation = `Missed opportunity — SIP was £${sip.toFixed(2)}, one of the cheapest periods. `;
        if (sip < 0) explanation += `Negative price! You would have been PAID £${Math.abs(sip).toFixed(2)}/MWh to charge. `;
        explanation += `Charging ${powerRatingMw} MW here would have stored cheap energy for later discharge. DA forecast was £${da.toFixed(2)}.`;
      } else if (optimalAction === 'discharge') {
        verdict = 'missed';
        explanation = `Missed opportunity — SIP was £${sip.toFixed(2)}, one of the most expensive periods. `;
        explanation += `Discharging ${powerRatingMw} MW would have earned £${(sip * powerRatingMw * 0.5).toFixed(2)} this half-hour. `;
        if (nivVal < -200) explanation += `System was significantly short (NIV: ${nivVal} MWh), which drove prices up. `;
        explanation += `DA forecast was £${da.toFixed(2)} — the outturn was ${Math.abs(sip - da).toFixed(2)} ${sip > da ? 'higher' : 'lower'}.`;
      } else {
        verdict = 'neutral';
        explanation = `Correctly idle. SIP was £${sip.toFixed(2)} — mid-range, not worth cycling the battery. Preserving cycles for better spreads is the right call.`;
      }
    }

    return {
      period: sp, spLabel, daPrice: da, sipPrice: sip, nivValue: nivVal,
      playerAction, playerPrice, playerMw, playerMarket,
      optimalAction, optimalReason,
      playerRevenue: Math.round(playerRevenue * 100) / 100,
      optimalRevenue: Math.round(optimalRevenue * 100) / 100,
      missedRevenue: Math.round(missedRevenue * 100) / 100,
      explanation, verdict,
    };
  });

  // Summary stats
  totalPlayerRevenue = Math.round(totalPlayerRevenue * 100) / 100;
  totalOptimalRevenue = Math.round(totalOptimalRevenue * 100) / 100;
  const totalMissedRevenue = Math.round((totalOptimalRevenue - totalPlayerRevenue) * 100) / 100;
  const score = totalOptimalRevenue > 0 ? Math.round((totalPlayerRevenue / totalOptimalRevenue) * 100) : 0;

  let grade = 'F';
  if (score >= 90) grade = 'A';
  else if (score >= 75) grade = 'B';
  else if (score >= 60) grade = 'C';
  else if (score >= 40) grade = 'D';
  else if (score >= 20) grade = 'E';

  // Strategy advice
  const strategyAdvice: string[] = [];
  const badCount = periods.filter(p => p.verdict === 'bad').length;
  const missedCount = periods.filter(p => p.verdict === 'missed').length;
  const tradedCount = periods.filter(p => p.playerAction !== 'idle').length;

  if (tradedCount === 0) {
    strategyAdvice.push('You didn\'t make any trades. Start by using relative signals: charge when price is low versus recent/forecast conditions, then discharge when price is high versus that range.');
  }
  if (badCount > 2) {
    strategyAdvice.push(`${badCount} trades went against you. Review the DA forecast vs SIP outturn — large divergences suggest the market moved unexpectedly. Consider splitting trades between DA and intraday.`);
  }
  if (missedCount > 4) {
    strategyAdvice.push(`You missed ${missedCount} profitable periods. Look at relative lows/highs in the price curve and compare them with SoC availability.`);
  }

  const avgChargePrice = periods.filter(p => p.playerAction === 'charge').reduce((s, p) => s + p.playerPrice, 0) / Math.max(1, periods.filter(p => p.playerAction === 'charge').length);
  const avgDischargePrice = periods.filter(p => p.playerAction === 'discharge').reduce((s, p) => s + p.playerPrice, 0) / Math.max(1, periods.filter(p => p.playerAction === 'discharge').length);
  const spread = avgDischargePrice - avgChargePrice;

  if (tradedCount > 0 && spread < 15) {
    strategyAdvice.push(`Your average spread was only £${spread.toFixed(2)}/MWh. With 90% efficiency you need at least ~£${(avgChargePrice * 0.11).toFixed(0)}/MWh spread to break even. Try to widen the gap between charge and discharge times.`);
  }
  if (tradedCount > 0 && spread >= 30) {
    strategyAdvice.push(`Strong spread of £${spread.toFixed(2)}/MWh between avg charge and discharge prices. Good price selection.`);
  }

  const maxSip = Math.max(...revealedSip);
  const minSip = Math.min(...revealedSip);
  strategyAdvice.push(`SIP range so far (${maxSp} of 48 SPs): £${minSip.toFixed(2)} to £${maxSip.toFixed(2)} (spread: £${(maxSip - minSip).toFixed(2)}/MWh). Optimal revenue with hindsight: £${totalOptimalRevenue.toFixed(2)}.`);

  const bestTrade = periods.filter(p => p.playerAction !== 'idle').sort((a, b) => b.playerRevenue - a.playerRevenue)[0] ?? null;
  const worstTrade = periods.filter(p => p.playerAction !== 'idle').sort((a, b) => a.playerRevenue - b.playerRevenue)[0] ?? null;

  let overallVerdict: string;
  if (score >= 75) overallVerdict = 'Excellent trading day. Your timing and price selection were strong.';
  else if (score >= 50) overallVerdict = 'Decent performance. You captured the main price moves but left some value on the table.';
  else if (score >= 25) overallVerdict = 'Room for improvement. Focus on the basic pattern: charge relative lows, discharge relative highs, and preserve optionality.';
  else if (tradedCount > 0) overallVerdict = 'Tough day. Review the period-by-period breakdown to understand where trades went wrong.';
  else overallVerdict = 'No trades recorded. Submit DA bids or trade spot/intraday, then check Analysis to see how you did.';

  return {
    totalPlayerRevenue, totalOptimalRevenue, totalMissedRevenue,
    score, grade, overallVerdict,
    bestTrade, worstTrade, strategyAdvice, periods,
  };
}

export function assessTriadRisk(
  month: number,
  dayOfWeek: number,
  temperature: number,
  windPct: number,
  demandForecastGw: number,
): 'low' | 'medium' | 'high' {
  if (month < 10 && month > 1) return 'low';
  if (dayOfWeek === 0 || dayOfWeek === 6) return 'low';
  if (temperature < 2 && windPct < 0.15 && demandForecastGw > 48) return 'high';
  if (temperature < 5 && windPct < 0.25 && demandForecastGw > 45) return 'medium';
  return 'low';
}

function mulberry32(seed: number) {
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
