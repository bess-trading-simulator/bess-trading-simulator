import { useState } from 'react';
import type { AppView, SpeedPreset } from './engine/types';
import { useGameState } from './hooks/useGameState';
import MarketClock, { speedOptions } from './components/MarketClock';
import DayAheadAuction from './components/DayAheadAuction';
import IntradayTrading from './components/IntradayTrading';
import PostTradeAnalysis from './components/PostTradeAnalysis';
import Glossary from './components/Glossary';
import RevenueStreams from './components/RevenueStreams';
import ScenarioSelector from './components/ScenarioSelector';
import SaveManager from './components/SaveManager';
import ThemeToggle from './components/ThemeToggle';
import Tutorial from './components/Tutorial';
import TrainingLesson from './components/TrainingLesson';
import type { LessonId } from './components/TrainingLesson';
import PositionBook from './components/PositionBook';
import ReplayTimeline from './components/ReplayTimeline';
import PostTradeExplainer from './components/PostTradeExplainer';
import EndOfDayReport from './components/EndOfDayReport';
import ForecastReview from './components/ForecastReview';
import DeskPanels from './components/DeskPanels';
import ImbalanceTrading from './components/ImbalanceTrading';
import RenewablesForecast from './components/RenewablesForecast';
import StartScreen from './components/StartScreen';
import SandboxLauncher from './components/SandboxLauncher';
import type { SandboxView, SandboxMarket } from './components/SandboxLauncher';
import type { HistoricalDay } from './data/historicalDays';
import AboutProject from './components/AboutProject';
import HeaderMenu from './components/HeaderMenu';
import ScenarioBanner from './components/ScenarioBanner';
import PnlDashboard from './components/PnlDashboard';
import LiveNews from './components/LiveNews';

export default function App() {
  const {
    state, dataSource, togglePause, setSpeed, stepForward,
    chargeBattery, dischargeBattery, placeDayAheadBids, withdrawDayAheadBid, configureBattery,
    placeIntradayOrder, cancelIntradayOrder, setBlockOrders, submitHalfHourBids,
    subStep, setDeviation, setAssetType, setBmOrder,
    intradayCharge, intradayDischarge, submitBmOffer, playScenario, loadLive,
    advanceTutorial, skipTutorial, setMode, loadSavedState, reset,
  } = useGameState();
  const [view, setView] = useState<AppView>('imbalance');
  const [appMode, setAppMode] = useState<'start' | 'training' | 'sandbox'>('start');
  const [enabledViews, setEnabledViews] = useState<SandboxView[] | null>(null);
  const [, setSandboxMarket] = useState<SandboxMarket>('GB');
  const [activeScenarioId, setActiveScenarioId] = useState<string>('live');
  const [lessonId, setLessonId] = useState<LessonId>(1);

  const openSandbox = () => {
    setEnabledViews(null);
    setAppMode('sandbox');
  };

  const confirmSandbox = (views: SandboxView[], market: SandboxMarket, scenario: HistoricalDay | null) => {
    setEnabledViews(views);
    setSandboxMarket(market);
    setView(views[0]);
    if (scenario) { playScenario(scenario); setActiveScenarioId(scenario.id); }
    else { loadLive(); setActiveScenarioId('live'); }
  };

  const goToStart = () => {
    setEnabledViews(null);
    setAppMode('start');
  };

  // Canonical tab order — keeps enabledViews ordered however they're toggled.
  const VIEW_ORDER: SandboxView[] = ['imbalance', 'intraday', 'dayahead'];
  const toggleView = (v: SandboxView) => {
    setEnabledViews((prev) => {
      const cur = prev ?? [];
      const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
      const ordered = VIEW_ORDER.filter((x) => next.includes(x));
      // If the currently open market tab was removed, fall back to a remaining tab.
      if (view !== 'analysis' && view !== 'forecast' && view !== 'pnl' && !ordered.includes(view as SandboxView)) {
        setView(ordered[0] ?? 'forecast');
      }
      return ordered;
    });
  };

  const visibleTabs: AppView[] = enabledViews ? [...enabledViews, 'forecast', 'pnl', 'analysis'] : [];


  if (appMode === 'start') {
    return (
      <StartScreen onOpenSandbox={openSandbox} />
    );
  }

  if (appMode === 'sandbox' && !enabledViews) {
    return <SandboxLauncher onConfirm={confirmSandbox} onBack={goToStart} />;
  }

  if (appMode === 'training') {
    return (
      <TrainingLesson
        lessonId={lessonId}
        state={state}
        dataSource={dataSource}
        onSelectLesson={setLessonId}
        onOpenSandbox={openSandbox}
        onTogglePause={togglePause}
        onSetSpeed={setSpeed}
        onStepForward={stepForward}
        onReset={reset}
        onCharge={chargeBattery}
        onDischarge={dischargeBattery}
        onSubmitBids={placeDayAheadBids}
        onConfigureBattery={configureBattery}
        onIntradayCharge={intradayCharge}
        onIntradayDischarge={intradayDischarge}
        onPlaceIntradayOrder={placeIntradayOrder}
        onCancelIntradayOrder={cancelIntradayOrder}
        onSubmitBmOffer={submitBmOffer}
        onSetMode={setMode}
        onPlayScenario={playScenario}
      />
    );
  }

  const battery = state.battery;

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1>BESS Trader</h1>
          <span className="hdr-sep" />
          <nav className="hdr-tabs" data-tutorial="dayahead-tab">
            {visibleTabs.includes('imbalance') && (
              <button className={`hdr-tab ${view === 'imbalance' ? 'active' : ''}`} onClick={() => setView('imbalance')}>
                Imbalance
              </button>
            )}
            {visibleTabs.includes('intraday') && (
              <button className={`hdr-tab ${view === 'intraday' ? 'active' : ''}`} onClick={() => setView('intraday')}>
                Intraday
              </button>
            )}
            {visibleTabs.includes('dayahead') && (
              <button className={`hdr-tab ${view === 'dayahead' ? 'active' : ''}`} onClick={() => setView('dayahead')} id="dayahead-tab">
                Day Ahead
              </button>
            )}
          </nav>
        </div>
        <div className="header-right">
          {visibleTabs.includes('forecast') && (
            <>
              <button className={`hdr-tab ${view === 'forecast' ? 'active' : ''}`} onClick={() => setView('forecast')}>
                Forecast
              </button>
              <button className={`hdr-tab ${view === 'pnl' ? 'active' : ''}`} onClick={() => setView('pnl')}>
                P&amp;L
              </button>
              <span className="hdr-sep" />
            </>
          )}
          <span
            className={`hdr-data-src ${dataSource}`}
            title={dataSource === 'live'
              ? 'This day is backed by real Elexon BMRS data (real SIP and NIV; DA = Market Index Price proxy).'
              : dataSource === 'loading'
                ? 'Loading Elexon data…'
                : 'Simulated / illustrative data — not a real market day.'}
          >
            {dataSource === 'live' ? 'Real data' : dataSource === 'loading' ? 'Loading…' : 'Simulated'}
          </span>
          <span className="hdr-sep" />
          <div className="hdr-battery" title={`State of Charge: ${battery.socPct.toFixed(1)}%`}>
            <span className="hdr-stat-value">{battery.socPct.toFixed(1)}%</span>
            <span className="hdr-stat-muted">{battery.currentSocMwh.toFixed(0)}/{battery.config.capacityMwh} MWh · {battery.config.powerRatingMw} MW</span>
          </div>
          <span className="hdr-sep" />
          <MarketClock
            currentTime={state.clock.currentTime}
            isPaused={state.clock.isPaused}
            speed={state.clock.speed}
            onTogglePause={togglePause}
            onSetSpeed={setSpeed}
            onStepForward={stepForward}
            onReset={reset}
            compact
          />
          <span className="hdr-sep" />
          <HeaderMenu>
            <div className="header-menu-speed" onClick={(e) => e.stopPropagation()}>
              <span className="hms-label">Speed</span>
              <select
                className="input"
                value={state.clock.speed}
                onChange={(e) => setSpeed(e.target.value as SpeedPreset)}
              >
                {speedOptions.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </div>
            <button className="btn header-menu-item" onClick={() => { reset(); setActiveScenarioId('live'); }}>
              Reset day
            </button>
            {visibleTabs.includes('analysis') && (
              <button
                className={`btn header-menu-item ${view === 'analysis' ? 'active' : ''}`}
                onClick={() => setView('analysis')}
                id="analysis-tab"
                data-tutorial="analysis-tab"
              >
                Analysis{state.analysis && <span className="hdr-tab-grade">{state.analysis.grade}</span>}
              </button>
            )}
            <button className="btn header-menu-item" onClick={goToStart}>
              Start
            </button>
            <button className="btn header-menu-item btn-buy" onClick={() => setAppMode('training')}>
              Training
            </button>
            <div className="header-menu-modal-slot" onClick={(e) => e.stopPropagation()}>
              <SaveManager state={state} dataSource={dataSource} onLoad={loadSavedState} />
              <ScenarioSelector
                activeId={activeScenarioId}
                onSelectScenario={(day) => { playScenario(day); setActiveScenarioId(day.id); }}
                onSelectLive={() => { loadLive(); setActiveScenarioId('live'); }}
              />
              <RevenueStreams enabledViews={enabledViews ?? []} onToggleView={toggleView} />
              <Glossary />
              <AboutProject />
              <ThemeToggle />
            </div>
          </HeaderMenu>
        </div>
      </header>

      <main className="dashboard-bess">
        <ScenarioBanner state={state} />
        {(view === 'imbalance' || view === 'intraday' || view === 'dayahead') && <LiveNews events={state.events} now={state.clock.currentTime} />}
        {view === 'imbalance' && (
          <div className="grid-main-full">
            <ImbalanceTrading
              state={state}
              onSetDeviation={setDeviation}
              onSubStep={subStep}
              onSetAssetType={setAssetType}
              onSetBmOrder={setBmOrder}
            />
            <DeskPanels state={state} />
          </div>
        )}

        {view === 'intraday' && (
          <div className="grid-main-full">
            <IntradayTrading
              state={state}
              onPlaceOrder={placeIntradayOrder}
              onCancelOrder={cancelIntradayOrder}
            />
            <DeskPanels state={state} />
          </div>
        )}

        {/* Kept mounted while hidden so unsent order drafts survive tab switches */}
        {visibleTabs.includes('dayahead') && (
          <div className="grid-main-full" style={view === 'dayahead' ? undefined : { display: 'none' }}>
            <DayAheadAuction
              dayAhead={state.dayAhead}
              nextDay={state.nextDay}
              ledger={state.ledger}
              currentTime={state.clock.currentTime}
              battery={state.battery}
              onSubmitBids={placeDayAheadBids}
              onWithdrawBids={withdrawDayAheadBid}
              onSetBlocks={setBlockOrders}
              onSubmitHalfHourBids={submitHalfHourBids}
            />
            <DeskPanels state={state} />
          </div>
        )}

        {view === 'forecast' && (
          <div className="grid-main-full">
            <RenewablesForecast dayAhead={state.dayAhead} />
          </div>
        )}

        {view === 'pnl' && (
          <div className="grid-main-full">
            <PnlDashboard state={state} />
          </div>
        )}

        {view === 'analysis' && (
          <div className="grid-main-full">
            <PostTradeExplainer state={state} />
            <ForecastReview state={state} />
            <EndOfDayReport state={state} />
            <PositionBook state={state} />
            <ReplayTimeline state={state} />
            <PostTradeAnalysis
              dayAhead={state.dayAhead}
              analysis={state.analysis}
            />
          </div>
        )}
      </main>

      <Tutorial
        currentStep={state.tutorial.currentStep}
        isActive={state.tutorial.isActive}
        onNext={advanceTutorial}
        onSkip={skipTutorial}
      />
    </div>
  );
}
