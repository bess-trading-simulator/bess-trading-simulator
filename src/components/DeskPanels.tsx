import { useState } from 'react';
import type { GameState } from '../engine/types';
import { forwardBook, benchmarks, mistakePatterns } from '../engine/desk';
import { getUtcDayStart } from '../engine/clock';
import HelpIcon from './HelpIcon';

const spLabel = (sp: number) => `${String(Math.floor(sp / 2)).padStart(2, '0')}:${sp % 2 === 0 ? '00' : '30'}`;
const gbp = (v: number) => `${v >= 0 ? '+' : '−'}£${Math.abs(v).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;

/** Trading desk strip under the market views: forward risk book and a review. */
export default function DeskPanels({ state }: { state: GameState }) {
  const [tab, setTab] = useState<'risk' | 'review'>('risk');
  return (
    <div className="panel desk">
      <div className="desk-tabs">
        <span className="isp-label">Desk</span>
        <button className={`hdr-tab ${tab === 'risk' ? 'active' : ''}`} onClick={() => setTab('risk')}>Risk</button>
        <button className={`hdr-tab ${tab === 'review' ? 'active' : ''}`} onClick={() => setTab('review')}>Review</button>
      </div>
      {tab === 'risk' ? <RiskView state={state} /> : <ReviewView state={state} />}
    </div>
  );
}

function RiskView({ state }: { state: GameState }) {
  const { rows, warnings } = forwardBook(state, 8);
  const today = getUtcDayStart(state.clock.currentTime);
  return (
    <div className="desk-body">
      <div className="desk-col">
        <h4 className="da-section-title">
          Forward book · next 4 hours
          <HelpIcon text="Your net contracted position per SP (day-ahead + intraday + BM), orders still pending (working intraday orders, open 30-min auction), the projected SoC if everything is delivered, and energy the battery can't deliver (settles as imbalance at SIP). Gate = intraday/BM gate closure (T-60)." />
        </h4>
        <table className="data-table desk-table">
          <thead><tr><th>SP</th><th>Net MW</th><th>Pending</th><th>SoC after</th><th>Imbalance risk</th><th>Gate</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.day}-${r.sp}`} className={i === 0 ? 'row-hovered' : ''}>
                <td>{r.day !== today ? 'D+1 ' : ''}{spLabel(r.sp)}{i === 0 ? ' · now' : ''}</td>
                <td style={{ color: r.netMw > 0 ? 'var(--discharge)' : r.netMw < 0 ? 'var(--charge)' : undefined }}>
                  {r.netMw === 0 ? '·' : `${r.netMw > 0 ? 'sell ' : 'buy '}${Math.abs(r.netMw).toFixed(0)}`}
                </td>
                <td className="muted">
                  {r.pendingBuyMw > 0 && `buy ${r.pendingBuyMw.toFixed(0)} `}
                  {r.pendingSellMw > 0 && `sell ${r.pendingSellMw.toFixed(0)}`}
                  {r.pendingBuyMw === 0 && r.pendingSellMw === 0 && '·'}
                </td>
                <td>{r.socPct.toFixed(0)}%</td>
                <td className={r.imbalanceRiskMwh !== 0 ? 'negative' : 'muted'}>
                  {r.imbalanceRiskMwh === 0 ? '·' : `${r.imbalanceRiskMwh < 0 ? 'short' : 'long'} ${Math.abs(r.imbalanceRiskMwh).toFixed(1)} MWh`}
                </td>
                <td className="muted">{r.gateMin > 0 ? `${r.gateMin} min` : 'closed'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="desk-col">
        <h4 className="da-section-title">Alerts</h4>
        {warnings.length === 0
          ? <div className="muted da-section-empty">No open risks in the next 4 hours.</div>
          : <ul className="desk-alerts">{warnings.map((w, i) => <li key={i} className={`desk-alert ${w.level}`}>{w.text}</li>)}</ul>}
      </div>
    </div>
  );
}

function ReviewView({ state }: { state: GameState }) {
  const b = benchmarks(state);
  const findings = mistakePatterns(state);
  const bars = [
    { label: 'You', value: b.you, cls: 'you' },
    ...(b.naive !== null ? [{ label: 'Naive schedule', value: b.naive, cls: '' }] : []),
    { label: 'Idle', value: b.idle, cls: '' },
    { label: 'Hindsight optimum (DA)', value: b.optimum, cls: 'opt' },
  ];
  const max = Math.max(1, ...bars.map(x => Math.abs(x.value)));
  return (
    <div className="desk-body">
      <div className="desk-col">
        <h4 className="da-section-title">
          Benchmark · today {b.window}
          <HelpIcon text="Your net P&L for today's delivered SPs (all markets, after fees and wear) vs: doing nothing; a naive fixed schedule (charge 00:00–02:00, discharge 17:00–19:00 at DA prices); and the best possible DA arbitrage with perfect hindsight on today's DA prices — respecting power, capacity, efficiency, SoC order and wear. Same time window for all." />
        </h4>
        <div className="desk-bench">
          {bars.map(x => (
            <div key={x.label} className="desk-bench-row">
              <span className="desk-bench-label">{x.label}</span>
              <span className="desk-bench-track"><span className={`desk-bench-bar ${x.cls} ${x.value < 0 ? 'neg' : ''}`} style={{ width: `${(Math.abs(x.value) / max) * 100}%` }} /></span>
              <strong className={x.value >= 0 ? 'positive' : 'negative'}>{gbp(x.value)}</strong>
            </div>
          ))}
        </div>
        {b.naive === null && <div className="muted desk-capture">Naive schedule (charge 00–02, discharge 17–19) is shown once the day has reached 19:00.</div>}
        {b.capturePct !== null && (
          <div className="muted desk-capture">
            You captured <strong>{b.capturePct}%</strong> of the hindsight optimum. The optimum is DA-only; imbalance and intraday can take you above it.
          </div>
        )}
      </div>
      <div className="desk-col">
        <h4 className="da-section-title">Patterns · today and yesterday</h4>
        <ul className="desk-alerts">
          {findings.map((f, i) => (
            <li key={i} className={`desk-finding ${f.level}`}><strong>{f.title}</strong><span>{f.detail}</span></li>
          ))}
        </ul>
      </div>
    </div>
  );
}
