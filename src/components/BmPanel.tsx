import { useState } from 'react';
import type { BmStandingOrder, GameState } from '../engine/types';
import { getUtcDayStart, getSettlementPeriod, HALF_HOUR_MS, ID_GATE_CLOSURE_MS } from '../engine/clock';
import HelpIcon from './HelpIcon';
import { visibleBoas } from '../engine/gameState';

interface Props {
  state: GameState;
  onSetBmOrder: (order: BmStandingOrder) => void;
}

const spLabel = (sp: number) => `${String(Math.floor(sp / 2)).padStart(2, '0')}:${sp % 2 === 0 ? '00' : '30'}`;
type Draft = { offerMw: string; offerPrice: string; bidMw: string; bidPrice: string };

/**
 * Balancing Mechanism unit: your physical notification (FPN) is binding — you
 * don't spill on purpose. Instead you post bid-offer prices per SP (until gate
 * closure T-60) and NESO may accept them (BOA) when the system needs you.
 */
export default function BmPanel({ state, onSetBmOrder }: Props) {
  const now = state.clock.currentTime;
  const today = getUtcDayStart(now);
  const curSp = getSettlementPeriod(now) - 1;
  const book = state.bmBook ?? [];
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  // Next 12 SPs of today (open ones editable, closed ones read-only).
  const rows = Array.from({ length: 12 }, (_, i) => curSp + 1 + i).filter(sp => sp < 48).map(sp => {
    const open = now < today + sp * HALF_HOUR_MS - ID_GATE_CLOSURE_MS;
    const o = book.find(b => b.day === today && b.sp === sp);
    const key = `${today}:${sp}`;
    const d: Draft = drafts[key] ?? {
      offerMw: o?.offerMw ? String(o.offerMw) : '', offerPrice: o?.offerPrice != null ? String(o.offerPrice) : '',
      bidMw: o?.bidMw ? String(o.bidMw) : '', bidPrice: o?.bidPrice != null ? String(o.bidPrice) : '',
    };
    return { sp, open, o, key, d };
  });
  const accepted = visibleBoas(state).filter(a => a.day === today).slice().reverse();
  const P = state.battery.config.powerRatingMw;
  const num = (v: string) => (v.trim() === '' ? NaN : Number(v));

  const save = (sp: number, key: string, d: Draft) => {
    onSetBmOrder({
      day: today, sp,
      offerMw: num(d.offerMw) || 0, offerPrice: Number.isFinite(num(d.offerPrice)) ? num(d.offerPrice) : null,
      bidMw: num(d.bidMw) || 0, bidPrice: Number.isFinite(num(d.bidPrice)) ? num(d.bidPrice) : null,
    });
    setDrafts(prev => { const n = { ...prev }; delete n[key]; return n; });
  };

  return (
    <div className="bm-panel">
      <div className="bm-note">
        <strong>BM unit:</strong> your FPN (= contracted position at gate closure) is binding — deliberate deviation isn't allowed (Grid Code). Offer flexibility to NESO instead.
        <HelpIcon text="Offer = price you want to be PAID to discharge extra MW. Bid = price you PAY to charge extra MW (a negative bid means you get paid). NESO accepts at the start of the SP when the system needs you: offers when it's short and your price is at or below the marginal (≈ SIP), bids when it's long and your bid is at or above it. Accepted volumes (BOAs) change your position — no imbalance — and are paid at your own price (pay-as-bid). Prices can be changed until gate closure (T-60)." />
      </div>
      <table className="data-table bm-table">
        <thead>
          <tr><th>SP</th><th>Offer MW</th><th>Offer £</th><th>Bid MW</th><th>Bid £</th><th /></tr>
        </thead>
        <tbody>
          {rows.map(({ sp, open, key, d, o }) => {
            const set = (f: keyof Draft, v: string) => setDrafts(prev => ({ ...prev, [key]: { ...d, [f]: v } }));
            const dirty = Boolean(drafts[key]);
            return (
              <tr key={sp} className={open ? '' : 'muted'}>
                <td>{spLabel(sp)}</td>
                <td><input className="input" type="number" min={0} max={P} value={d.offerMw} disabled={!open} onChange={e => set('offerMw', e.target.value)} /></td>
                <td><input className="input" type="number" step={1} value={d.offerPrice} disabled={!open} onChange={e => set('offerPrice', e.target.value)} placeholder="—" /></td>
                <td><input className="input" type="number" min={0} max={P} value={d.bidMw} disabled={!open} onChange={e => set('bidMw', e.target.value)} /></td>
                <td><input className="input" type="number" step={1} value={d.bidPrice} disabled={!open} onChange={e => set('bidPrice', e.target.value)} placeholder="—" /></td>
                <td>
                  {open
                    ? <button className={`btn btn-sm ${dirty ? 'btn-buy' : 'btn-ghost'}`} disabled={!dirty} onClick={() => save(sp, key, d)}>{dirty ? 'Save' : o ? '✓ set' : '—'}</button>
                    : <span className="muted">gate closed</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="bm-boas">
        <span className="isp-label">BOAs today</span>
        {accepted.length === 0
          ? <span className="muted"> none yet</span>
          : accepted.slice(0, 8).map((a, i) => {
            if (a.status === 'skipped') {
              return (
                <span key={i} className="bm-boa skipped" title="Your price was in merit, but the control room dispatched other units instead ('skip'). A known issue for batteries in the GB BM.">
                  {spLabel(a.sp)} skipped · in merit at £{a.price.toFixed(0)}
                </span>
              );
            }
            // A BOA runs from its start interval to the SP end and is paid at your price.
            const cash = (a.kind === 'offer' ? 1 : -1) * a.mw * 0.5 * a.price;
            const status = a.sp < curSp ? 'delivered' : a.sp === curSp ? 'running' : 'scheduled';
            return (
              <span key={i} className={`bm-boa ${a.kind}`} title={`BOA: ${a.instructedMw ?? a.mw} MW from :${String((a.startSubIdx ?? 0) * 5).padStart(2, '0')} to the end of the SP = ${(a.mw * 0.5).toFixed(1)} MWh (SP average ${a.mw} MW) at your price £${a.price.toFixed(2)} (pay-as-bid). Counts as a contract — no imbalance.`}>
                {spLabel(a.sp)} {a.kind === 'offer' ? '+' : '−'}{a.instructedMw ?? a.mw} MW{a.startSubIdx ? ` from :${String(a.startSubIdx * 5).padStart(2, '0')}` : ''} @ £{a.price.toFixed(0)} · {status} · {cash >= 0 ? '+' : '−'}£{Math.abs(cash).toFixed(0)}
              </span>
            );
          })}
        {accepted.length > 0 && (() => {
          const total = accepted.filter(a => a.status !== 'skipped').reduce((s, a) => s + (a.kind === 'offer' ? 1 : -1) * a.mw * 0.5 * a.price, 0);
          return <span className="bm-boa-total">BM cash today: <strong className={total >= 0 ? 'positive' : 'negative'}>{total >= 0 ? '+' : '−'}£{Math.abs(total).toFixed(0)}</strong></span>;
        })()}
      </div>
    </div>
  );
}
