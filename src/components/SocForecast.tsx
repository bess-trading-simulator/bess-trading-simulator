import type { BatteryState } from '../engine/battery';
import type { DayAheadState } from '../engine/types';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { BatteryWarning } from 'lucide-react';

interface Props {
  battery: BatteryState;
  dayAhead: DayAheadState;
}

export default function SocForecast({ battery, dayAhead }: Props) {
  const cap = battery.config.capacityMwh;
  const min = cap * (battery.config.minSocPct / 100);
  const max = cap * (battery.config.maxSocPct / 100);
  const eff = battery.config.efficiencyPct / 100;

  const forecast = Array.from({ length: 48 }).reduce<{ soc: number; feasible: boolean; data: Array<{ sp: string; socPct: number; feasible: boolean }> }>((acc, _, period) => {
    const positions = dayAhead.playerSchedule.filter(position => position.period === period);
    let nextSoc = acc.soc;
    for (const position of positions) {
      if (position.action === 'charge') nextSoc += position.mw * 0.5 * eff;
      else nextSoc -= position.mw * 0.5;
    }
    const periodFeasible = nextSoc >= min && nextSoc <= max;
    acc.data.push({
      sp: `${String(Math.floor(period / 2)).padStart(2, '0')}:${period % 2 === 0 ? '00' : '30'}`,
      socPct: Math.max(0, Math.min(100, (nextSoc / cap) * 100)),
      feasible: periodFeasible,
    });
    return { soc: nextSoc, feasible: acc.feasible && periodFeasible, data: acc.data };
  }, { soc: battery.currentSocMwh, feasible: true, data: [] });

  return (
    <div className="panel soc-forecast-panel">
      <div className="panel-header">
        <h3><BatteryWarning size={15} /> SoC Forecast</h3>
      </div>
      <div className={`soc-feasibility ${forecast.feasible ? 'positive' : 'negative'}`}>
        {forecast.feasible ? 'Schedule looks physically feasible.' : 'Schedule may break battery SoC limits.'}
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={forecast.data} margin={{ top: 5, right: 12, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
          <XAxis dataKey="sp" stroke="#888" fontSize={9} interval={5} />
          <YAxis stroke="#888" fontSize={11} domain={[0, 100]} />
          <Tooltip formatter={(value: unknown) => [`${Number(value).toFixed(1)}%`, 'SoC']} />
          <ReferenceLine y={battery.config.minSocPct} stroke="#ff5f62" strokeDasharray="3 3" />
          <ReferenceLine y={battery.config.maxSocPct} stroke="#ff5f62" strokeDasharray="3 3" />
          <Line type="monotone" dataKey="socPct" stroke="#00a15d" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
