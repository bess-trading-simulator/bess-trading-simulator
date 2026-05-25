import type { MarketEvent } from '../engine/types';
import { formatHour } from '../engine/clock';
import HelpIcon from './HelpIcon';
import { Cloud, AlertTriangle, BarChart3, Leaf, Shield } from 'lucide-react';

interface Props {
  events: MarketEvent[];
}

const categoryIcons: Record<string, React.ReactNode> = {
  weather: <Cloud size={14} />,
  outage: <AlertTriangle size={14} />,
  demand: <BarChart3 size={14} />,
  renewable: <Leaf size={14} />,
  policy: <Shield size={14} />,
};

const categoryColors: Record<string, string> = {
  weather: '#007be2',
  outage: '#ff5f62',
  demand: '#ff874b',
  renewable: '#00a15d',
  policy: '#c7b4f8',
};

export default function NewsFeed({ events }: Props) {
  return (
    <div className="panel news-feed" id="news">
      <div className="panel-header">
        <h3>Market News</h3>
        <HelpIcon text="Events that affect electricity prices. Use this to anticipate price moves — charge before prices drop (high wind/solar), discharge before spikes (cold weather, plant outages)." />
      </div>
      <div className="news-list">
        {events.length === 0 ? (
          <div className="empty-state">
            No market events yet. Start the simulation to see news.
          </div>
        ) : (
          events.slice(0, 15).map((event, index) => (
            <div key={`${event.id}-${event.timestamp}-${index}`} className="news-item" style={{ borderLeftColor: categoryColors[event.category] }}>
              <div className="news-header">
                <span className="news-category" style={{ color: categoryColors[event.category] }}>
                  {categoryIcons[event.category]} {event.category}
                </span>
                <span className="news-time">
                  {formatHour(event.timestamp)}
                </span>
              </div>
              <div className="news-headline">{event.headline}</div>
              <div className="news-description">{event.description}</div>
              <div className={`news-impact ${event.priceImpact >= 0 ? 'positive' : 'negative'}`}>
                Price impact: {event.priceImpact >= 0 ? '+' : ''}£{event.priceImpact.toFixed(2)}/MWh
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
