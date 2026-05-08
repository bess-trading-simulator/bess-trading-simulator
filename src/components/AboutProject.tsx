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
                <span>Learning BESS dispatch, scheduling, intraday revisions, SIP/NIV review, and market context.</span>
              </div>
              <div>
                <strong>Simplified</strong>
                <span>Market mechanics are simplified and order books, fees, and collateral are not modelled.</span>
              </div>
              <div>
                <strong>Data</strong>
                <span>Loads actual GB settlement prices, day-ahead forecasts, and NIV from the Elexon BMRS API. Falls back to synthetic data if unavailable.</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

