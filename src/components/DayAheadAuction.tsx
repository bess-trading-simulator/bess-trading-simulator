import { useMemo, useState } from 'react';
import type { DayAheadBid, DayAheadState, MarketDay, SettlementEntry } from '../engine/types';
import DayAheadToday from './DayAheadToday';
import { OrderSide } from '../engine/types';
import type { BatteryState } from '../engine/battery';
import { hoursUntilGateClosure, getGateClosureTime, formatDeliveryDay, getUtcDayStart, getSettlementPeriod } from '../engine/clock';
import { DA_HOURS, hourlyPrices, bidFills, sanitizeBids } from '../engine/dayAheadAuction';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import HelpIcon from './HelpIcon';
import { CheckCircle } from 'lucide-react';

interface Props {
  dayAhead: DayAheadState;
  nextDay: MarketDay;
  ledger?: SettlementEntry[];
  currentTime: number;
  battery: BatteryState;
  onSubmitBids: (bids: DayAheadBid[]) => void;
  onWithdrawBids?: (hour?: number) => void;
}

type Draft = { buyMw: string; buyPx: string; sellMw: string; sellPx: string };
const EMPTY: Draft = { buyMw: '', buyPx: '', sellMw: '', sellPx: '' };

const hourLabel = (h: number) => `${String(h).padStart(2, '0')}–${String((h + 1) % 24).padStart(2, '0')}`;
const num = (s: string) => (s.trim() === '' ? NaN : Number(s));

function draftFromBids(bids: DayAheadBid[]): Record<number, Draft> {
  const out: Record<number, Draft> = {};
  for (const b of bids) {
    const d = { ...(out[b.hour] ?? EMPTY) };
    if (b.side === OrderSide.BUY) { d.buyMw = String(b.volumeMw); d.buyPx = String(b.price); }
    else { d.sellMw = String(b.volumeMw); d.sellPx = String(b.price); }
    out[b.hour] = d;
  }
  return out;
}

function bidsFromDraft(draft: Record<number, Draft>): DayAheadBid[] {
  const bids: DayAheadBid[] = [];
  for (const [h, d] of Object.entries(draft)) {
    const hour = Number(h);
    const bm = num(d.buyMw), bp = num(d.buyPx), sm = num(d.sellMw), spx = num(d.sellPx);
    if (bm > 0 && Number.isFinite(bp)) bids.push({ hour, side: OrderSide.BUY, volumeMw: bm, price: bp });
    if (sm > 0 && Number.isFinite(spx)) bids.push({ hour, side: OrderSide.SELL, volumeMw: sm, price: spx });
  }
  return bids;
}

function AuctionView({ dayAhead, nextDay, currentTime, battery, onSubmitBids, onWithdrawBids }: Props) {
  const { isAuctionOpen, results, playerSchedule, deliveryDay, bids: submittedBids } = dayAhead;
  const [draft, setDraft] = useState<Record<number, Draft>>(() => draftFromBids(submittedBids));
  const [justSubmitted, setJustSubmitted] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);

  // Re-sync the editor when the auction day changes (new auction after midnight).
  const [syncedDay, setSyncedDay] = useState(deliveryDay);
  if (syncedDay !== deliveryDay) {
    setSyncedDay(deliveryDay);
    setDraft(draftFromBids(submittedBids));
  }

  const P = battery.config.powerRatingMw;
  const capacity = battery.config.capacityMwh;
  const eff = battery.config.efficiencyPct / 100;
  const gateHours = hoursUntilGateClosure(currentTime);
  const gateTimeUk = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })
    .format(new Date(getGateClosureTime(currentTime)));

  const forecast = useMemo(() => hourlyPrices(nextDay.daForecast), [nextDay.daForecast]);
  const clearingH = useMemo(() => hourlyPrices(nextDay.daClearing), [nextDay.daClearing]);
  // Fundamental model components per hour (mean of the two half-hours).
  const model = nextDay.forecastModel;
  const hourlyOf = (arr?: number[]) => (arr ? hourlyPrices(arr) : new Array<number>(DA_HOURS).fill(0));
  const refH = hourlyOf(model?.ref);
  const demH = hourlyOf(model?.demandDelta);
  const windH = hourlyOf(model?.windDelta);
  const solarH = hourlyOf(model?.solarDelta);
  const shockH = hourlyOf(nextDay.truth?.shock);
  const beta = model?.beta ?? 0;
  const gw = (mw: number) => `${mw >= 0 ? '+' : '−'}${Math.abs(mw / 1000).toFixed(1)} GW`;
  const pounds = (v: number) => `${v >= 0 ? '+' : '−'}£${Math.abs(v).toFixed(2)}`;
  const dRl = (h: number) => demH[h] - windH[h] - solarH[h];
  const driverText = (h: number) =>
    `Today's DA £${refH[h].toFixed(2)} · demand ${gw(demH[h])}, wind ${gw(windH[h])}, solar ${gw(solarH[h])} `
    + `→ residual load ${gw(dRl(h))} × £${beta.toFixed(1)}/GW = ${pounds(beta * dRl(h) / 1000)} → forecast £${forecast[h].toFixed(2)}`;
  const errorText = (h: number) => {
    const err = clearingH[h] - forecast[h];
    if (nextDay.truth) {
      const slope = (nextDay.truth.beta - beta) * dRl(h) / 1000;
      return `Model error ${pounds(err)}: merit order was £${nextDay.truth.beta.toFixed(1)}/GW vs your £${beta.toFixed(1)}/GW (${pounds(slope)}), `
        + `market shock — gas/carbon, outages, interconnectors, other bids (${pounds(shockH[h])}).`;
    }
    return `Model error ${pounds(err)}: not explained by residual load — gas/carbon, plant outages, interconnector flows and other participants' bids.`;
  };
  const resultByHour = useMemo(() => new Map(results.map(r => [r.hour, r])), [results]);
  const sorted = [...forecast].sort((a, b) => a - b);
  const lowT = sorted[Math.floor(DA_HOURS * 0.25)] ?? 0;
  const highT = sorted[Math.floor(DA_HOURS * 0.75)] ?? 0;

  const draftBids = bidsFromDraft(draft);
  // Compare as order sets (independent of order/formatting) after the same
  // validation the engine applies.
  const orderKey = (bids: DayAheadBid[]) => sanitizeBids(bids, battery.config.powerRatingMw)
    .map(b => `${b.hour}|${b.side}|${b.volumeMw}|${b.price.toFixed(2)}`).sort().join(';');
  const isDirty = orderKey(draftBids) !== orderKey(submittedBids);

  // Starting SoC of the delivery day: current SoC played forward through today's
  // remaining (undelivered) net positions.
  const todayDay = getUtcDayStart(currentTime);
  const currentSp = getSettlementPeriod(currentTime) - 1;
  let startSoc = battery.currentSocMwh;
  for (let sp = currentSp; sp < 48; sp++) {
    const net = playerSchedule
      .filter(p => !p.delivered && p.deliveryDay === todayDay && p.period === sp)
      .reduce((a, p) => a + (p.action === 'discharge' ? p.mw : -p.mw), 0);
    startSoc = net > 0 ? startSoc - Math.min(net, P) * 0.5 : startSoc + Math.min(-net, P) * 0.5 * eff;
    startSoc = Math.max(0, Math.min(capacity, startSoc));
  }

  // Net MW per hour IF your orders fill: after clearing the real positions;
  // before clearing every order is assumed filled — the battery must be able to
  // deliver whatever clears, so feasibility is judged on that.
  const hourNet: number[] = Array.from({ length: DA_HOURS }, (_, h) => {
    if (!isAuctionOpen) {
      return playerSchedule
        .filter(p => p.deliveryDay === deliveryDay && p.market === 'da' && p.period === 2 * h)
        .reduce((a, p) => a + (p.action === 'discharge' ? p.mw : -p.mw), 0);
    }
    return draftBids
      .filter(b => b.hour === h)
      .reduce((a, b) => a + (b.side === OrderSide.SELL ? b.volumeMw : -b.volumeMw), 0);
  });

  // Expected cash: only orders that would fill at the forecast price.
  const expectedNet: number[] = Array.from({ length: DA_HOURS }, (_, h) => (
    isAuctionOpen
      ? draftBids.filter(b => b.hour === h && bidFills(b, forecast[h]))
        .reduce((a, b) => a + (b.side === OrderSide.SELL ? b.volumeMw : -b.volumeMw), 0)
      : hourNet[h]
  ));

  // SoC path per hour (two SPs), flagging infeasible energy (→ imbalance).
  const socPct: number[] = [];
  let soc = startSoc;
  let shortfallMwh = 0;
  for (let h = 0; h < DA_HOURS; h++) {
    const net = hourNet[h];
    const delta = net > 0 ? -net * 1 : -net * 1 * eff; // 1 h = two SPs
    const raw = soc + delta;
    if (raw < 0) shortfallMwh += -raw;
    if (raw > capacity) shortfallMwh += (raw - capacity) / eff;
    soc = Math.max(0, Math.min(capacity, raw));
    socPct.push((soc / capacity) * 100);
  }

  const priceFor = (h: number) => (isAuctionOpen ? forecast[h] : resultByHour.get(h)?.clearingPrice ?? forecast[h]);
  const chargeMwh = hourNet.reduce((a, n) => a + (n < 0 ? -n : 0), 0);
  const dischargeMwh = hourNet.reduce((a, n) => a + (n > 0 ? n : 0), 0);
  const netCash = expectedNet.reduce((a, n, h) => a + n * priceFor(h), 0);

  const chartData = forecast.map((f, h) => ({
    hour: `${String(h).padStart(2, '0')}:00`,
    forecast: f,
    clearing: isAuctionOpen ? null : (resultByHour.get(h)?.clearingPrice ?? clearingH[h]),
    todayDa: model ? refH[h] : null,
    socPct: socPct[h],
    isLow: f <= lowT,
    isHigh: f >= highT,
  }));

  const setField = (h: number, field: keyof Draft, value: string) => {
    setJustSubmitted(false);
    setDraft(prev => {
      const d = { ...(prev[h] ?? EMPTY), [field]: value };
      // Volume entered without a limit → default limit at the forecast (a coin flip!).
      if (field === 'buyMw' && value && !d.buyPx) d.buyPx = forecast[h].toFixed(2);
      if (field === 'sellMw' && value && !d.sellPx) d.sellPx = forecast[h].toFixed(2);
      return { ...prev, [h]: d };
    });
  };

  const submit = () => {
    if (!isAuctionOpen) return;
    const clean = sanitizeBids(draftBids, P);
    onWithdrawBids?.();
    onSubmitBids(clean);
    setDraft(draftFromBids(clean)); // editor shows exactly what was submitted
    setJustSubmitted(true);
  };

  // Preset: charge the cheapest k-hour block, discharge the dearest later block.
  // Limits leave a margin vs forecast (pay up to +£margin / sell down to −£margin)
  // — wider margin = more likely to fill, but you accept a worse clearing price.
  const presetArbitrage = (margin: number) => {
    const k = Math.max(1, Math.round(capacity / P));
    let best = { c: 0, d: k, spread: -Infinity };
    for (let c = 0; c + k <= DA_HOURS; c++) {
      for (let d = c + k; d + k <= DA_HOURS; d++) {
        const avg = (s: number) => forecast.slice(s, s + k).reduce((a, b) => a + b, 0) / k;
        const spread = avg(d) * eff - avg(c);
        if (spread > best.spread) best = { c, d, spread };
      }
    }
    // Size to the energy actually available: fill from the projected start SoC
    // up to full, then sell everything stored.
    const buyMwh = Math.max(0, (capacity - startSoc) / eff);
    const buyMw = Math.min(P, Math.round(buyMwh / k));
    const sellMw = Math.min(P, Math.floor((startSoc + buyMw * k * eff) / k));
    const next: Record<number, Draft> = {};
    for (let i = 0; i < k; i++) {
      if (buyMw > 0) next[best.c + i] = { ...EMPTY, buyMw: String(buyMw), buyPx: (forecast[best.c + i] + margin).toFixed(2) };
      if (sellMw > 0) next[best.d + i] = { ...EMPTY, sellMw: String(sellMw), sellPx: (forecast[best.d + i] - margin).toFixed(2) };
    }
    setJustSubmitted(false);
    setDraft(next);
  };

  const sourceLabel = nextDay.source === 'real' ? `Real data · ${nextDay.date ?? ''}` : 'Simulated';

  return (
    <div className="panel day-ahead-full" id="dayahead-tab">
      <div className="da-sticky-top">
        <div className="panel-header da-panel-header">
          <h3>Day-Ahead Auction · hourly</h3>
          <HelpIcon text="Blind, uniform-price auction for the next delivery day (EPEX GB 09:20 UK style, HOURLY products). Per hour you can bid to BUY (charge) up to a max price and/or SELL (discharge) down to a min price — a 2-step bid curve. At gate closure the auction clears: an order fills only if the clearing price meets its limit, and fills settle at the CLEARING price (pay-as-cleared), not your limit. You don't see the clearing price before — only the desk forecast: today's price for the same hour, adjusted by how much residual load (demand − wind − solar) changes tomorrow × the merit-order slope fitted on today. Hover a row for the breakdown; after clearing, hover the result to see why the forecast was off. On real Elexon days the actual price is the Market Index Price (MID) as DA proxy." />
          <span className="da-delivery-badge">
            Delivery <strong>{formatDeliveryDay(deliveryDay)}</strong> · {sourceLabel}
          </span>
        </div>

        <div className="kpi-strip">
          <div className="kpi-card">
            <div className="kpi-label">{isAuctionOpen ? 'Expected cash' : 'Cleared cash'}</div>
            <div className="kpi-value-row">
              <span className={`kpi-value ${netCash >= 0 ? 'positive' : 'negative'}`}>
                {netCash >= 0 ? '+' : '−'}£{Math.abs(netCash).toFixed(0)}
              </span>
            </div>
            <div className="kpi-sub">{isAuctionOpen ? 'orders that fill at forecast' : 'at clearing prices'}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Charge</div>
            <div className="kpi-value-row">
              <span className="kpi-value" style={{ color: 'var(--charge)' }}>{chargeMwh.toFixed(0)}<span className="kpi-unit"> MWh</span></span>
            </div>
            <div className="kpi-sub">{isAuctionOpen ? 'if all orders fill' : 'won in auction'}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Discharge</div>
            <div className="kpi-value-row">
              <span className="kpi-value" style={{ color: 'var(--discharge)' }}>{dischargeMwh.toFixed(0)}<span className="kpi-unit"> MWh</span></span>
            </div>
            <div className="kpi-sub">{isAuctionOpen ? 'if all orders fill' : 'won in auction'}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Energy feasibility</div>
            <div className="kpi-value-row">
              <span className={`kpi-value ${shortfallMwh > 0.5 ? 'negative' : ''}`}>
                {shortfallMwh > 0.5 ? `${shortfallMwh.toFixed(0)}` : 'OK'}
                {shortfallMwh > 0.5 && <span className="kpi-unit"> MWh</span>}
              </span>
            </div>
            <div className="kpi-sub">
              {shortfallMwh > 0.5 ? 'undeliverable → settles as imbalance at SIP' : `start SoC ${((startSoc / capacity) * 100).toFixed(0)}%`}
            </div>
          </div>
        </div>

        <div className="da-sticky-content">
          <div className="da-forecast-chart compact">
            <div className="da-forecast-head">
              <h4>
                Hourly price · {isAuctionOpen ? 'desk forecast' : 'forecast vs clearing'}
                <HelpIcon text="Bars = desk forecast per hourly product (blue = cheapest quarter, orange = dearest quarter). Dashed grey = today's cleared DA price, the forecast's starting point. After gate closure the line shows the actual clearing price — compare to see your forecast error. Lavender = projected SoC at the end of each hour, assuming all your orders fill." />
              </h4>
              <div className="da-chart-legend inline">
                <span className="legend-item"><span className="legend-bar da-bar" /> Forecast</span>
                {model && <span className="legend-item"><span className="legend-line" style={{ borderTop: '2px dashed #8b95a8', height: 0 }} /> Today's DA</span>}
                {!isAuctionOpen && <span className="legend-item"><span className="legend-line id-line" /> Clearing</span>}
                <span className="legend-item"><span className="legend-line soc-line" /> SoC%</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -8 }} barCategoryGap="22%">
                <CartesianGrid strokeDasharray="5 5" stroke="#8b95a8" strokeOpacity={0.5} vertical={false} />
                <XAxis dataKey="hour" stroke="#6b7280" fontSize={9} interval={3} tickLine={false} axisLine={false} />
                <YAxis yAxisId="price" stroke="#6b7280" fontSize={10} width={40} tickLine={false} axisLine={false} />
                <YAxis yAxisId="soc" orientation="right" stroke="#c7b4f8" fontSize={10} width={32} domain={[0, 100]} ticks={[0, 50, 100]} tickFormatter={(v: number) => `${v}%`} tickLine={false} axisLine={false} />
                <Tooltip
                  cursor={{ stroke: '#9272f5', strokeWidth: 1, strokeDasharray: '2 3' }}
                  contentStyle={{ background: '#0f1420', border: '1px solid #1f2535', borderRadius: '6px', color: '#e5e7eb', fontSize: 11, padding: '6px 8px' }}
                  formatter={(value: unknown, name: unknown) => {
                    if (value == null) return ['—', String(name)];
                    return String(name) === 'Projected SoC' ? [`${Number(value).toFixed(0)}%`, String(name)] : [`£${Number(value).toFixed(2)}`, String(name)];
                  }}
                />
                <Bar yAxisId="price" dataKey="forecast" name="Forecast" radius={[2, 2, 0, 0]}>
                  {chartData.map((e, i) => (
                    <Cell key={i} fill={e.isLow ? '#007be2' : e.isHigh ? '#ff874b' : '#9ca3af'} fillOpacity={hovered === i ? 1 : 0.6} />
                  ))}
                </Bar>
                {model && <Line yAxisId="price" type="monotone" dataKey="todayDa" stroke="#8b95a8" strokeWidth={1.5} strokeDasharray="4 3" dot={false} name="Today's DA" isAnimationActive={false} />}
                {!isAuctionOpen && <Line yAxisId="price" type="monotone" dataKey="clearing" stroke="#76b8ef" strokeWidth={2} dot={{ r: 2 }} name="Clearing" isAnimationActive={false} />}
                <Line yAxisId="soc" type="stepAfter" dataKey="socPct" stroke="#c7b4f8" strokeWidth={2} dot={false} name="Projected SoC" isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="da-quick-panel">
            <div className={`da-status-inline ${isAuctionOpen ? 'open' : 'closed'}`}>
              <div className="da-status-row">
                <span className={`da-status-dot ${isAuctionOpen ? 'open' : 'closed'}`} />
                <span className="da-status-label">{isAuctionOpen ? 'Auction OPEN' : 'Auction CLEARED'}</span>
              </div>
              <div className="da-status-sub">
                {isAuctionOpen ? `Gate closes ${gateTimeUk} UK · ${gateHours}h left` : 'Positions are locked · trade adjustments intraday'}
              </div>
              {model && (
                <div className="da-status-sub">
                  Desk model: today's price + £{beta.toFixed(1)}/GW × Δ residual load
                </div>
              )}
              <div className="da-status-sub">
                {submittedBids.length} order{submittedBids.length === 1 ? '' : 's'} submitted
                {justSubmitted && !isDirty && <span className="da-submitted"> <CheckCircle size={12} /> sent</span>}
              </div>
            </div>
            {isAuctionOpen && (
              <>
                <h4>
                  Quick fill
                  <HelpIcon text="Arbitrage picks the cheapest block of hours to charge and a later, dearest block to discharge (by forecast), sized to your projected start SoC. 'Tight' limits = at forecast ±£2 (cheap but often not filled); 'Safe' = ±£25 (fills more often, but you accept a worse clearing price)." />
                </h4>
                <div className="da-quick-fill vertical">
                  <button className="btn btn-preset" onClick={() => presetArbitrage(2)}>Arbitrage · tight</button>
                  <button className="btn btn-preset" onClick={() => presetArbitrage(25)}>Arbitrage · safe</button>
                  <button className="btn btn-preset" onClick={() => { setDraft({}); setJustSubmitted(false); }}>Clear</button>
                </div>
                <button
                  className={`btn btn-submit da-submit-inline ${isDirty ? 'btn-buy' : ''}`}
                  onClick={submit}
                  disabled={!isDirty}
                >
                  {isDirty ? `Submit ${draftBids.length} order${draftBids.length === 1 ? '' : 's'}` : submittedBids.length ? 'Orders up to date' : 'No orders yet'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="da-bid-section">
        {!isAuctionOpen && (
          <div className="da-gate-warning">
            Gate closed — the auction has cleared for {formatDeliveryDay(deliveryDay)}. Adjust positions in the Intraday market (tomorrow's products are now open there). The next auction opens after midnight.
          </div>
        )}
        <div className="da-bid-scroll">
          <table className="data-table bid-table">
            <thead>
              <tr>
                <th>Hour</th>
                <th title="Today's cleared DA price for the same hour — the forecast's reference">Today £</th>
                <th title="Change in residual load (demand − wind − solar) vs today, and its price effect">Δ res. load</th>
                <th>Forecast</th>
                <th>Buy MW</th>
                <th>Max £</th>
                <th>Sell MW</th>
                <th>Min £</th>
                <th>{isAuctionOpen ? 'Fill at forecast?' : 'Clearing · result'}</th>
              </tr>
            </thead>
            <tbody>
              {forecast.map((f, h) => {
                const d = draft[h] ?? EMPTY;
                const r = resultByHour.get(h);
                const rowBids = draftBids.filter(b => b.hour === h);
                const expected = rowBids.map(b => `${b.side === OrderSide.BUY ? 'Buy' : 'Sell'} ${bidFills(b, f) ? '✓' : '✗'}`).join(' · ');
                return (
                  <tr
                    key={h}
                    className={`${f <= lowT ? 'row-charge-hint' : f >= highT ? 'row-discharge-hint' : ''} ${hovered === h ? 'row-hovered' : ''}`}
                    onMouseEnter={() => setHovered(h)}
                    onMouseLeave={() => setHovered(null)}
                  >
                    <td>{hourLabel(h)}</td>
                    <td className="muted">{model ? `£${refH[h].toFixed(2)}` : '—'}</td>
                    <td className="muted" title={model ? driverText(h) : 'No driver forecasts — persistence forecast'} style={{ cursor: 'help' }}>
                      {model ? <>{gw(dRl(h))} <small>({pounds(beta * dRl(h) / 1000)})</small></> : '—'}
                    </td>
                    <td title={model ? driverText(h) : undefined}>£{f.toFixed(2)}</td>
                    <td><input className="input" type="number" min={0} max={P} step={1} value={d.buyMw} disabled={!isAuctionOpen} onChange={e => setField(h, 'buyMw', e.target.value)} placeholder="" /></td>
                    <td><input className="input" type="number" step={0.5} value={d.buyPx} disabled={!isAuctionOpen} onChange={e => setField(h, 'buyPx', e.target.value)} placeholder="—" /></td>
                    <td><input className="input" type="number" min={0} max={P} step={1} value={d.sellMw} disabled={!isAuctionOpen} onChange={e => setField(h, 'sellMw', e.target.value)} placeholder="" /></td>
                    <td><input className="input" type="number" step={0.5} value={d.sellPx} disabled={!isAuctionOpen} onChange={e => setField(h, 'sellPx', e.target.value)} placeholder="—" /></td>
                    <td className="muted">
                      {isAuctionOpen
                        ? (expected || '—')
                        : r
                          ? (
                            <span title={errorText(h)} style={{ cursor: 'help' }}>
                              £{r.clearingPrice.toFixed(2)} <small>({pounds(r.clearingPrice - r.forecastPrice)})</small> ·{' '}
                              {r.buyMw > 0 && <span className={r.buyFilled ? 'positive' : 'negative'}>Buy {r.buyFilled ? 'filled' : 'not filled'} </span>}
                              {r.sellMw > 0 && <span className={r.sellFilled ? 'positive' : 'negative'}>Sell {r.sellFilled ? 'filled' : 'not filled'}</span>}
                            </span>
                          )
                          : <span title={errorText(h)} style={{ cursor: 'help' }}>£{clearingH[h].toFixed(2)} <small>({pounds(clearingH[h] - f)})</small></span>}
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

/**
 * Day-ahead has two faces: the auction you bid in today (for TOMORROW), and
 * today's delivery of the schedule you won in YESTERDAY's auction.
 */
export default function DayAheadAuction(props: Props) {
  const [view, setView] = useState<'auction' | 'today'>('auction');
  const today = getUtcDayStart(props.currentTime);
  return (
    <div className="da-views">
      <div className="da-view-toggle">
        <button className={`hdr-tab ${view === 'auction' ? 'active' : ''}`} onClick={() => setView('auction')}>
          Auction · bid for {formatDeliveryDay(props.dayAhead.deliveryDay)}
        </button>
        <button className={`hdr-tab ${view === 'today' ? 'active' : ''}`} onClick={() => setView('today')}>
          Today · delivery {formatDeliveryDay(today)}
        </button>
      </div>
      {view === 'auction'
        ? <AuctionView {...props} />
        : <DayAheadToday dayAhead={props.dayAhead} ledger={props.ledger ?? []} battery={props.battery} currentTime={props.currentTime} />}
    </div>
  );
}
