import { useState } from 'react';
import type { BatteryState } from '../engine/battery';
import { getMaxChargeableMw, getMaxDischargeableMw } from '../engine/battery';
import HelpIcon from './HelpIcon';
import { ArrowDown, ArrowUp } from 'lucide-react';

interface Props {
  battery: BatteryState;
  currentPrice: number;
  onCharge: (mw: number) => void;
  onDischarge: (mw: number) => void;
}

export default function ChargeDischargeControls({ battery, currentPrice, onCharge, onDischarge }: Props) {
  const [chargeMw, setChargeMw] = useState(battery.config.powerRatingMw);
  const [dischargeMw, setDischargeMw] = useState(battery.config.powerRatingMw);

  const maxCharge = getMaxChargeableMw(battery);
  const maxDischarge = getMaxDischargeableMw(battery);
  const canCharge = maxCharge >= 0.1;
  const canDischarge = maxDischarge >= 0.1;

  const chargeCost = Math.min(chargeMw, maxCharge) * 0.5 * currentPrice;
  const dischargeRevenue = Math.min(dischargeMw, maxDischarge) * 0.5 * currentPrice;
  const chargeEnergyMwh = Math.min(chargeMw, maxCharge) * 0.5;
  const storedEnergyMwh = chargeEnergyMwh * (battery.config.efficiencyPct / 100);
  const dischargeEnergyMwh = Math.min(dischargeMw, maxDischarge) * 0.5;

  return (
    <div className="panel controls-panel" id="controls">
      <div className="panel-header">
        <h3>Controls</h3>
        <HelpIcon text="CHARGE buys electricity from the grid to store in your battery (costs money). DISCHARGE sells stored electricity back to the grid (earns money). Charge when prices are low, discharge when high!" />
      </div>

      <div className="current-price-banner">
        Current Price: <strong>£{currentPrice.toFixed(2)}/MWh</strong>
        {currentPrice < 30 && <span className="price-hint good">Good time to charge</span>}
        {currentPrice > 70 && <span className="price-hint great">Good time to discharge</span>}
        {currentPrice < 0 && <span className="price-hint amazing">Negative price! Charge now!</span>}
      </div>
      <div className="constraint-note">
        This battery is rated at {battery.config.powerRatingMw} MW, so {battery.config.powerRatingMw} MW is allowed for one settlement period if SoC/headroom permits. One half-hour at 50 MW equals 25 MWh. Charging/discharging here is an imbalance position: it settles at the SIP published after the SP — the costs shown use the current price as an estimate.
      </div>

      <div className="controls-grid">
        {/* Charge section */}
        <div className="control-section charge-section">
          <h4><ArrowDown size={16} /> Charge</h4>
          <p className="control-desc">Buy electricity, store in battery</p>

          <div className="mw-slider-group">
            <label>Power: {Math.min(chargeMw, maxCharge).toFixed(0)} MW</label>
            <input
              type="range"
              min={1}
              max={battery.config.powerRatingMw}
              step={1}
              value={chargeMw}
              onChange={e => setChargeMw(Number(e.target.value))}
              className="mw-slider"
              disabled={!canCharge}
            />
          </div>

          <div className="control-cost">
            Cost: <span className="negative">-£{chargeCost.toFixed(2)}</span>
          </div>
          <div className="control-energy">
            Grid energy: {chargeEnergyMwh.toFixed(1)} MWh · Stored after efficiency: {storedEnergyMwh.toFixed(1)} MWh
          </div>

          <button
            className="btn btn-action btn-charge"
            onClick={() => onCharge(Math.min(chargeMw, maxCharge))}
            disabled={!canCharge}
          >
            {canCharge
              ? `CHARGE ${Math.min(chargeMw, maxCharge).toFixed(0)} MW`
              : 'Battery Full'
            }
          </button>
        </div>

        {/* Discharge section */}
        <div className="control-section discharge-section">
          <h4><ArrowUp size={16} /> Discharge</h4>
          <p className="control-desc">Sell stored electricity to grid</p>

          <div className="mw-slider-group">
            <label>Power: {Math.min(dischargeMw, maxDischarge).toFixed(0)} MW</label>
            <input
              type="range"
              min={1}
              max={battery.config.powerRatingMw}
              step={1}
              value={dischargeMw}
              onChange={e => setDischargeMw(Number(e.target.value))}
              className="mw-slider"
              disabled={!canDischarge}
            />
          </div>

          <div className="control-cost">
            Revenue: <span className="positive">+£{dischargeRevenue.toFixed(2)}</span>
          </div>
          <div className="control-energy">
            Battery energy delivered this SP: {dischargeEnergyMwh.toFixed(1)} MWh
          </div>

          <button
            className="btn btn-action btn-discharge"
            onClick={() => onDischarge(Math.min(dischargeMw, maxDischarge))}
            disabled={!canDischarge}
          >
            {canDischarge
              ? `DISCHARGE ${Math.min(dischargeMw, maxDischarge).toFixed(0)} MW`
              : 'Battery Empty'
            }
          </button>
        </div>
      </div>
    </div>
  );
}
