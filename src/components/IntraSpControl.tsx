import { useState } from 'react';
import type { GameState } from '../engine/types';
import { getUtcDayStart, getSettlementPeriod, subStepIndex, SUB_STEPS_PER_SP, SUB_STEP_MS, HALF_HOUR_MS } from '../engine/clock';
import { findEntry, deviationRange } from '../engine/settlement';
import { nivEstimate, imbalanceSettlementPrice } from '../engine/ukMarket';
import HelpIcon from './HelpIcon';
import { ChevronRight } from 'lucide-react';

interface Props {
  state: GameState;
  onSetDeviation: (mw: number) => void;
  onSubStep: () => void;
  hideSip?: boolean;
}

const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

/**
 * Real-time control of a non-BM battery inside the running SP: like an
 * optimiser, you steer the output in 5-minute intervals while live system
 * indicators sharpen. What counts for settlement is the metered energy over the
 * whole half hour vs your contract, at the SIP published after the SP.
 */
export default function IntraSpControl({ state, onSetDeviation, onSubStep, hideSip }: Props) {
  const now = state.clock.currentTime;
  const day = getUtcDayStart(now);
  const sp = getSettlementPeriod(now) - 1;
  const k = subStepIndex(now);
  const spStart = day + sp * HALF_HOUR_MS;
  const entry = findEntry(state.ledger, day, sp);
  const profile = entry?.deviationProfile ?? new Array(SUB_STEPS_PER_SP).fill(entry?.deviationMw ?? 0);
  const contracted = entry?.contractedMw ?? 0;
  const delivered = entry?.deliveredMw ?? 0;
  const range = deviationRange(state, day, sp);
  const past = profile.slice(0, k).reduce((a, v) => a + v, 0);
  const n = SUB_STEPS_PER_SP - k;
  const P = state.battery.config.powerRatingMw;
  // Energy limit on the SP average, and power limit on each 5-minute interval.
  const xMin = Math.ceil(Math.max((range.min * SUB_STEPS_PER_SP - past) / n, -P - delivered));
  const xMax = Math.floor(Math.min((range.max * SUB_STEPS_PER_SP - past) / n, P - delivered));
  const current = profile[k] ?? 0;
  const [target, setTarget] = useState<number | null>(null);
  const value = Math.max(xMin, Math.min(xMax, target ?? current));

  // Live system view for the running SP, sharper with every interval.
  const dayIdx = Math.floor(day / 86_400_000);
  const est = nivEstimate(state.dayAhead.niv[sp] ?? 0, sp, dayIdx, k);
  const short = est.niv > 0;
  const da = state.dayAhead.forecastPrices[sp] ?? 0;
  const expectedSip = imbalanceSettlementPrice(da, est.niv);
  const freq = 50 - Math.max(-0.3, Math.min(0.3, est.niv / 2000));
  const boa = Math.abs(est.niv) < 80
    ? 'NESO taking few actions — system near balance'
    : short ? 'NESO accepting OFFERS (more generation) — system short' : 'NESO accepting BIDS (less generation) — system long';

  // Preview: metered average and imbalance if the set point holds to the end of the SP.
  const newProfile = profile.map((v, i) => (i >= k ? value : v));
  const devAvg = newProfile.reduce((a, v) => a + v, 0) / SUB_STEPS_PER_SP;
  const metered = delivered + devAvg;
  const imbMwh = (metered - contracted) * 0.5;
  const estCash = imbMwh * expectedSip;

  return (
    <div className="isp">
      <div className="isp-indicators">
        <div>
          <span className="isp-label">NIV estimate · live</span>
          <strong style={{ color: short ? 'var(--discharge)' : 'var(--charge)' }}>
            {est.niv > 0 ? '+' : ''}{est.niv} {est.band > 0 && <small>±{est.band}</small>} MWh
          </strong>
          <span className="isp-sub">{short ? 'short' : 'long'} · sharpens every 5 min</span>
        </div>
        <div>
          <span className="isp-label">BOA flow</span>
          <span className="isp-sub isp-boa">{boa}</span>
        </div>
        <div>
          <span className="isp-label">Frequency <HelpIcon text="Illustrative: derived from the live NIV estimate." /></span>
          <strong>{freq.toFixed(2)} Hz</strong>
        </div>
      </div>

      <div className="isp-intervals">
        {profile.map((v, i) => (
          <div key={i} className={`isp-int ${i < k ? 'past' : i === k ? 'now' : 'future'}`} title={i < k ? 'Locked (past)' : i === k ? 'Running now' : 'Upcoming'}>
            <span className="isp-int-time">{hhmm(spStart + i * SUB_STEP_MS)}</span>
            <span className="isp-int-val" style={{ color: (i >= k ? value : v) > 0 ? 'var(--discharge)' : (i >= k ? value : v) < 0 ? 'var(--charge)' : undefined }}>
              {(() => { const x = i >= k ? value : v; return x === 0 ? '0' : `${x > 0 ? '+' : ''}${x.toFixed(0)}`; })()}
            </span>
          </div>
        ))}
      </div>

      <div className="im-slider-labels">
        <span className="im-slider-lbl charge">← Charge more</span>
        <span className="im-slider-lbl discharge">Discharge more →</span>
      </div>
      <input
        type="range"
        className="mw-slider im-slider"
        min={xMin}
        max={xMax}
        step={1}
        value={value}
        onChange={(e) => setTarget(Number(e.target.value))}
        disabled={xMin >= xMax}
      />
      <div className="isp-readout">
        <span>Set point from {hhmm(now)}: <strong>{value > 0 ? '+' : ''}{value} MW</strong></span>
        <span className="muted">range {xMin}…{xMax} MW</span>
      </div>
      <div className="isp-readout muted">
        Contract {contracted === 0 ? 'none' : `${contracted > 0 ? 'sell' : 'buy'} ${Math.abs(contracted).toFixed(0)} MW`}
        {' '}· metered avg {metered > 0 ? '+' : ''}{metered.toFixed(1)} MW · imbalance {imbMwh > 0 ? 'long' : imbMwh < 0 ? 'short' : '0'} {Math.abs(imbMwh).toFixed(1)} MWh
        {!hideSip && Math.abs(imbMwh) > 0.05 && <> · est. {estCash >= 0 ? '+' : '−'}£{Math.abs(estCash).toFixed(0)}</>}
      </div>

      <div className="im-action-buttons">
        <button className="btn btn-action im-deliver-btn" disabled={value === current} onClick={() => { onSetDeviation(value); setTarget(null); }}>
          Apply from {hhmm(now)}
        </button>
        <button className="btn btn-secondary" onClick={() => { onSubStep(); setTarget(null); }} title="Advance 5 minutes within this SP">
          Next 5 min <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
