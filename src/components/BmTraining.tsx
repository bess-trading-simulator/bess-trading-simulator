import { useMemo, useState } from 'react';
import { CheckCircle, RadioTower, XCircle } from 'lucide-react';
import type { BmDirection, GameState } from '../engine/types';
import { getSettlementPeriod } from '../engine/clock';

interface Props {
  state: GameState;
  onSubmitBmOffer: (period: number, direction: BmDirection, mw: number, price: number) => void;
}

function spLabel(period: number): string {
  const hour = Math.floor(period / 2);
  return `${String(hour).padStart(2, '0')}:${period % 2 === 0 ? '00' : '30'}`;
}

function getBmReference(state: GameState, period: number): { price: number; label: string } {
  const da = state.dayAhead.forecastPrices[period] ?? state.currentPrice?.price ?? 50;
  const sip = period < state.dayAhead.revealedPeriods && state.dayAhead.sipOutturn[period] !== 0
    ? state.dayAhead.sipOutturn[period]
    : null;
  const niv = state.dayAhead.niv[period] ?? 0;
  // Elexon sign: short (+NIV) lifts the reference, long (−NIV) lowers it
  const nivAdjustment = Math.max(-18, Math.min(18, niv / 35));
  const price = sip === null
    ? da + nivAdjustment
    : (da * 0.35) + (sip * 0.65) + (nivAdjustment * 0.5);

  return {
    price: Math.round(price * 100) / 100,
    label: sip === null
      ? `DA £${da.toFixed(2)} plus NIV adjustment`
      : `DA £${da.toFixed(2)}, SIP £${sip.toFixed(2)}, NIV ${niv}`,
  };
}

function getSuggestedBmPrice(referencePrice: number, direction: BmDirection): number {
  return direction === 'offer'
    ? Math.round((referencePrice + 25) * 100) / 100
    : Math.round((referencePrice - 20) * 100) / 100;
}

export default function BmTraining({ state, onSubmitBmOffer }: Props) {
  const currentPeriod = Math.max(0, getSettlementPeriod(state.clock.currentTime) - 1);
  const defaultPeriod = Math.min(47, currentPeriod + 2);
  const [period, setPeriod] = useState(defaultPeriod);
  const [direction, setDirection] = useState<BmDirection>('offer');
  const [mw, setMw] = useState(Math.min(25, state.battery.config.powerRatingMw));
  const reference = getBmReference(state, period);
  const referencePrice = reference.price;
  const suggestedPrice = getSuggestedBmPrice(referencePrice, direction);
  const [price, setPrice] = useState(suggestedPrice);

  const periodOptions = useMemo(() => {
    return Array.from({ length: 12 }, (_, idx) => Math.min(47, currentPeriod + idx + 1))
      .filter((value, idx, arr) => arr.indexOf(value) === idx);
  }, [currentPeriod]);

  const actionText = direction === 'offer' ? 'discharge if accepted' : 'charge if accepted';
  const mwh = mw * 0.5;
  const pendingAccepted = (state.bm?.accepted ?? [])
    .filter(offer => !state.dayAhead.playerSchedule.some(position =>
      position.market === 'bm' &&
      position.period === offer.period &&
      position.lockedAt === offer.submittedAt &&
      position.delivered,
    ))
    .sort((a, b) => a.period - b.period);
  const nextAccepted = pendingAccepted[0];

  const handleDirection = (next: BmDirection) => {
    setDirection(next);
    setPrice(getSuggestedBmPrice(referencePrice, next));
  };

  const handlePeriod = (nextPeriod: number) => {
    setPeriod(nextPeriod);
    setPrice(getSuggestedBmPrice(getBmReference(state, nextPeriod).price, direction));
  };

  const handleSubmit = () => {
    onSubmitBmOffer(period, direction, mw, price);
  };

  return (
    <div className="panel bm-training">
      <div className="panel-header">
        <h3><RadioTower size={15} /> Balancing Mechanism</h3>
      </div>

      <div className="bm-simple-rule">
        <strong>Simple rule:</strong> BM is where the system operator pays you to help in real time.
        Offer = discharge. Bid = charge.
      </div>

      <div className={`bm-pending ${nextAccepted ? 'active' : ''}`}>
        <strong>{nextAccepted ? 'Accepted instruction pending delivery' : 'No accepted BM instruction waiting'}</strong>
        <span>
          {nextAccepted
            ? `SP${nextAccepted.period + 1} ${spLabel(nextAccepted.period)} will ${nextAccepted.direction === 'bid' ? 'charge' : 'discharge'} ${nextAccepted.mw.toFixed(0)} MW at £${nextAccepted.price.toFixed(2)}/MWh when that settlement period arrives.`
            : 'Accepted BM bids/offers will appear here until the delivery SP moves the battery.'}
        </span>
      </div>

      <div className="bm-controls">
        <div className="bm-direction">
          <button className={`btn ${direction === 'offer' ? 'btn-sell' : ''}`} onClick={() => handleDirection('offer')}>
            Offer: discharge
          </button>
          <button className={`btn ${direction === 'bid' ? 'btn-buy' : ''}`} onClick={() => handleDirection('bid')}>
            Bid: charge
          </button>
        </div>

        <label className="bm-field">
          Settlement period
          <select className="input" value={period} onChange={event => handlePeriod(Number(event.target.value))}>
            {periodOptions.map(sp => (
              <option key={sp} value={sp}>SP{sp + 1} · {spLabel(sp)}</option>
            ))}
          </select>
        </label>

        <div className="bm-grid">
          <label className="bm-field">
            MW
            <input
              className="input"
              type="number"
              min="1"
              max={state.battery.config.powerRatingMw}
              value={mw}
              onChange={event => setMw(Number(event.target.value))}
            />
          </label>
          <label className="bm-field">
            Price £/MWh
            <input
              className="input"
              type="number"
              value={price}
              onChange={event => setPrice(Number(event.target.value))}
            />
          </label>
        </div>

        <div className="bm-ticket">
          <span>{actionText}</span>
          <strong>{mw.toFixed(0)} MW for 30 mins = {mwh.toFixed(1)} MWh</strong>
          <small>SP reference: £{referencePrice.toFixed(2)}/MWh · {reference.label}</small>
        </div>

        <button className="btn btn-submit btn-buy" onClick={handleSubmit}>
          Submit BM price
        </button>
      </div>

      <div className="bm-history">
        <h4>Submitted prices</h4>
        {(state.bm?.offers.length ?? 0) === 0 ? (
          <div className="empty-state">No BM prices submitted yet.</div>
        ) : (
          state.bm.offers.slice(0, 6).map(offer => (
            <div key={offer.id} className={`bm-offer ${offer.accepted ? 'accepted' : 'rejected'}`}>
              <div className="bm-offer-main">
                {offer.accepted ? <CheckCircle size={14} /> : <XCircle size={14} />}
                <strong>{offer.direction === 'offer' ? 'Offer discharge' : 'Bid charge'}</strong>
                <span>SP{offer.period + 1} · {offer.mw.toFixed(0)} MW · £{offer.price.toFixed(2)} · rank {offer.stackRank}/40 · {(offer.acceptanceProbability * 100).toFixed(0)}%</span>
              </div>
              <small>{offer.reason}</small>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
