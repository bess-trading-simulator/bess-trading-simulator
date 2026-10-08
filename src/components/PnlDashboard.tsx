import type { GameState } from '../engine/types';
import { getUtcDayStart, formatDeliveryDay } from '../engine/clock';
import { dayPnl, spPnl } from '../engine/pnl';
import { EXCHANGE_FEE_PER_MWH } from '../engine/settlement';
import { ComposedChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import HelpIcon from './HelpIcon';

const gbp = (v: number) => `${v >= 0 ? '+' : '−'}£${Math.abs(v).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
const spLabel = (sp: number) => `${String(Math.floor(sp / 2)).padStart(2, '0')}:${sp % 2 === 0 ? '00' : '30'}`;

/** Profit & loss across all markets: today by source and per SP, plus finished days. */
export default function PnlDashboard({ state }: { state: GameState }) {
  const today = getUtcDayStart(state.clock.currentTime);
  const t = dayPnl(state, today);
  const history = (state.pnlHistory ?? []).filter(d => d.day < today).slice().sort((a, b) => b.day - a.day);
  const session = history.reduce((a, d) => a + d.net, 0) + t.net;
  const rows = spPnl(state, today);
  const chartData = rows.map(r => ({ sp: spLabel(r.sp), DA: r.da, ID: r.id, BM: r.bm, Imbalance: r.imbalance, Costs: r.costs }));
  const deg = state.battery.config.degradationCostPerMwh ?? 5;

  const cards: { label: string; value: number; sub: string }[] = [
    { label: 'Day-ahead', value: t.da, sub: 'hourly + 30-min auctions, blocks' },
    { label: 'Intraday', value: t.id, sub: 'continuous fills' },
    { label: 'BM', value: t.bm, sub: 'NESO acceptances (BOAs)' },
    { label: 'Imbalance', value: t.imbalance, sub: 'deviations + undeliverable, at SIP' },
    { label: 'Fees', value: t.fees, sub: `exchange £${EXCHANGE_FEE_PER_MWH}/MWh DA+ID` },
    { label: 'Degradation', value: t.degradation, sub: `£${deg}/MWh throughput · ${t.throughputMwh.toFixed(0)} MWh` },
  ];

  return (
    <div className="panel day-ahead-full pnl">
      <div className="panel-header da-panel-header">
        <h3>P&amp;L · all markets</h3>
        <HelpIcon text="Profit & loss of the battery by source. Contracts (day-ahead, intraday, BM) count at their own prices when the SP is delivered; imbalance at the SIP once published. Costs: exchange fees on DA/ID volume and a wear cost per MWh of throughput (both illustrative assumptions). Network charges are not modelled." />
        <span className="da-delivery-badge">Today <strong>{formatDeliveryDay(today)}</strong></span>
      </div>

      <div className="pnl-hero">
        <div>
          <span className="isp-label">Net today (delivered so far)</span>
          <strong className={t.net >= 0 ? 'positive' : 'negative'}>{gbp(t.net)}</strong>
        </div>
        <div>
          <span className="isp-label">Session total</span>
          <strong className={session >= 0 ? 'positive' : 'negative'}>{gbp(session)}</strong>
          <span className="muted"> · {history.length + 1} day{history.length ? 's' : ''}</span>
        </div>
      </div>

      <div className="pnl-cards">
        {cards.map(c => (
          <div key={c.label} className="kpi-card">
            <div className="kpi-label">{c.label}</div>
            <div className="kpi-value-row"><span className={`kpi-value ${c.value > 0 ? 'positive' : c.value < 0 ? 'negative' : ''}`}>{gbp(c.value)}</span></div>
            <div className="kpi-sub">{c.sub}</div>
          </div>
        ))}
      </div>

      <div className="da-forecast-chart">
        <div className="da-forecast-head">
          <h4>Today per settlement period <HelpIcon text="Stacked contribution of each source per SP (delivered SPs only). Costs = fees + degradation." /></h4>
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} stackOffset="sign">
            <CartesianGrid strokeDasharray="5 5" stroke="#8b95a8" strokeOpacity={0.5} vertical={false} />
            <XAxis dataKey="sp" stroke="#6b7280" fontSize={9} interval={7} tickLine={false} axisLine={false} />
            <YAxis stroke="#6b7280" fontSize={10} width={52} tickLine={false} axisLine={false} tickFormatter={(v: number) => `£${Math.round(v)}`} />
            <ReferenceLine y={0} stroke="#8b95a8" />
            <Tooltip
              contentStyle={{ background: '#0f1420', border: '1px solid #1f2535', borderRadius: '6px', color: '#e5e7eb', fontSize: 11, padding: '6px 8px' }}
              formatter={(v: unknown, n: unknown) => [gbp(Number(v)), String(n)]}
            />
            <Bar dataKey="DA" stackId="p" fill="#9272f5" />
            <Bar dataKey="ID" stackId="p" fill="#76b8ef" />
            <Bar dataKey="BM" stackId="p" fill="#ff874b" />
            <Bar dataKey="Imbalance" stackId="p" fill="#c7b4f8" />
            <Bar dataKey="Costs" stackId="p" fill="#ff5f62" />
          </ComposedChart>
        </ResponsiveContainer>
        <div className="da-chart-legend inline pnl-legend">
          <span className="legend-item"><span className="legend-bar" style={{ background: '#9272f5' }} /> DA</span>
          <span className="legend-item"><span className="legend-bar" style={{ background: '#76b8ef' }} /> ID</span>
          <span className="legend-item"><span className="legend-bar" style={{ background: '#ff874b' }} /> BM</span>
          <span className="legend-item"><span className="legend-bar" style={{ background: '#c7b4f8' }} /> Imbalance</span>
          <span className="legend-item"><span className="legend-bar" style={{ background: '#ff5f62' }} /> Costs</span>
        </div>
      </div>

      <h4 className="da-section-title">Finished days</h4>
      {history.length === 0 ? <div className="muted da-section-empty">No finished day yet — days are archived at midnight.</div> : (
        <table className="data-table">
          <thead><tr><th>Day</th><th>DA</th><th>ID</th><th>BM</th><th>Imbalance</th><th>Fees</th><th>Degradation</th><th>Net</th><th>Throughput</th></tr></thead>
          <tbody>
            {history.map(d => (
              <tr key={d.day}>
                <td>{formatDeliveryDay(d.day)}</td>
                <td>{gbp(d.da)}</td><td>{gbp(d.id)}</td><td>{gbp(d.bm)}</td><td>{gbp(d.imbalance)}</td>
                <td className="muted">{gbp(d.fees)}</td><td className="muted">{gbp(d.degradation)}</td>
                <td className={d.net >= 0 ? 'positive' : 'negative'}><strong>{gbp(d.net)}</strong></td>
                <td className="muted">{d.throughputMwh.toFixed(0)} MWh</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
