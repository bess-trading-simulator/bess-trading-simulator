import { Info, X } from 'lucide-react';
import { useState } from 'react';

export default function AboutProject() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>
        <Info size={16} /> About
      </button>
      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div className="modal about-modal" onClick={event => event.stopPropagation()}>
            <div className="modal-header">
              <h2>About This Simulator</h2>
              <button className="btn btn-icon" onClick={() => setOpen(false)}><X size={18} /></button>
            </div>
            <p>
              An educational simulator focused on core trading decisions: when to charge, discharge, or wait.
              Not a market replica, operational trading software, or intended for live trading decisions.
            </p>
            <div className="about-grid">
              <div>
                <strong>Good for</strong>
                <span>Learning how a GB battery is traded: day-ahead auctions, intraday order book, imbalance and the Balancing Mechanism.</span>
              </div>
              <div>
                <strong>Simplified</strong>
                <span>Other participants, liquidity and NESO decisions are modelled, not real. Collateral, network charges and ancillary services are not modelled.</span>
              </div>
              <div>
                <strong>Data</strong>
                <span>Real imbalance prices, NIV and Market Index Price from the Elexon BMRS API; desk forecasts are simulated. Falls back to synthetic data if unavailable.</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

