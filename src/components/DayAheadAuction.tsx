import { useState } from 'react';
import type { DayAheadBid, DayAheadState } from '../engine/types';
import { OrderSide } from '../engine/types';
import type { BatteryState } from '../engine/battery';
import { hoursUntilGateClosure, getGateClosureTime, formatHour, formatDeliveryDay, getUtcDayStart } from '../engine/clock';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import HelpIcon from './HelpIcon';
import { CheckCircle } from 'lucide-react';

interface Props {
  dayAhead: DayAheadState;
  currentTime: number;
  battery: BatteryState;
  onSubmitBids: (bids: DayAheadBid[]) => void;
}

export default function DayAheadAuction({ dayAhead, currentTime, battery, onSubmitBids }: Props) {
  const { isAuctionOpen, results, forecastPrices, playerSchedule, deliveryDay } = dayAhead;
  const [bids, setBids] = useState<{ [period: number]: { side: string; volume: string; price: string } }>({});
  const [submitted, setSubmitted] = useState(false);
  const [hoveredPeriod, setHoveredPeriod] = useState<number | null>(null);
  const gateHours = hoursUntilGateClosure(currentTime);
  const gateTimeUtc = formatHour(getGateClosureTime(currentTime));

  // Calculate price thresholds to determine charge vs discharge hints
  const sortedPrices = [...forecastPrices].filter(p => p !== 0).sort((a, b) => a - b);
  const lowThreshold = sortedPrices.length > 0 ? sortedPrices[Math.floor(sortedPrices.length * 0.25)] : 35;
  const highThreshold = sortedPrices.length > 0 ? sortedPrices[Math.floor(sortedPrices.length * 0.75)] : 65;

  const handleBidChange = (period: number, field: 'side' | 'volume' | 'price', value: string) => {
    setSubmitted(false);
    const fPrice = forecastPrices[period] ?? 0;
    const existing = bids[period] ?? { side: isHighPeriod(period) ? OrderSide.SELL : OrderSide.BUY, volume: '', price: '' };

    const updated = { ...existing, [field]: value };

    // Auto-fill price with forecast when user enters volume but hasn't set a price
    if (field === 'volume' && value && !existing.price && fPrice > 0) {
      updated.price = fPrice.toFixed(1);
    }

    setBids(prev => ({ ...prev, [period]: updated }));
  };

  const isHighPeriod = (period: number) => {
    const p = forecastPrices[period] ?? 0;
    return p >= highThreshold;
  };

  const handleSubmit = () => {
    const allBids = Object.entries(bids);
    const validBids: DayAheadBid[] = [];
    for (const [periodStr, bid] of allBids) {
      if (!bid.volume || !bid.price) continue;
      const vol = parseFloat(bid.volume);
      const price = parseFloat(bid.price);
      if (isNaN(vol) || isNaN(price) || vol <= 0) continue;
      validBids.push({
        period: Number(periodStr),
        side: bid.side === 'sell' ? OrderSide.SELL : OrderSide.BUY,
        volumeMw: vol,
        price,
      });
    }
    if (validBids.length > 0) {
      onSubmitBids(validBids);
      setSubmitted(true);
      setBids({});
      setTimeout(() => setSubmitted(false), 4000);
    }
  };

  const bidCount = Object.values(bids).filter(b => {
    const v = parseFloat(b.volume);
    const p = parseFloat(b.price);
    return !isNaN(v) && !isNaN(p) && v > 0 && p > 0;
  }).length;
  // Project SoC across the delivery day combining already-cleared positions
  // (in playerSchedule) and the bids currently being entered in the form.
  // Starting SoC = current SoC, advanced through every undelivered position
  // scheduled for any day strictly before `deliveryDay`. Most relevant case:
  // bidding the DA auction on day D-1 for delivery on day D — the battery
  // first has to play out today's remaining DA/ID/BM schedule.
  const capacity = battery.config.capacityMwh;
  const eff = battery.config.efficiencyPct / 100;
  const todayDay = getUtcDayStart(currentTime);
  let startSocMwh = battery.currentSocMwh;
  const priorPositions = playerSchedule
    .filter((p) => !p.delivered && p.deliveryDay >= todayDay && p.deliveryDay < deliveryDay)
    .sort((a, b) => (a.deliveryDay - b.deliveryDay) || (a.period - b.period));
  for (const pos of priorPositions) {
    if (pos.action === 'charge') startSocMwh += pos.mw * 0.5 * eff;
    else startSocMwh -= pos.mw * 0.5;
    startSocMwh = Math.max(0, Math.min(capacity, startSocMwh));
  }

  const socPctByPeriod: number[] = new Array(48).fill(0);
  {
    let socMwh = startSocMwh;
    for (let sp = 0; sp < 48; sp++) {
      let chargeMw = 0;
      let dischargeMw = 0;
      for (const pos of playerSchedule) {
        if (pos.deliveryDay !== deliveryDay || pos.period !== sp) continue;
        if (pos.action === 'charge') chargeMw += pos.mw;
        else dischargeMw += pos.mw;
      }
      const bid = bids[sp];
      if (bid) {
        const v = parseFloat(bid.volume);
        const pr = parseFloat(bid.price);
        if (!isNaN(v) && v > 0 && !isNaN(pr) && pr > 0) {
          if (bid.side === OrderSide.BUY) chargeMw += v;
          else dischargeMw += v;
        }
      }
      socMwh += chargeMw * 0.5 * eff;
      socMwh -= dischargeMw * 0.5;
      socMwh = Math.max(0, Math.min(capacity, socMwh));
      socPctByPeriod[sp] = (socMwh / capacity) * 100;
    }
  }

  // KPI aggregates for the delivery day (cleared positions + pending bids).
  let chargeMwh = 0, dischargeMwh = 0, chargeCost = 0, dischargeRev = 0;
  const accumulate = (action: 'charge' | 'discharge', mw: number, price: number) => {
    const mwh = mw * 0.5;
    if (action === 'charge') { chargeMwh += mwh; chargeCost += mwh * price; }
    else { dischargeMwh += mwh; dischargeRev += mwh * price; }
  };
  for (const pos of playerSchedule) {
    if (pos.deliveryDay !== deliveryDay) continue;
    accumulate(pos.action, pos.mw, pos.price);
  }
  for (const [sp, bid] of Object.entries(bids)) {
    const v = parseFloat(bid.volume), pr = parseFloat(bid.price);
    if (isNaN(v) || v <= 0 || isNaN(pr) || pr <= 0) continue;
    accumulate(bid.side === OrderSide.BUY ? 'charge' : 'discharge', v, pr);
    void sp;
  }
  const netCashflow = dischargeRev - chargeCost;
  const socValues = socPctByPeriod.filter((v) => Number.isFinite(v));
  const socMin = socValues.length ? Math.min(...socValues) : 0;
  const socMax = socValues.length ? Math.max(...socValues) : 0;
  const scheduledPositions = playerSchedule.filter((p) => p.deliveryDay === deliveryDay).length;

  const chartData = forecastPrices.map((price, sp) => ({
    sp: `${String(Math.floor(sp / 2)).padStart(2, '0')}:${sp % 2 === 0 ? '00' : '30'}`,
    price,
    socPct: socPctByPeriod[sp],
    isLow: price > 0 && price <= lowThreshold,
    isHigh: price >= highThreshold,
  }));

  return (
    <div className="panel day-ahead-full" id="dayahead-tab">
      <div className="da-sticky-top">
        <div className="panel-header da-panel-header">
          <h3>Day-Ahead Market (EPEX SPOT)</h3>
          <HelpIcon text="The DA auction at 09:20 UK closes the schedule for the next delivery day. Submit bids for each half-hour settlement period. Green = cheap (charge). Red = expensive (discharge)." />
          <span className="da-delivery-badge">
            Delivery <strong>{formatDeliveryDay(deliveryDay)}</strong>
          </span>
        </div>

        <div className="kpi-strip">
          <div className="kpi-card">
            <div className="kpi-label">Net cashflow</div>
            <div className="kpi-value-row">
              <span className={`kpi-value ${netCashflow >= 0 ? 'positive' : 'negative'}`}>
                {netCashflow >= 0 ? '+' : '−'}£{Math.abs(netCashflow).toFixed(0)}
              </span>
            </div>
            <div className="kpi-sub">revenue − charge cost (cleared + pending)</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Charge</div>
            <div className="kpi-value-row">
              <span className="kpi-value" style={{ color: 'var(--accent)' }}>{chargeMwh.toFixed(0)}<span className="kpi-unit"> MWh</span></span>
            </div>
            <div className="kpi-sub">@ avg £{chargeMwh > 0 ? (chargeCost / chargeMwh).toFixed(0) : '—'}/MWh</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Discharge</div>
            <div className="kpi-value-row">
              <span className="kpi-value" style={{ color: 'var(--magenta)' }}>{dischargeMwh.toFixed(0)}<span className="kpi-unit"> MWh</span></span>
            </div>
            <div className="kpi-sub">@ avg £{dischargeMwh > 0 ? (dischargeRev / dischargeMwh).toFixed(0) : '—'}/MWh</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">SoC swing</div>
            <div className="kpi-value-row">
              <span className="kpi-value">{socMin.toFixed(0)}–{socMax.toFixed(0)}<span className="kpi-unit">%</span></span>
            </div>
            <div className="kpi-sub">{scheduledPositions} positions scheduled</div>
          </div>
        </div>

        <div className="da-sticky-content">
          {/* Forecast price chart — sticky, 2/3 width */}
          <div className="da-forecast-chart compact">
            <div className="da-forecast-head">
              <h4>
                48-Period Price Forecast
                <HelpIcon text="Green = charge zone (cheap). Red = discharge zone (expensive). Blue = mid-range. Red line = actual SIP outturn once revealed." />
              </h4>
              <div className="da-chart-legend inline">
                <span className="legend-item"><span className="legend-bar da-bar" /> Forecast</span>
                <span className="legend-item"><span className="legend-line soc-line" /> SoC%</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -8 }} barCategoryGap="28%">
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
                    return [`£${Number(value).toFixed(2)}`, key];
                  }}
                />
                <Bar yAxisId="price" dataKey="price" name="DA Forecast" radius={[2, 2, 0, 0]}>
                  {chartData.map((entry, i) => {
                    const isHovered = hoveredPeriod === i;
                    const baseColor = entry.isLow ? '#007be2' : entry.isHigh ? '#ff874b' : '#9ca3af';
                    return (
                      <Cell
                        key={i}
                        fill={baseColor}
                        fillOpacity={isHovered ? 1 : 0.6}
                        stroke={isHovered ? '#ffffff' : 'none'}
                        strokeWidth={isHovered ? 1.5 : 0}
                      />
                    );
                  })}
                </Bar>
                <Line
                  yAxisId="soc"
                  type="stepAfter"
                  dataKey="socPct"
                  stroke="#c7b4f8"
                  strokeWidth={2}
                  dot={false}
                  name="Projected SoC"
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Quick fill panel — sticky, 1/3 width */}
          <div className="da-quick-panel">
            <div className={`da-status-inline ${isAuctionOpen ? 'open' : 'closed'}`}>
              <div className="da-status-row">
                <span className={`da-status-dot ${isAuctionOpen ? 'open' : 'closed'}`} />
                <span className="da-status-label">
                  {isAuctionOpen ? 'Auction OPEN' : 'Auction CLOSED'}
                </span>
              </div>
              <div className="da-status-sub">
                {isAuctionOpen
                  ? `Gate closes ${gateTimeUtc} UTC · ${gateHours}h left`
                  : `Cleared · awaiting delivery`}
              </div>
              <div className="da-status-sub">
                Delivery day: <strong>{formatDeliveryDay(deliveryDay)}</strong>
              </div>
              {(scheduledPositions > 0 || submitted) && (
                <div className="da-status-meta">
                  {scheduledPositions > 0 && (
                    <span className="da-schedule-count">
                      {scheduledPositions} scheduled
                    </span>
                  )}
                  {submitted && (
                    <span className="da-submitted">
                      <CheckCircle size={12} /> Submitted
                    </span>
                  )}
                </div>
              )}
            </div>
            <h4>
              Submit Battery Schedule
              <HelpIcon text="Quick-fill presets generate bids across all periods. Customise individual rows in the table below." />
            </h4>
            <div className="da-quick-fill vertical">
              <span className="da-quick-label">Quick Fill</span>
              <button className="btn btn-preset" onClick={() => {
                const pw = battery.config.powerRatingMw;
                const eff = battery.config.efficiencyPct / 100;
                const cap = battery.config.capacityMwh;
                const currentSoc = battery.currentSocMwh;
                const headroom = cap - currentSoc;

                const periodPrices = Array.from({ length: 48 }, (_, period) => ({
                  period, price: forecastPrices[period] ?? 0,
                })).filter(x => Number.isFinite(x.price));
                const sorted = [...periodPrices].sort((a, b) => a.price - b.price);

                const newBids: typeof bids = {};
                let chargeRemaining = headroom / (eff * 0.5);
                for (const { period, price } of sorted) {
                  if (chargeRemaining <= 0) break;
                  const mw = Math.min(pw, chargeRemaining);
                  newBids[period] = { side: OrderSide.BUY, volume: String(Math.round(mw)), price: price.toFixed(1) };
                  chargeRemaining -= mw;
                }
                let dischargeRemaining = cap / 0.5;
                for (const { period, price } of [...periodPrices].sort((a, b) => b.price - a.price)) {
                  if (dischargeRemaining <= 0) break;
                  if (newBids[period]) continue;
                  const mw = Math.min(pw, dischargeRemaining);
                  newBids[period] = { side: OrderSide.SELL, volume: String(Math.round(mw)), price: price.toFixed(1) };
                  dischargeRemaining -= mw;
                }
                setBids(newBids);
              }}>
                Arbitrage
              </button>
              <button className="btn btn-preset" onClick={() => {
                const pw = battery.config.powerRatingMw;
                const eff = battery.config.efficiencyPct / 100;
                const cap = battery.config.capacityMwh;
                const headroom = (cap - battery.currentSocMwh) / (eff * 0.5);
                const sorted = Array.from({ length: 48 }, (_, period) => ({
                  period, price: forecastPrices[period] ?? 0,
                })).filter(x => Number.isFinite(x.price)).sort((a, b) => a.price - b.price);
                const newBids: typeof bids = {};
                let remaining = headroom;
                for (const { period, price } of sorted) {
                  if (remaining <= 0) break;
                  const mw = Math.min(pw, remaining);
                  newBids[period] = { side: OrderSide.BUY, volume: String(Math.round(mw)), price: price.toFixed(1) };
                  remaining -= mw;
                }
                setBids(newBids);
              }}>
                Charge only
              </button>
              <button className="btn btn-preset" onClick={() => {
                const pw = battery.config.powerRatingMw;
                const available = battery.currentSocMwh / 0.5;
                const sorted = Array.from({ length: 48 }, (_, period) => ({
                  period, price: forecastPrices[period] ?? 0,
                })).filter(x => Number.isFinite(x.price)).sort((a, b) => b.price - a.price);
                const newBids: typeof bids = {};
                let remaining = available;
                for (const { period, price } of sorted) {
                  if (remaining <= 0) break;
                  const mw = Math.min(pw, remaining);
                  newBids[period] = { side: OrderSide.SELL, volume: String(Math.round(mw)), price: price.toFixed(1) };
                  remaining -= mw;
                }
                setBids(newBids);
              }}>
                Discharge only
              </button>
              <button className="btn btn-preset" onClick={() => setBids({})}>
                Clear
              </button>
            </div>
            <button
              className={`btn btn-submit da-submit-inline ${bidCount > 0 ? 'btn-buy' : ''}`}
              onClick={handleSubmit}
              disabled={bidCount === 0}
            >
              {submitted
                ? '✓ Submitted'
                : bidCount > 0
                  ? `Submit ${bidCount} Bid${bidCount > 1 ? 's' : ''}`
                  : 'No bids to submit'}
            </button>
          </div>
        </div>
      </div>

      {/* Auction results */}
      {results.length > 0 && (
        <div className="da-results">
          <h4>Auction Results</h4>
          <div className="da-results-scroll">
            <table className="data-table">
              <thead>
                <tr><th>Hour</th><th>Clearing</th><th>Your Action</th><th>Status</th></tr>
              </thead>
              <tbody>
                {results.map(r => (
                  <tr key={r.period} className={r.accepted ? 'row-accepted' : ''}>
                    <td>{String(Math.floor(r.period / 2)).padStart(2, '0')}:{r.period % 2 === 0 ? '00' : '30'}</td>
                    <td>£{r.clearingPrice.toFixed(2)}</td>
                    <td>
                      {r.playerVolume > 0 ? `Charge ${r.playerVolume} MW` :
                       r.playerVolume < 0 ? `Discharge ${Math.abs(r.playerVolume)} MW` : '—'}
                    </td>
                    <td className={r.accepted ? 'positive' : 'muted'}>
                      {r.accepted ? 'Accepted' : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Bid entry — always visible so user can enter bids */}
      <div className="da-bid-section">
        {!isAuctionOpen && (
          <div className="da-gate-warning">
            Gate has closed for this delivery day. Bids submitted now will apply to the next auction.
          </div>
        )}
          <div className="da-bid-scroll">
            <table className="data-table bid-table">
              <thead>
                <tr><th>SP</th><th>Forecast</th><th>Hint</th><th>Action</th><th>MW</th><th>Price £</th></tr>
              </thead>
              <tbody>
                {Array.from({ length: 48 }, (_, sp) => {
                  const fPrice = forecastPrices[sp] ?? 0;
                  const bid = bids[sp];
                  const isLow = fPrice > 0 && fPrice <= lowThreshold;
                  const isHigh = fPrice >= highThreshold;
                  const isMid = fPrice > 0 && !isLow && !isHigh;
                  const defaultSide = isHigh ? OrderSide.SELL : OrderSide.BUY;
                  const isHoveredRow = hoveredPeriod === sp;
                  return (
                    <tr
                      key={sp}
                      className={`${isLow ? 'row-charge-hint' : isHigh ? 'row-discharge-hint' : ''} ${isHoveredRow ? 'row-hovered' : ''}`}
                      onMouseEnter={() => setHoveredPeriod(sp)}
                      onMouseLeave={() => setHoveredPeriod(null)}
                    >
                      <td>{String(Math.floor(sp / 2)).padStart(2, '0')}:{sp % 2 === 0 ? '00' : '30'}</td>
                      <td className="muted">£{fPrice.toFixed(1)}</td>
                      <td className="da-hint">
                        {isLow && <span className="hint-charge">Charge</span>}
                        {isHigh && <span className="hint-discharge">Discharge</span>}
                        {isMid && <span className="hint-mid">—</span>}
                        {fPrice === 0 && <span className="hint-mid">N/A</span>}
                      </td>
                      <td>
                        <select
                          value={bid?.side ?? defaultSide}
                          onChange={e => handleBidChange(sp, 'side', e.target.value)}
                          className="input input-sm"
                        >
                          <option value={OrderSide.BUY}>Charge</option>
                          <option value={OrderSide.SELL}>Discharge</option>
                        </select>
                      </td>
                      <td>
                        <input
                          type="number"
                          value={bid?.volume ?? ''}
                          onChange={e => handleBidChange(sp, 'volume', e.target.value)}
                          placeholder="0"
                          min="1" max="50"
                          className="input input-sm"
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          value={bid?.price ?? ''}
                          onChange={e => handleBidChange(sp, 'price', e.target.value)}
                          placeholder={fPrice > 0 ? fPrice.toFixed(0) : ''}
                          step="0.5"
                          className="input input-sm"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
    </div>
  );
}
