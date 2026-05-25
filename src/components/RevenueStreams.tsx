import { useState } from 'react';
import { BookOpen, X, Lock, CheckCircle2, Calendar, Zap, Activity } from 'lucide-react';
import type { SandboxView } from './SandboxLauncher';
import { STRATEGIES } from '../data/strategies';

interface Props {
  enabledViews: SandboxView[];
  onToggleView: (view: SandboxView) => void;
}

const viewIcons: Record<SandboxView, typeof Calendar> = {
  dayahead: Calendar,
  intraday: Zap,
  imbalance: Activity,
};

export default function RevenueStreams({ enabledViews, onToggleView }: Props) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button className="btn btn-strategy-toggle" id="strategies" onClick={() => setIsOpen(true)}>
        <BookOpen size={16} /> Revenue Streams
      </button>

      {isOpen && (
        <div className="modal-overlay" onClick={() => setIsOpen(false)}>
          <div className="modal strategy-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Revenue Streams</h2>
              <button className="btn btn-icon" onClick={() => setIsOpen(false)}><X size={18} /></button>
            </div>
            <p className="strategy-intro">
              Toggle the markets you want to trade — they stack, so pick any combination.
              Greyed-out streams aren't simulated yet.
            </p>

            <div className="launcher-grid">
              {STRATEGIES.map(s => {
                const Icon = s.view ? viewIcons[s.view] : Lock;
                const selectable = !!s.view && !s.comingSoon;
                const isSelected = selectable && enabledViews.includes(s.view!);
                return (
                  <button
                    key={s.mode}
                    className={`launcher-card ${isSelected ? 'selected' : ''} ${s.comingSoon ? 'disabled' : ''}`}
                    onClick={() => selectable && onToggleView(s.view!)}
                    aria-pressed={isSelected}
                    disabled={!selectable}
                  >
                    <div className="launcher-card-head">
                      <Icon size={20} />
                      <div>
                        <h3>{s.streamLabel}</h3>
                        <span className="launcher-card-sub">{s.tagline}</span>
                      </div>
                      {s.comingSoon
                        ? <span className="strategy-soon-tag"><Lock size={11} /> Coming soon</span>
                        : isSelected && <CheckCircle2 size={18} className="launcher-card-check" />}
                    </div>
                    <p>{s.description}</p>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
