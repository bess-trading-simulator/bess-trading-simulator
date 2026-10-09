import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { GameState, SpeedPreset, AssetType } from '../engine/types';
import { LESSONS } from '../data/academy';
import type { AcademyView } from '../data/academy';
import MarketClock from './MarketClock';
import { CheckCircle2, Circle, ArrowLeft } from 'lucide-react';

interface Props {
  state: GameState;
  lessonId: number;
  onSelectLesson: (id: number) => void;
  onOpenSandbox: () => void;
  onSetAssetType: (t: AssetType) => void;
  onTogglePause: () => void;
  onSetSpeed: (s: SpeedPreset) => void;
  onStepForward: () => void;
  onReset: () => void;
  /** Renders the real sandbox market view (with Desk) for the lesson */
  renderView: (view: AcademyView) => ReactNode;
}

const DONE_KEY = 'bess-academy-done';
function loadDone(): number[] {
  try { return JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]'); } catch { return []; }
}

/** Guided lessons on the live sandbox markets; steps tick off from what you actually do. */
export default function Academy(props: Props) {
  const { state, lessonId, onSelectLesson } = props;
  const lesson = LESSONS.find(l => l.id === lessonId) ?? LESSONS[0];
  const [startedAt, setStartedAt] = useState(state.clock.currentTime);
  const [openedId, setOpenedId] = useState(lesson.id);
  const [done, setDone] = useState<number[]>(loadDone);

  // (Re)start the step tracking when a lesson is opened; set the asset type it needs.
  if (openedId !== lesson.id) {
    setOpenedId(lesson.id);
    setStartedAt(state.clock.currentTime);
  }
  const { onSetAssetType } = props;
  const needAsset = lesson.assetType;
  const haveAsset = state.assetType ?? 'non-bm';
  useEffect(() => {
    if (needAsset !== haveAsset) onSetAssetType(needAsset);
  }, [lesson.id, needAsset, haveAsset, onSetAssetType]);

  const ctx = { state, startedAt };
  const status = lesson.steps.map(s => s.done(ctx));
  const complete = status.every(Boolean);
  if (complete && !done.includes(lesson.id)) {
    const next = [...done, lesson.id];
    setDone(next);
    try { localStorage.setItem(DONE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }
  const current = status.findIndex(s => !s);

  return (
    <div className="app academy">
      <header className="app-header">
        <div className="header-left">
          <h1>BESS Trader</h1>
          <span className="hdr-sep" />
          <span className="hdr-tab active">Academy</span>
        </div>
        <div className="header-right">
          <MarketClock
            currentTime={state.clock.currentTime}
            isPaused={state.clock.isPaused}
            speed={state.clock.speed}
            onTogglePause={props.onTogglePause}
            onSetSpeed={props.onSetSpeed}
            onStepForward={props.onStepForward}
            onReset={props.onReset}
            compact
          />
          <span className="hdr-sep" />
          <button className="btn btn-ghost btn-sm" onClick={props.onOpenSandbox}><ArrowLeft size={14} /> Sandbox</button>
        </div>
      </header>

      <div className="academy-body">
        <nav className="academy-nav">
          {LESSONS.map(l => (
            <button key={l.id} className={`academy-nav-item ${l.id === lesson.id ? 'active' : ''}`} onClick={() => onSelectLesson(l.id)}>
              {done.includes(l.id) ? <CheckCircle2 size={14} className="positive" /> : <Circle size={14} />}
              <span><strong>{l.id}. {l.title}</strong><small>{l.subtitle}</small></span>
            </button>
          ))}
          <p className="muted academy-note">Lessons run on the same market as the sandbox (same clock, data and positions).</p>
        </nav>

        <section className="academy-main">
          <div className="academy-lesson">
            <div>
              <h2>{lesson.id}. {lesson.title}</h2>
              <p className="muted">{lesson.subtitle}</p>
              <ul className="academy-ideas">{lesson.ideas.map((t, i) => <li key={i}>{t}</li>)}</ul>
            </div>
            <ol className="academy-steps">
              {lesson.steps.map((s, i) => (
                <li key={i} className={status[i] ? 'done' : i === current ? 'current' : ''}>
                  {status[i] ? <CheckCircle2 size={16} className="positive" /> : <Circle size={16} />}
                  <span><strong>{s.title}</strong>{!status[i] && i === current && <small>{s.hint}</small>}</span>
                </li>
              ))}
              {complete && (
                <li className="academy-complete">
                  Lesson complete.{' '}
                  {lesson.id < LESSONS.length
                    ? <button className="btn btn-sm btn-buy" onClick={() => onSelectLesson(lesson.id + 1)}>Next lesson →</button>
                    : <button className="btn btn-sm btn-buy" onClick={props.onOpenSandbox}>Go to the sandbox →</button>}
                </li>
              )}
            </ol>
          </div>
          <div className="academy-view">{props.renderView(lesson.view)}</div>
        </section>
      </div>
    </div>
  );
}
