import { useState } from 'react';
import { GameMode } from '../engine/types';
import { ChevronDown, ChevronRight, Play, BookOpen, X, Lock } from 'lucide-react';
import { STRATEGIES } from '../data/strategies';

interface Props {
  currentMode: GameMode;
  onSelectMode: (mode: GameMode) => void;
}

export default function StrategyGuide({ currentMode, onSelectMode }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [expanded, setExpanded] = useState<GameMode | null>(null);

  return (
    <>
      <button className="btn btn-strategy-toggle" id="strategies" onClick={() => setIsOpen(true)}>
        <BookOpen size={16} /> Strategies
      </button>

      {isOpen && (
        <div className="modal-overlay" onClick={() => setIsOpen(false)}>
          <div className="modal strategy-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>GB Battery Trading Strategies</h2>
              <button className="btn btn-icon" onClick={() => setIsOpen(false)}><X size={18} /></button>
            </div>
            <p className="strategy-intro">
              The main revenue strategies for GB grid-scale batteries. Greyed-out
              strategies are not simulated yet — they're shown for context.
            </p>

            <div className="strategy-list">
              {STRATEGIES.map(s => (
                <div key={s.mode} className={`strategy-card ${currentMode === s.mode ? 'active-mode' : ''} ${s.comingSoon ? 'coming-soon' : ''}`}>
                  <button
                    className="strategy-header"
                    onClick={() => setExpanded(expanded === s.mode ? null : s.mode)}
                  >
                    <div className="strategy-title-row">
                      <h3>{s.name}</h3>
                      {s.comingSoon
                        ? <span className="strategy-soon-tag"><Lock size={11} /> Coming soon</span>
                        : <span className={`difficulty ${s.difficulty.toLowerCase()}`}>{s.difficulty}</span>}
                    </div>
                    <p className="strategy-tagline">{s.tagline}</p>
                    {expanded === s.mode ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>

                  {expanded === s.mode && (
                    <div className="strategy-details">
                      <div className="strategy-section"><h4>What is it?</h4><p>{s.description}</p></div>
                      <div className="strategy-section"><h4>How it works</h4><p>{s.howItWorks}</p></div>
                      <div className="strategy-section"><h4>Key metrics</h4><p>{s.keyMetrics}</p></div>
                      <div className="strategy-section tip"><h4>Tip</h4><p>{s.tip}</p></div>
                      <div className="strategy-section"><h4>In the real world</h4><p>{s.realWorld}</p></div>
                      {s.comingSoon ? (
                        <button className="btn btn-play-mode" disabled>
                          <Lock size={14} /> Not simulated yet
                        </button>
                      ) : (
                        <button
                          className={`btn btn-play-mode ${currentMode === s.mode ? 'btn-active-mode' : 'btn-buy'}`}
                          onClick={() => { onSelectMode(s.mode); setIsOpen(false); }}
                        >
                          {currentMode === s.mode ? 'Currently Active' : <><Play size={14} /> Activate Mode</>}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
