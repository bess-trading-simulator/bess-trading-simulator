import { useMemo, useState } from 'react';
import type { DayAheadBid, DayAheadState, MarketDay, SettlementEntry, DaBlockOrder, HalfHourBid } from '../engine/types';
import DaBlockOrders from './DaBlockOrders';
import DayAheadHalfHour from './DayAheadHalfHour';
import DayAheadToday from './DayAheadToday';
import { OrderSide } from '../engine/types';
import type { BatteryState } from '../engine/battery';
import { hoursUntilGateClosure, getGateClosureTime, formatDeliveryDay, getUtcDayStart, getSettlementPeriod } from '../engine/clock';
import { DA_HOURS, hourlyPrices, bidFills, sanitizeBids } from '../engine/dayAheadAuction';
import { RULES } from '../engine/marketDay';
import type { DeskSignals } from '../engine/types';
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
  onSubmitBlock?: (block: Omit<DaBlockOrder, 'id'>) => void;
  onCancelBlock?: (id: string) => void;
  onSubmitHalfHourBids?: (bids: HalfHourBid[]) => void;
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

function AuctionView({ dayAhead, nextDay, currentTime, battery, onSubmitBids, onWithdrawBids, onSubmitBlock, onCancelBlock }: Props) {
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
  // Today's cleared DA price per hour — context for tomorrow's forecast.
  const todayH = useMemo(() => hourlyPrices(dayAhead.forecastPrices), [dayAhead.forecastPrices]);
  // Market signals since the desk model ran, per hour.
  const sig = nextDay.signals;
  const errs = nextDay.forecastErrors;
  const hourlyOf = (arr?: number[]) => (arr ? hourlyPrices(arr) : new Array<number>(DA_HOURS).fill(0));
  const windRevH = hourlyOf(sig?.windRevisionMw);
  const pounds = (v: number) => `${v >= 0 ? '+' : '−'}£${Math.abs(v).toFixed(2)}`;
  const eventsIn = (h: number) => (sig?.events ?? []).filter(e => e.startSp <= 2 * h + 1 && e.endSp >= 2 * h);
  type Chip = { label: string; dir: 'up' | 'down'; title: string };
  const chipsFor = (h: number): Chip[] => {
    if (!sig) return [];
    const out: Chip[] = [];
    if (Math.abs(sig.gasPct) >= 1) out.push({ label: 'Gas', dir: sig.gasPct > 0 ? 'up' : 'down', title: `Gas ${sig.gasPct > 0 ? '+' : ''}${sig.gasPct.toFixed(1)}% overnight` });
    const wr = windRevH[h];
    if (Math.abs(wr) >= 500) out.push({ label: 'Wind', dir: wr > 0 ? 'down' : 'up', title: `Wind ${wr > 0 ? '+' : '−'}${Math.abs(wr / 1000).toFixed(1)} GW vs model` });
    const peak = h >= 16 && h <= 19;
    if (Math.abs(sig.tempAnomalyC) >= 0.8) out.push({ label: sig.tempAnomalyC < 0 ? 'Cold' : 'Mild', dir: sig.tempAnomalyC < 0 ? 'up' : 'down', title: `Temperature ${sig.tempAnomalyC > 0 ? '+' : ''}${sig.tempAnomalyC.toFixed(1)}°C vs normal${peak ? ' (peak hour: stronger)' : ''}` });
    for (const e of eventsIn(h)) {
      out.push({ label: e.kind === 'imports' ? 'Imports' : e.kind === 'outage' ? 'Outage' : 'IC', dir: e.kind === 'imports' ? 'down' : 'up', title: `${e.headline}${e.confirmed ? '' : ' — unconfirmed'}` });
    }
    return out;
  };
  const errorText = (h: number) => {
    const err = clearingH[h] - forecast[h];
    if (!errs) return `Forecast error ${pounds(err)}.`;
    const part = (arr: number[]) => (arr[2 * h] + arr[2 * h + 1]) / 2;
    return `Forecast error ${pounds(err)} = gas ${pounds(part(errs.gas))} · wind ${pounds(part(errs.wind))} · `
      + `temperature ${pounds(part(errs.temperature))} · events ${pounds(part(errs.event))} · unexplained ${pounds(part(errs.noise))}`;
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

  // Hourly blocks (before clearing): assumed filled for feasibility, filled at
  // forecast if the block's average forecast meets its limit.
  const hourlyBlocks = (dayAhead.blocks ?? []).filter(b => b.auction === 'hourly');
  if (isAuctionOpen) {
    for (const b of hourlyBlocks) {
      for (let sp = b.startSp; sp <= b.endSp; sp += 2) hourNet[Math.floor(sp / 2)] += b.side === OrderSide.SELL ? b.volumeMw : -b.volumeMw;
    }
  }
  const blockFillsAtForecast = (b: DaBlockOrder) => {
    let sum = 0;
    for (let sp = b.startSp; sp <= b.endSp; sp++) sum += nextDay.daForecast[sp] ?? 0;
    const avg = sum / (b.endSp - b.startSp + 1);
    return b.side === OrderSide.BUY ? avg <= b.price : avg >= b.price;
  };

  // Expected cash: only orders that would fill at the forecast price.
  const expectedNet: number[] = Array.from({ length: DA_HOURS }, (_, h) => (
    isAuctionOpen
      ? draftBids.filter(b => b.hour === h && bidFills(b, forecast[h]))
        .reduce((a, b) => a + (b.side === OrderSide.SELL ? b.volumeMw : -b.volumeMw), 0)
        + hourlyBlocks.filter(b => b.startSp <= 2 * h && b.endSp >= 2 * h + 1 && blockFillsAtForecast(b))
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
    todayDa: todayH[h] || null,
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
          <HelpIcon text="Blind, uniform-price auction for the next delivery day (EPEX GB 09:20 UK style, HOURLY products). Per hour you can bid to BUY (charge) up to a max price and/or SELL (discharge) down to a min price — a 2-step bid curve. At gate closure the auction clears: an order fills only if the clearing price meets its limit, and fills settle at the CLEARING price (pay-as-cleared), not your limit. You don't see the clearing price before — only the desk forecast, made earlier by your price model. Since then the market moved: read the SIGNALS (gas, wind revision, temperature, news) to judge which way the forecast is likely wrong in each hour, and set your limits accordingly. After clearing, hover the result to see the forecast error split by cause. On real Elexon days the actual price is the Market Index Price (MID) as DA proxy." />
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
                <span className="legend-item"><span className="legend-line" style={{ borderTop: '2px dashed #8b95a8', height: 0 }} /> Today's DA</span>
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
                {<Line yAxisId="price" type="monotone" dataKey="todayDa" stroke="#8b95a8" strokeWidth={1.5} strokeDasharray="4 3" dot={false} name="Today's DA" isAnimationActive={false} />}
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
        {sig && <DeskSignalsPanel signals={sig} avgPrice={forecast.reduce((x, y) => x + Math.abs(y), 0) / DA_HOURS} />}
        <DaBlockOrders
          auction="hourly"
          blocks={dayAhead.blocks ?? []}
          results={dayAhead.blockResults ?? []}
          isOpen={isAuctionOpen}
          forecastBySp={Array.from({ length: 48 }, (_, sp) => forecast[Math.floor(sp / 2)])}
          powerMw={P}
          onSubmit={onSubmitBlock}
          onCancel={onCancelBlock}
        />
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
                <th title="Today's cleared DA price for the same hour (context)">Today £</th>
                <th>Forecast</th>
                <th title="Signals that changed since the desk model ran and which way they push this hour's price. Hover a chip for details.">Signals</th>
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
                    <td className="muted">{todayH[h] ? `£${todayH[h].toFixed(2)}` : '—'}</td>
                    <td>£{f.toFixed(2)}</td>
                    <td className="da-chips">
                      {chipsFor(h).map((c, i) => (
                        <span key={i} className={`da-chip ${c.dir}`} title={c.title}>{c.label} {c.dir === 'up' ? '↑' : '↓'}</span>
                      ))}
                    </td>
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

const hhmm = (sp: number) => `${String(Math.floor(sp / 2)).padStart(2, '0')}:${sp % 2 === 0 ? '00' : '30'}`;

/** What changed since the desk's price model ran — the trader's edge on the forecast. */
function DeskSignalsPanel({ signals, avgPrice }: { signals: DeskSignals; avgPrice: number }) {
  const { gasPct, windRevisionMw, tempAnomalyC, events } = signals;
  // Strongest wind revision window (contiguous SPs with the same sign and |rev| > 0.5 GW).
  let best = { from: 0, to: -1, peak: 0 };
  for (let i = 0; i < 48; i++) {
    if (Math.abs(windRevisionMw[i]) < 500) continue;
    let j = i, peak = 0;
    while (j < 48 && Math.abs(windRevisionMw[j]) >= 500 && Math.sign(windRevisionMw[j]) === Math.sign(windRevisionMw[i])) {
      if (Math.abs(windRevisionMw[j]) > Math.abs(peak)) peak = windRevisionMw[j];
      j++;
    }
    if (Math.abs(peak) > Math.abs(best.peak)) best = { from: i, to: j - 1, peak };
    i = j;
  }
  const gasRule = 0.01 * RULES.gasShare(30) * avgPrice;
  const slope = RULES.slopeAt(avgPrice);
  const peakSlope = RULES.slopeAt(avgPrice * 1.4);
  const tempRule = RULES.demandPerDegree * slope;
  const arrow = (up: boolean) => <span className={`da-chip ${up ? 'up' : 'down'}`}>{up ? 'prices ↑' : 'prices ↓'}</span>;
  return (
    <div className="da-signals">
      <div className="da-signals-head">
        Market signals since your desk model ran
        <HelpIcon text="Your forecast was produced earlier this morning. These are the changes since then. Each one pushes the actual auction price away from your forecast — use them to decide where to bid more aggressively or cautiously. Signals are measured with some noise, news can be wrong, and part of the error is unexplainable. (Signals are simulated, also on real-data days.)" />
      </div>
      <div className="da-signal-grid">
        <div className="da-signal">
          <div className="da-signal-label">Gas (NBP day-ahead)</div>
          <div className="da-signal-value">{gasPct > 0 ? '+' : ''}{gasPct.toFixed(1)}% <small>overnight</small> {Math.abs(gasPct) >= 1 && arrow(gasPct > 0)}</div>
          <div className="da-signal-rule">+1% gas ≈ +£{gasRule.toFixed(1)}/MWh when gas sets the price (day & peak)</div>
        </div>
        <div className="da-signal">
          <div className="da-signal-label">Wind · latest weather run vs model</div>
          <div className="da-signal-value">
            {best.to >= best.from
              ? <>{best.peak > 0 ? '+' : '−'}{Math.abs(best.peak / 1000).toFixed(1)} GW <small>{hhmm(best.from)}–{hhmm(best.to + 1)}</small> {arrow(best.peak < 0)}</>
              : <>no material change</>}
          </div>
          <div className="da-signal-rule">+1 GW wind ≈ −£{slope.toFixed(1)}/MWh at today's price level, ≈ −£{peakSlope.toFixed(1)} at the peak (merit order steeper when prices are high) · per hour in the table</div>
        </div>
        <div className="da-signal">
          <div className="da-signal-label">Temperature vs normal</div>
          <div className="da-signal-value">{tempAnomalyC > 0 ? '+' : ''}{tempAnomalyC.toFixed(1)}°C {Math.abs(tempAnomalyC) >= 0.8 && arrow(tempAnomalyC < 0)}</div>
          <div className="da-signal-rule">1°C colder ≈ +{RULES.demandPerDegree} GW demand ≈ +£{tempRule.toFixed(0)}/MWh, more at the evening peak</div>
        </div>
        <div className="da-signal">
          <div className="da-signal-label">News · REMIT / interconnectors</div>
          {events.length === 0 ? <div className="da-signal-value"><small>nothing relevant</small></div> : (
            <ul className="da-news">
              {events.map((e, i) => (
                <li key={i}>
                  <span className={`da-news-tag ${e.confirmed ? 'confirmed' : ''}`}>{e.confirmed ? 'confirmed' : 'unconfirmed'}</span> {e.headline}
                </li>
              ))}
            </ul>
          )}
          <div className="da-signal-rule">Lost imports / outages lift prices in that window; extra imports lower them</div>
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
  const [view, setView] = useState<'auction' | 'half' | 'today'>('auction');
  const today = getUtcDayStart(props.currentTime);
  const d = props.dayAhead;
  return (
    <div className="da-views">
      <div className="da-view-toggle">
        <button className={`hdr-tab ${view === 'auction' ? 'active' : ''}`} onClick={() => setView('auction')}>
          Hourly auction · 09:20 · {formatDeliveryDay(d.deliveryDay)}
        </button>
        <button className={`hdr-tab ${view === 'half' ? 'active' : ''}`} onClick={() => setView('half')}>
          30-min auction · 15:30 {d.hhAuctionOpen ? '· open' : ''}
        </button>
        <button className={`hdr-tab ${view === 'today' ? 'active' : ''}`} onClick={() => setView('today')}>
          Today · delivery {formatDeliveryDay(today)}
        </button>
      </div>
      {view === 'auction' && <AuctionView {...props} />}
      {view === 'half' && (
        <DayAheadHalfHour
          dayAhead={d}
          nextDay={props.nextDay}
          battery={props.battery}
          currentTime={props.currentTime}
          onSubmitHalfHourBids={props.onSubmitHalfHourBids}
          onSubmitBlock={props.onSubmitBlock}
          onCancelBlock={props.onCancelBlock}
        />
      )}
      {view === 'today' && <DayAheadToday dayAhead={d} ledger={props.ledger ?? []} battery={props.battery} currentTime={props.currentTime} />}
    </div>
  );
}
