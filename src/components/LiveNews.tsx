import type { MarketEvent } from '../engine/types';
import { getUtcDayStart } from '../engine/clock';

const time = (t: number) => {
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

/** News that broke during today's delivery (e.g. an interconnector trip). */
export default function LiveNews({ events, now }: { events: MarketEvent[]; now: number }) {
  const today = getUtcDayStart(now);
  const live = events.filter(e => e.id.startsWith('live-') && getUtcDayStart(e.timestamp) === today).slice(0, 3);
  if (live.length === 0) return null;
  return (
    <div className="live-news">
      <span className="live-news-label">Live news</span>
      {live.map((e, i) => (
        <span key={e.id} className={`live-news-item ${e.category} ${i === 0 ? 'latest' : ''}`}>
          <span className="live-news-time">{time(e.timestamp)}</span> {e.headline}
        </span>
      ))}
    </div>
  );
}
