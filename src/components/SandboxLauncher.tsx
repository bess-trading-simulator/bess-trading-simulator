import { useState } from 'react';
import { ArrowLeft, ArrowRight, Calendar, Activity, Zap, Globe, Lock, CheckCircle2, Radio } from 'lucide-react';
import type { AppView } from '../engine/types';
import ThemeToggle from './ThemeToggle';
import { HISTORICAL_DAYS } from '../data/historicalDays';
import type { HistoricalDay } from '../data/historicalDays';
import { STRATEGIES } from '../data/strategies';

export type SandboxMarket = 'GB';
export type SandboxView = Exclude<AppView, 'analysis' | 'forecast'>;

interface Props {
  onConfirm: (views: SandboxView[], market: SandboxMarket, scenario: HistoricalDay | null) => void;
  onBack: () => void;
}

const difficultyColors: Record<HistoricalDay['difficulty'], string> = {
  easy: 'var(--text-muted)',
  medium: 'var(--text-secondary)',
  hard: 'var(--text-primary)',
};

const viewIcons: Record<SandboxView, typeof Calendar> = {
  dayahead: Calendar,
  intraday: Zap,
  imbalance: Activity,
};

const MARKETS: { id: SandboxMarket; label: string; available: boolean; note?: string }[] = [
  { id: 'GB', label: 'Great Britain', available: true },
];

/** Simple circular Union Jack used as the GB market marker. */
function GbFlagCircle() {
  return (
    <svg className="launcher-flag" viewBox="0 0 60 60" width="22" height="22" aria-hidden="true">
      <defs>
        <clipPath id="gb-circle"><circle cx="30" cy="30" r="30" /></clipPath>
      </defs>
      <g clipPath="url(#gb-circle)">
        <rect width="60" height="60" fill="#012169" />
        <path d="M0,0 L60,60 M60,0 L0,60" stroke="#fff" strokeWidth="12" />
        <path d="M0,0 L60,60 M60,0 L0,60" stroke="#C8102E" strokeWidth="5" />
        <path d="M30,0 V60 M0,30 H60" stroke="#fff" strokeWidth="16" />
        <path d="M30,0 V60 M0,30 H60" stroke="#C8102E" strokeWidth="9" />
      </g>
    </svg>
  );
}

const ALL_VIEWS: SandboxView[] = ['dayahead', 'intraday', 'imbalance'];

export default function SandboxLauncher({ onConfirm, onBack }: Props) {
  const [selected, setSelected] = useState<Set<SandboxView>>(new Set());
  const [market, setMarket] = useState<SandboxMarket>('GB');
  const [scenarioId, setScenarioId] = useState<string>('live');

  const toggle = (id: SandboxView) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(ALL_VIEWS));
  const clearAll = () => setSelected(new Set());

  const canStart = selected.size > 0;

  const handleConfirm = () => {
    if (!canStart) return;
    const orderedViews = ALL_VIEWS.filter((v) => selected.has(v));
    const scenario = scenarioId === 'live' ? null : HISTORICAL_DAYS.find((d) => d.id === scenarioId) ?? null;
    onConfirm(orderedViews, market, scenario);
  };

  return (
    <main className="sandbox-launcher">
      <header className="sandbox-launcher-header">
        <button className="btn btn-ghost" onClick={onBack}>
          <ArrowLeft size={16} /> Back
        </button>
        <h1>Configure Sandbox</h1>
        <ThemeToggle />
      </header>

      <section className="launcher-step">
        <div className="launcher-step-head">
          <span className="launcher-step-num">1</span>
          <div className="launcher-step-title">
            <h2>Choose your market region</h2>
            <p>More regions are planned. For now, only Great Britain is available.</p>
          </div>
        </div>
        <div className="launcher-grid">
          {MARKETS.map((m) => {
            const isSelected = market === m.id;
            return (
              <button
                key={m.id}
                className={`launcher-card market ${isSelected ? 'selected' : ''} ${!m.available ? 'disabled' : ''}`}
                disabled={!m.available}
                onClick={() => m.available && setMarket(m.id)}
              >
                <div className="launcher-card-head">
                  {m.id === 'GB'
                    ? <GbFlagCircle />
                    : m.available ? <Globe size={20} /> : <Lock size={20} />}
                  <div>
                    <h3>{m.label}</h3>
                    {m.note && <span className="launcher-card-sub">{m.note}</span>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="launcher-step">
        <div className="launcher-step-head">
          <span className="launcher-step-num">2</span>
          <div className="launcher-step-title">
            <h2>Choose a day</h2>
            <p>Start on today's live Elexon data, or load a curated historical scenario. You can switch days any time from the menu.</p>
          </div>
        </div>
        <div className="launcher-grid scenario-grid">
          <button
            className={`launcher-card ${scenarioId === 'live' ? 'selected' : ''}`}
            onClick={() => setScenarioId('live')}
            aria-pressed={scenarioId === 'live'}
          >
            <div className="launcher-card-head">
              <Radio size={20} />
              <div>
                <h3>Live market</h3>
                <span className="launcher-card-sub">Today · Elexon BMRS</span>
              </div>
              {scenarioId === 'live' && <CheckCircle2 size={18} className="launcher-card-check" />}
            </div>
            <p>Trade the most recent real GB market day, with live day-ahead, NIV, wind, demand and solar forecasts.</p>
          </button>

          {HISTORICAL_DAYS.map((day) => {
            const isSelected = scenarioId === day.id;
            return (
              <button
                key={day.id}
                className={`launcher-card ${isSelected ? 'selected' : ''}`}
                onClick={() => setScenarioId(day.id)}
                aria-pressed={isSelected}
              >
                <div className="launcher-card-head">
                  <Calendar size={20} />
                  <div>
                    <h3>{day.title}</h3>
                    <span className="launcher-card-sub">{day.date}</span>
                  </div>
                  <span
                    className="scenario-difficulty"
                    style={{ color: difficultyColors[day.difficulty] }}
                  >
                    {day.difficulty}
                  </span>
                  {isSelected && <CheckCircle2 size={18} className="launcher-card-check" />}
                </div>
                <p>{day.description}</p>
              </button>
            );
          })}
        </div>
      </section>

      <section className="launcher-step">
        <div className="launcher-step-head">
          <span className="launcher-step-num">3</span>
          <div className="launcher-step-title">
            <h2>Choose your revenue streams</h2>
            <p>Pick any combination of the markets you want to trade. Greyed-out streams aren't simulated yet. Analysis is always available for post-trade review.</p>
          </div>
          <div className="launcher-quick-actions">
            <button className="btn btn-ghost btn-sm" onClick={selectAll}>Select all</button>
            <button className="btn btn-ghost btn-sm" onClick={clearAll} disabled={selected.size === 0}>Clear</button>
          </div>
        </div>

        <div className="launcher-grid">
          {STRATEGIES.map((s) => {
            const Icon = s.view ? viewIcons[s.view] : Lock;
            const selectable = !!s.view && !s.comingSoon;
            const isSelected = selectable && selected.has(s.view!);
            return (
              <button
                key={s.mode}
                className={`launcher-card ${isSelected ? 'selected' : ''} ${s.comingSoon ? 'disabled' : ''}`}
                onClick={() => selectable && toggle(s.view!)}
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
      </section>

      <footer className="launcher-footer">
        <span className="launcher-summary">
          {selected.size === 0
            ? 'Select at least one market to continue.'
            : `${selected.size} market${selected.size === 1 ? '' : 's'} selected · ${scenarioId === 'live' ? 'Live data' : 'Scenario'} · Analysis included`}
        </span>
        <button
          className="btn btn-submit btn-buy"
          disabled={!canStart}
          onClick={handleConfirm}
        >
          Enter Sandbox <ArrowRight size={16} />
        </button>
      </footer>
    </main>
  );
}
