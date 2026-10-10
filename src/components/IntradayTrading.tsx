import { useMemo, useState } from 'react';
import type { GameState, IdOrderType } from '../engine/types';
import { OrderSide } from '../engine/types';
import { getUtcDayStart, getSettlementPeriod, formatDeliveryDay, ID_GATE_CLOSURE_MS } from '../engine/clock';
import {
  buildBook, isProductOpen, netPositionMw, orderRoomMw, productStart, productRef,
} from '../engine/intradayBook';
import type { PlaceOrderInput, OrderBook } from '../engine/intradayBook';
import HelpIcon from './HelpIcon';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { Clock, X } from 'lucide-react';

interface Props {
  state: GameState;
  onPlaceOrder: (input: PlaceOrderInput) => void;
  onCancelOrder: (orderId: string) => void;
}

const spLabel = (sp: number) => `${String(Math.floor(sp / 2)).padStart(2, '0')}:${sp % 2 === 0 ? '00' : '30'}`;
const fmt = (v: number | undefined | null, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));

const TYPE_HELP: Record<IdOrderType, string> = {
  market: 'Market: take whatever liquidity is in the book now (walks the levels, you pay the spread). Unfilled rest is cancelled.',
  limit: 'Limit: fills immediately up to your price if the book crosses it; the rest rests in the book and may fill later at your limit, or never.',
  ioc: 'Immediate-or-Cancel: like limit, but whatever can’t fill right now is cancelled.',
  fok: 'Fill-or-Kill: fills the full quantity at or better than your limit right now, otherwise nothing.',
};

function vwapEstimate(book: OrderBook | null, side: OrderSide, qty: number, limit: number | null) {
  if (!book) return { mw: 0, price: 0 };
  const levels = side === OrderSide.BUY ? book.asks : book.bids;
  let left = qty, cash = 0, mw = 0;
  for (const l of levels) {
    if (left <= 0) break;
    if (limit !== null && (side === OrderSide.BUY ? l.price > limit : l.price < limit)) break;
    const take = Math.min(left, l.mw);
    cash += take * l.price; mw += take; left -= take;
  }
  return { mw, price: mw > 0 ? cash / mw : 0 };
}

export default function IntradayTrading({ state, onPlaceOrder, onCancelOrder }: Props) {
  const { dayAhead, battery, intraday, clock, nextDay } = state;
  const now = clock.currentTime;
  const today = getUtcDayStart(now);
  const tomorrowOpen = !dayAhead.isAuctionOpen && !dayAhead.hhAuctionOpen && nextDay.day !== today;
  const [dayChoice, setDayChoice] = useState<'today' | 'tomorrow'>('today');
  const day = dayChoice === 'tomorrow' && tomorrowOpen ? nextDay.day : today;
  const [selected, setSelected] = useState<number | null>(null);
  // SP under the mouse in the product table — highlights its bar in the chart.
  const [hoverSp, setHoverSp] = useState<number | null>(null);
  const [side, setSide] = useState<OrderSide>(OrderSide.BUY);
  const [type, setType] = useState<IdOrderType>('limit');
  const [qty, setQty] = useState('10');
  const [limit, setLimit] = useState('');

  const currentSp = getSettlementPeriod(now) - 1;
  const P = battery.config.powerRatingMw;

  const rows = useMemo(() => Array.from({ length: 48 }, (_, sp) => {
    const open = isProductOpen(state, day, sp);
    const book = open ? buildBook(state, day, sp) : null;
    const ref = productRef(state, day, sp);
    const net = netPositionMw(state, day, sp);
    const delivered = day === today && sp < currentSp;
    const status = open ? 'open' : delivered ? 'delivered' : day === today && sp === currentSp ? 'delivering' : 'closed';
    return { sp, open, book, da: ref?.da ?? (day === today ? dayAhead.forecastPrices[sp] : nextDay.daClearing[sp]), net, status };
  }), [state, day, today, currentSp, dayAhead.forecastPrices, nextDay.daClearing]);

  const sel = selected !== null ? rows[selected] : null;
  const selBook = sel?.book ?? null;
  const qtyNum = Number(qty);
  const limitNum = limit.trim() === '' ? NaN : Number(limit);
  const room = sel ? orderRoomMw(state, day, sel.sp, side) : 0;
  const est = vwapEstimate(selBook, side, qtyNum || 0, type === 'market' ? null : (Number.isFinite(limitNum) ? limitNum : null));
  const gateMs = sel ? productStart(day, sel.sp) - ID_GATE_CLOSURE_MS - now : 0;

  const choose = (sp: number) => {
    setSelected(sp === selected ? null : sp);
    const b = rows[sp].book;
    if (b) setLimit((side === OrderSide.BUY ? b.bids[0]?.price ?? b.mid : b.asks[0]?.price ?? b.mid).toFixed(2));
  };

  const place = () => {
    if (!sel || !sel.open) return;
    onPlaceOrder({
      deliveryDay: day,
      period: sel.sp,
      side,
      type,
      qtyMw: qtyNum,
      limitPrice: type === 'market' ? null : limitNum,
    });
  };

  // SoC projection for TODAY through the net contracted position per SP.
  const cap = battery.config.capacityMwh;
  const eff = battery.config.efficiencyPct / 100;
  const socBySp: (number | null)[] = new Array(48).fill(null);
  if (day === today) {
    let soc = battery.currentSocMwh;
    for (let sp = currentSp + 1; sp < 48; sp++) {
      const net = netPositionMw(state, today, sp);
      soc = net > 0 ? soc - Math.min(net, P) * 0.5 : soc + Math.min(-net, P) * 0.5 * eff;
      soc = Math.max(0, Math.min(cap, soc));
      socBySp[sp] = (soc / cap) * 100;
    }
  }

  const chartData = rows.map(r => ({
    sp: spLabel(r.sp),
    da: r.da,
    mid: r.book?.mid ?? null,
    sip: day === today && r.sp < dayAhead.revealedPeriods ? dayAhead.sipOutturn[r.sp] : null,
    net: r.net,
    soc: socBySp[r.sp],
  }));

  const dayOrders = intraday.orders.filter(o => o.deliveryDay >= today);
  const working = dayOrders.filter(o => o.status === 'working' || o.status === 'partial');
  const history = [...dayOrders].filter(o => o.status !== 'working' && o.status !== 'partial').reverse().slice(0, 8);
  const fills = intraday.fills.filter(f => f.deliveryDay >= today).slice(-10).reverse();
  const idCashToday = intraday.fills
    .filter(f => f.deliveryDay === today)
    .reduce((a, f) => a + (f.side === OrderSide.SELL ? 1 : -1) * f.mw * 0.5 * f.price, 0);

  const ladder: { price: number; mw: number; kind: 'ask' | 'bid' }[] = selBook
    ? [
      ...[...selBook.asks].reverse().map(l => ({ ...l, kind: 'ask' as const })),
      ...selBook.bids.map(l => ({ ...l, kind: 'bid' as const })),
    ]
    : [];
  const maxLvl = Math.max(1, ...ladder.map(l => l.mw));

  return (
    <div className="panel day-ahead-full" id="intraday-tab">
      <div className="da-sticky-top">
        <div className="panel-header da-panel-header">
          <h3><Clock size={16} /> Intraday · continuous order book</h3>
          <HelpIcon text="Continuous trading per half-hour product, like EPEX/Nord Pool GB intraday. Every product has its own order book (bids = buyers, asks = sellers). Crossing the spread fills immediately but costs you the spread; resting limit orders may fill later at your price — or not at all. Each product closes 1 hour before delivery (BM Gate Closure, T-60). Tomorrow's products open once both day-ahead auctions have cleared (after 15:30)." />
          <div className="idb-day-toggle">
            <button className={`hdr-tab ${day === today ? 'active' : ''}`} onClick={() => { setDayChoice('today'); setSelected(null); }}>
              Today · {formatDeliveryDay(today)}
            </button>
            <button
              className={`hdr-tab ${day !== today ? 'active' : ''}`}
              disabled={!tomorrowOpen}
              title={tomorrowOpen ? '' : 'Opens after the day-ahead auctions (15:30 UK)'}
              onClick={() => { setDayChoice('tomorrow'); setSelected(null); }}
            >
              Tomorrow · {formatDeliveryDay(nextDay.day)}
            </button>
          </div>
        </div>

        <div className="kpi-strip">
          <div className="kpi-card">
            <div className="kpi-label">SoC now</div>
            <div className="kpi-value-row"><span className="kpi-value">{battery.socPct.toFixed(0)}<span className="kpi-unit">%</span></span></div>
            <div className="kpi-sub">{battery.currentSocMwh.toFixed(0)} / {cap} MWh</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Working orders</div>
            <div className="kpi-value-row"><span className="kpi-value">{working.length}</span></div>
            <div className="kpi-sub">resting in the book</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">ID cash today</div>
            <div className="kpi-value-row">
              <span className={`kpi-value ${idCashToday >= 0 ? 'positive' : 'negative'}`}>{idCashToday >= 0 ? '+' : '−'}£{Math.abs(idCashToday).toFixed(0)}</span>
            </div>
            <div className="kpi-sub">from fills for today's delivery</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Open products</div>
            <div className="kpi-value-row"><span className="kpi-value">{rows.filter(r => r.open).length}</span></div>
            <div className="kpi-sub">gate closes T-60 each</div>
          </div>
        </div>

        <div className="da-sticky-content">
          <div className="da-forecast-chart compact">
            <div className="da-forecast-head">
              <h4>
                DA · ID mid · SIP · your net position
                <HelpIcon text="Grey bars = DA price of each half-hour. Blue line = current intraday mid of open products. Red = settled SIP (only after each SP ends). Lavender = projected SoC from your net DA+ID position." />
              </h4>
            </div>
            <ResponsiveContainer width="100%" height={190}>
              <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -8 }} barCategoryGap="25%"
                onClick={(e: unknown) => {
                  const idx = (e as { activeTooltipIndex?: number })?.activeTooltipIndex;
                  if (typeof idx === 'number' && rows[idx]?.open) choose(idx);
                }}>
                <CartesianGrid strokeDasharray="5 5" stroke="#8b95a8" strokeOpacity={0.5} vertical={false} />
                <XAxis dataKey="sp" stroke="#6b7280" fontSize={9} interval={7} tickLine={false} axisLine={false} />
                <YAxis yAxisId="p" stroke="#6b7280" fontSize={10} width={40} tickLine={false} axisLine={false} />
                <YAxis yAxisId="soc" orientation="right" stroke="#c7b4f8" fontSize={10} width={32} domain={[0, 100]} ticks={[0, 50, 100]} tickFormatter={(v: number) => `${v}%`} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ background: '#0f1420', border: '1px solid #1f2535', borderRadius: '6px', color: '#e5e7eb', fontSize: 11, padding: '6px 8px' }}
                  formatter={(v: unknown, n: unknown) => (v == null ? ['—', String(n)] : String(n) === 'SoC' ? [`${Number(v).toFixed(0)}%`, 'SoC'] : [`£${Number(v).toFixed(2)}`, String(n)])}
                />
                <Bar yAxisId="p" dataKey="da" name="DA" radius={[2, 2, 0, 0]}>
                  {chartData.map((c, i) => (
                    <Cell key={i} fill={c.net < 0 ? '#007be2' : c.net > 0 ? '#ff874b' : hoverSp === i || selected === i ? '#e5e7eb' : '#9ca3af'} fillOpacity={hoverSp === i || selected === i ? 1 : c.net !== 0 ? 0.75 : 0.35} />
                  ))}
                </Bar>
                <Line yAxisId="p" dataKey="mid" name="ID mid" stroke="#76b8ef" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
                <Line yAxisId="p" dataKey="sip" name="SIP" stroke="#ff5f62" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                <Line yAxisId="soc" dataKey="soc" name="SoC" type="stepAfter" stroke="#c7b4f8" strokeWidth={2} dot={false} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="da-quick-panel idb-ticket">
            {sel ? (
              <>
                <div className="idb-ticket-head">
                  <strong>{spLabel(sel.sp)}</strong>
                  <span className="muted"> · {formatDeliveryDay(day)}</span>
                  <span className="idb-gate">{sel.open ? `gate in ${Math.max(0, Math.floor(gateMs / 60000))} min` : 'closed'}</span>
                </div>
                <div className="idb-ladder">
                  {ladder.map((l, i) => (
                    <div key={i} className={`idb-level ${l.kind}`} onClick={() => setLimit(l.price.toFixed(2))} title="Click to use as limit">
                      <span className="idb-depth" style={{ width: `${(l.mw / maxLvl) * 100}%` }} />
                      <span className="idb-px">£{l.price.toFixed(2)}</span>
                      <span className="idb-mw">{l.mw.toFixed(1)} MW</span>
                    </div>
                  ))}
                  {selBook && <div className="idb-spread">spread £{(2 * selBook.halfSpread).toFixed(2)} · mid £{selBook.mid.toFixed(2)} · DA £{fmt(sel.da)}</div>}
                </div>
                <div className="idb-side">
                  <button className={`btn idb-side-btn buy ${side === OrderSide.BUY ? 'active' : ''}`} onClick={() => setSide(OrderSide.BUY)}>Buy · charge</button>
                  <button className={`btn idb-side-btn sell ${side === OrderSide.SELL ? 'active' : ''}`} onClick={() => setSide(OrderSide.SELL)}>Sell · discharge</button>
                </div>
                <div className="idb-fields">
                  <label>Type
                    <select className="input" value={type} onChange={e => setType(e.target.value as IdOrderType)}>
                      <option value="limit">Limit</option>
                      <option value="market">Market</option>
                      <option value="ioc">IOC</option>
                      <option value="fok">FOK</option>
                    </select>
                  </label>
                  <label>MW
                    <input className="input" type="number" min={0.1} step={1} value={qty} onChange={e => setQty(e.target.value)} />
                  </label>
                  <label>Limit £
                    <input className="input" type="number" step={0.05} value={type === 'market' ? '' : limit} disabled={type === 'market'} onChange={e => setLimit(e.target.value)} placeholder={type === 'market' ? 'n/a' : ''} />
                  </label>
                </div>
                <div className="idb-hint">{TYPE_HELP[type]}</div>
                <div className="idb-hint">
                  Now crossable: {est.mw.toFixed(1)} MW{est.mw > 0 ? ` @ avg £${est.price.toFixed(2)}` : ''} · room {room.toFixed(1)} MW (net {sel.net >= 0 ? '+' : ''}{sel.net.toFixed(0)} MW, limit ±{P})
                </div>
                {sel.open && type !== 'market' && qtyNum > 0 && est.mw < 0.05 && (
                  <div className="idb-hint idb-hint-passive">
                    ⚠ Fills nothing now — you {side === OrderSide.BUY ? 'buy at the ask, and your limit' : 'sell at the bid, and your limit'} (£{Number.isFinite(limitNum) ? limitNum.toFixed(2) : '—'}) is {side === OrderSide.BUY
                      ? `below the best ask (£${sel.book?.asks[0]?.price.toFixed(2) ?? '—'})`
                      : `above the best bid (£${sel.book?.bids[0]?.price.toFixed(2) ?? '—'})`}. The order rests in the book until the market reaches it, and expires at the gate (T-60). To trade now: Market, or click the {side === OrderSide.BUY ? 'ask' : 'bid'} price level.
                  </div>
                )}
                <button className={`btn btn-submit idb-submit ${side === OrderSide.BUY ? 'buy' : 'sell'}`} disabled={!sel.open || !(qtyNum > 0) || (type !== 'market' && !Number.isFinite(limitNum))} onClick={place}>
                  {!sel.open ? 'Product closed (T-60)'
                    : type === 'market' ? `${side === OrderSide.BUY ? 'Buy' : 'Sell'} ${qtyNum > 0 ? qtyNum : ''} MW now · MARKET`
                    : est.mw >= qtyNum - 0.05 ? `${side === OrderSide.BUY ? 'Buy' : 'Sell'} ${qtyNum > 0 ? qtyNum : ''} MW now · ${type.toUpperCase()}`
                    : est.mw > 0 ? `${side === OrderSide.BUY ? 'Buy' : 'Sell'} ≈${est.mw.toFixed(1)} MW now, rest ${type === 'limit' ? 'rests' : 'cancels'} · ${type.toUpperCase()}`
                    : `Place resting ${side === OrderSide.BUY ? 'buy' : 'sell'} ${qtyNum > 0 ? qtyNum : ''} MW · ${type.toUpperCase()}`}
                </button>
              </>
            ) : (
              <div className="id-trade-card empty">
                <div className="id-trade-empty-title">Select a product</div>
                <div className="id-trade-empty-sub">Click an open half-hour in the table or chart to see its order book and place orders.</div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="idb-lower">
        <div className="idb-products">
          <table className="data-table">
            <thead>
              <tr><th>SP</th><th>DA £</th><th>Bid</th><th>Ask</th><th>Mid</th><th>Net MW</th><th>Status</th></tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.sp}
                  className={`${selected === r.sp ? 'row-hovered' : ''} ${r.open ? '' : 'muted'}`}
                  style={{ cursor: r.open ? 'pointer' : 'default' }}
                  onClick={() => r.open && choose(r.sp)}
                  onMouseEnter={() => setHoverSp(r.sp)}
                  onMouseLeave={() => setHoverSp(h => (h === r.sp ? null : h))}>
                  <td>{spLabel(r.sp)}</td>
                  <td>{fmt(r.da)}</td>
                  <td>{r.book ? <span>{fmt(r.book.bids[0]?.price)} <small className="muted">{fmt(r.book.bids[0]?.mw, 0)}</small></span> : '—'}</td>
                  <td>{r.book ? <span>{fmt(r.book.asks[0]?.price)} <small className="muted">{fmt(r.book.asks[0]?.mw, 0)}</small></span> : '—'}</td>
                  <td>{r.book ? fmt(r.book.mid) : '—'}</td>
                  <td style={{ color: r.net < 0 ? 'var(--charge)' : r.net > 0 ? 'var(--discharge)' : undefined }}>{r.net === 0 ? '·' : `${r.net > 0 ? '+' : ''}${r.net.toFixed(0)}`}</td>
                  <td className="muted">{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="idb-orders">
          <h4>Working orders</h4>
          {working.length === 0 ? <div className="muted idb-empty">None.</div> : (
            <table className="data-table">
              <thead><tr><th>ID</th><th>Product</th><th>Side</th><th>Limit</th><th>Filled</th><th /></tr></thead>
              <tbody>
                {working.map(o => (
                  <tr key={o.id}>
                    <td>{o.id}</td>
                    <td>{o.deliveryDay === today ? '' : 'D+1 '}{spLabel(o.period)}</td>
                    <td style={{ color: o.side === OrderSide.BUY ? 'var(--charge)' : 'var(--discharge)' }}>{o.side === OrderSide.BUY ? 'Buy' : 'Sell'}</td>
                    <td>£{fmt(o.limitPrice)}</td>
                    <td>{o.filledMw.toFixed(1)} / {o.qtyMw.toFixed(1)}</td>
                    <td><button className="btn btn-ghost btn-sm" onClick={() => onCancelOrder(o.id)} title="Cancel"><X size={12} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h4>Fills</h4>
          {fills.length === 0 ? <div className="muted idb-empty">No fills yet.</div> : (
            <table className="data-table">
              <thead><tr><th>Product</th><th>Side</th><th>MW</th><th>Price</th><th>Type</th></tr></thead>
              <tbody>
                {fills.map((f, i) => (
                  <tr key={i}>
                    <td>{f.deliveryDay === today ? '' : 'D+1 '}{spLabel(f.period)}</td>
                    <td style={{ color: f.side === OrderSide.BUY ? 'var(--charge)' : 'var(--discharge)' }}>{f.side === OrderSide.BUY ? 'Buy' : 'Sell'}</td>
                    <td>{f.mw.toFixed(1)}</td>
                    <td>£{f.price.toFixed(2)}</td>
                    <td className="muted">{f.aggressor ? 'took liquidity' : 'resting filled'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h4>Order history</h4>
          {history.length === 0 ? <div className="muted idb-empty">—</div> : (
            <ul className="idb-history">
              {history.map(o => (
                <li key={o.id}>
                  <span className={`idb-status ${o.status}`}>{o.status}</span> {o.id} · {o.side === OrderSide.BUY ? 'Buy' : 'Sell'} {o.qtyMw} MW {spLabel(o.period)} {o.type.toUpperCase()}
                  {o.filledMw > 0 && ` · filled ${o.filledMw} @ £${o.avgFillPrice.toFixed(2)}`}
                  {o.note && <span className="muted"> — {o.note}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

