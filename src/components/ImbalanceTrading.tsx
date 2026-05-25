import { useState } from 'react';
import type { GameState } from '../engine/types';
import { MarketType, OrderSide } from '../engine/types';
import { getSettlementPeriod, getUtcDayStart, formatDeliveryDay } from '../engine/clock';
import { getMaxChargeableMw, getMaxDischargeableMw } from '../engine/battery';
import { imbalanceSettlementPrice } from '../engine/ukMarket';
import HelpIcon from './HelpIcon';
import {
  ComposedChart, Line, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { Activity, Wind, Gauge, AlertCircle, ArrowDown, ArrowUp, Clock, Eye, EyeOff } from 'lucide-react';

interface Props {
  state: GameState;
  onCharge: (mw: number) => void;
  onDischarge: (mw: number) => void;
}

const HISTORY_LOOKBACK = 12;

// NIV forecasts carry uncertainty: you see a forecast ± band, but the system
// settles at the actual NIV revealed after the SP. This deterministic error
// (stable per SP+day) realises as slippage between your expected and settled price.
const NIV_FORECAST_BAND = 220; // ±MW shown as the uncertainty band
function nivForecastError(sp: number, dayIdx: number): number {
  const x = Math.sin((sp + 1) * 12.9898 + dayIdx * 78.233) * 43758.5453;
  return ((x - Math.floor(x)) - 0.5) * 2 * NIV_FORECAST_BAND; // uniform ±BAND
}

function NivHeatmap({ niv, currentSp, revealedPeriods, tradeBySp }: {
  niv: number[];
  currentSp: number;
  revealedPeriods: number;
  tradeBySp: Map<number, { isHit: boolean; direction: 'charge' | 'discharge' }>;
}) {
  // Color intensity scales to ±1500 MW
  const cell = (sp: number) => {
    const v = niv[sp] ?? 0;
    const isFuture = sp > currentSp;
    const isCurrent = sp === currentSp;
    const isRevealed = sp < revealedPeriods;
    const t = Math.max(-1, Math.min(1, v / 1500));
    const intensity = Math.abs(t) * 70; // 0–70% blend
    const bg = isFuture
      ? 'transparent'
      : t > 0
        ? `color-mix(in srgb, #007be2 ${intensity}%, var(--niv-cell-base))`
        : `color-mix(in srgb, #ff874b ${intensity}%, var(--niv-cell-base))`;
    const trade = tradeBySp.get(sp);
    return (
      <div
        key={sp}
        className={`niv-cell ${isCurrent ? 'current' : ''} ${isFuture ? 'future' : ''} ${!isRevealed && !isCurrent ? 'unrevealed' : ''}`}
        style={{ background: bg }}
        title={`SP ${sp + 1} (${String(Math.floor(sp / 2)).padStart(2, '0')}:${sp % 2 === 0 ? '00' : '30'}) · NIV ${v >= 0 ? '+' : ''}${v.toFixed(0)} MW${trade ? ` · ${trade.direction} ${trade.isHit ? 'hit' : 'miss'}` : ''}`}
      >
        {trade && (
          <span className={`niv-cell-mark ${trade.isHit ? 'hit' : 'miss'}`}>
            {trade.isHit ? '✓' : '✗'}
          </span>
        )}
      </div>
    );
  };
  return (
    <div className="niv-heatmap-wrap">
      <div className="niv-heatmap">
        {Array.from({ length: 48 }, (_, sp) => cell(sp))}
      </div>
      <div className="niv-heatmap-axis">
        {[0, 4, 8, 12, 16, 20, 24].map((h) => (
          <span key={h} className="niv-axis-tick" style={{ left: `${(h / 24) * 100}%` }}>{String(h).padStart(2, '0')}</span>
        ))}
      </div>
      <div className="niv-heatmap-legend">
        <span className="niv-legend-swatch short" /> short
        <span className="niv-legend-swatch neutral" /> ≈0
        <span className="niv-legend-swatch long" /> long
        <span className="niv-legend-sep">·</span>
        <span className="niv-legend-mark hit">✓</span> your hit
        <span className="niv-legend-mark miss">✗</span> miss
      </div>
    </div>
  );
}

export default function ImbalanceTrading({ state, onCharge, onDischarge }: Props) {
  const { battery, dayAhead, currentPrice, clock } = state;
  // 0-indexed current SP for array access (getSettlementPeriod returns 1-48).
  const currentSp = getSettlementPeriod(clock.currentTime) - 1;
  const todayDay = getUtcDayStart(clock.currentTime);

  const [showIntro, setShowIntro] = useState(() => {
    try { return localStorage.getItem('bess-niv-intro-dismissed') !== '1'; } catch { return true; }
  });
  const dismissIntro = () => {
    setShowIntro(false);
    try { localStorage.setItem('bess-niv-intro-dismissed', '1'); } catch { /* ignore */ }
  };

  // Blind mode: hide the Expected SIP (the spoon-fed consensus £) so you trade
  // purely off the raw signals (NIV, wind, demand, conviction). Outcome revealed
  // after settlement via the trade table.
  const [hideSip, setHideSip] = useState(() => {
    try { return localStorage.getItem('bess-hide-sip') === '1'; } catch { return false; }
  });
  const toggleHideSip = () => {
    setHideSip((v) => {
      const next = !v;
      try { localStorage.setItem('bess-hide-sip', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };


  const dayIdx = Math.floor(todayDay / 86400000);
  const nivActual = dayAhead.niv[currentSp] ?? 0;
  // Current SP isn't settled yet → player sees a forecast (actual + error).
  const currentSpRevealed = currentSp < dayAhead.revealedPeriods;
  const niv = currentSpRevealed ? nivActual : nivActual + nivForecastError(currentSp, dayIdx);
  const nivBand = currentSpRevealed ? 0 : NIV_FORECAST_BAND;
  const daHere = dayAhead.forecastPrices[currentSp] ?? currentPrice?.price ?? 0;
  const liveSettlePrice = imbalanceSettlementPrice(daHere, niv); // EXPECTED from forecast
  // Independent driver signals (wind surplus → long, demand above forecast → short).
  const windError = (dayAhead.windOutturn[currentSp] ?? 0) - (dayAhead.windForecast[currentSp] ?? 0);
  const demandError = (dayAhead.demandOutturn[currentSp] ?? 0) - (dayAhead.demandForecast[currentSp] ?? 0);

  // Synthetic frequency from NIV: oversupply pushes freq up, undersupply pulls it down.
  const freqDelta = Math.max(-0.4, Math.min(0.4, niv / 1500));
  const frequency = 50 + freqDelta;

  // Signal alignment / conviction: each independent driver votes long or short.
  // Aligned signals = high conviction (size up); conflicting = trade small.
  const windVote = windError > 80 ? 1 : windError < -80 ? -1 : 0;        // +long
  const demandVote = demandError > 150 ? -1 : demandError < -150 ? 1 : 0; // demand up → short
  const longVotes = [windVote, demandVote].filter((v) => v > 0).length;
  const shortVotes = [windVote, demandVote].filter((v) => v < 0).length;
  const conviction: { dir: 'long' | 'short' | 'mixed' | 'flat'; level: 'high' | 'lean' | 'mixed' | 'flat' } =
    longVotes === 2 ? { dir: 'long', level: 'high' }
    : shortVotes === 2 ? { dir: 'short', level: 'high' }
    : longVotes === 1 && shortVotes === 0 ? { dir: 'long', level: 'lean' }
    : shortVotes === 1 && longVotes === 0 ? { dir: 'short', level: 'lean' }
    : longVotes === 1 && shortVotes === 1 ? { dir: 'mixed', level: 'mixed' }
    : { dir: 'flat', level: 'flat' };

  // Once the SP is revealed, show the actual settle (from the actual NIV).
  const currentActualSettle = currentSpRevealed ? imbalanceSettlementPrice(daHere, nivActual) : null;

  const maxCharge = getMaxChargeableMw(battery);
  const maxDischarge = getMaxDischargeableMw(battery);

  // One imbalance trade per SP — check if today's SPOT trades already include this SP
  const alreadyTradedThisSp = state.trades.some((t) => {
    if (t.marketType !== MarketType.SPOT) return false;
    const tDate = new Date(t.timestamp);
    const tSp = tDate.getUTCHours() * 2 + (tDate.getUTCMinutes() >= 30 ? 1 : 0);
    return tSp === currentSp && getUtcDayStart(t.timestamp) === todayDay;
  });

  // Signed slider: negative = charge, positive = discharge
  const [target, setTarget] = useState(0);
  const targetClamped = target >= 0
    ? Math.min(target, maxDischarge)
    : Math.max(target, -maxCharge);

  const apply = () => {
    if (alreadyTradedThisSp) return;
    if (targetClamped > 0.1) onDischarge(targetClamped);
    else if (targetClamped < -0.1) onCharge(-targetClamped);
    setTarget(0);
  };

  // SP time math for the countdown
  const spStartMs = (() => {
    const d = new Date(clock.currentTime);
    const min = d.getUTCMinutes();
    const spMin = min < 30 ? 0 : 30;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), spMin, 0);
  })();
  const spEndMs = spStartMs + 30 * 60 * 1000;
  const minutesLeft = Math.max(0, Math.round((spEndMs - clock.currentTime) / 60000));

  // Recent SIP / DA chart with player actions overlaid
  const startSp = Math.max(0, currentSp - HISTORY_LOOKBACK + 1);
  const endSp = Math.min(48, currentSp + 1);
  const playerActionsBySp: Record<number, { chargeMw: number; dischargeMw: number; avgPrice: number }> = {};
  for (const t of state.trades) {
    const sp = Math.floor(new Date(t.timestamp).getUTCHours() * 2 + (new Date(t.timestamp).getUTCMinutes() >= 30 ? 1 : 0));
    const tDay = getUtcDayStart(t.timestamp);
    if (tDay !== todayDay) continue;
    const slot = playerActionsBySp[sp] ?? { chargeMw: 0, dischargeMw: 0, avgPrice: 0 };
    if (t.side === 'buy') slot.chargeMw += t.volumeMw;
    else slot.dischargeMw += t.volumeMw;
    slot.avgPrice = t.price;
    playerActionsBySp[sp] = slot;
  }

  const chartData = [];
  for (let sp = startSp; sp < endSp; sp++) {
    const isRevealed = sp < dayAhead.revealedPeriods;
    const sip = isRevealed ? dayAhead.sipOutturn[sp] : null;
    const action = playerActionsBySp[sp];
    const markerY = action ? action.avgPrice : sip ?? 0;
    chartData.push({
      sp: `${String(Math.floor(sp / 2)).padStart(2, '0')}:${sp % 2 === 0 ? '00' : '30'}`,
      spIdx: sp,
      sip,
      isCurrent: sp === currentSp,
      isFuture: sp > currentSp,
      chargeMw: action?.chargeMw ?? 0,
      dischargeMw: action?.dischargeMw ?? 0,
      chargeMarker: action && action.chargeMw > 0 ? markerY : null,
      dischargeMarker: action && action.dischargeMw > 0 ? markerY : null,
    });
  }

  // Today's average SIP across revealed periods (for hint reference).
  const revealedSips = dayAhead.sipOutturn.slice(0, dayAhead.revealedPeriods).filter((v) => Number.isFinite(v) && v !== 0);
  const sipAvg = revealedSips.length > 0
    ? revealedSips.reduce((a, b) => a + b, 0) / revealedSips.length
    : daHere;

  // Today's SPOT (imbalance) trades. You acted on a forecast SIP but settled at
  // the actual one — the gap (Δ) is your realised forecast error.
  type ImbRow = {
    timestamp: number;
    sp: number;
    direction: 'charge' | 'discharge';
    mw: number;
    energyMwh: number;
    nivActual: number;     // actual NIV (outcome)
    forecastSip: number;   // what you expected when you traded (forecast-NIV derived)
    settledSip: number;    // what you actually settled at (actual-NIV derived)
    settledPnL: number;    // P&L on the books (from settled price)
    isHit: boolean;        // direction matched the actual system state
  };
  const imbRows: ImbRow[] = [];
  for (const t of state.trades) {
    if (t.marketType !== MarketType.SPOT) continue;
    if (getUtcDayStart(t.timestamp) !== todayDay) continue;
    const tDate = new Date(t.timestamp);
    const tSp = tDate.getUTCHours() * 2 + (tDate.getUTCMinutes() >= 30 ? 1 : 0);
    const nivAct = dayAhead.niv[tSp] ?? 0;
    const daAt = dayAhead.forecastPrices[tSp] ?? t.price;
    const forecastSip = imbalanceSettlementPrice(daAt, nivAct + nivForecastError(tSp, dayIdx));
    const direction: 'charge' | 'discharge' = t.side === OrderSide.BUY ? 'charge' : 'discharge';
    const energyMwh = t.volumeMw * 0.5;
    const settledSip = t.price; // engine settled at the actual NIV
    const settledPnL = direction === 'charge' ? -(settledSip * energyMwh) : (settledSip * energyMwh);
    const isHit = (nivAct > 0 && direction === 'charge') || (nivAct < 0 && direction === 'discharge');
    imbRows.push({
      timestamp: t.timestamp, sp: tSp, direction, mw: t.volumeMw, energyMwh,
      nivActual: nivAct, forecastSip, settledSip, settledPnL, isHit,
    });
  }
  imbRows.sort((a, b) => b.timestamp - a.timestamp);

  const totalTrades = imbRows.length;
  const hitTrades = imbRows.filter((r) => r.isHit).length;
  const dailyPnL = imbRows.reduce((acc, r) => acc + r.settledPnL, 0);
  const hitRatePct = totalTrades > 0 ? (hitTrades / totalTrades) * 100 : null;

  // Avg realised forecast error per MWh (|settled − forecast| settle price).
  const avgSlippage = imbRows.length > 0
    ? imbRows.reduce((s, r) => s + Math.abs(r.settledSip - r.forecastSip), 0) / imbRows.length
    : null;

  // NIV trend: last 12 revealed SPs.
  const nivWindowStart = Math.max(0, currentSp - 11);
  const nivSeries: number[] = [];
  for (let sp = nivWindowStart; sp <= currentSp; sp++) {
    const v = dayAhead.niv[sp];
    if (Number.isFinite(v)) nivSeries.push(v);
  }
  const nivAvgRecent = nivSeries.length > 0
    ? nivSeries.reduce((a, b) => a + b, 0) / nivSeries.length
    : 0;

  type DotProps = { cx?: number; cy?: number; payload?: { chargeMw: number; dischargeMw: number; spIdx: number } };
  const renderChargeDot = (props: DotProps) => {
    const { cx, cy, payload } = props;
    if (!payload || !payload.chargeMw || cx == null || cy == null) {
      return <g key={`c-empty-${payload?.spIdx ?? Math.random()}`} />;
    }
    const r = Math.max(3, Math.min(6, 2 + payload.chargeMw / 12));
    return (
      <g key={`c-${payload.spIdx}`}>
        <circle cx={cx} cy={cy} r={r + 1.5} fill="#007be2" fillOpacity={0.25} />
        <circle cx={cx} cy={cy} r={r} fill="#007be2" />
      </g>
    );
  };
  const renderDischargeDot = (props: DotProps) => {
    const { cx, cy, payload } = props;
    if (!payload || !payload.dischargeMw || cx == null || cy == null) {
      return <g key={`d-empty-${payload?.spIdx ?? Math.random()}`} />;
    }
    const r = Math.max(3, Math.min(6, 2 + payload.dischargeMw / 12));
    return (
      <g key={`d-${payload.spIdx}`}>
        <rect x={cx - r - 1.5} y={cy - r - 1.5} width={(r + 1.5) * 2} height={(r + 1.5) * 2} fill="#ff874b" fillOpacity={0.2} rx={1.5} />
        <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} fill="#ff874b" rx={1} />
      </g>
    );
  };

  const freqColor = Math.abs(freqDelta) < 0.05 ? '#00a15d' : Math.abs(freqDelta) < 0.2 ? '#ff874b' : '#ff5f62';
  const nivSign = niv >= 0 ? 'long' : 'short';
  const nivColor = niv >= 0 ? '#007be2' : '#ff874b';
  // Cyan = signal points long (→ charge), magenta = points short (→ discharge).
  const windErrColor = windError > 80 ? '#007be2' : windError < -80 ? '#ff874b' : '#9ca3af';
  const demandErrColor = demandError > 150 ? '#ff874b' : demandError < -150 ? '#007be2' : '#9ca3af';

  // Risk/reward preview for the slider's current setting.
  const previewDir: 'charge' | 'discharge' = targetClamped < 0 ? 'charge' : 'discharge';
  const previewMwh = Math.abs(targetClamped) * 0.5;
  const previewPnL = previewDir === 'charge'
    ? -(liveSettlePrice * previewMwh)
    : liveSettlePrice * previewMwh;
  const slipPerMwh = avgSlippage ?? 12; // fallback before any settled trades
  const previewBand = slipPerMwh * previewMwh;

  return (
    <div className="panel imbalance-panel" id="imbalance-tab">
      <div className="da-sticky-top">
        <div className="panel-header da-panel-header">
          <h3><Activity size={16} /> Imbalance / Cashout</h3>
          <HelpIcon text="Imbalance trading isn't a market — it's deliberately running long or short of your declared position to capture the cashout price (SIP). You can't actually see the live SIP, only signals that hint at the direction. The SIP shown for the current SP is the settlement truth, revealed ex-post." />
          <span className="da-delivery-badge">
            SP {currentSp + 1} · <strong>{minutesLeft} min</strong> left
          </span>
          <span className="da-delivery-badge">
            Delivery <strong>{formatDeliveryDay(todayDay)}</strong>
          </span>
        </div>

        {showIntro && (
          <div className="im-intro">
            <div className="im-intro-body">
              <strong>NIV chasing:</strong> predict whether the grid will be <span style={{ color: 'var(--accent)' }}>long</span> (oversupplied) or <span style={{ color: 'var(--magenta)' }}>short</span>, then position <em>against</em> it — charge into a long system (cheap, sometimes paid), discharge into a short system (high SIP). Watch the <strong>NIV</strong> card and the pattern heatmap; you settle at the NIV-derived price.
            </div>
            <button className="im-intro-dismiss" onClick={dismissIntro} aria-label="Dismiss">×</button>
          </div>
        )}

        {/* Performance bar — compact retrospective line (review, not decision) */}
        <div className="im-perf-bar">
          <span className="im-perf-item">
            <span className="im-perf-label">Today P&amp;L</span>
            <strong className={dailyPnL >= 0 ? 'positive' : 'negative'}>
              {dailyPnL >= 0 ? '+' : '−'}£{Math.abs(dailyPnL).toFixed(0)}
            </strong>
            <span className="im-perf-sub">{totalTrades} {totalTrades === 1 ? 'trade' : 'trades'}</span>
          </span>
          <span className="im-perf-sep" />
          <span className="im-perf-item">
            <span className="im-perf-label">Hit rate</span>
            <strong className={hitRatePct == null ? 'muted' : hitRatePct >= 60 ? 'positive' : hitRatePct >= 40 ? '' : 'negative'}>
              {hitRatePct == null ? '—' : `${hitRatePct.toFixed(0)}%`}
            </strong>
            <span className="im-perf-sub">{hitTrades}/{totalTrades} vs NIV</span>
          </span>
          <span className="im-perf-sep" />
          <span className="im-perf-item">
            <span className="im-perf-label">Avg slippage</span>
            <strong className={avgSlippage == null ? 'muted' : ''}>{avgSlippage == null ? '—' : `£${avgSlippage.toFixed(1)}`}</strong>
            <span className="im-perf-sub">/MWh</span>
          </span>
          <span className="im-perf-sep" />
          <span className="im-perf-item">
            <span className="im-perf-label">NIV regime</span>
            <strong className={nivAvgRecent >= 0 ? 'positive' : 'negative'}>
              {nivAvgRecent >= 0 ? '+' : ''}{nivAvgRecent.toFixed(0)} MW
            </strong>
            <span className="im-perf-sub">{nivAvgRecent >= 0 ? 'mostly long' : 'mostly short'}</span>
          </span>
        </div>

        <div className="da-sticky-content">
          {/* LEFT — signals + chart */}
          <div className="im-signals-chart">
            <div className="im-signals-row">
              <div className="im-signal-card">
                <div className="im-signal-head">
                  <Gauge size={12} />
                  <span>Frequency</span>
                </div>
                <div className="im-signal-value" style={{ color: freqColor }}>
                  {frequency.toFixed(2)} <span className="im-signal-unit">Hz</span>
                </div>
                <div className="im-signal-hint">
                  {freqDelta > 0.05 ? 'System long → SIP likely down' : freqDelta < -0.05 ? 'System short → SIP likely up' : 'Balanced'}
                </div>
              </div>

              <div className="im-signal-card">
                <div className="im-signal-head">
                  <AlertCircle size={12} />
                  <span>{currentSpRevealed ? 'NIV (actual)' : 'NIV forecast'}</span>
                </div>
                <div className="im-signal-value" style={{ color: nivColor }}>
                  {niv >= 0 ? '+' : ''}{niv.toFixed(0)}
                  {nivBand > 0 && <span className="im-signal-band"> ±{nivBand}</span>}
                  <span className="im-signal-unit"> MW</span>
                </div>
                <div className="im-signal-hint">
                  System {nivSign} → {niv >= 0 ? 'consume to earn' : 'generate to earn'}
                </div>
              </div>

              <div className="im-signal-card">
                <div className="im-signal-head">
                  <Wind size={12} />
                  <span>Wind error</span>
                </div>
                <div className="im-signal-value" style={{ color: windErrColor }}>
                  {windError >= 0 ? '+' : ''}{windError.toFixed(0)} <span className="im-signal-unit">MW</span>
                </div>
                <div className="im-signal-hint">
                  {windError > 80 ? 'Surplus → leans long' : windError < -80 ? 'Deficit → leans short' : 'On forecast'}
                </div>
              </div>

              <div className="im-signal-card">
                <div className="im-signal-head">
                  <Activity size={12} />
                  <span>Demand error</span>
                </div>
                <div className="im-signal-value" style={{ color: demandErrColor }}>
                  {demandError >= 0 ? '+' : ''}{demandError.toFixed(0)} <span className="im-signal-unit">MW</span>
                </div>
                <div className="im-signal-hint">
                  {demandError > 150 ? 'Above forecast → leans short' : demandError < -150 ? 'Below forecast → leans long' : 'On forecast'}
                </div>
              </div>
            </div>

            <div className={`im-conviction ${conviction.dir}`}>
              <span className="im-conviction-label">Signal read</span>
              <span className="im-conviction-value">
                {conviction.level === 'high' && `Favours ${conviction.dir === 'long' ? 'CHARGE' : 'DISCHARGE'} — high conviction, size up`}
                {conviction.level === 'lean' && `Leans ${conviction.dir === 'long' ? 'charge' : 'discharge'} — modest edge`}
                {conviction.level === 'mixed' && 'Signals conflict — low conviction, trade small or sit out'}
                {conviction.level === 'flat' && 'Signals quiet — no clear edge'}
              </span>
            </div>

            <div className="im-chart">
              <div className="da-forecast-head">
                <h4>
                  Recent SIP outturn <span className="im-ex-post-tag">ex-post · settlement truth</span>
                </h4>
                <div className="da-chart-legend inline">
                  <span className="legend-item"><span className="legend-line sip-line" /> SIP</span>
                  <span className="legend-item"><span className="legend-dot charge-dot" /> Charge</span>
                  <span className="legend-item"><span className="legend-dot discharge-dot" /> Discharge</span>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -8 }} barCategoryGap="28%">
                  <CartesianGrid
                    strokeDasharray="5 5"
                    stroke="#8b95a8"
                    strokeOpacity={1}
                    strokeWidth={1.2}
                    verticalCoordinatesGenerator={(props: { offset?: { left?: number; width?: number } }) => {
                      const o = props.offset ?? {};
                      const w = o.width ?? 0;
                      const left = o.left ?? 0;
                      const n = chartData.length;
                      if (n < 2) return [];
                      const stride = 2; // every 1h
                      const out: number[] = [];
                      for (let i = 0; i < n; i += stride) {
                        out.push(left + (i / (n - 1)) * w);
                      }
                      return out;
                    }}
                  />
                  <XAxis dataKey="sp" stroke="#6b7280" fontSize={10} interval={1} tickLine={false} axisLine={false} />
                  <YAxis stroke="#6b7280" fontSize={10} width={36} tickLine={false} axisLine={false} />
                  <Tooltip
                    cursor={{ stroke: '#9272f5', strokeWidth: 1, strokeDasharray: '2 3' }}
                    contentStyle={{ background: '#0f1420', border: '1px solid #1f2535', borderRadius: '6px', color: '#e5e7eb', fontSize: 11, padding: '6px 8px' }}
                    labelStyle={{ color: '#6b7280', fontSize: 10, marginBottom: 2 }}
                    itemStyle={{ color: '#e5e7eb', padding: 0 }}
                    formatter={(value: unknown, name: unknown) => {
                      if (value == null) return ['—', String(name)];
                      const key = String(name);
                      if (key === 'You charged' || key === 'You discharged') {
                        return [`£${Number(value).toFixed(2)}/MWh`, key];
                      }
                      return [`£${Number(value).toFixed(2)}`, key];
                    }}
                  />
                  <ReferenceLine
                    x={chartData.find((d) => d.isCurrent)?.sp}
                    stroke="#6b7280"
                    strokeDasharray="2 4"
                    label={{ value: 'Now', fill: '#9ca3af', fontSize: 10, position: 'top' }}
                  />
                  <Line
                    type="monotone"
                    dataKey="sip"
                    stroke="#ff5f62"
                    strokeWidth={2.5}
                    dot={{ r: 2.5, fill: '#ff5f62', stroke: 'none' }}
                    name="SIP outturn"
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                  <Scatter
                    dataKey="chargeMarker"
                    shape={renderChargeDot}
                    isAnimationActive={false}
                    name="You charged"
                  />
                  <Scatter
                    dataKey="dischargeMarker"
                    shape={renderDischargeDot}
                    isAnimationActive={false}
                    name="You discharged"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* RIGHT — action panel */}
          <div className="da-quick-panel im-action-panel">
            <div className="im-action-head">
              <Clock size={14} />
              <span>Current SP action</span>
              <button
                className={`im-blind-toggle ${hideSip ? 'on' : ''}`}
                onClick={toggleHideSip}
                title={hideSip ? 'Show Expected SIP' : 'Blind mode: hide Expected SIP, trade on signals only'}
              >
                {hideSip ? <EyeOff size={13} /> : <Eye size={13} />} {hideSip ? 'Blind' : 'SIP'}
              </button>
              <span className="im-sp-end">ends in {minutesLeft} min</span>
            </div>

            <div className="im-sp-price-row">
              <span className="im-sp-price-label">
                Expected SIP
                <HelpIcon text="Derived from the NIV FORECAST you see. The system settles at the actual NIV, revealed after the SP — so your realised price will differ by the forecast error (your slippage). Blind mode (eye toggle) hides this so you read the raw signals yourself." />
              </span>
              {hideSip ? (
                <span className="im-sp-price-value im-sip-hidden">hidden</span>
              ) : (
                <span
                  className="im-sp-price-value"
                  style={{ color: liveSettlePrice < 0 ? 'var(--green)' : liveSettlePrice > 120 ? 'var(--red)' : undefined }}
                >
                  £{liveSettlePrice.toFixed(2)}
                </span>
              )}
            </div>
            {!hideSip && (
              <div className="im-sp-price-hint">
                {liveSettlePrice < 0 && '⚡ Forecast negative — likely paid to charge'}
                {liveSettlePrice >= 0 && liveSettlePrice < sipAvg - 15 && `Cheap vs avg £${sipAvg.toFixed(0)} — lean charge`}
                {liveSettlePrice > sipAvg + 15 && `Expensive vs avg £${sipAvg.toFixed(0)} — lean discharge`}
                {liveSettlePrice >= 0 && Math.abs(liveSettlePrice - sipAvg) <= 15 && `Near avg £${sipAvg.toFixed(0)} — small edge`}
              </div>
            )}
            {hideSip && (
              <div className="im-sp-price-hint">
                Blind mode — read NIV, wind, demand & conviction. Outcome shows after the SP settles.
              </div>
            )}

            {currentSpRevealed && currentActualSettle != null && (
              <div className="im-sp-sip-row">
                <span className="im-sp-sip-label">Actual settle (revealed)</span>
                <span className="im-sp-sip-value">£{currentActualSettle.toFixed(2)}</span>
              </div>
            )}

            <div className="im-slider-wrap">
              <div className="im-slider-labels">
                <span className="im-slider-lbl charge">← Charge</span>
                <span className="im-slider-lbl discharge">Discharge →</span>
              </div>
              <input
                type="range"
                className="mw-slider im-slider"
                min={-Math.round(maxCharge)}
                max={Math.round(maxDischarge)}
                step={1}
                value={targetClamped}
                onChange={(e) => setTarget(Number(e.target.value))}
              />
              <div className="im-slider-readout">
                <span
                  style={{
                    color: targetClamped < 0 ? 'var(--accent)' : targetClamped > 0 ? 'var(--magenta)' : 'var(--text-muted)',
                  }}
                >
                  {targetClamped === 0
                    ? '0 MW (idle)'
                    : targetClamped < 0
                      ? `Charge ${(-targetClamped).toFixed(0)} MW`
                      : `Discharge ${targetClamped.toFixed(0)} MW`}
                </span>
                <span className="im-slider-cap muted">
                  cap ±{Math.round(Math.max(maxCharge, maxDischarge))} MW
                </span>
              </div>
            </div>

            {Math.abs(targetClamped) > 0.1 && !hideSip && (
              <div className="im-rr-preview">
                <div className="im-rr-row">
                  <span className="im-rr-label">Est. P&amp;L this SP</span>
                  <span className={`im-rr-pnl ${previewPnL >= 0 ? 'positive' : 'negative'}`}>
                    {previewPnL >= 0 ? '+' : '−'}£{Math.abs(previewPnL).toFixed(0)}
                  </span>
                </div>
                <div className="im-rr-band">
                  likely £{(previewPnL - previewBand).toFixed(0)} … £{(previewPnL + previewBand).toFixed(0)}
                  <span className="im-rr-note">±£{previewBand.toFixed(0)} from typical slippage</span>
                </div>
              </div>
            )}
            {Math.abs(targetClamped) > 0.1 && hideSip && (
              <div className="im-rr-preview im-rr-blind">
                <span className="im-rr-label">Est. P&amp;L</span>
                <span className="muted">hidden — revealed after settlement</span>
              </div>
            )}

            <div className="im-action-buttons">
              <button
                className="btn btn-action im-deliver-btn"
                onClick={apply}
                disabled={Math.abs(targetClamped) < 0.1 || alreadyTradedThisSp}
              >
                {alreadyTradedThisSp
                  ? 'Already traded this SP'
                  : targetClamped < 0
                    ? <><ArrowDown size={14} /> Deliver in current SP</>
                    : targetClamped > 0
                      ? <><ArrowUp size={14} /> Deliver in current SP</>
                      : 'Pick a direction'}
              </button>
              <button
                className="btn btn-secondary im-reset-btn"
                onClick={() => setTarget(0)}
                disabled={alreadyTradedThisSp}
              >
                Reset
              </button>
            </div>

          </div>
        </div>
      </div>

      {/* Today's NIV heatmap with hit/miss markers */}
      <div className="im-pattern">
        <h4>
          Today&apos;s NIV pattern
          <HelpIcon text="One cell per SP. Cyan = system long, magenta = short, intensity ∝ |NIV|. Past SPs show the actual settled NIV; the current SP shows your forecast. Future SPs are blank. ✓ / ✗ where you traded." />
        </h4>
        <NivHeatmap
          niv={dayAhead.niv.map((v, sp) => sp < dayAhead.revealedPeriods ? v : v + nivForecastError(sp, dayIdx))}
          currentSp={currentSp}
          revealedPeriods={dayAhead.revealedPeriods}
          tradeBySp={new Map(imbRows.map((r) => [r.sp, { isHit: r.isHit, direction: r.direction }]))}
        />
      </div>

      {/* Activity log — today's imbalance trades only, with hit/miss + slippage reveal */}
      <div className="im-activity">
        <h4>
          Today&apos;s imbalance trades
          <HelpIcon text="You traded on the FORECAST SIP but settled at the actual one. Δ = Settled − Forecast = your realised forecast error. Hit = your direction matched the actual NIV sign (charge when long, discharge when short)." />
        </h4>
        {imbRows.length === 0 ? (
          <div className="empty-state" style={{ padding: 12 }}>
            No imbalance activity yet. Use the slider above to charge or discharge against the current SP.
          </div>
        ) : (
          <table className="data-table im-trades-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>SP</th>
                <th>Dir</th>
                <th>MW</th>
                <th>NIV actual</th>
                <th>Forecast £</th>
                <th>Settled £</th>
                <th>Δ</th>
                <th>P&amp;L</th>
                <th>Call</th>
              </tr>
            </thead>
            <tbody>
              {imbRows.slice(0, 24).map((r) => {
                const delta = r.settledSip - r.forecastSip;
                return (
                  <tr key={r.timestamp} className={r.isHit ? 'im-row-hit' : 'im-row-miss'}>
                    <td>{new Date(r.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}</td>
                    <td className="muted">{r.sp + 1}</td>
                    <td className={r.direction === 'charge' ? 'buy-text' : 'sell-text'}>
                      {r.direction === 'charge' ? 'CHARGE' : 'DISCHARGE'}
                    </td>
                    <td>{r.mw.toFixed(0)} MW</td>
                    <td className={r.nivActual >= 0 ? 'positive' : 'negative'}>
                      {r.nivActual >= 0 ? '+' : ''}{r.nivActual.toFixed(0)}
                    </td>
                    <td className="muted">£{r.forecastSip.toFixed(2)}</td>
                    <td>£{r.settledSip.toFixed(2)}</td>
                    <td className={Math.abs(delta) < 0.5 ? 'muted' : delta >= 0 ? 'positive' : 'negative'}>
                      {delta >= 0 ? '+' : ''}£{delta.toFixed(2)}
                    </td>
                    <td className={r.settledPnL >= 0 ? 'positive' : 'negative'}>
                      {r.settledPnL >= 0 ? '+' : ''}£{r.settledPnL.toFixed(2)}
                    </td>
                    <td>
                      <span className={`im-call-chip ${r.isHit ? 'hit' : 'miss'}`}>
                        {r.isHit ? '✓' : '✗'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
