import { useState } from 'react';
import type { DaBlockOrder, DayAheadState, HalfHourBid, MarketDay } from '../engine/types';
import { OrderSide } from '../engine/types';
import type { BatteryState } from '../engine/battery';
import { formatDeliveryDay, getUtcDayStart, getSettlementPeriod } from '../engine/clock';
import { hourlyPrices, bidFills, sanitizeHalfHourBids, powerViolations } from '../engine/dayAheadAuction';
import { signedMw } from '../engine/settlement';
import DaBlockOrders from './DaBlockOrders';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import HelpIcon from './HelpIcon';
import { CheckCircle } from 'lucide-react';

interface Props {
  dayAhead: DayAheadState;
  nextDay: MarketDay;
  battery: BatteryState;
  currentTime: number;
  onSubmitHalfHourBids?: (bids: HalfHourBid[]) => void;
  onSetBlocks?: (auction: 'hourly' | 'half', blocks: DaBlockOrder[]) => void;
}

type Draft = { buyMw: string; buyPx: string; sellMw: string; sellPx: string };
const EMPTY: Draft = { buyMw: '', buyPx: '', sellMw: '', sellPx: '' };
const spLabel = (sp: number) => `${String(Math.floor(sp / 2)).padStart(2, '0')}:${sp % 2 === 0 ? '00' : '30'}`;
const num = (s: string) => (s.trim() === '' ? NaN : Number(s));

function toDraft(bids: HalfHourBid[]): Record<number, Draft> {
  const out: Record<number, Draft> = {};
  for (const b of bids) {
    const d = { ...(out[b.sp] ?? EMPTY) };
    if (b.side === OrderSide.BUY) { d.buyMw = String(b.volumeMw); d.buyPx = String(b.price); }
    else { d.sellMw = String(b.volumeMw); d.sellPx = String(b.price); }
    out[b.sp] = d;
  }
  return out;
}

function fromDraft(draft: Record<number, Draft>): HalfHourBid[] {
  const out: HalfHourBid[] = [];
  for (const [k, d] of Object.entries(draft)) {
    const sp = Number(k);
    if (num(d.buyMw) > 0 && Number.isFinite(num(d.buyPx))) out.push({ sp, side: OrderSide.BUY, volumeMw: num(d.buyMw), price: num(d.buyPx) });
    if (num(d.sellMw) > 0 && Number.isFinite(num(d.sellPx))) out.push({ sp, side: OrderSide.SELL, volumeMw: num(d.sellMw), price: num(d.sellPx) });
  }
  return out;
}

/**
 * EPEX GB 30-min day-ahead auction (gate 15:30 UK, results ~15:45): after the
 * hourly auction you know the hourly prices and your hourly position; here you
 * re-shape it per half-hour (e.g. sell more in the dearer half of an hour, buy
 * back in the cheaper half).
 */
export default function DayAheadHalfHour({ dayAhead, nextDay, battery, currentTime, onSubmitHalfHourBids, onSetBlocks }: Props) {
  const isOpen = Boolean(dayAhead.hhAuctionOpen);
  const cleared = !dayAhead.isAuctionOpen && !isOpen;
  const pending = dayAhead.isAuctionOpen;
  const submitted = dayAhead.hhBids ?? [];
  const [draft, setDraft] = useState<Record<number, Draft>>(() => toDraft(submitted));
  const submittedBlocks = (dayAhead.blocks ?? []).filter(b => b.auction === 'half');
  const [draftBlocks, setDraftBlocks] = useState<DaBlockOrder[]>(() => submittedBlocks);
  const [sent, setSent] = useState(false);
  const [syncedDay, setSyncedDay] = useState(dayAhead.deliveryDay);
  // After Submit, mirror exactly what the engine accepted (it may trim orders).
  const [awaitingSync, setAwaitingSync] = useState(false);
  if (awaitingSync) { setAwaitingSync(false); setDraft(toDraft(submitted)); setDraftBlocks(submittedBlocks); }
  if (syncedDay !== dayAhead.deliveryDay) { setSyncedDay(dayAhead.deliveryDay); setDraft(toDraft(submitted)); setDraftBlocks(submittedBlocks); }

  const P = battery.config.powerRatingMw;
  const cap = battery.config.capacityMwh;
  const eff = battery.config.efficiencyPct / 100;
  const day = dayAhead.deliveryDay;
  const hourly = hourlyPrices(nextDay.daClearing);
  const fc = nextDay.daForecastHH ?? [];
  const results = new Map((dayAhead.hhResults ?? []).map(r => [r.sp, r]));
  const gateUk = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' })
    .format(new Date(dayAhead.hhGateClosureTime ?? currentTime));
  const hoursLeft = Math.max(0, ((dayAhead.hhGateClosureTime ?? currentTime) - currentTime) / 3_600_000);

  // Your position for the delivery day from the HOURLY auction (and hourly blocks).
  const hourlyPos = Array.from({ length: 48 }, (_, sp) => dayAhead.playerSchedule
    .filter(p => p.deliveryDay === day && p.period === sp && p.market === 'da' && p.lockedAt < (dayAhead.hhGateClosureTime ?? Infinity))
    .reduce((a, p) => a + signedMw(p), 0));
  // Power room is judged on the WHOLE position for that SP (hourly DA + any D+1 intraday), like the engine.
  const netAll = Array.from({ length: 48 }, (_, sp) => dayAhead.playerSchedule
    .filter(p => p.deliveryDay === day && p.period === sp)
    .reduce((a, p) => a + signedMw(p), 0));

  const draftBids = fromDraft(draft);
  const key = (bids: HalfHourBid[]) => sanitizeHalfHourBids(bids, P, netAll).map(b => `${b.sp}|${b.side}|${b.volumeMw}|${b.price.toFixed(2)}`).sort().join(';');
  const blockKey = (bs: DaBlockOrder[]) => bs.map(b => `${b.id}|${b.side}|${b.startSp}|${b.endSp}|${b.volumeMw}|${b.price}|${b.parentId ?? ''}`).sort().join(';');
  const dirty = key(draftBids) !== key(submitted) || blockKey(draftBlocks) !== blockKey(submittedBlocks);
  const crossing = Array.from({ length: 48 }, (_, sp) => {
    const buy = draftBids.find(b => b.sp === sp && b.side === OrderSide.BUY);
    const sell = draftBids.find(b => b.sp === sp && b.side === OrderSide.SELL);
    return buy && sell && buy.price >= sell.price ? `crossing curve ${spLabel(sp)}: max £${buy.price} ≥ min £${sell.price} (buy max must be below sell min)` : null;
  }).filter((x): x is string => x !== null);
  const violations = [...powerViolations(draftBids, draftBlocks, P, netAll), ...crossing];
  const draftCount = draftBids.length + draftBlocks.length;
  const submittedCount = submitted.length + submittedBlocks.length;

  // Net per SP: hourly position + 30-min orders (assumed filled) + 30-min blocks.
  const halfBlocks = isOpen ? draftBlocks : submittedBlocks;
  const totalNet = hourlyPos.map((n, sp) => {
    let v = n;
    if (!cleared) {
      // With a buy AND a sell on the same SP only one leg can fill — use the one that fills at the forecast.
      const legs = draftBids.filter(b => b.sp === sp);
      const used = legs.length > 1 ? legs.filter(b => fc[sp] !== undefined && bidFills(b, fc[sp])) : legs;
      for (const b of used) v += b.side === OrderSide.SELL ? b.volumeMw : -b.volumeMw;
      for (const b of halfBlocks) if (sp >= b.startSp && sp <= b.endSp) v += b.side === OrderSide.SELL ? b.volumeMw : -b.volumeMw;
    } else {
      v = dayAhead.playerSchedule.filter(p => p.deliveryDay === day && p.period === sp && p.market === 'da').reduce((a, p) => a + signedMw(p), 0);
    }
    return v;
  });

  // SoC path over the delivery day from the projected start SoC.
  const today = getUtcDayStart(currentTime);
  const curSp = getSettlementPeriod(currentTime) - 1;
  let soc = battery.currentSocMwh;
  for (let sp = curSp; sp < 48; sp++) {
    const n = dayAhead.playerSchedule.filter(p => !p.delivered && p.deliveryDay === today && p.period === sp).reduce((a, p) => a + signedMw(p), 0);
    soc = Math.max(0, Math.min(cap, n > 0 ? soc - Math.min(n, P) * 0.5 : soc + Math.min(-n, P) * 0.5 * eff));
  }
  const startSoc = soc;
  let shortfall = 0;
  const socPct = totalNet.map(n => {
    const raw = n > 0 ? soc - Math.min(n, P) * 0.5 : soc + Math.min(-n, P) * 0.5 * eff;
    if (raw < 0) shortfall += -raw;
    if (raw > cap) shortfall += (raw - cap) / eff;
    soc = Math.max(0, Math.min(cap, raw));
    return (soc / cap) * 100;
  });

  const blockAvgFc = (b: DaBlockOrder) => {
    let sum = 0;
    for (let sp = b.startSp; sp <= b.endSp; sp++) sum += fc[sp] ?? 0;
    return sum / (b.endSp - b.startSp + 1);
  };
  const expectedCash = draftBids
    .filter(b => fc[b.sp] !== undefined && bidFills(b, fc[b.sp]))
    .reduce((a, b) => a + (b.side === OrderSide.SELL ? 1 : -1) * b.volumeMw * 0.5 * fc[b.sp], 0)
    + draftBlocks
      .filter(b => (b.side === OrderSide.BUY ? blockAvgFc(b) <= b.price : blockAvgFc(b) >= b.price))
      .reduce((a, b) => {
        let cash = 0;
        for (let sp = b.startSp; sp <= b.endSp; sp++) cash += (b.side === OrderSide.SELL ? 1 : -1) * b.volumeMw * 0.5 * (fc[sp] ?? 0);
        return a + cash;
      }, 0);

  const setField = (sp: number, f: keyof Draft, v: string) => {
    setSent(false);
    setDraft(prev => {
      const d = { ...(prev[sp] ?? EMPTY), [f]: v };
      if (f === 'buyMw' && v && !d.buyPx && fc[sp] !== undefined) d.buyPx = fc[sp].toFixed(2);
      if (f === 'sellMw' && v && !d.sellPx && fc[sp] !== undefined) d.sellPx = fc[sp].toFixed(2);
      return { ...prev, [sp]: d };
    });
  };

  const submit = () => {
    if (!isOpen || !onSubmitHalfHourBids || violations.length) return;
    onSubmitHalfHourBids(sanitizeHalfHourBids(draftBids, P, netAll));
    onSetBlocks?.('half', draftBlocks);
    setAwaitingSync(true);
    setSent(true);
  };

  // Preset "shape": within every hour you hold a position, shift volume from the
  // cheaper half-hour into the dearer one (sell more in the dear half, buy back
  // in the cheap half) — the classic use of the 30-min auction.
  const presetShape = () => {
    const next: Record<number, Draft> = {};
    for (let h = 0; h < 24; h++) {
      const a = 2 * h, b = 2 * h + 1;
      if (!fc.length || Math.abs(fc[a] - fc[b]) < 3) continue;
      const [cheap, dear] = fc[a] < fc[b] ? [a, b] : [b, a];
      // Stay within the power rating on both legs, given the hourly position.
      const sellRoom = P - hourlyPos[dear];
      const buyRoom = P + hourlyPos[cheap];
      const mw = Math.min(10, sellRoom, buyRoom);
      if (mw <= 0) continue;
      next[dear] = { ...EMPTY, sellMw: String(mw), sellPx: (fc[dear] - 2).toFixed(2) };
      next[cheap] = { ...EMPTY, buyMw: String(mw), buyPx: (fc[cheap] + 2).toFixed(2) };
    }
    setSent(false);
    setDraft(next);
  };

  const chartData = Array.from({ length: 48 }, (_, sp) => ({
    sp: spLabel(sp),
    forecast: fc[sp] ?? null,
    hourly: pending ? null : hourly[Math.floor(sp / 2)],
    clearing: cleared ? nextDay.daClearing[sp] : null,
    soc: socPct[sp],
    net: totalNet[sp],
  }));

  return (
    <div className="panel day-ahead-full">
      <div className="da-sticky-top">
        <div className="panel-header da-panel-header">
          <h3>Day-Ahead · 30-min auction</h3>
          <HelpIcon text="EPEX GB half-hourly day-ahead auction: gate closure 15:30 UK on D-1, results from ~15:45. It runs AFTER the hourly 09:20 auction, so you already know the hourly prices and your hourly position. Within an hour the two half-hours often differ (ramps!) — here you re-shape: sell more in the dearer half, buy back in the cheaper half. Same rules: blind, uniform price, pay-as-cleared. On real days the half-hourly price is the Market Index Price." />
          <span className="da-delivery-badge">Delivery <strong>{formatDeliveryDay(day)}</strong></span>
        </div>

        <div className="kpi-strip">
          <div className="kpi-card">
            <div className="kpi-label">Status</div>
            <div className="kpi-value-row"><span className="kpi-value" style={{ fontSize: 16 }}>{pending ? 'Not open yet' : isOpen ? 'OPEN' : 'Cleared'}</span></div>
            <div className="kpi-sub">{pending ? 'opens when the 09:20 hourly auction has cleared' : isOpen ? `gate ${gateUk} UK · ${hoursLeft.toFixed(1)}h left` : 'results published'}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Hourly position</div>
            <div className="kpi-value-row">
              <span className="kpi-value" style={{ fontSize: 16 }}>
                <span style={{ color: 'var(--charge)' }}>{hourlyPos.reduce((a, n) => a + (n < 0 ? -n * 0.5 : 0), 0).toFixed(0)}</span>
                <span className="kpi-unit"> / </span>
                <span style={{ color: 'var(--discharge)' }}>{hourlyPos.reduce((a, n) => a + (n > 0 ? n * 0.5 : 0), 0).toFixed(0)}</span>
                <span className="kpi-unit"> MWh</span>
              </span>
            </div>
            <div className="kpi-sub">charge / discharge won at 09:20</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">{cleared ? '30-min cash' : 'Expected 30-min cash'}</div>
            <div className="kpi-value-row">
              {(() => {
                const cash = cleared
                  ? dayAhead.playerSchedule.filter(p => p.deliveryDay === day && p.market === 'da' && p.lockedAt >= (dayAhead.hhGateClosureTime ?? Infinity)).reduce((a, p) => a + signedMw(p) * 0.5 * p.price, 0)
                  : expectedCash;
                return <span className={`kpi-value ${cash >= 0 ? 'positive' : 'negative'}`}>{cash >= 0 ? '+' : '−'}£{Math.abs(cash).toFixed(0)}</span>;
              })()}
            </div>
            <div className="kpi-sub">{cleared ? 'at half-hourly clearing prices' : 'orders that fill at forecast'}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Energy feasibility</div>
            <div className="kpi-value-row">
              <span className={`kpi-value ${shortfall > 0.5 ? 'negative' : ''}`}>{shortfall > 0.5 ? `${shortfall.toFixed(0)}` : 'OK'}{shortfall > 0.5 && <span className="kpi-unit"> MWh</span>}</span>
            </div>
            <div className="kpi-sub">{shortfall > 0.5 ? 'undeliverable → imbalance at SIP' : `start SoC ${((startSoc / cap) * 100).toFixed(0)}%`}</div>
          </div>
        </div>

        <div className="da-sticky-content">
          <div className="da-forecast-chart compact">
            <div className="da-forecast-head">
              <h4>
                Half-hourly forecast vs hourly price
                <HelpIcon text="Bars = desk forecast per half-hour. Grey step = the hourly price cleared at 09:20. Blue line (after 15:30) = half-hourly clearing. Lavender = projected SoC with your hourly position + 30-min orders." />
              </h4>
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -8 }} barCategoryGap="20%">
                <CartesianGrid strokeDasharray="5 5" stroke="#8b95a8" strokeOpacity={0.5} vertical={false} />
                <XAxis dataKey="sp" stroke="#6b7280" fontSize={9} interval={7} tickLine={false} axisLine={false} />
                <YAxis yAxisId="p" stroke="#6b7280" fontSize={10} width={40} tickLine={false} axisLine={false} />
                <YAxis yAxisId="soc" orientation="right" stroke="#c7b4f8" fontSize={10} width={32} domain={[0, 100]} ticks={[0, 50, 100]} tickFormatter={(v: number) => `${v}%`} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ background: '#0f1420', border: '1px solid #1f2535', borderRadius: '6px', color: '#e5e7eb', fontSize: 11, padding: '6px 8px' }}
                  formatter={(v: unknown, n: unknown) => (v == null ? ['—', String(n)] : String(n) === 'SoC' ? [`${Number(v).toFixed(0)}%`, 'SoC'] : [`£${Number(v).toFixed(2)}`, String(n)])}
                />
                <Bar yAxisId="p" dataKey="forecast" name="30-min forecast" radius={[2, 2, 0, 0]}>
                  {chartData.map((c, i) => <Cell key={i} fill={c.net < 0 ? '#007be2' : c.net > 0 ? '#ff874b' : '#9ca3af'} fillOpacity={c.net !== 0 ? 0.8 : 0.45} />)}
                </Bar>
                <Line yAxisId="p" dataKey="hourly" name="Hourly price" type="stepAfter" stroke="#8b95a8" strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                <Line yAxisId="p" dataKey="clearing" name="30-min clearing" stroke="#76b8ef" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line yAxisId="soc" dataKey="soc" name="SoC" type="stepAfter" stroke="#c7b4f8" strokeWidth={2} dot={false} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="da-quick-panel">
            <div className={`da-status-inline ${isOpen ? 'open' : 'closed'}`}>
              <div className="da-status-row">
                <span className={`da-status-dot ${isOpen ? 'open' : 'closed'}`} />
                <span className="da-status-label">{pending ? 'Waiting for 09:20 results' : isOpen ? '30-min auction OPEN' : '30-min auction CLEARED'}</span>
              </div>
              <div className="da-status-sub">{submittedCount} order{submittedCount === 1 ? '' : 's'} submitted{submittedBlocks.length ? ` (${submittedBlocks.length} block${submittedBlocks.length === 1 ? '' : 's'})` : ''} {sent && !dirty && <span className="da-submitted"><CheckCircle size={12} /> sent</span>}</div>
            </div>
            {isOpen && (
              <>
                <h4>
                  Quick fill
                  <HelpIcon text="Shape: in every hour where the two half-hours differ by more than £3, sell up to 10 MW in the dearer half and buy back the same in the cheaper half (limits ±£2 around the forecast). Net energy stays the same, you capture the intra-hour spread." />
                </h4>
                <div className="da-quick-fill vertical">
                  <button className="btn btn-preset" onClick={presetShape}>Shape within hours</button>
                  <button className="btn btn-preset" onClick={() => { setDraft({}); setDraftBlocks([]); setSent(false); }}>Clear</button>
                </div>
                <button className={`btn btn-submit da-submit-inline ${dirty ? 'btn-buy' : ''}`} disabled={!dirty || violations.length > 0} onClick={submit}>
                  {violations.length
                    ? 'Fix orders first'
                    : dirty ? `Submit ${draftCount} order${draftCount === 1 ? '' : 's'}${draftBlocks.length ? ` (${draftBlocks.length} block${draftBlocks.length === 1 ? '' : 's'})` : ''}` : submittedCount ? 'Orders up to date' : 'No orders yet'}
                </button>
                {violations.length > 0 && (
                  <div className="da-power-warning negative">
                    {violations.slice(0, 4).join(' · ')}{violations.length > 4 ? ` … +${violations.length - 4}` : ''}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="da-bid-section">
        {!pending && (
          <DaBlockOrders
            auction="half"
            blocks={isOpen ? draftBlocks : submittedBlocks}
            submitted={submittedBlocks}
            results={dayAhead.blockResults ?? []}
            isOpen={isOpen}
            forecastBySp={fc}
            powerMw={P}
            onAdd={b => { setDraftBlocks(prev => [...prev, b]); setSent(false); }}
            onRemove={id => { setDraftBlocks(prev => prev.filter(b => b.id !== id && b.parentId !== id)); setSent(false); }}
          />
        )}
        {pending ? (
          <div className="muted da-section-empty">The 30-min auction opens once the hourly auction has cleared at 09:20 UK — then you'll see the hourly prices, your hourly position and a half-hourly forecast here.</div>
        ) : (
          <div className="da-bid-scroll">
            <table className="data-table bid-table">
              <thead>
                <tr><th>SP</th><th>Hourly £</th><th>Hourly pos.</th><th>30-min forecast</th><th>Buy MW</th><th>Max £</th><th>Sell MW</th><th>Min £</th><th>{cleared ? 'Clearing · result' : 'Fill at forecast?'}</th></tr>
              </thead>
              <tbody>
                {Array.from({ length: 48 }, (_, sp) => {
                  const d = draft[sp] ?? EMPTY;
                  const r = results.get(sp);
                  const rowBids = draftBids.filter(b => b.sp === sp);
                  return (
                    <tr key={sp} className={sp % 2 === 1 ? 'row-hh-second' : ''}>
                      <td>{spLabel(sp)}</td>
                      <td className="muted">£{hourly[Math.floor(sp / 2)].toFixed(2)}</td>
                      <td style={{ color: hourlyPos[sp] < 0 ? 'var(--charge)' : hourlyPos[sp] > 0 ? 'var(--discharge)' : undefined }}>
                        {hourlyPos[sp] === 0 ? '·' : `${hourlyPos[sp] > 0 ? '+' : ''}${hourlyPos[sp].toFixed(0)}`}
                      </td>
                      <td>{fc[sp] !== undefined ? `£${fc[sp].toFixed(2)}` : '—'}</td>
                      <td><input className="input" type="number" min={0} max={P} value={d.buyMw} disabled={!isOpen} onChange={e => setField(sp, 'buyMw', e.target.value)} /></td>
                      <td><input className="input" type="number" step={0.5} value={d.buyPx} disabled={!isOpen} onChange={e => setField(sp, 'buyPx', e.target.value)} placeholder="—" /></td>
                      <td><input className="input" type="number" min={0} max={P} value={d.sellMw} disabled={!isOpen} onChange={e => setField(sp, 'sellMw', e.target.value)} /></td>
                      <td><input className="input" type="number" step={0.5} value={d.sellPx} disabled={!isOpen} onChange={e => setField(sp, 'sellPx', e.target.value)} placeholder="—" /></td>
                      <td className="muted">
                        {cleared
                          ? r
                            ? <span>£{r.clearingPrice.toFixed(2)} · {r.buyMw > 0 && <span className={r.buyFilled ? 'positive' : 'negative'}>Buy {r.buyFilled ? 'filled' : 'not filled'} </span>}{r.sellMw > 0 && <span className={r.sellFilled ? 'positive' : 'negative'}>Sell {r.sellFilled ? 'filled' : 'not filled'}</span>}</span>
                            : `£${(nextDay.daClearing[sp] ?? 0).toFixed(2)}`
                          : rowBids.map(b => `${b.side === OrderSide.BUY ? 'Buy' : 'Sell'} ${fc[sp] !== undefined && bidFills(b, fc[sp]) ? '✓' : '✗'}`).join(' · ') || '—'}
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
