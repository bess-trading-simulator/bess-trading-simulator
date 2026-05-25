import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DayAheadState } from '../engine/types';

function label(period: number): string {
  return `${String(Math.floor(period / 2)).padStart(2, '0')}:${period % 2 === 0 ? '00' : '30'}`;
}

const COLORS = { demand: '#9272f5', wind: '#007be2', solar: '#ff874b' };

export default function RenewablesForecast({ dayAhead }: { dayAhead: DayAheadState }) {
  const hasForecast = dayAhead.demandForecast.some((v) => v > 0);
  if (!hasForecast) {
    return (
      <div className="panel renewables-forecast">
        <h3>Demand · Wind · Solar Forecast</h3>
        <p className="muted-note">No forecast data available for this day.</p>
      </div>
    );
  }

  const data = dayAhead.demandForecast.map((demand, sp) => ({
    sp: label(sp),
    demand: demand / 1000,
    wind: (dayAhead.windForecast[sp] ?? 0) / 1000,
    solar: (dayAhead.solarForecast[sp] ?? 0) / 1000,
  }));

  const names: Record<string, string> = { demand: 'Demand', wind: 'Wind', solar: 'Solar' };

  return (
    <div className="panel renewables-forecast">
      <h3>Demand · Wind · Solar Forecast</h3>
      <p className="muted-note">Day-ahead national forecast for the delivery day. Wind surplus pushes the system long (+NIV); high demand pushes it short (−NIV).</p>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data} margin={{ top: 6, right: 18, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke="#2c3245" strokeOpacity={0.6} vertical={false} />
          <XAxis dataKey="sp" stroke="#6b7280" fontSize={10} interval={5} tickLine={false} axisLine={false} />
          <YAxis stroke="#6b7280" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}GW`} />
          <Tooltip
            cursor={{ stroke: '#9272f5', strokeWidth: 1, strokeDasharray: '2 3' }}
            contentStyle={{ background: '#0f1420', border: '1px solid #1f2535', borderRadius: '6px', color: '#e5e7eb', fontSize: 11, padding: '6px 8px' }}
            labelStyle={{ color: '#6b7280', fontSize: 10, marginBottom: 2 }}
            itemStyle={{ padding: 0 }}
            formatter={(value: unknown, key: unknown) => [`${Number(value).toFixed(1)} GW`, names[key as string] ?? String(key)]}
          />
          <Line type="monotone" dataKey="demand" stroke={COLORS.demand} strokeWidth={2} dot={false} name="demand" isAnimationActive={false} />
          <Line type="monotone" dataKey="wind" stroke={COLORS.wind} strokeWidth={2} dot={false} name="wind" isAnimationActive={false} />
          <Line type="monotone" dataKey="solar" stroke={COLORS.solar} strokeWidth={2} dot={false} name="solar" isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      <div className="rf-legend">
        <span><i style={{ background: COLORS.demand }} /> Demand</span>
        <span><i style={{ background: COLORS.wind }} /> Wind</span>
        <span><i style={{ background: COLORS.solar }} /> Solar</span>
      </div>
    </div>
  );
}
