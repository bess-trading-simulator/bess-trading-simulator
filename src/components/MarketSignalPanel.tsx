import type { GameState } from '../engine/types';
import { getSettlementPeriod } from '../engine/clock';
import { getMaxChargeableMw, getMaxDischargeableMw } from '../engine/battery';
import { Activity, AlertTriangle, BatteryCharging, BatteryFull, CheckCircle, Gauge, TrendingDown, TrendingUp } from 'lucide-react';

interface Signal {
  regime: string;
  action: string;
  confidence: 'Low' | 'Medium' | 'High';
  explanation: string;
  spread: number;
  bestCharge: number;
  bestDischarge: number;
  recentMove: number;
  recentRank: number;
  trend: string;
  volatility: number;
  socMessage: string;
  nivMessage: string;
  daSipMessage: string;
  optimizerMessage: string;
  expectedValue: number;
  degradationCost: number;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
}

function buildSignal(state: GameState): Signal {
  const currentPrice = state.currentPrice?.price ?? 0;
  const currentSp = getSettlementPeriod(state.clock.currentTime) - 1;
  const prices = state.dayAhead.forecastPrices.filter(Number.isFinite);
  const recentPrices = state.priceHistory.slice(-12).map(p => p.price).filter(Number.isFinite);
  const priorPrices = state.priceHistory.slice(-13, -1).map(p => p.price).filter(Number.isFinite);
  const recentLow = recentPrices.length ? Math.min(...recentPrices) : currentPrice;
  const recentHigh = recentPrices.length ? Math.max(...recentPrices) : currentPrice;
  const recentRange = Math.max(1, recentHigh - recentLow);
  const recentRank = Math.round(((currentPrice - recentLow) / recentRange) * 100);
  const recentAverage = recentPrices.reduce((sum, price) => sum + price, 0) / Math.max(1, recentPrices.length);
  const priorAverage = priorPrices.reduce((sum, price) => sum + price, 0) / Math.max(1, priorPrices.length);
  const recentMove = currentPrice - priorAverage;
  const volatility = recentPrices.reduce((sum, price) => sum + Math.abs(price - recentAverage), 0) / Math.max(1, recentPrices.length);
  const trend = recentMove > Math.max(3, volatility * 0.35)
    ? 'Rising'
    : recentMove < -Math.max(3, volatility * 0.35)
      ? 'Falling'
      : 'Flat';
  const low = percentile(prices, 0.25) || 30;
  const high = percentile(prices, 0.75) || 70;
  const bestCharge = Math.min(...prices);
  const bestDischarge = Math.max(...prices);
  const spread = bestDischarge - bestCharge;
  const maxChargeMw = getMaxChargeableMw(state.battery);
  const maxDischargeMw = getMaxDischargeableMw(state.battery);
  const efficiency = state.battery.config.efficiencyPct / 100;
  const degradationCost = 4;
  const futurePrices = state.dayAhead.forecastPrices
    .slice(Math.max(0, currentSp + 1))
    .filter(Number.isFinite);
  const futureHigh = futurePrices.length ? Math.max(...futurePrices) : currentPrice;
  const futureLow = futurePrices.length ? Math.min(...futurePrices) : currentPrice;
  const chargeValue = (futureHigh * efficiency) - currentPrice - degradationCost;
  const dischargeValue = currentPrice - (futureLow / Math.max(0.01, efficiency)) - degradationCost;
  const chargeSps = maxChargeMw > 0 ? Math.floor((state.battery.config.capacityMwh - state.battery.currentSocMwh) / (maxChargeMw * 0.5)) : 0;
  const dischargeSps = maxDischargeMw > 0 ? Math.floor(state.battery.currentSocMwh / (maxDischargeMw * 0.5)) : 0;
  const renewablePct = state.currentPrice ? Math.round(state.currentPrice.renewablePct * 100) : 0;
  const demandGw = state.currentPrice ? state.currentPrice.demandMw / 1000 : 0;
  const niv = state.dayAhead.niv[currentSp];
  const da = state.dayAhead.forecastPrices[currentSp];
  const sip = currentSp < state.dayAhead.revealedPeriods ? state.dayAhead.sipOutturn[currentSp] : null;

  let regime = 'Fair';
  if (currentPrice <= low || recentRank <= 25) regime = 'Cheap';
  else if (currentPrice >= high || recentRank >= 75) regime = 'Expensive';

  let action = 'Wait';
  let confidence: Signal['confidence'] = volatility > 8 ? 'Low' : 'Medium';
  let explanation = 'Price is not stretched versus the recent range. Preserve flexibility until the next relative move is clearer.';
  const recentDrop = recentMove < -Math.max(4, volatility * 0.5);
  const recentSpike = recentMove > Math.max(4, volatility * 0.5);
  const relativeCheap = currentPrice <= low || recentRank <= 25 || recentDrop;
  const relativeExpensive = currentPrice >= high || recentRank >= 75 || recentSpike;
  const optimizerCharge = chargeValue > 3;
  const optimizerDischarge = dischargeValue > 3;

  if ((relativeCheap || optimizerCharge) && maxChargeMw > 0.1 && chargeValue >= dischargeValue) {
    action = 'Charge candidate';
    confidence = chargeValue > 10 || recentRank <= 20 || recentDrop || renewablePct > 45 || demandGw < 32 ? 'High' : 'Medium';
    explanation = chargeValue > 3
      ? 'Optimiser sees positive expected value: current price is low enough versus a future sell opportunity after efficiency and degradation.'
      : recentDrop
        ? 'Price has dropped versus the recent average. With headroom available, this is a relative charging opportunity.'
        : 'Price is cheap versus the day or recent range. Headroom is available, so charging can create optionality for a later relative spike.';
  } else if ((relativeExpensive || optimizerDischarge) && maxDischargeMw > 0.1 && dischargeValue > chargeValue) {
    action = 'Discharge candidate';
    confidence = dischargeValue > 10 || recentRank >= 80 || recentSpike || renewablePct < 30 || demandGw > 40 ? 'High' : 'Medium';
    explanation = dischargeValue > 3
      ? 'Optimiser sees positive expected value: current price is high enough versus a future refill opportunity after efficiency and degradation.'
      : recentSpike
        ? 'Price has spiked versus the recent average. Stored energy can be monetised into this relative strength.'
        : 'Price is expensive versus the day or recent range. Stored energy can be monetised if you are not saving it for a stronger move.';
  } else if (maxChargeMw < 0.1 && relativeCheap) {
    action = 'Full: cannot charge';
    confidence = 'High';
    explanation = 'The price is attractive for charging, but the battery has no headroom. You need to discharge before capturing more cheap energy.';
  } else if (maxDischargeMw < 0.1 && relativeExpensive) {
    action = 'Empty: cannot discharge';
    confidence = 'High';
    explanation = 'The price is attractive for discharging, but the battery has no stored energy. Earlier relative charging opportunities mattered.';
  }

  const socMessage = `Can charge ~${Math.max(0, chargeSps)} SPs or discharge ~${Math.max(0, dischargeSps)} SPs at current limits.`;
  const nivMessage = niv === undefined
    ? 'NIV not available yet.'
    : niv > 100
      ? `System short (+${niv} MWh): upward price risk.`
      : niv < -100
        ? `System long (${niv} MWh): downward price risk.`
        : `NIV balanced (${niv ?? 0} MWh).`;
  const daSipMessage = sip === null || da === undefined
    ? 'SIP not revealed for this SP yet.'
    : `DA £${da.toFixed(2)} vs SIP £${sip.toFixed(2)} (${sip >= da ? '+' : ''}£${(sip - da).toFixed(2)}).`;
  const bestOptimizedValue = Math.max(chargeValue, dischargeValue);
  const optimizerMessage = `Charge expected value £${chargeValue.toFixed(2)}/MWh vs discharge expected value £${dischargeValue.toFixed(2)}/MWh using future high £${futureHigh.toFixed(2)}, future low £${futureLow.toFixed(2)}, efficiency ${(efficiency * 100).toFixed(0)}%, degradation £${degradationCost.toFixed(2)}/MWh.`;

  return {
    regime,
    action,
    confidence,
    explanation,
    spread,
    bestCharge,
    bestDischarge,
    recentMove,
    recentRank,
    trend,
    volatility,
    socMessage,
    nivMessage,
    daSipMessage,
    optimizerMessage,
    expectedValue: bestOptimizedValue,
    degradationCost,
  };
}

function actionIcon(action: string) {
  if (action.includes('Charge')) return <BatteryCharging size={16} />;
  if (action.includes('Discharge')) return <TrendingUp size={16} />;
  if (action.includes('cannot')) return <AlertTriangle size={16} />;
  return <CheckCircle size={16} />;
}

export default function MarketSignalPanel({ state, detail = 'simple' }: { state: GameState; detail?: 'simple' | 'advanced' }) {
  const signal = buildSignal(state);
  const currentSp = getSettlementPeriod(state.clock.currentTime);
  const price = state.currentPrice?.price ?? 0;
  const demandGw = state.currentPrice ? state.currentPrice.demandMw / 1000 : 0;
  const renewablePct = state.currentPrice ? Math.round(state.currentPrice.renewablePct * 100) : 0;

  return (
    <div className="panel market-signal-panel" id="market-signal">
      <div className="panel-header">
        <h3><Activity size={15} /> Market Signal</h3>
      </div>
      <div className={`signal-hero ${signal.action.toLowerCase().replace(/[^a-z]+/g, '-')}`}>
        <div>
          <span className="signal-kicker">SP{currentSp} · {signal.regime}</span>
          <strong>{signal.action}</strong>
        </div>
        <div className="signal-icon">{actionIcon(signal.action)}</div>
      </div>
      <p className="signal-explanation">{signal.explanation}</p>
      <div className="signal-grid">
        <div><span>Price</span><strong>£{price.toFixed(2)}</strong></div>
        <div><span>Battery</span><strong>{state.battery.socPct.toFixed(0)}%</strong></div>
        <div><span>Trend</span><strong>{signal.trend}</strong></div>
        <div><span>Confidence</span><strong>{signal.confidence}</strong></div>
        {detail === 'advanced' && <div><span>Demand</span><strong>{demandGw.toFixed(1)} GW</strong></div>}
        {detail === 'advanced' && <div><span>Renewables</span><strong>{renewablePct}%</strong></div>}
        {detail === 'advanced' && <div><span>Recent Rank</span><strong>{signal.recentRank}%</strong></div>}
        {detail === 'advanced' && <div><span>Expected Value</span><strong>£{signal.expectedValue.toFixed(2)}</strong></div>}
      </div>
      {detail === 'advanced' ? (
        <div className="signal-detail-list">
          <div><Gauge size={14} /> Spread visible: £{signal.spread.toFixed(2)}/MWh ({signal.bestCharge.toFixed(1)} to {signal.bestDischarge.toFixed(1)})</div>
          <div><CheckCircle size={14} /> {signal.optimizerMessage}</div>
          <div><TrendingUp size={14} /> Recent move: {signal.recentMove >= 0 ? '+' : ''}£{signal.recentMove.toFixed(2)}/MWh vs recent average. Volatility: £{signal.volatility.toFixed(2)}.</div>
          <div><BatteryFull size={14} /> {signal.socMessage}</div>
          <div><TrendingDown size={14} /> {signal.daSipMessage}</div>
          <div><AlertTriangle size={14} /> {signal.nivMessage}</div>
        </div>
      ) : (
        <div className="signal-simple-list">
          <div><Gauge size={14} /> Buy low, sell later only if the spread is worth it.</div>
          <div><BatteryFull size={14} /> {signal.socMessage}</div>
        </div>
      )}
    </div>
  );
}
