import { useState } from 'react';
import type { GameState } from '../engine/types';
import { formatDeliveryDay, getUtcDayStart, getSettlementPeriod } from '../engine/clock';
import { X } from 'lucide-react';

/**
 * Scenario briefing → live → debrief strip. Before the scenario day it tells you
 * to bid for it in the day-ahead auctions; on the day it is a reminder; at the
 * end of the scenario day the teaching points (spoilers) are revealed.
 */
export default function ScenarioBanner({ state }: { state: GameState }) {
  const sc = state.scenario;
  const [hidden, setHidden] = useState<string | null>(null);
  if (!sc) return null;
  const today = getUtcDayStart(state.clock.currentTime);
  const sp = getSettlementPeriod(state.clock.currentTime) - 1;
  const phase = today < sc.day ? 'brief' : today === sc.day && sp < 46 ? 'live' : 'debrief';
  const key = `${sc.id}:${phase}`;
  if (hidden === key) return null;
  return (
    <div className={`scenario-banner ${phase}`}>
      <div className="scenario-banner-body">
        <strong>{phase === 'brief' ? 'Scenario briefing' : phase === 'live' ? 'Scenario day live' : 'Scenario debrief'} · {sc.title}</strong>
        <span className="muted"> · {sc.realData ? 'real Elexon day' : 'illustrative'} · {formatDeliveryDay(sc.day)}</span>
        {phase === 'brief' && (
          <p>
            Tomorrow is the scenario day. Bid for it in the Day-Ahead tab (hourly auction 09:20, 30-min auction 15:30) — read the desk signals: they hint at what's coming.
            {sc.description ? ` ${sc.description}` : ''}
          </p>
        )}
        {phase === 'live' && <p>Watch the news as the day unfolds — adjust intraday (gate T-60) and use imbalance deliberately.</p>}
        {phase === 'debrief' && (
          sc.teachingPoints.length
            ? <ul>{sc.teachingPoints.map((t, i) => <li key={i}>{t}</li>)}</ul>
            : <p>Scenario day complete — review your results in Day Ahead → Today and in Analysis.</p>
        )}
      </div>
      <button className="btn btn-ghost btn-sm" onClick={() => setHidden(key)} aria-label="Dismiss"><X size={14} /></button>
    </div>
  );
}
