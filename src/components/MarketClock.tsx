import type { SpeedPreset } from '../engine/types';
import { formatHour, getSettlementPeriod } from '../engine/clock';
import { Pause, Play, RotateCcw, SkipForward } from 'lucide-react';

interface Props {
  currentTime: number;
  isPaused: boolean;
  speed: SpeedPreset;
  onTogglePause: () => void;
  onSetSpeed: (s: SpeedPreset) => void;
  onStepForward: () => void;
  onReset: () => void;
  /** Hide speed select + reset (moved into the header menu) */
  compact?: boolean;
}

export const speedOptions: { key: SpeedPreset; label: string }[] = [
  { key: 'manual', label: 'Manual' },
  { key: 'slow', label: 'Slow' },
  { key: 'normal', label: 'Normal' },
  { key: 'fast', label: 'Fast' },
  { key: 'ultra', label: 'Ultra' },
];

export default function MarketClock({ currentTime, isPaused, speed, onTogglePause, onSetSpeed, onStepForward, onReset, compact = false }: Props) {
  const d = new Date(currentTime);
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }).toUpperCase();
  const dayMonth = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });

  return (
    <div className="market-clock">
      <span className="mc-sp">SP{getSettlementPeriod(currentTime)}</span>
      <span className="mc-date">{weekday} {dayMonth}</span>
      <span className="mc-time">{formatHour(currentTime)}</span>
      <span className="mc-status">
        <span className={`status-dot ${isPaused || speed === 'manual' ? 'paused' : 'running'}`} />
        <span className="mc-status-text">{isPaused ? 'Paused' : speed === 'manual' ? 'Manual' : 'Live'}</span>
      </span>
      <span className="mc-controls">
        <button className="mc-btn" onClick={onTogglePause} title={isPaused ? 'Resume' : 'Pause'}>
          {isPaused ? <Play size={15} /> : <Pause size={15} />}
        </button>
        <button className="mc-btn" onClick={onStepForward} title="Step forward 1 settlement period (30 min)">
          <SkipForward size={15} />
        </button>
        {!compact && (
          <>
            <select
              className="input speed-select"
              value={speed}
              onChange={(e) => onSetSpeed(e.target.value as SpeedPreset)}
              title="Speed"
            >
              {speedOptions.map(s => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
            <button className="mc-btn" onClick={onReset} title="Reset">
              <RotateCcw size={15} />
            </button>
          </>
        )}
      </span>
    </div>
  );
}
