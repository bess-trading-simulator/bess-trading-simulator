import type { GameState, DayAheadBid, GameMode, BmDirection } from '../engine/types';
import type React from 'react';
import { useState } from 'react';
import type { BatteryConfig } from '../engine/battery';
import { getRevenueSummary } from '../engine/battery';
import { getSettlementPeriod } from '../engine/clock';
import MarketClock from './MarketClock';
import BatteryStatus from './BatteryStatus';
import DayAheadAuction from './DayAheadAuction';
import IntradayTrading from './IntradayTrading';
import PostTradeAnalysis from './PostTradeAnalysis';
import NewsFeed from './NewsFeed';
import StrategyGuide from './StrategyGuide';
import ScenarioSelector from './ScenarioSelector';
import MarketSignalPanel from './MarketSignalPanel';
import PositionBook from './PositionBook';
import AcademyRoadmap from './AcademyRoadmap';
import LessonQuiz from './LessonQuiz';
import SocForecast from './SocForecast';
import ReplayTimeline from './ReplayTimeline';
import PostTradeExplainer from './PostTradeExplainer';
import BmTraining from './BmTraining';
import LessonAssessment from './LessonAssessment';
import ExplainThisScreen from './ExplainThisScreen';
import DailyBriefing from './DailyBriefing';
import CapacityAllocationBoard from './CapacityAllocationBoard';
import EndOfDayReport from './EndOfDayReport';
import ForecastReview from './ForecastReview';
import ScenarioObjective from './ScenarioObjective';
import RiskLimits from './RiskLimits';
import DecisionCoach from './DecisionCoach';
import SupportPanels from './SupportPanels';
import ExamReport from './ExamReport';
import TradingCockpit from './TradingCockpit';
import ThemeToggle from './ThemeToggle';
import Tutorial, { type TutorialStep } from './Tutorial';
import AboutProject from './AboutProject';
import TradeExplainer from './TradeExplainer';
import type { HistoricalDay } from '../data/historicalDays';
import type { TrainingLevel } from '../data/curriculum';
import { scoreMission } from '../engine/missionScoring';
import { assessLesson } from '../engine/lessonAssessment';
import { BarChart3, Battery, Brain, CheckCircle, ChevronLeft, ChevronRight, EyeOff, HelpCircle, Layers, LineChart, Play, Target } from 'lucide-react';
import type { SpeedPreset } from '../engine/types';

export type LessonId = 1 | 2 | 3 | 4 | 5;

interface LessonMeta {
  id: LessonId;
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ size?: number }>;
}

interface MissionStep {
  title: string;
  objective: string;
  briefing: string;
  focus: 'price' | 'battery' | 'controls' | 'revenue' | 'dayahead' | 'intraday' | 'analysis' | 'stack' | 'news' | 'strategy' | 'bm';
  completeWhen: (state: GameState) => boolean;
  hint: string;
  required?: boolean;
}

const LESSONS: LessonMeta[] = [
  { id: 1, title: 'Arbitrage', subtitle: 'Physical battery dispatch', icon: Battery },
  { id: 2, title: 'Day-Ahead', subtitle: '48-period schedule', icon: BarChart3 },
  { id: 3, title: 'Intraday', subtitle: 'Re-optimise positions', icon: LineChart },
  { id: 4, title: 'Imbalance', subtitle: 'SIP and NIV review', icon: Brain },
  { id: 5, title: 'Market Context', subtitle: 'BM, frequency, and triad overview', icon: Layers },
];

const TRAINING_TOUR_STEPS: TutorialStep[] = [
  {
    title: 'Training Tour',
    content: 'Training mode is the guided version of the simulator. Each lesson gives you one objective, explains why it matters, then asks you to practise it on the live screen.',
    target: null,
  },
  {
    title: 'Lesson Roadmap',
    content: 'These are the five lesson chapters. Use them like a course menu: Arbitrage first, then Day-Ahead, Intraday, Imbalance, and Market Context.',
    target: 'training-progress',
  },
  {
    title: 'Mission Objective',
    content: 'This card tells you exactly what to do next. Treat it like a videogame walkthrough objective: read the briefing, complete the task, then move forward.',
    target: 'mission-walkthrough',
  },
  {
    title: 'Difficulty Level',
    content: 'Beginner keeps the screen simple. Trader adds desk workflow and risk checks. Quant opens advanced analytics, models, and backtest-style panels.',
    target: 'training-level-select',
  },
  {
    title: 'Lesson Work Area',
    content: 'This is where the actual lesson task appears. It changes by mission, so Day-Ahead, Intraday, BM, and Analysis lessons should feel different immediately.',
    target: 'training-main-surface',
  },
  {
    title: 'Support Panels',
    content: 'Use these after the main action. Coach explains the workflow, Risk checks constraints, Review shows performance, and Advanced unlocks deeper analytics.',
    target: 'training-support-panels',
  },
  {
    title: 'Side Coach',
    content: 'The right side gives context: briefing, objective, risk limits, assessment, and extra coaching. It is there to help you understand why a trade is good or bad.',
    target: 'training-side-stack',
  },
  {
    title: 'Start the Lesson',
    content: 'Now follow the mission card one step at a time. If the screen feels too complex, switch to Beginner.',
    target: null,
  },
];

const MISSION_STEPS: Record<LessonId, MissionStep[]> = {
  1: [
    {
      title: 'Watch the price',
      objective: 'Press Step Forward three times.',
      briefing: 'Do not trade yet. First learn that the price changes every settlement period.',
      focus: 'price',
      completeWhen: state => state.priceHistory.length >= 4,
      hint: 'Use Step Forward a few times and watch the current price change.',
      required: true,
    },
    {
      title: 'Check the battery',
      objective: 'Look at how full the battery is.',
      briefing: 'The battery is like inventory. You need empty space to charge and stored energy to discharge.',
      focus: 'battery',
      completeWhen: () => true,
      hint: 'The battery starts at 50% SoC, so you have room to charge or discharge.',
    },
    {
      title: 'Make one trade',
      objective: 'Make one deliberate charge or discharge.',
      briefing: 'This is a half-hour settlement period. A 50 MW action moves 25 MWh before efficiency effects.',
      focus: 'controls',
      completeWhen: state => state.battery.cycleLog.length >= 1,
      hint: 'Use the controls panel. If the signal is unclear, choose a small action and read the explainer.',
      required: true,
    },
    {
      title: 'Complete the round trip',
      objective: 'Make the opposite action as well: charge and discharge at least once.',
      briefing: 'A battery trade only becomes a full arbitrage cycle when you have both bought energy and sold energy.',
      focus: 'controls',
      completeWhen: state => (
        state.battery.cycleLog.some(entry => entry.action === 'charge')
        && state.battery.cycleLog.some(entry => entry.action === 'discharge')
      ),
      hint: 'Step forward to a better price, then use the opposite button. You need both sides to judge spread.',
      required: true,
    },
    {
      title: 'Review the result',
      objective: 'Check if money and battery position improved.',
      briefing: 'A good trade is not just cash now. It also leaves the battery ready for the next opportunity.',
      focus: 'revenue',
      completeWhen: state => state.battery.cycleLog.length >= 2,
      hint: 'Look for spread, SoC, and whether you still have headroom or stored energy.',
    },
  ],
  2: [
    {
      title: 'Read the delivery day',
      objective: 'Find the cheap and expensive settlement periods in the day-ahead forecast.',
      briefing: 'Day-ahead is about committing before delivery. You are trading a schedule, not pushing the battery immediately.',
      focus: 'dayahead',
      completeWhen: state => state.dayAhead.forecastPrices.length === 48,
      hint: 'Green periods are candidate charges. Red periods are candidate discharges.',
    },
    {
      title: 'Build an arbitrage schedule',
      objective: 'Create charge and discharge bids for multiple settlement periods.',
      briefing: 'A real DA plan should pair cheap charging with later higher-value discharge. A one-sided schedule is usually incomplete.',
      focus: 'dayahead',
      completeWhen: state => {
        const da = state.dayAhead.playerSchedule.filter(p => p.market === 'da');
        return da.some(p => p.action === 'charge') && da.some(p => p.action === 'discharge');
      },
      hint: 'Use Quick Fill Arbitrage or manually add both charge and discharge periods.',
      required: true,
    },
    {
      title: 'Wait for delivery',
      objective: 'Step forward and watch scheduled positions deliver into physical battery actions.',
      briefing: 'Auction clearing creates a position. The physical battery changes when the scheduled settlement period arrives.',
      focus: 'battery',
      completeWhen: state => state.battery.cycleLog.length >= 1 || state.dayAhead.playerSchedule.some(p => p.delivered),
      hint: 'Use Step Forward after submitting bids. Delivery happens period by period.',
      required: true,
    },
    {
      title: 'Compare plan to reality',
      objective: 'Open the first analysis view and check if DA prices lined up with SIP outturn.',
      briefing: 'A DA schedule can be directionally right and still leave money on the table when outturn diverges.',
      focus: 'analysis',
      completeWhen: state => Boolean(state.analysis),
      hint: 'Step forward until analysis appears, then check forecast vs outturn.',
    },
  ],
  3: [
    {
      title: 'Compare DA, ID, and SIP',
      objective: 'Inspect future settlement periods where intraday price differs from day-ahead.',
      briefing: 'Intraday trading is where forecast errors become tradable. Your job is to improve the schedule, not trade every move.',
      focus: 'intraday',
      completeWhen: () => true,
      hint: 'Look for future SPs where ID has moved meaningfully away from DA.',
    },
    {
      title: 'Revise the position',
      objective: 'Place one intraday charge or discharge for a selected future SP.',
      briefing: 'This locks a new position for that period. Think of it as updating your plan with newer information.',
      focus: 'intraday',
      completeWhen: state => state.dayAhead.playerSchedule.some(p => p.market === 'id'),
      hint: 'Select a future SP, set MW, then charge or discharge at the displayed ID price.',
      required: true,
    },
    {
      title: 'Check the revised book',
      objective: 'Review battery, revenue, and trader feedback after adding the ID position.',
      briefing: 'A revision is only good if it improves the total book while respecting SoC and future optionality.',
      focus: 'revenue',
      completeWhen: state => state.dayAhead.playerSchedule.some(p => p.market === 'id'),
      hint: 'Look at SoC, current P&L, and whether the ID trade conflicts with your DA plan.',
    },
  ],
  4: [
    {
      title: 'Reveal outturn',
      objective: 'Step through enough periods for SIP/NIV analysis to appear.',
      briefing: 'SIP is where forecast meets settlement. This is where a trader learns whether the decision logic was right.',
      focus: 'analysis',
      completeWhen: state => Boolean(state.analysis),
      hint: 'Step forward until at least a few settlement periods have settled.',
      required: true,
    },
    {
      title: 'Study missed value',
      objective: 'Review your grade, missed periods, and worst trade.',
      briefing: 'The goal is not perfection. The goal is a repeatable explanation for why money was made or missed.',
      focus: 'analysis',
      completeWhen: state => Boolean(state.analysis && state.analysis.periods.length >= 4),
      hint: 'Look for periods marked MISSED or BAD TRADE.',
    },
    {
      title: 'Read NIV direction',
      objective: 'Use NIV and SIP movement to explain one price surprise.',
      briefing: 'NIV tells you whether the system was long or short. The sign and magnitude help explain why SIP moved against or in favour of your trade.',
      focus: 'analysis',
      completeWhen: state => Boolean(state.analysis && state.analysis.periods.some(p => Math.abs(p.nivValue) > 100)),
      hint: 'Find a period with a large positive or negative NIV value in the breakdown.',
    },
  ],
  5: [
    {
      title: 'Explore revenue streams',
      objective: 'Switch to a different strategy mode and read what it does.',
      briefing: 'Real BESS assets earn from multiple services — BM, frequency response, capacity market, and triad avoidance. Pick a mode to see how the simulator context changes. These are illustrative — full simulation is coming in a future update.',
      focus: 'strategy',
      completeWhen: state => state.mode !== 'arbitrage',
      hint: 'Open Strategies and pick any mode other than Arbitrage.',
      required: true,
    },
    {
      title: 'Try a BM submission',
      objective: 'Submit one bid or offer to the Balancing Mechanism panel.',
      briefing: 'In a real BM, you submit a price and NGESO may accept it. Here you can see the mechanics, but acceptance and physical dispatch are not yet wired up. This will be functional in a future update.',
      focus: 'bm',
      completeWhen: state => (state.bm?.offers.length ?? 0) > 0,
      hint: 'Use Offer to set a discharge price, or Bid to set a charge price.',
      required: true,
    },
    {
      title: 'Review what you have learned',
      objective: 'Step forward and observe events, then reflect on the four lessons so far.',
      briefing: 'You have covered spot arbitrage, day-ahead scheduling, intraday revision, and imbalance analysis. These are the core skills. The services in this lesson add revenue but depend on the same fundamentals.',
      focus: 'stack',
      completeWhen: state => state.events.length > 0 || Boolean(state.analysis),
      hint: 'Step forward and watch the events that each mode generates.',
    },
  ],
};

interface Props {
  lessonId: LessonId;
  state: GameState;
  dataSource: 'loading' | 'live' | 'synthetic';
  onSelectLesson: (id: LessonId) => void;
  onOpenSandbox: () => void;
  onTogglePause: () => void;
  onSetSpeed: (speed: SpeedPreset) => void;
  onStepForward: () => void;
  onReset: () => void;
  onCharge: (mw: number) => void;
  onDischarge: (mw: number) => void;
  onSubmitBids: (bids: DayAheadBid[]) => void;
  onConfigureBattery: (config: Partial<BatteryConfig>) => void;
  onIntradayCharge: (sp: number, mw: number) => void;
  onIntradayDischarge: (sp: number, mw: number) => void;
  onSubmitBmOffer: (period: number, direction: BmDirection, mw: number, price: number) => void;
  onSetMode: (mode: GameMode) => void;
  onPlayScenario: (day: HistoricalDay) => void;
}

function buildFeedback(state: GameState, lessonId: LessonId): string[] {
  const summary = getRevenueSummary(state.battery);
  const trades = state.battery.cycleLog;
  const feedback: string[] = [];
  const chargeTrades = trades.filter(t => t.action === 'charge');
  const dischargeTrades = trades.filter(t => t.action === 'discharge');

  if (trades.length === 0) {
    return ['No physical dispatch yet. Start with one deliberate charge or discharge decision.'];
  }

  if (chargeTrades.length > 0 && dischargeTrades.length === 0) {
    feedback.push('You have bought energy but have not monetised it yet. Preserve enough SoC for the next high-price window.');
  }
  if (dischargeTrades.length > 0 && chargeTrades.length === 0) {
    feedback.push('You have sold stored energy without first creating a cheap refill. Watch SoC before the next relative price spike.');
  }

  const spread = summary.avgDischargePrice - summary.avgChargePrice;
  if (chargeTrades.length > 0 && dischargeTrades.length > 0) {
    if (spread >= 30) feedback.push(`Strong spread captured: £${spread.toFixed(2)}/MWh between average charge and discharge prices.`);
    else if (spread >= 10) feedback.push(`Positive but thin spread: £${spread.toFixed(2)}/MWh. Efficiency losses can eat weak trades.`);
    else feedback.push(`Spread is weak at £${spread.toFixed(2)}/MWh. Wait for a cleaner relative low-to-high move.`);
  }

  if (state.battery.socPct < 15) feedback.push('SoC is very low. You have limited optionality if prices spike later.');
  if (state.battery.socPct > 90) feedback.push('SoC is high. You are ready for a price spike, but you have little headroom for negative or very cheap prices.');

  if (lessonId >= 2 && state.dayAhead.playerSchedule.length === 0) {
    feedback.push('No forward schedule is locked. Use day-ahead once you have a price view for the delivery day.');
  }
  if (lessonId >= 4 && state.analysis) {
    feedback.push(`Current score: ${state.analysis.grade} (${state.analysis.score}%). Review missed periods before adding more market complexity.`);
  }

  return feedback.slice(0, 4);
}

function LessonProgress({ lessonId, onSelectLesson }: { lessonId: LessonId; onSelectLesson: (id: LessonId) => void }) {
  return (
    <div className="lesson-progress" id="training-progress">
      {LESSONS.map(lesson => {
        const Icon = lesson.icon;
        const status = lesson.id < lessonId ? 'complete' : lesson.id === lessonId ? 'active' : '';
        return (
          <button key={lesson.id} className={`lesson-step ${status}`} onClick={() => onSelectLesson(lesson.id)}>
            <span className="lesson-step-icon">{lesson.id < lessonId ? <CheckCircle size={15} /> : <Icon size={15} />}</span>
            <span>
              <strong>{lesson.title}</strong>
              <small>{lesson.subtitle}</small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function LessonHeader({
  lessonId, state, dataSource, onSelectLesson, onOpenSandbox,
  onTogglePause, onSetSpeed, onStepForward, onReset,
  level, onSetLevel,
  assessmentMode, onToggleAssessmentMode, onStartTour, onPlayScenario,
}: Pick<Props, 'lessonId' | 'state' | 'dataSource' | 'onSelectLesson' | 'onOpenSandbox' | 'onTogglePause' | 'onSetSpeed' | 'onStepForward' | 'onReset' | 'onPlayScenario'> & {
  level: TrainingLevel;
  onSetLevel: (level: TrainingLevel) => void;
  assessmentMode: boolean;
  onToggleAssessmentMode: () => void;
  onStartTour: () => void;
}) {
  const meta = LESSONS.find(l => l.id === lessonId) ?? LESSONS[0];
  const Icon = meta.icon;
  return (
    <header className="app-header">
      <div className="header-left">
        <span className="logo-icon"><Icon size={22} /></span>
        <h1>{meta.title}</h1>
        <span className="mode-badge">{meta.subtitle}</span>
        <span className={`data-badge ${dataSource}`}>
          {dataSource === 'live' ? 'LIVE DATA' : dataSource === 'loading' ? 'LOADING...' : 'SYNTHETIC'}
        </span>
      </div>
      <div className="header-center">
        <MarketClock
          currentTime={state.clock.currentTime}
          isPaused={state.clock.isPaused}
          speed={state.clock.speed}
          onTogglePause={onTogglePause}
          onSetSpeed={onSetSpeed}
          onStepForward={onStepForward}
          onReset={onReset}
        />
      </div>
      <div className="header-right">
        <select id="training-level-select" className="input input-sm training-level-select" value={level} onChange={event => onSetLevel(event.target.value as TrainingLevel)}>
          <option value="beginner">Beginner</option>
          <option value="trader">Trader</option>
          <option value="quant">Quant</option>
        </select>
        <button className={`btn ${assessmentMode ? 'btn-sell' : ''}`} onClick={onToggleAssessmentMode}>
          <EyeOff size={14} /> Exam
        </button>
        <LessonAssessment state={state} lessonId={lessonId} />
        <ExplainThisScreen lessonId={lessonId} />
        <button className="btn" onClick={onStartTour} title="Tour">
          <HelpCircle size={14} /> Tour
        </button>
        <ScenarioSelector onSelectScenario={onPlayScenario} />
        <AcademyRoadmap level={level} currentLesson={lessonId} onSelectLesson={onSelectLesson} />
        <button className="btn" onClick={() => onSelectLesson(Math.min(5, lessonId + 1) as LessonId)} disabled={lessonId === 5}>
          Next <ChevronRight size={14} />
        </button>
        <AboutProject />
        <ThemeToggle />
        <button className="btn btn-buy" onClick={onOpenSandbox}>Sandbox</button>
      </div>
    </header>
  );
}

function CoachPanel({ state, lessonId }: { state: GameState; lessonId: LessonId }) {
  const currentSp = getSettlementPeriod(state.clock.currentTime);
  const feedback = buildFeedback(state, lessonId);
  const missionScore = scoreMission(state, lessonId);
  return (
    <div className="panel coach-panel">
      <div className="panel-header"><h3><Target size={15} /> Trader Review</h3></div>
      <div className="mission-score-card">
        <div className="mission-grade">{missionScore.grade}</div>
        <div>
          <strong>{missionScore.score}/100</strong>
          <span>Mission score</span>
        </div>
      </div>
      <div className="coach-metrics">
        <div><span>SP</span><strong>{currentSp}</strong></div>
        <div><span>SoC</span><strong>{state.battery.socPct.toFixed(0)}%</strong></div>
        <div><span>Trades</span><strong>{state.battery.cycleLog.length}</strong></div>
      </div>
      <ul className="coach-list">
        {feedback.map((item, idx) => <li key={idx}>{item}</li>)}
      </ul>
      {(missionScore.strengths.length > 0 || missionScore.improvements.length > 0) && (
        <div className="score-feedback">
          {missionScore.strengths.slice(0, 1).map(item => <div key={item} className="positive">Good: {item}</div>)}
          {missionScore.improvements.slice(0, 1).map(item => <div key={item} className="warning-text">Improve: {item}</div>)}
        </div>
      )}
    </div>
  );
}

function SideStack({ props, includeStrategy = false, assessmentMode = false }: {
  props: Props;
  includeStrategy?: boolean;
  assessmentMode?: boolean;
}) {
  return (
    <>
      {includeStrategy && <StrategyGuide currentMode={props.state.mode} onSelectMode={props.onSetMode} />}
      {!assessmentMode && <DecisionCoach state={props.state} />}
      <NewsFeed events={props.state.events} />
      {!assessmentMode && <DailyBriefing state={props.state} />}
      <RiskLimits state={props.state} />
      <ScenarioObjective state={props.state} />
    </>
  );
}

function LessonMain({ props, lessonId, focus, assessmentMode, level }: {
  props: Props;
  lessonId: LessonId;
  focus: MissionStep['focus'];
  assessmentMode: boolean;
  level: TrainingLevel;
}) {
  const { state } = props;
  const currentHour = new Date(state.clock.currentTime).getUTCHours();
  const signalDetail = level === 'quant' || (level === 'trader' && lessonId >= 3) || lessonId >= 4 || focus === 'stack' || focus === 'strategy' ? 'advanced' : 'simple';
  const Signal = assessmentMode ? null : <MarketSignalPanel state={state} detail={signalDetail} />;

  if (focus === 'price') {
    return (
      <>
        {!assessmentMode && <div className="mission-focus-target">{Signal}</div>}
      </>
    );
  }
  if (focus === 'battery') {
    return (
      <div className="lesson-two-col">
        <div className="mission-focus-target"><BatteryStatus battery={state.battery} onConfigure={props.onConfigureBattery} /></div>
        <CoachPanel state={state} lessonId={lessonId} />
      </div>
    );
  }
  if (focus === 'controls') {
    return (
      <>
        {Signal}
        <TradeExplainer battery={state.battery} currentPrice={state.currentPrice} priceHistory={state.priceHistory} />
      </>
    );
  }
  if (focus === 'revenue') {
    return (
      <>
        {Signal}
        <TradeExplainer battery={state.battery} currentPrice={state.currentPrice} priceHistory={state.priceHistory} />
      </>
    );
  }
  if (focus === 'dayahead') {
    return (
      <>
        {Signal}
        <div className="mission-focus-target">
          <DayAheadAuction
            dayAhead={state.dayAhead}
            currentTime={state.clock.currentTime}
            battery={state.battery}
            onSubmitBids={props.onSubmitBids}
          />
        </div>
        <SocForecast battery={state.battery} dayAhead={state.dayAhead} />
      </>
    );
  }
  if (focus === 'intraday') {
    return (
      <>
        {Signal}
        <div className="mission-focus-target">
          <IntradayTrading
            dayAhead={state.dayAhead}
            battery={state.battery}
            currentPrice={state.currentPrice?.price ?? 0}
            currentTime={state.clock.currentTime}
            currentHour={currentHour}
            onIntradayCharge={props.onIntradayCharge}
            onIntradayDischarge={props.onIntradayDischarge}
          />
        </div>
      </>
    );
  }
  if (focus === 'analysis') {
    return (
      <>
        {Signal}
        <PostTradeExplainer state={state} />
        <ForecastReview state={state} />
        <EndOfDayReport state={state} />
        <div className="mission-focus-target"><PostTradeAnalysis dayAhead={state.dayAhead} analysis={state.analysis} /></div>
        <PositionBook state={state} />
        <ReplayTimeline state={state} />
      </>
    );
  }
  if (focus === 'news') {
    return (
      <>
        {Signal}
        <div className="mission-focus-target"><NewsFeed events={state.events} /></div>
      </>
    );
  }
  if (focus === 'strategy') {
    return (
      <>
        {Signal}
        <div className="panel stack-mode-panel mission-focus-target">
          <div className="panel-header"><h3><Layers size={15} /> Stack Components</h3></div>
          <p>Choose which revenue stream you want to practise. The active mode changes the events and payments the simulator generates.</p>
          <StrategyGuide currentMode={state.mode} onSelectMode={props.onSetMode} />
        </div>
      </>
    );
  }
  if (focus === 'bm') {
    return (
      <>
        {!assessmentMode && <MarketSignalPanel state={state} detail="advanced" />}
        <div className="mission-focus-target">
          <BmTraining state={state} onSubmitBmOffer={props.onSubmitBmOffer} />
        </div>
        <PositionBook state={state} />
      </>
    );
  }
  return (
    <>
      {Signal}
      <NewsFeed events={state.events} />
      <CapacityAllocationBoard state={state} />
      <ForecastReview state={state} />
      <EndOfDayReport state={state} />
      <PositionBook state={state} />
      <ReplayTimeline state={state} />
      <PostTradeAnalysis dayAhead={state.dayAhead} analysis={state.analysis} />
    </>
  );
}

function MissionWalkthrough({
  lessonId,
  stepIndex,
  state,
  onBack,
  onNext,
  onFinish,
  onSelectLesson,
  assessmentMode,
}: {
  lessonId: LessonId;
  stepIndex: number;
  state: GameState;
  onBack: () => void;
  onNext: () => void;
  onFinish: () => void;
  onSelectLesson: (id: LessonId) => void;
  assessmentMode: boolean;
}) {
  const steps = MISSION_STEPS[lessonId];
  const step = steps[stepIndex];
  const isComplete = step.completeWhen(state);
  const canAdvance = isComplete || !step.required;
  const isLastStep = stepIndex === steps.length - 1;
  const nextLabel = isLastStep ? (lessonId === 5 ? 'Finish' : 'Next Lesson') : 'Next';

  const handleNext = () => {
    if (!canAdvance) return;
    if (isLastStep && lessonId < 5) {
      onSelectLesson((lessonId + 1) as LessonId);
      return;
    }
    if (isLastStep && lessonId === 5) {
      onFinish();
      return;
    }
    onNext();
  };

  return (
    <section className={`mission-panel focus-${step.focus}`} id="mission-walkthrough">
      <div className="mission-left">
        <div className="mission-left-top">
          <div className="mission-kicker">Lesson {lessonId} · Step {stepIndex + 1}/{steps.length}</div>
          <h2>{step.title}</h2>
        </div>
        {assessmentMode ? (
          <span className="mission-briefing assessment-copy">No hints.</span>
        ) : (
          <span className="mission-briefing">{step.briefing}</span>
        )}
      </div>
      <div className="mission-center">
        <div className="mission-objective">
          <Target size={14} />
          <span>{step.objective}</span>
        </div>
        <div className={`mission-status ${isComplete ? 'complete' : ''}`}>
          {isComplete ? <CheckCircle size={13} /> : <Play size={13} />}
          <span>{isComplete ? 'Objective clear' : assessmentMode ? 'Complete the objective.' : step.hint}</span>
        </div>
      </div>
      <div className="mission-actions">
        <button className="btn" onClick={onBack} disabled={lessonId === 1 && stepIndex === 0}>
          <ChevronLeft size={14} />
        </button>
        <button className={`btn ${isComplete ? 'btn-buy' : ''}`} onClick={handleNext} disabled={!canAdvance}>
          {nextLabel} <ChevronRight size={14} />
        </button>
      </div>
    </section>
  );
}

function LessonSummaryPanel({ state, lessonId, onNextLesson }: {
  state: GameState;
  lessonId: LessonId;
  onNextLesson: () => void;
}) {
  const assessment = assessLesson(state, lessonId);
  if (assessment.readiness !== 'ready') return null;

  const lesson = LESSONS.find(item => item.id === lessonId) ?? LESSONS[0];

  return (
    <section className="lesson-summary-panel">
      <div>
        <strong>{lesson.title} complete</strong>
        <span>You passed {assessment.passed}/{assessment.total} checks. The next useful step is to practise without hints or move on.</span>
      </div>
      <button className="btn btn-buy" onClick={onNextLesson} disabled={lessonId === 5}>
        Next Lesson <ChevronRight size={14} />
      </button>
    </section>
  );
}

function TrainingCompletePanel({ props, onBackToLessons }: { props: Props; onBackToLessons: () => void }) {
  return (
    <section className="training-complete-panel">
      <div className="panel complete-summary">
        <div className="panel-header"><h3><CheckCircle size={15} /> Training Complete</h3></div>
        <h2>You finished the guided walkthrough.</h2>
        <p>The simulator is paused so you can choose what to do next. Use the controls below to keep trading, open Sandbox, or go back into the lessons.</p>
        <div className="complete-actions">
          <button className="btn btn-buy" onClick={props.onOpenSandbox}>Open Sandbox</button>
          <button className="btn" onClick={onBackToLessons}>Back to Lessons</button>
          <button className="btn" onClick={props.onStepForward}>Step Forward</button>
        </div>
      </div>
      <TradingCockpit
        state={props.state}
        onCharge={props.onCharge}
        onDischarge={props.onDischarge}
        onConfigureBattery={props.onConfigureBattery}
      />
      <SupportPanels
        state={props.state}
        lessonId={5}
        level="trader"
      />
    </section>
  );
}

export default function TrainingLesson(props: Props) {
  const { lessonId, state, dataSource, onSelectLesson, onOpenSandbox } = props;
  const [stepByLesson, setStepByLesson] = useState<Record<LessonId, number>>({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
  const [level, setLevel] = useState<TrainingLevel>('beginner');
  const [assessmentMode, setAssessmentMode] = useState(false);
  const [examStartedAt, setExamStartedAt] = useState<number | null>(null);
  const [trainingComplete, setTrainingComplete] = useState(false);
  const [trainingTour, setTrainingTour] = useState({ currentStep: 0, isActive: true });
  const stepIndex = stepByLesson[lessonId] ?? 0;
  const currentMission = MISSION_STEPS[lessonId][stepIndex];
  const focus = currentMission.focus;
  const showTradingCockpit = focus === 'price' || focus === 'controls' || focus === 'revenue';
  const stepForwardMission = () => {
    setStepByLesson(prev => {
      const max = MISSION_STEPS[lessonId].length - 1;
      return { ...prev, [lessonId]: Math.min(max, (prev[lessonId] ?? 0) + 1) };
    });
  };
  const stepBackMission = () => {
    const current = stepByLesson[lessonId] ?? 0;
    if (current === 0 && lessonId > 1) {
      onSelectLesson((lessonId - 1) as LessonId);
      return;
    }
    setStepByLesson(prev => {
      const previous = prev[lessonId] ?? 0;
      return { ...prev, [lessonId]: Math.max(0, previous - 1) };
    });
  };
  const selectLesson = (id: LessonId) => {
    setTrainingComplete(false);
    onSelectLesson(id);
    setStepByLesson(prev => ({ ...prev, [id]: prev[id] ?? 0 }));
  };
  const finishTraining = () => {
    if (!state.clock.isPaused) props.onTogglePause();
    setTrainingComplete(true);
  };
  const toggleExamMode = () => {
    const next = !assessmentMode;
    setAssessmentMode(next);
    setExamStartedAt(next ? state.clock.currentTime : null);
  };
  const startTrainingTour = () => setTrainingTour({ currentStep: 0, isActive: true });
  const advanceTrainingTour = () => {
    setTrainingTour(prev => {
      const nextStep = prev.currentStep + 1;
      return {
        currentStep: nextStep,
        isActive: nextStep < TRAINING_TOUR_STEPS.length,
      };
    });
  };
  const skipTrainingTour = () => setTrainingTour({ currentStep: 0, isActive: false });

  return (
    <div className="training-app">
      <LessonHeader
        lessonId={lessonId}
        state={state}
        dataSource={dataSource}
        onSelectLesson={selectLesson}
        onOpenSandbox={onOpenSandbox}
        onTogglePause={props.onTogglePause}
        onSetSpeed={props.onSetSpeed}
        onStepForward={props.onStepForward}
        onReset={props.onReset}
        level={level}
        onSetLevel={setLevel}
        assessmentMode={assessmentMode}
        onToggleAssessmentMode={toggleExamMode}
        onStartTour={startTrainingTour}
        onPlayScenario={props.onPlayScenario}
      />
      <LessonProgress lessonId={lessonId} onSelectLesson={selectLesson} />

      <MissionWalkthrough
        lessonId={lessonId}
        stepIndex={stepIndex}
        state={state}
        onBack={stepBackMission}
        onNext={stepForwardMission}
        onFinish={finishTraining}
        onSelectLesson={selectLesson}
        assessmentMode={assessmentMode}
      />
      <LessonSummaryPanel
        state={state}
        lessonId={lessonId}
        onNextLesson={() => selectLesson(Math.min(5, lessonId + 1) as LessonId)}
      />

      <main className={`training-grid mission-focus-${focus}`}>
        <section className="training-main" id="training-main-surface">
          {trainingComplete ? (
            <TrainingCompletePanel props={props} onBackToLessons={() => setTrainingComplete(false)} />
          ) : (
            <>
              {assessmentMode && <ExamReport state={state} lessonId={lessonId} startedAt={examStartedAt} />}
              {showTradingCockpit && (
                <TradingCockpit
                  state={state}
                  onCharge={props.onCharge}
                  onDischarge={props.onDischarge}
                  onConfigureBattery={props.onConfigureBattery}
                />
              )}
              <LessonMain props={props} lessonId={lessonId} focus={focus} assessmentMode={assessmentMode} level={level} />
              <div id="training-support-panels">
                <SupportPanels
                  key={`${lessonId}-${level}`}
                  state={state}
                  lessonId={lessonId}
                  assessmentMode={assessmentMode}
                  level={level}
                />
              </div>
            </>
          )}
        </section>
        <aside className="training-side" id="training-side-stack">
          <SideStack
            props={props}
            includeStrategy={lessonId === 5 && focus !== 'strategy' && state.mode === 'arbitrage'}
            assessmentMode={assessmentMode}
          />
          {!assessmentMode && (level !== 'beginner' || focus === 'revenue' || focus === 'analysis') && <LessonQuiz lessonId={lessonId} />}
        </aside>
      </main>
      <Tutorial
        currentStep={trainingTour.currentStep}
        isActive={trainingTour.isActive}
        onNext={advanceTrainingTour}
        onSkip={skipTrainingTour}
        steps={TRAINING_TOUR_STEPS}
      />
    </div>
  );
}
