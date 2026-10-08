import type { DayAheadState, SettlementEntry } from '../engine/types';
import { OrderSide } from '../engine/types';
import { hourlyPrices, bidFills } from '../engine/dayAheadAuction';
import type { BatteryState } from '../engine/battery';
import { getUtcDayStart, getSettlementPeriod, formatDeliveryDay } from '../engine/clock';
import { findEntry, signedMw } from '../engine/settlement';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import HelpIcon from './HelpIcon';

interface Props {
  dayAhead: DayAheadState;
  ledger: SettlementEntry[];
  battery: BatteryState;
  currentTime: number;
}

const spLabel = (sp: number) => `${String(Math.floor(sp / 2)).padStart(2, '0')}:${sp % 2 === 0 ? '00' : '30'}`;
const signed = (v: number, d = 0) => (Math.abs(v) < 0.005 ? '·' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`);

/**
 * TODAY's delivery of the day-ahead schedule won in yesterday's auction:
 * prices, your DA + intraday contracts per SP, physical delivery and imbalance.
 */
export default function DayAheadToday({ dayAhead, ledger, battery, currentTime }: Props) {
  const today = getUtcDayStart(currentTime);
  const currentSp = getSettlementPeriod(currentTime) - 1;
  const P = battery.config.powerRatingMw;
  const cap = battery.config.capacityMwh;
  const eff = battery.config.efficiencyPct / 100;

  const rows = Array.from({ length: 48 }, (_, sp) => {
    const pos = dayAhead.playerSchedule.filter(p => p.deliveryDay === today && p.period === sp);
    const daMw = pos.filter(p => p.market === 'da').reduce((a, p) => a + signedMw(p), 0);
    const idMw = pos.filter(p => p.market !== 'da').reduce((a, p) => a + signedMw(p), 0);
    const daCash = pos.filter(p => p.market === 'da').reduce((a, p) => a + signedMw(p) * 0.5 * p.price, 0);
    const e = findEntry(ledger, today, sp);
    const status = e?.settled ? 'settled' : sp === currentSp ? 'delivering' : sp < currentSp ? 'delivered' : 'upcoming';
    return {
      sp,
      price: dayAhead.forecastPrices[sp] ?? 0,
      forecast: dayAhead.todayForecast?.[sp],
      daMw, idMw, net: daMw + idMw, daCash,
      metered: e && sp <= currentSp ? e.meteredMw : null,
      imbMwh: e?.settled ? e.imbalanceMwh : null,
      imbCash: e?.settled ? e.imbalanceCash : null,
      status,
    };
  });

  // Projected SoC from now through the remaining net contracts.
  const soc: (number | null)[] = new Array(48).fill(null);
  let s = battery.currentSocMwh;
  for (let sp = currentSp + 1; sp < 48; sp++) {
    const n = rows[sp].net;
    s = n > 0 ? s - Math.min(n, P) * 0.5 : s + Math.min(-n, P) * 0.5 * eff;
    s = Math.max(0, Math.min(cap, s));
    soc[sp] = (s / cap) * 100;
  }

  const daCash = rows.reduce((a, r) => a + r.daCash, 0);
  const daChargeMwh = rows.reduce((a, r) => a + (r.daMw < 0 ? -r.daMw * 0.5 : 0), 0);
  const daDischargeMwh = rows.reduce((a, r) => a + (r.daMw > 0 ? r.daMw * 0.5 : 0), 0);
  const imbCash = rows.reduce((a, r) => a + (r.imbCash ?? 0), 0);
  const imbMwh = rows.reduce((a, r) => a + Math.abs(r.imbMwh ?? 0), 0);
  const delivered = rows.filter(r => r.status === 'settled' || r.status === 'delivered').length;

  // Yesterday's auction orders for today, with their outcome at the clearing price.
  const clearingH = hourlyPrices(dayAhead.forecastPrices);
  const forecastH = dayAhead.todayForecast ? hourlyPrices(dayAhead.todayForecast) : null;
  const orders = (dayAhead.todayBids ?? [])
    .map(b => {
      const clearing = clearingH[b.hour];
      const filled = bidFills(b, clearing);
      const buy = b.side === OrderSide.BUY;
      const reason = filled
        ? `Clearing £${clearing.toFixed(2)} ${buy ? '≤ your max' : '≥ your min'} £${b.price.toFixed(2)} → filled at £${clearing.toFixed(2)}`
        : `Clearing £${clearing.toFixed(2)} ${buy ? 'above your max' : 'below your min'} £${b.price.toFixed(2)} → not filled`;
      return { ...b, clearing, forecast: forecastH?.[b.hour] ?? null, filled, reason };
    })
    .sort((a, b) => a.hour - b.hour || a.side.localeCompare(b.side));
  const hourLabel = (h: number) => `${String(h).padStart(2, '0')}–${String((h + 1) % 24).padStart(2, '0')}`;

  const chartData = rows.map(r => ({
    sp: spLabel(r.sp), price: r.price, forecast: r.forecast ?? null, net: r.net, soc: soc[r.sp],
  }));

  return (
    <div className="panel day-ahead-full">
      <div className="da-sticky-top">
        <div className="panel-header da-panel-header">
          <h3>Today's delivery · day-ahead schedule</h3>
          <HelpIcon text="The schedule you won in YESTERDAY's auction is delivered today, half-hour by half-hour. DA contracts settle at their clearing price; intraday trades adjust the net position; the battery dispatches the NET contract at the start of each SP. Anything it can't deliver (SoC/power) — or deliberately deviates — settles as imbalance at the SIP after the SP." />
          <span className="da-delivery-badge">
            Delivery <strong>{formatDeliveryDay(today)}</strong> · {dayAhead.todaySource === 'real' ? 'Real data' : 'Simulated'}
          </span>
        </div>

        <div className="kpi-strip">
          <div className="kpi-card">
            <div className="kpi-label">DA cash (locked)</div>
            <div className="kpi-value-row">
              <span className={`kpi-value ${daCash >= 0 ? 'positive' : 'negative'}`}>{daCash >= 0 ? '+' : '−'}£{Math.abs(daCash).toFixed(0)}</span>
            </div>
            <div className="kpi-sub">at yesterday's clearing prices</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">DA schedule</div>
            <div className="kpi-value-row">
              <span className="kpi-value" style={{ fontSize: 16 }}>
                <span style={{ color: 'var(--charge)' }}>{daChargeMwh.toFixed(0)}</span>
                <span className="kpi-unit"> / </span>
                <span style={{ color: 'var(--discharge)' }}>{daDischargeMwh.toFixed(0)}</span>
                <span className="kpi-unit"> MWh</span>
              </span>
            </div>
            <div className="kpi-sub">charge / discharge · {orders.filter(o => o.filled).length}/{orders.length} auction orders filled</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Delivered</div>
            <div className="kpi-value-row"><span className="kpi-value">{delivered}<span className="kpi-unit"> / 48 SPs</span></span></div>
            <div className="kpi-sub">running: {spLabel(currentSp)}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Imbalance so far</div>
            <div className="kpi-value-row">
              <span className={`kpi-value ${imbCash >= 0 ? 'positive' : 'negative'}`}>{imbCash >= 0 ? '+' : '−'}£{Math.abs(imbCash).toFixed(0)}</span>
            </div>
            <div className="kpi-sub">{imbMwh.toFixed(1)} MWh off contract, at SIP</div>
          </div>
        </div>

        <div className="da-forecast-chart">
          <div className="da-forecast-head">
            <h4>
              Today's DA prices · your net contract · SoC
              <HelpIcon text="Bars = today's DA price per half-hour (blue = you're contracted to charge, orange = to discharge, grey = no contract). Dashed = the desk forecast you bid on yesterday. Lavender = projected SoC from now." />
            </h4>
          </div>
          <ResponsiveContainer width="100%" height={190}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -8 }} barCategoryGap="25%">
              <CartesianGrid strokeDasharray="5 5" stroke="#8b95a8" strokeOpacity={0.5} vertical={false} />
              <XAxis dataKey="sp" stroke="#6b7280" fontSize={9} interval={7} tickLine={false} axisLine={false} />
              <YAxis yAxisId="p" stroke="#6b7280" fontSize={10} width={40} tickLine={false} axisLine={false} />
              <YAxis yAxisId="soc" orientation="right" stroke="#c7b4f8" fontSize={10} width={32} domain={[0, 100]} ticks={[0, 50, 100]} tickFormatter={(v: number) => `${v}%`} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{ background: '#0f1420', border: '1px solid #1f2535', borderRadius: '6px', color: '#e5e7eb', fontSize: 11, padding: '6px 8px' }}
                formatter={(v: unknown, n: unknown) => (v == null ? ['—', String(n)] : String(n) === 'SoC' ? [`${Number(v).toFixed(0)}%`, 'SoC'] : [`£${Number(v).toFixed(2)}`, String(n)])}
              />
              <Bar yAxisId="p" dataKey="price" name="DA price" radius={[2, 2, 0, 0]}>
                {chartData.map((c, i) => (
                  <Cell key={i} fill={c.net < 0 ? '#007be2' : c.net > 0 ? '#ff874b' : '#9ca3af'} fillOpacity={i < currentSp ? 0.3 : c.net !== 0 ? 0.85 : 0.45} />
                ))}
              </Bar>
              <Line yAxisId="p" dataKey="forecast" name="Your forecast" stroke="#8b95a8" strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              <Line yAxisId="soc" dataKey="soc" name="SoC" type="stepAfter" stroke="#c7b4f8" strokeWidth={2} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="da-bid-section">
        <h4 className="da-section-title">
          Yesterday's auction · your orders for today
          <HelpIcon text="Every order you submitted in yesterday's auction for today. Buy (charge) fills if the clearing price is at or below your max; sell (discharge) fills if it is at or above your min. Filled orders settle at the CLEARING price, not your limit." />
        </h4>
        {orders.length === 0 ? (
          <div className="muted da-section-empty">
            {dayAhead.todayBids ? 'You placed no orders in yesterday\'s auction.' : 'No auction history for today (session started today).'}
          </div>
        ) : (
          <table className="data-table bid-table da-orders-table">
            <thead>
              <tr><th>Hour</th><th>Order</th><th>Your limit</th><th>Forecast</th><th>Clearing</th><th>Result</th></tr>
            </thead>
            <tbody>
              {orders.map((o, i) => (
                <tr key={i} className={o.filled ? '' : 'muted'}>
                  <td>{hourLabel(o.hour)}</td>
                  <td style={{ color: o.side === OrderSide.BUY ? 'var(--charge)' : 'var(--discharge)' }}>
                    {o.side === OrderSide.BUY ? 'Buy · charge' : 'Sell · discharge'} {o.volumeMw} MW
                  </td>
                  <td>{o.side === OrderSide.BUY ? 'max' : 'min'} £{o.price.toFixed(2)}</td>
                  <td className="muted">{o.forecast == null ? '—' : `£${o.forecast.toFixed(2)}`}</td>
                  <td>£{o.clearing.toFixed(2)}</td>
                  <td className={o.filled ? 'positive' : 'negative'} title={o.reason} style={{ cursor: 'help' }}>
                    {o.filled ? '✓ filled' : '✗ not filled'}
                    <small className="muted"> · {o.filled
                      ? `${o.side === OrderSide.BUY ? 'paid' : 'received'} £${o.clearing.toFixed(2)}`
                      : `£${Math.abs(o.clearing - o.price).toFixed(2)} ${o.side === OrderSide.BUY ? 'above max' : 'below min'}`}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h4 className="da-section-title">Delivery per settlement period</h4>
        <div className="da-bid-scroll">
          <table className="data-table bid-table">
            <thead>
              <tr>
                <th>SP</th>
                <th>DA £</th>
                <th title="The desk forecast you bid on yesterday">Forecast £</th>
                <th>DA MW</th>
                <th title="Intraday (and BM) trades for this SP">ID MW</th>
                <th>Net contract</th>
                <th title="Actually delivered (metered), + = discharge">Metered MW</th>
                <th title="(metered − contracted) × 0.5 h, settled at SIP">Imbalance</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.sp} className={`${r.sp === currentSp ? 'row-hovered' : ''} ${r.sp < currentSp ? 'muted' : ''}`}>
                  <td>{spLabel(r.sp)}</td>
                  <td>£{r.price.toFixed(2)}</td>
                  <td className="muted">{r.forecast == null ? '—' : `£${r.forecast.toFixed(2)}`}</td>
                  <td style={{ color: r.daMw < 0 ? 'var(--charge)' : r.daMw > 0 ? 'var(--discharge)' : undefined }}>{signed(r.daMw)}</td>
                  <td style={{ color: r.idMw < 0 ? 'var(--charge)' : r.idMw > 0 ? 'var(--discharge)' : undefined }}>{signed(r.idMw)}</td>
                  <td>{signed(r.net)}</td>
                  <td>{r.metered == null ? '—' : signed(r.metered)}</td>
                  <td className={r.imbCash == null ? 'muted' : r.imbCash >= 0 ? 'positive' : 'negative'}>
                    {r.imbMwh == null ? '—' : Math.abs(r.imbMwh) < 0.005 ? '·' : `${signed(r.imbMwh, 1)} MWh · ${r.imbCash! >= 0 ? '+' : '−'}£${Math.abs(r.imbCash!).toFixed(0)}`}
                  </td>
                  <td className="muted">{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
