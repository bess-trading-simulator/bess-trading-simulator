import type { BatteryState, BatteryConfig } from '../engine/battery';
import { getRevenueSummary } from '../engine/battery';
import BatteryConfigPanel from './BatteryConfig';
import HelpIcon from './HelpIcon';
import { Battery, Zap } from 'lucide-react';

interface Props {
  battery: BatteryState;
  onConfigure?: (config: Partial<BatteryConfig>) => void;
}

function socColor(pct: number): string {
  if (pct < 15) return '#ff5f62';
  if (pct < 30) return '#ff874b';
  if (pct < 70) return '#00a15d';
  if (pct < 90) return '#007be2';
  return '#c7b4f8';
}

export default function BatteryStatus({ battery, onConfigure }: Props) {
  const summary = getRevenueSummary(battery);
  const color = socColor(battery.socPct);
  const lastAction = battery.cycleLog[0];

  return (
    <div className="panel battery-status" id="battery-status">
      <div className="panel-header">
        <h3>
          <Battery size={16} /> Your Battery
        </h3>
        <HelpIcon text="This shows your battery's current state. State of Charge (SoC) is how full it is. Charge when prices are low, discharge when high." />
        {onConfigure && (
          <BatteryConfigPanel config={battery.config} onApply={onConfigure} />
        )}
      </div>

      <div className="battery-gauge-container">
        <div className="battery-gauge">
          <div
            className="battery-fill"
            style={{ height: `${battery.socPct}%`, backgroundColor: color }}
          />
          <div className="battery-soc-label">
            {battery.socPct.toFixed(1)}%
          </div>
        </div>
        <div className="battery-details">
          <div className="battery-stat">
            <span className="stat-label">Stored</span>
            <span className="stat-value">{battery.currentSocMwh.toFixed(1)} MWh</span>
          </div>
          <div className="battery-stat">
            <span className="stat-label">Capacity</span>
            <span className="stat-value">{battery.config.capacityMwh} MWh</span>
          </div>
          <div className="battery-stat">
            <span className="stat-label">Power</span>
            <span className="stat-value">{battery.config.powerRatingMw} MW</span>
          </div>
          <div className="battery-stat">
            <span className="stat-label">Efficiency</span>
            <span className="stat-value">{battery.config.efficiencyPct}%</span>
          </div>
          <div className="battery-stat">
            <span className="stat-label">Cycles</span>
            <span className="stat-value">{summary.totalCycles}</span>
          </div>
        </div>
      </div>

      {lastAction && (
        <div className={`last-action ${lastAction.action}`}>
          <Zap size={12} />
          Last: {lastAction.action === 'charge' ? 'Charged' : 'Discharged'} {lastAction.mw} MW @ £{lastAction.price.toFixed(2)}
        </div>
      )}
    </div>
  );
}
