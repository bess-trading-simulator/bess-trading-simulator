import { useState } from 'react';
import type { DayAheadState } from '../engine/types';
import type { BatteryState } from '../engine/battery';
import { getMaxChargeableMw, getMaxDischargeableMw } from '../engine/battery';
import { getUtcDayStart, formatDeliveryDay } from '../engine/clock';
import HelpIcon from './HelpIcon';
import {
  ComposedChart, Bar, Line, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import { ArrowDown, ArrowUp, Clock } from 'lucide-react';
import { getIntradayPrice } from '../engine/intradayPricing';
import TermTooltip from './TermTooltip';

interface Props {
  dayAhead: DayAheadState;
  battery: BatteryState;
  currentPrice: number;
  currentTime: number;
  currentHour: number;
  onIntradayCharge: (sp: number, mw: number) => void;
  onIntradayDischarge: (sp: number, mw: number) => void;
}

export default function IntradayTrading({
  dayAhead, battery, currentPrice, currentTime,
  onIntradayCharge, onIntradayDischarge,
}: Props) {
  const [selectedSp, setSelectedSp] = useState<number | null>(null);
  const [mw, setMw] = useState(String(battery.config.powerRatingMw));
  const [hoveredSp, setHoveredSp] = useState<number | null>(null);

  const { forecastPrices, sipOutturn, revealedPeriods, playerSchedule } = dayAhead;

  const todayDay = getUtcDayStart(currentTime);

  // Intraday prices are tradable only for live/future periods. Settled periods show SIP instead.
  const idPrices = forecastPrices.map((_, sp) => {
    if (sp < revealedPeriods) return null;
    return getIntradayPrice({ forecastPrices, sipOutturn, revealedPeriods, currentPrice, period: sp });
  });

  // Aggregate today's scheduled positions per SP for chart + table
  type SpPlan = { chargeMw: number; dischargeMw: number; netMw: number; avgPrice: number; positions: typeof playerSchedule };
  const planBySp: Record<number, SpPlan> = {};
  for (const pos of playerSchedule) {
    if (pos.deliveryDay !== todayDay) continue;
    const slot = planBySp[pos.period] ?? { chargeMw: 0, dischargeMw: 0, netMw: 0, avgPrice: 0, positions: [] };
    if (pos.action === 'charge') slot.chargeMw += pos.mw;
    else slot.dischargeMw += pos.mw;
    slot.positions.push(pos);
    planBySp[pos.period] = slot;
  }
  for (const sp in planBySp) {
    const s = planBySp[sp];
    s.netMw = s.dischargeMw - s.chargeMw;
    const totalMw = s.positions.reduce((a, p) => a + p.mw, 0);
    s.avgPrice = totalMw > 0
      ? s.positions.reduce((a, p) => a + p.mw * p.price, 0) / totalMw
      : 0;
  }

  // Project SoC across upcoming periods given the current schedule.
  // `socAtEntry[sp]` = SoC% at the *start* of period sp (before that SP's trades apply).
  const capacity = battery.config.capacityMwh;
  const eff = battery.config.efficiencyPct / 100;
  const socAtEntry: (number | null)[] = new Array(48).fill(null);
  const socAtExit: (number | null)[] = new Array(48).fill(null);
  {
    let socMwh = battery.currentSocMwh;
    for (let sp = revealedPeriods; sp < 48; sp++) {
      socAtEntry[sp] = (socMwh / capacity) * 100;
      const plan = planBySp[sp];
      if (plan) {
        socMwh += plan.chargeMw * 0.5 * eff;
        socMwh -= plan.dischargeMw * 0.5;
        socMwh = Math.max(0, Math.min(capacity, socMwh));
      }
      socAtExit[sp] = (socMwh / capacity) * 100;
    }
  }

  const chartData = forecastPrices.map((da, sp) => {
    const plan = planBySp[sp];
    const livePrice = idPrices[sp];
    const settledPrice = sp < revealedPeriods ? sipOutturn[sp] : null;
    // Y-position for plan markers: prefer the trade's avg price, else SIP/ID/DA price as fallback
    const markerY = plan && plan.avgPrice > 0
      ? plan.avgPrice
      : (settledPrice ?? livePrice ?? da);
    return {
      sp: `${String(Math.floor(sp / 2)).padStart(2, '0')}:${sp % 2 === 0 ? '00' : '30'}`,
      spIdx: sp,
      da,
      id: livePrice,
      sip: settledPrice,
      isFuture: sp > revealedPeriods,
      isSelected: sp === selectedSp,
      isHovered: sp === hoveredSp,
      chargeMw: plan?.chargeMw ?? 0,
      dischargeMw: plan?.dischargeMw ?? 0,
      chargeMarker: plan && plan.chargeMw > 0 ? markerY : null,
      dischargeMarker: plan && plan.dischargeMw > 0 ? markerY : null,
      socPct: socAtExit[sp],
    };
  });

  const maxCharge = getMaxChargeableMw(battery);
  const maxDischarge = getMaxDischargeableMw(battery);
  const vol = Math.min(Number(mw) || 0, battery.config.powerRatingMw);
  const selectedPlan = selectedSp !== null ? planBySp[selectedSp] : undefined;
  const selectedDa = selectedSp !== null ? forecastPrices[selectedSp] : 0;
  const selectedId = selectedSp !== null ? (idPrices[selectedSp] ?? currentPrice) : currentPrice;
  const spread = selectedId - selectedDa;
  const socEntryAtSelected = selectedSp !== null ? socAtEntry[selectedSp] : null;
  const socExitAtSelected = selectedSp !== null ? socAtExit[selectedSp] : null;

  const handleCharge = () => {
    if (selectedSp === null || vol <= 0) return;
    onIntradayCharge(selectedSp, Math.min(vol, maxCharge));
    setSelectedSp(null);
  };

  const handleDischarge = () => {
    if (selectedSp === null || vol <= 0) return;
    onIntradayDischarge(selectedSp, Math.min(vol, maxDischarge));
    setSelectedSp(null);
  };

  const plannedSpList = Object.keys(planBySp)
    .map((k) => Number(k))
    .sort((a, b) => a - b);

  // KPI aggregates
  const todayChargeMwh = plannedSpList.reduce((s, sp) => s + planBySp[sp].chargeMw * 0.5, 0);
  const todayDischargeMwh = plannedSpList.reduce((s, sp) => s + planBySp[sp].dischargeMw * 0.5, 0);
  const projectedEndSoc = (() => {
    for (let sp = 47; sp >= revealedPeriods; sp--) {
      if (socAtExit[sp] != null) return socAtExit[sp] as number;
    }
    return battery.socPct;
  })();

  // Custom dot renderers for the planned-trade markers
  type DotProps = { cx?: number; cy?: number; payload?: { chargeMw: number; dischargeMw: number; spIdx: number } };
  const renderChargeDot = (props: DotProps) => {
    const { cx, cy, payload } = props;
    if (!payload || !payload.chargeMw || cx == null || cy == null) {
      return <g key={`c-empty-${payload?.spIdx ?? Math.random()}`} />;
    }
    const r = Math.max(2, Math.min(5, 1.5 + payload.chargeMw / 14));
    const isHl = payload.spIdx === hoveredSp || payload.spIdx === selectedSp;
    return (
      <g key={`c-${payload.spIdx}`}>
        <circle cx={cx} cy={cy} r={r + 1.5} fill="#007be2" fillOpacity={0.2} />
        <circle cx={cx} cy={cy} r={r} fill="#007be2" stroke={isHl ? '#fff' : 'transparent'} strokeWidth={isHl ? 1 : 0} />
      </g>
    );
  };
  const renderDischargeDot = (props: DotProps) => {
    const { cx, cy, payload } = props;
    if (!payload || !payload.dischargeMw || cx == null || cy == null) {
      return <g key={`d-empty-${payload?.spIdx ?? Math.random()}`} />;
    }
    const r = Math.max(2, Math.min(5, 1.5 + payload.dischargeMw / 14));
    const isHl = payload.spIdx === hoveredSp || payload.spIdx === selectedSp;
    return (
      <g key={`d-${payload.spIdx}`}>
        <rect x={cx - r - 1.5} y={cy - r - 1.5} width={(r + 1.5) * 2} height={(r + 1.5) * 2} fill="#ff874b" fillOpacity={0.18} rx={1.5} />
        <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} fill="#ff874b" stroke={isHl ? '#fff' : 'transparent'} strokeWidth={isHl ? 1 : 0} rx={1} />
      </g>
    );
  };

  return (
    <div className="panel intraday-panel" id="intraday-tab">
      <div className="da-sticky-top">
        <div className="panel-header da-panel-header">
          <h3><Clock size={16} /> Intraday Continuous Market <TermTooltip term="Gate Closure" label="ID" /></h3>
          <HelpIcon text="Trade individual settlement periods as new information arrives. ID prices update with the latest market conditions. Plans you have placed are shown as dots on the chart." />
          <span className="da-delivery-badge">
            Delivery <strong>{formatDeliveryDay(todayDay)}</strong>
          </span>
        </div>

        <div className="kpi-strip">
          <div className="kpi-card">
            <div className="kpi-label">SoC now</div>
            <div className="kpi-value-row">
              <span className="kpi-value">{battery.socPct.toFixed(0)}<span className="kpi-unit">%</span></span>
            </div>
            <div className="kpi-sub">{battery.currentSocMwh.toFixed(0)} / {battery.config.capacityMwh} MWh</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Projected end-of-day</div>
            <div className="kpi-value-row">
              <span className="kpi-value" style={{ color: 'var(--chart-soc)' }}>{projectedEndSoc.toFixed(0)}<span className="kpi-unit">%</span></span>
            </div>
            <div className="kpi-sub">after all scheduled trades</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Headroom</div>
            <div className="kpi-value-row">
              <span className="kpi-value" style={{ fontSize: 16 }}>
                <span style={{ color: 'var(--accent)' }}>↓{maxCharge.toFixed(0)}</span>
                <span className="kpi-unit"> / </span>
                <span style={{ color: 'var(--magenta)' }}>↑{maxDischarge.toFixed(0)}</span>
                <span className="kpi-unit"> MW</span>
              </span>
            </div>
            <div className="kpi-sub">max charge / discharge now</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Scheduled today</div>
            <div className="kpi-value-row">
              <span className="kpi-value">{plannedSpList.length}<span className="kpi-unit"> SPs</span></span>
            </div>
            <div className="kpi-sub">
              <span style={{ color: 'var(--accent)' }}>{todayChargeMwh.toFixed(0)}</span> chg ·{' '}
              <span style={{ color: 'var(--magenta)' }}>{todayDischargeMwh.toFixed(0)}</span> dis MWh
            </div>
          </div>
        </div>

        <div className="da-sticky-content">
          {/* Chart — 2/3 width */}
          <div className="da-forecast-chart compact">
            <div className="da-forecast-head">
              <h4>
                DA Forecast · Intraday · Plan
                <HelpIcon text="Slate bars = DA forecast (locked). Blue dashed = live ID price. Orange = settled SIP. Cyan dot = planned charge, magenta square = planned discharge — size scales with MW. Purple line = projected SoC." />
              </h4>
              <div className="da-chart-legend inline">
                <span className="legend-item"><span className="legend-bar da-bar" /> DA</span>
                <span className="legend-item"><span className="legend-line id-line" /> ID</span>
                {revealedPeriods > 0 && (
                  <span className="legend-item"><span className="legend-line sip-line" /> SIP</span>
                )}
                <span className="legend-item"><span className="legend-dot charge-dot" /> Charge</span>
                <span className="legend-item"><span className="legend-dot discharge-dot" /> Discharge</span>
                <span className="legend-item"><span className="legend-line soc-line" /> SoC%</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart
                data={chartData}
                margin={{ top: 6, right: 8, bottom: 0, left: -8 }}
                barCategoryGap="28%"
                onMouseMove={(e: unknown) => {
                  const ev = e as { activePayload?: Array<{ payload?: { spIdx?: number } }> };
                  const idx = ev?.activePayload?.[0]?.payload?.spIdx;
                  if (typeof idx === 'number') setHoveredSp(idx);
                }}
                onMouseLeave={() => setHoveredSp(null)}
              >
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
                    const stride = 2; // every 1h on a 48-SP day
                    const out: number[] = [];
                    for (let i = 0; i < n; i += stride) {
                      out.push(left + (i / (n - 1)) * w);
                    }
                    return out;
                  }}
                />
                <XAxis dataKey="sp" stroke="#6b7280" fontSize={9} interval={7} tickLine={false} axisLine={false} />
                <YAxis yAxisId="price" stroke="#6b7280" fontSize={10} width={36} tickLine={false} axisLine={false} />
                <YAxis
                  yAxisId="soc"
                  orientation="right"
                  stroke="#c7b4f8"
                  fontSize={10}
                  width={32}
                  domain={[0, 100]}
                  ticks={[0, 50, 100]}
                  tickFormatter={(v: number) => `${v}%`}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  cursor={{ stroke: '#9272f5', strokeWidth: 1, strokeDasharray: '2 3' }}
                  contentStyle={{ background: '#0f1420', border: '1px solid #1f2535', borderRadius: '6px', color: '#e5e7eb', fontSize: 11, padding: '6px 8px' }}
                  labelStyle={{ color: '#6b7280', fontSize: 10, marginBottom: 2 }}
                  itemStyle={{ color: '#e5e7eb', padding: 0 }}
                  formatter={(value: unknown, name: unknown) => {
                    if (value == null) return ['—', String(name)];
                    const key = String(name);
                    if (key === 'Projected SoC') {
                      return [`${Number(value).toFixed(1)}%`, key];
                    }
                    if (key === 'Planned Charge' || key === 'Planned Discharge') {
                      return [`£${Number(value).toFixed(2)}/MWh`, key];
                    }
                    return [`£${Number(value).toFixed(2)}`, key];
                  }}
                />
                <ReferenceLine
                  yAxisId="price"
                  x={chartData[revealedPeriods]?.sp}
                  stroke="#6b7280"
                  strokeDasharray="2 4"
                  label={{ value: 'Now', fill: '#9ca3af', fontSize: 10, position: 'top' }}
                />
                <Bar yAxisId="price" dataKey="da" name="DA Forecast" radius={[2, 2, 0, 0]} fill="#9ca3af">
                  {chartData.map((entry, i) => (
                    <Cell
                      key={i}
                      fill={entry.isFuture ? '#9ca3af' : '#3a4458'}
                      fillOpacity={entry.isHovered || entry.isSelected ? 0.9 : entry.isFuture ? 0.5 : 0.3}
                    />
                  ))}
                </Bar>
                <Line
                  yAxisId="price"
                  type="monotone"
                  dataKey="id"
                  stroke="#76b8ef"
                  strokeWidth={2.5}
                  strokeDasharray="4 2"
                  dot={false}
                  name="ID Price"
                  connectNulls={false}
                  isAnimationActive={false}
                />
                {revealedPeriods > 0 && (
                  <Line
                    yAxisId="price"
                    type="monotone"
                    dataKey="sip"
                    stroke="#ff5f62"
                    strokeWidth={2.5}
                    dot={false}
                    name="SIP Outturn"
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                )}
                <Line
                  yAxisId="soc"
                  type="stepAfter"
                  dataKey="socPct"
                  stroke="#c7b4f8"
                  strokeWidth={2}
                  dot={false}
                  name="Projected SoC"
                  connectNulls={false}
                  isAnimationActive={false}
                />
                <Scatter
                  yAxisId="price"
                  dataKey="chargeMarker"
                  shape={renderChargeDot}
                  isAnimationActive={false}
                  name="Planned Charge"
                />
                <Scatter
                  yAxisId="price"
                  dataKey="dischargeMarker"
                  shape={renderDischargeDot}
                  isAnimationActive={false}
                  name="Planned Discharge"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Trade panel — 1/3 width */}
          <div className="da-quick-panel id-trade-panel">
            {selectedSp !== null ? (
              <div className="id-trade-card">
                <div className="id-trade-head">
                  <span className="id-trade-sp">{chartData[selectedSp]?.sp}</span>
                  <span className="id-trade-price">£{selectedId.toFixed(2)}/MWh</span>
                </div>
                <div className="id-trade-spread">
                  DA £{selectedDa.toFixed(2)} · spread
                  <span className={spread >= 0 ? 'positive' : 'negative'}>
                    {spread >= 0 ? ' +' : ' '}£{spread.toFixed(2)}
                  </span>
                </div>
                {selectedPlan && (
                  <div className="id-trade-existing">
                    Existing plan: {selectedPlan.chargeMw > 0 && <span className="hint-charge">+{selectedPlan.chargeMw.toFixed(0)} MW charge</span>}
                    {selectedPlan.chargeMw > 0 && selectedPlan.dischargeMw > 0 && ' · '}
                    {selectedPlan.dischargeMw > 0 && <span className="hint-discharge">{selectedPlan.dischargeMw.toFixed(0)} MW discharge</span>}
                  </div>
                )}
                {socEntryAtSelected !== null && socExitAtSelected !== null && (
                  <div className="id-trade-soc">
                    SoC at this SP:
                    <strong>{socEntryAtSelected.toFixed(0)}%</strong>
                    <span className="id-soc-arrow">→</span>
                    <strong className={socExitAtSelected < 15 ? 'negative' : socExitAtSelected > 90 ? 'warn' : ''}>
                      {socExitAtSelected.toFixed(0)}%
                    </strong>
                  </div>
                )}

                <div className="id-mw-row">
                  <label>Volume</label>
                  <input
                    type="number"
                    className="input input-sm"
                    value={mw}
                    onChange={e => setMw(e.target.value)}
                    min={1}
                    max={battery.config.powerRatingMw}
                  />
                  <span className="id-mw-unit">MW</span>
                </div>

                <div className="id-action-buttons">
                  <button
                    className="btn btn-action btn-charge"
                    onClick={handleCharge}
                    disabled={maxCharge < 0.1 || vol <= 0}
                    title={maxCharge < 0.1 ? 'Battery full' : `Up to ${maxCharge.toFixed(1)} MW`}
                  >
                    <ArrowDown size={14} /> Charge {Math.min(vol, maxCharge).toFixed(0)} MW
                  </button>
                  <button
                    className="btn btn-action btn-discharge"
                    onClick={handleDischarge}
                    disabled={maxDischarge < 0.1 || vol <= 0}
                    title={maxDischarge < 0.1 ? 'Battery empty' : `Up to ${maxDischarge.toFixed(1)} MW`}
                  >
                    <ArrowUp size={14} /> Discharge {Math.min(vol, maxDischarge).toFixed(0)} MW
                  </button>
                </div>
              </div>
            ) : (
              <div className="id-trade-card empty">
                <div className="id-trade-empty-title">No period selected</div>
                <div className="id-trade-empty-sub">
                  Click a future settlement period below or a bar on the chart to place an intraday trade.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* SP selector grid */}
      <div className="id-trade-section">
        <h4>Future settlement periods (next 12)</h4>
        <div className="id-sp-grid">
          {Array.from({ length: Math.max(0, Math.min(12, 48 - revealedPeriods - 1)) }, (_, idx) => {
            const sp = revealedPeriods + 1 + idx;
            const hour = Math.floor(sp / 2);
            const min = sp % 2 === 0 ? '00' : '30';
            const idPrice = idPrices[sp] ?? currentPrice;
            const isLow = idPrice < 35;
            const isHigh = idPrice > 65;
            const plan = planBySp[sp];
            return (
              <button
                key={sp}
                className={`id-sp-btn ${selectedSp === sp ? 'selected' : ''} ${isLow ? 'low' : ''} ${isHigh ? 'high' : ''}`}
                onClick={() => setSelectedSp(sp === selectedSp ? null : sp)}
                onMouseEnter={() => setHoveredSp(sp)}
                onMouseLeave={() => setHoveredSp(null)}
              >
                <span className="id-sp-time">{String(hour).padStart(2, '0')}:{min}</span>
                <span className="id-sp-price">£{idPrice.toFixed(1)}</span>
                {plan && (
                  <span className="id-sp-plan">
                    {plan.chargeMw > 0 && <span className="plan-chip charge">+{plan.chargeMw.toFixed(0)}</span>}
                    {plan.dischargeMw > 0 && <span className="plan-chip discharge">-{plan.dischargeMw.toFixed(0)}</span>}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Planned positions for today */}
      <div className="id-plan-section">
        <h4>
          Today&apos;s schedule
          <HelpIcon text="All your committed positions for today across DA, ID and BM. Past SPs have already delivered." />
        </h4>
        {plannedSpList.length === 0 ? (
          <div className="empty-state" style={{ padding: 12 }}>
            No positions scheduled for {formatDeliveryDay(todayDay)} yet. Place an intraday trade above or submit DA bids.
          </div>
        ) : (
          <div className="id-plan-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>SP</th>
                  <th>Charge MW</th>
                  <th>Discharge MW</th>
                  <th>Avg Price</th>
                  <th>Markets</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {plannedSpList.map((sp) => {
                  const plan = planBySp[sp];
                  const hour = Math.floor(sp / 2);
                  const min = sp % 2 === 0 ? '00' : '30';
                  const markets = Array.from(new Set(plan.positions.map((p) => p.market.toUpperCase()))).join(' · ');
                  const allDelivered = plan.positions.every((p) => p.delivered);
                  return (
                    <tr
                      key={sp}
                      className={sp === hoveredSp || sp === selectedSp ? 'row-hovered' : ''}
                      onMouseEnter={() => setHoveredSp(sp)}
                      onMouseLeave={() => setHoveredSp(null)}
                      onClick={() => sp > revealedPeriods && setSelectedSp(sp === selectedSp ? null : sp)}
                      style={{ cursor: sp > revealedPeriods ? 'pointer' : 'default' }}
                    >
                      <td>{String(hour).padStart(2, '0')}:{min}</td>
                      <td className={plan.chargeMw > 0 ? 'buy-text' : 'muted'}>
                        {plan.chargeMw > 0 ? plan.chargeMw.toFixed(1) : '—'}
                      </td>
                      <td className={plan.dischargeMw > 0 ? 'sell-text' : 'muted'}>
                        {plan.dischargeMw > 0 ? plan.dischargeMw.toFixed(1) : '—'}
                      </td>
                      <td>£{plan.avgPrice.toFixed(2)}</td>
                      <td className="muted">{markets}</td>
                      <td className={allDelivered ? 'muted' : 'positive'}>
                        {allDelivered ? 'Delivered' : sp < revealedPeriods ? 'Settling' : 'Pending'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
