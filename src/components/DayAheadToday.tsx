import type { DayAheadState, SettlementEntry } from '../engine/types';
import { OrderSide } from '../engine/types';
import { hourlyPrices, bidFills } from '../engine/dayAheadAuction';
import { nivForecastError, NIV_FORECAST_BAND } from '../engine/ukMarket';
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

  // Projected SoC from now through the remaining net contracts, and the
  // energy that can't be delivered (→ imbalance at SIP): short = sold energy
  // you won't have, long = bought energy you can't store.
  const soc: (number | null)[] = new Array(48).fill(null);
  const projected: (number | null)[] = new Array(48).fill(null); // MWh, − = short, + = long
  let s = battery.currentSocMwh;
  for (let sp = currentSp + 1; sp < 48; sp++) {
    const n = rows[sp].net;
    if (n > 0) {
      const need = Math.min(n, P) * 0.5;
      if (need > s + 0.01) projected[sp] = -(need - s);
      s = Math.max(0, s - need);
    } else if (n < 0) {
      const store = Math.min(-n, P) * 0.5 * eff;
      if (store > cap - s + 0.01) projected[sp] = (store - (cap - s)) / eff;
      s = Math.min(cap, s + store);
    }
    soc[sp] = (s / cap) * 100;
  }
  const projectedShort = projected.reduce<number>((a, v) => a + (v && v < 0 ? -v : 0), 0);
  const projectedLong = projected.reduce<number>((a, v) => a + (v && v > 0 ? v : 0), 0);

  // System state per SP: actual NIV/SIP once published; forecast ± band for the running SP.
  const dayIdx = Math.floor(today / 86_400_000);
  const systemFor = (sp: number) => {
    if (sp < dayAhead.revealedPeriods) {
      return { niv: dayAhead.niv[sp] ?? 0, sip: dayAhead.sipOutturn[sp] ?? null, band: 0 };
    }
    if (sp === currentSp) {
      return { niv: (dayAhead.niv[sp] ?? 0) + nivForecastError(sp, dayIdx), sip: null, band: NIV_FORECAST_BAND };
    }
    return null;
  };

  const daCash = rows.reduce((a, r) => a + r.daCash, 0);
  const daChargeMwh = rows.reduce((a, r) => a + (r.daMw < 0 ? -r.daMw * 0.5 : 0), 0);
  const daDischargeMwh = rows.reduce((a, r) => a + (r.daMw > 0 ? r.daMw * 0.5 : 0), 0);
  const imbCash = rows.reduce((a, r) => a + (r.imbCash ?? 0), 0);
  const imbMwh = rows.reduce((a, r) => a + Math.abs(r.imbMwh ?? 0), 0);
  const delivered = rows.filter(r => r.status === 'settled' || r.status === 'delivered').length;

  // Yesterday's auction orders for today, with their outcome at the clearing price.
  const clearingH = hourlyPrices(dayAhead.forecastPrices);
  const forecastH = dayAhead.todayForecast ? hourlyPrices(dayAhead.todayForecast) : null;
  type OrderRow = {
    key: string; when: string; label: string; side: OrderSide; volumeMw: number;
    limit: string; forecast: number | null; clearing: number; filled: boolean; reason: string; sortKey: number;
  };
  const spT = (sp: number) => `${String(Math.floor(sp / 2)).padStart(2, '0')}:${sp % 2 === 0 ? '00' : '30'}`;
  const verdict = (buy: boolean, clearing: number, limit: number, filled: boolean, what = 'Clearing') => filled
    ? `${what} £${clearing.toFixed(2)} ${buy ? '≤ your max' : '≥ your min'} £${limit.toFixed(2)} → filled`
    : `${what} £${clearing.toFixed(2)} ${buy ? 'above your max' : 'below your min'} £${limit.toFixed(2)} → not filled`;
  const orders: OrderRow[] = [
    // Hourly auction (09:20)
    ...(dayAhead.todayBids ?? []).map((b, i) => {
      const clearing = clearingH[b.hour];
      const filled = bidFills(b, clearing);
      return {
        key: `h${i}`, when: `${String(b.hour).padStart(2, '0')}–${String((b.hour + 1) % 24).padStart(2, '0')}`, label: 'Hourly',
        side: b.side, volumeMw: b.volumeMw, limit: `${b.side === OrderSide.BUY ? 'max' : 'min'} £${b.price.toFixed(2)}`,
        forecast: forecastH?.[b.hour] ?? null, clearing, filled, reason: verdict(b.side === OrderSide.BUY, clearing, b.price, filled), sortKey: b.hour * 2,
      };
    }),
    // 30-min auction (15:30)
    ...(dayAhead.todayHhResults ? (dayAhead.todayHhBids ?? []) : []).map((b, i) => {
      const clearing = dayAhead.forecastPrices[b.sp] ?? 0;
      const filled = bidFills(b, clearing);
      return {
        key: `q${i}`, when: spT(b.sp), label: '30-min',
        side: b.side, volumeMw: b.volumeMw, limit: `${b.side === OrderSide.BUY ? 'max' : 'min'} £${b.price.toFixed(2)}`,
        forecast: dayAhead.todayHhResults?.find(r => r.sp === b.sp)?.forecastPrice ?? null, clearing, filled,
        reason: verdict(b.side === OrderSide.BUY, clearing, b.price, filled), sortKey: b.sp,
      };
    }),
    // Blocks (both auctions)
    ...(dayAhead.todayBlocks ?? []).map(b => {
      const r = dayAhead.todayBlockResults?.find(x => x.id === b.id);
      return {
        key: b.id, when: `${spT(b.startSp)}–${spT(b.endSp + 1)}`,
        label: `${b.auction === 'hourly' ? 'Hourly' : '30-min'} block ${b.id}${b.parentId ? ` ↳ ${b.parentId}` : ''}`,
        side: b.side, volumeMw: b.volumeMw, limit: `${b.side === OrderSide.BUY ? 'max' : 'min'} avg £${b.price.toFixed(2)}`,
        forecast: null, clearing: r?.avgClearing ?? 0, filled: Boolean(r?.accepted), reason: r?.reason ?? 'no result', sortKey: b.startSp,
      };
    }),
  ].sort((a, b) => a.sortKey - b.sortKey);

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
            <div className="kpi-label">Imbalance</div>
            <div className="kpi-value-row">
              <span className={`kpi-value ${imbCash >= 0 ? 'positive' : 'negative'}`}>{imbCash >= 0 ? '+' : '−'}£{Math.abs(imbCash).toFixed(0)}</span>
            </div>
            <div className="kpi-sub">
              {imbMwh.toFixed(1)} MWh so far at SIP
              {(projectedShort > 0.05 || projectedLong > 0.05) && (
                <span className="negative">
                  {' '}· ⚠ projected {projectedShort > 0.05 ? `short ${projectedShort.toFixed(0)} MWh` : ''}
                  {projectedShort > 0.05 && projectedLong > 0.05 ? ', ' : ''}
                  {projectedLong > 0.05 ? `long ${projectedLong.toFixed(0)} MWh` : ''}
                </span>
              )}
            </div>
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
          Yesterday's auctions · your orders for today
          <HelpIcon text="Every order you submitted in yesterday's auction for today. Buy (charge) fills if the clearing price is at or below your max; sell (discharge) fills if it is at or above your min. Filled orders settle at the CLEARING price, not your limit." />
        </h4>
        {orders.length === 0 ? (
          <div className="muted da-section-empty">
            {dayAhead.todayBids ? 'You placed no orders in yesterday\'s auction.' : 'No auction history for today (session started today).'}
          </div>
        ) : (
          <table className="data-table bid-table da-orders-table">
            <thead>
              <tr><th>Time</th><th>Auction</th><th>Order</th><th>Your limit</th><th>Forecast</th><th>Clearing</th><th>Result</th></tr>
            </thead>
            <tbody>
              {orders.map(o => (
                <tr key={o.key} className={o.filled ? '' : 'muted'}>
                  <td>{o.when}</td>
                  <td className="muted">{o.label}</td>
                  <td style={{ color: o.side === OrderSide.BUY ? 'var(--charge)' : 'var(--discharge)' }}>
                    {o.side === OrderSide.BUY ? 'Buy · charge' : 'Sell · discharge'} {o.volumeMw} MW
                  </td>
                  <td>{o.limit}</td>
                  <td className="muted">{o.forecast == null ? '—' : `£${o.forecast.toFixed(2)}`}</td>
                  <td>£{o.clearing.toFixed(2)}</td>
                  <td className={o.filled ? 'positive' : 'negative'} title={o.reason} style={{ cursor: 'help' }}>
                    {o.filled ? '✓ filled' : '✗ not filled'}
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
                <th title="System length: NIV (+ = short, − = long) and the SIP once published; for the running SP a NIV forecast ± band">System</th>
                <th title="(metered − contracted) × 0.5 h, settled at SIP. Short = you delivered less than you sold (you buy the gap at SIP); long = you delivered more / took less than you bought (you sell the gap at SIP).">Your imbalance</th>
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
                  <td className="muted">
                    {(() => {
                      const sys = systemFor(r.sp);
                      if (!sys) return '—';
                      const short = sys.niv > 0;
                      return (
                        <span>
                          <span style={{ color: short ? 'var(--discharge)' : 'var(--charge)' }}>{short ? 'short' : 'long'}</span>
                          {' '}{sys.niv > 0 ? '+' : '−'}{Math.abs(sys.niv).toFixed(0)}{sys.band ? ` ±${sys.band}` : ''} MWh
                          {sys.sip != null && <> · SIP £{sys.sip.toFixed(2)}</>}
                          {sys.band > 0 && <small> (forecast)</small>}
                        </span>
                      );
                    })()}
                  </td>
                  <td className={r.imbCash == null ? (projected[r.sp] || (r.status === 'delivering' && r.metered != null && Math.abs(r.metered - r.net) >= 0.05) ? 'negative' : 'muted') : r.imbCash >= 0 ? 'positive' : 'negative'}>
                    {r.imbMwh != null && Math.abs(r.imbMwh) >= 0.005 ? (() => {
                      const youShort = r.imbMwh < 0;
                      const sysShort = (dayAhead.niv[r.sp] ?? 0) > 0;
                      const withSystem = youShort !== sysShort; // you were long while system short (or vice versa) → you helped
                      return (
                        <span title={withSystem
                          ? 'Your imbalance went against the system imbalance — it helped balance the grid, usually at a favourable SIP.'
                          : 'Your imbalance went the same way as the system — it made the imbalance worse, usually at an unfavourable SIP.'}>
                          {youShort ? 'short' : 'long'} {Math.abs(r.imbMwh).toFixed(1)} MWh · {r.imbCash! >= 0 ? '+' : '−'}£{Math.abs(r.imbCash!).toFixed(0)}
                          <small> · {withSystem ? 'helped system' : 'same as system'}</small>
                        </span>
                      );
                    })()
                      : r.imbMwh != null ? '·'
                        : r.status === 'delivering' && r.metered != null && Math.abs(r.metered - r.net) >= 0.05
                          ? `${r.metered < r.net ? 'short' : 'long'} ${Math.abs((r.metered - r.net) * 0.5).toFixed(1)} MWh · awaiting SIP`
                          : projected[r.sp] ? `⚠ projected ${projected[r.sp]! < 0 ? 'short' : 'long'} ${Math.abs(projected[r.sp]!).toFixed(1)} MWh`
                            : '—'}
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
