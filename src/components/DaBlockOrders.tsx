import { useState } from 'react';
import type { BlockResult, DaBlockOrder } from '../engine/types';
import { OrderSide } from '../engine/types';
import { validateBlock } from '../engine/dayAheadAuction';
import HelpIcon from './HelpIcon';
import { X } from 'lucide-react';

interface Props {
  auction: 'hourly' | 'half';
  /** Blocks of this auction in your order draft (sent with the auction's Submit button) */
  blocks: DaBlockOrder[];
  /** Blocks currently submitted to the auction (to show draft vs submitted) */
  submitted: DaBlockOrder[];
  results: BlockResult[];
  isOpen: boolean;
  /** Desk forecast per SP for this auction */
  forecastBySp: number[];
  powerMw: number;
  onAdd?: (block: DaBlockOrder) => void;
  onRemove?: (id: string) => void;
}

const t = (sp: number) => `${String(Math.floor(sp / 2)).padStart(2, '0')}:${sp % 2 === 0 ? '00' : '30'}`;
const range = (b: Pick<DaBlockOrder, 'startSp' | 'endSp'>) => `${t(b.startSp)}–${t(b.endSp + 1)}`;

function avgOver(prices: number[], startSp: number, endSp: number): number {
  let s = 0;
  for (let sp = startSp; sp <= endSp; sp++) s += prices[sp] ?? 0;
  return s / (endSp - startSp + 1);
}

/** Block orders for one DA auction: create (incl. linked children), list, cancel, results. */
export default function DaBlockOrders({ auction, blocks, submitted, results, isOpen, forecastBySp, powerMw, onAdd, onRemove }: Props) {
  const mine = blocks.filter(b => b.auction === auction);
  const sameAs = (a: DaBlockOrder, b: DaBlockOrder) =>
    a.side === b.side && a.startSp === b.startSp && a.endSp === b.endSp && a.volumeMw === b.volumeMw && a.price === b.price && a.parentId === b.parentId;
  const isSubmitted = (b: DaBlockOrder) => submitted.some(x => x.id === b.id && sameAs(x, b));
  const resultById = new Map(results.map(r => [r.id, r]));
  const step = auction === 'hourly' ? 2 : 1;
  const [side, setSide] = useState<OrderSide>(OrderSide.BUY);
  const [start, setStart] = useState(auction === 'hourly' ? 4 : 4);
  const [end, setEnd] = useState(auction === 'hourly' ? 7 : 7);
  const [mw, setMw] = useState(String(powerMw));
  const [price, setPrice] = useState('');
  const [parentId, setParentId] = useState('');

  const avgFc = avgOver(forecastBySp, start, end);
  const input: Omit<DaBlockOrder, 'id'> = {
    auction, side, startSp: start, endSp: end, volumeMw: Number(mw), price: price === '' ? NaN : Number(price),
    ...(parentId ? { parentId } : {}),
  };
  const error = validateBlock(input, mine, powerMw);
  const fillsAtForecast = Number.isFinite(input.price) && (side === OrderSide.BUY ? avgFc <= input.price : avgFc >= input.price);

  const startOptions = Array.from({ length: 48 / step }, (_, i) => i * step);
  const endOptions = Array.from({ length: 48 }, (_, sp) => sp).filter(sp => (auction === 'hourly' ? sp % 2 === 1 : true) && sp > start);
  const parents = mine.filter(b => !b.parentId);

  const add = () => {
    if (error || !onAdd) return;
    // Next free id like BH3 / BQ2 (unique across draft and submitted blocks).
    const prefix = auction === 'hourly' ? 'BH' : 'BQ';
    const used = [...blocks, ...submitted].map(x => Number(x.id.replace(prefix, ''))).filter(Number.isFinite);
    const id = `${prefix}${Math.max(0, ...used) + 1}`;
    onAdd({ ...input, id });
    setParentId('');
  };

  const rows = [...parents.flatMap(p => [p, ...mine.filter(c => c.parentId === p.id)])];

  return (
    <div className="da-blocks">
      <div className="da-signals-head">
        Block orders · {auction === 'hourly' ? 'hourly auction' : '30-min auction'}
        <HelpIcon text="A block buys or sells the same MW over consecutive periods, all-or-nothing: it is accepted only if the AVERAGE clearing price over the block meets your limit; then each period settles at its own clearing price. Linked block: a child is only accepted together with its parent — e.g. parent = charge block at night, child = discharge block in the evening, so you can never end up selling energy you didn't buy. A profitable child can carry a parent that is slightly out of the money (combined surplus ≥ 0). EPEX offers classic and linked blocks in the GB 30-min auction; shown here for both auctions." />
      </div>

      {isOpen && onAdd && (
        <div className="da-block-form">
          <div className="idb-side">
            <button className={`btn idb-side-btn buy ${side === OrderSide.BUY ? 'active' : ''}`} onClick={() => setSide(OrderSide.BUY)}>Buy · charge</button>
            <button className={`btn idb-side-btn sell ${side === OrderSide.SELL ? 'active' : ''}`} onClick={() => setSide(OrderSide.SELL)}>Sell · discharge</button>
          </div>
          <label>From
            <select className="input" value={start} onChange={e => { const v = Number(e.target.value); setStart(v); if (end <= v) setEnd(v + (auction === 'hourly' ? 1 : 1)); }}>
              {startOptions.map(sp => <option key={sp} value={sp}>{t(sp)}</option>)}
            </select>
          </label>
          <label>To
            <select className="input" value={end} onChange={e => setEnd(Number(e.target.value))}>
              {endOptions.map(sp => <option key={sp} value={sp}>{t(sp + 1)}</option>)}
            </select>
          </label>
          <label>MW
            <input className="input" type="number" min={1} max={powerMw} value={mw} onChange={e => setMw(e.target.value)} />
          </label>
          <label>{side === OrderSide.BUY ? 'Max avg £' : 'Min avg £'}
            <input className="input" type="number" step={0.5} value={price} placeholder={avgFc.toFixed(2)} onChange={e => setPrice(e.target.value)} />
          </label>
          <label>Link to
            <select className="input" value={parentId} onChange={e => setParentId(e.target.value)}>
              <option value="">— none (classic) —</option>
              {parents.map(p => <option key={p.id} value={p.id}>{p.id} · {p.side === OrderSide.BUY ? 'buy' : 'sell'} {range(p)}</option>)}
            </select>
          </label>
          <button className={`btn btn-submit idb-submit ${side === OrderSide.BUY ? 'buy' : 'sell'}`} disabled={Boolean(error)} onClick={add} title={error ?? 'Adds the block to your order draft — send it with Submit'}>
            Add to draft
          </button>
          <div className="idb-hint da-block-hint">
            Avg forecast {range({ startSp: start, endSp: end })}: £{avgFc.toFixed(2)}
            {Number.isFinite(input.price) && <> · at forecast: {fillsAtForecast ? '✓ accepted' : '✗ rejected'}</>}
            {' '}· energy {(Number(mw) * 0.5 * (end - start + 1) || 0).toFixed(0)} MWh
            {error && Number.isFinite(input.price) && <span className="negative"> · {error}</span>}
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="muted da-section-empty">No block orders{isOpen ? '' : ' in this auction'}.</div>
      ) : (
        <table className="data-table da-orders-table">
          <thead>
            <tr><th>ID</th><th>Order</th><th>Window</th><th>Limit (avg)</th><th>Avg forecast</th><th>Result</th><th /></tr>
          </thead>
          <tbody>
            {rows.map(b => {
              const r = resultById.get(b.id);
              return (
                <tr key={b.id} className={r && !r.accepted ? 'muted' : ''}>
                  <td>{b.parentId ? <span className="muted">↳ </span> : null}{b.id}</td>
                  <td style={{ color: b.side === OrderSide.BUY ? 'var(--charge)' : 'var(--discharge)' }}>
                    {b.side === OrderSide.BUY ? 'Buy · charge' : 'Sell · discharge'} {b.volumeMw} MW
                    {b.parentId && <small className="muted"> · linked to {b.parentId}</small>}
                  </td>
                  <td>{range(b)}</td>
                  <td>{b.side === OrderSide.BUY ? 'max' : 'min'} £{b.price.toFixed(2)}</td>
                  <td className="muted">£{avgOver(forecastBySp, b.startSp, b.endSp).toFixed(2)}</td>
                  <td className={r ? (r.accepted ? 'positive' : 'negative') : isSubmitted(b) ? 'muted' : 'negative'} title={r?.reason} style={{ cursor: r ? 'help' : 'default' }}>
                    {r ? `${r.accepted ? '✓ accepted' : '✗ rejected'} · avg £${r.avgClearing.toFixed(2)}` : isSubmitted(b) ? 'submitted' : 'draft — not sent'}
                  </td>
                  <td>
                    {isOpen && onRemove && (
                      <button className="btn btn-ghost btn-sm" title={b.parentId ? 'Remove' : 'Remove (and its linked children)'} onClick={() => onRemove(b.id)}><X size={12} /></button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
