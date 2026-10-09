import { useState, useEffect, useCallback, useRef } from 'react';
import type { GameState, DayAheadBid, SpeedPreset, BmDirection, DaBlockOrder, HalfHourBid, AssetType, BmStandingOrder } from '../engine/types';
import { GameMode, SPEED_MS } from '../engine/types';
import {
  createGameState, tickGameState, stepForwardAction,
  chargeBatteryAction, dischargeBatteryAction, submitDayAheadBids, withdrawDayAheadBids,
  reconfigureBattery, intradayChargeAction, intradayDischargeAction, loadScenario,
  submitBmOfferAction, loadMarketDays, replaceNextDay,
  placeIntradayOrderAction, cancelIntradayOrderAction,
  submitBlockOrderAction, cancelBlockOrderAction, submitHalfHourBidsAction, setBlockOrdersAction,
  subStepAction, setDeviationAction, setAssetTypeAction, setBmOrderAction,
} from '../engine/gameState';
import type { PlaceOrderInput } from '../engine/intradayBook';
import type { BatteryConfig } from '../engine/battery';
import type { HistoricalDay } from '../data/historicalDays';
import { fetchLatestDay, fetchDayData } from '../engine/elexonApi';
import { realMarketDay, nextDayFrom, utcDateString } from '../engine/marketDay';
import { autoSave, loadAutoSave, clearAutoSave, cacheElexonDay } from '../engine/persistence';

export type DataSource = 'loading' | 'live' | 'synthetic';

const DAY_MS = 86_400_000;
const REAL_MODE_KEY = 'bess-real-mode';

function loadRealMode(): boolean {
  try { return localStorage.getItem(REAL_MODE_KEY) === '1'; } catch { return false; }
}
function storeRealMode(on: boolean) {
  try { localStorage.setItem(REAL_MODE_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

/** Saves from before the today/tomorrow split can't be migrated meaningfully. */
function isCurrentSave(saved: GameState | null): saved is GameState {
  return Boolean(saved && saved.nextDay?.signals && saved.intraday && Array.isArray(saved.ledger) && saved.dayAhead?.bids?.every(b => typeof b.hour === 'number') && typeof saved.dayAhead?.hhGateClosureTime === 'number');
}

/**
 * Real-data session: TODAY = the day before the latest complete Elexon day, and
 * TOMORROW (the open DA auction's delivery day) = the latest complete day, so
 * both the day you trade and the day you bid for are real.
 */
async function fetchRealPair() {
  const latest = await fetchLatestDay();
  const latestDay = Date.parse(latest.date + 'T00:00:00Z');
  const prevDate = utcDateString(latestDay - DAY_MS);
  const prev = await fetchDayData(prevDate).catch(() => null);
  cacheElexonDay(latest.date, latest);
  if (prev && prev.isComplete) {
    cacheElexonDay(prev.date, prev);
    return { today: realMarketDay(latestDay - DAY_MS, prev), next: realMarketDay(latestDay, latest) };
  }
  const today = realMarketDay(latestDay, latest);
  return { today, next: nextDayFrom(today, latestDay / DAY_MS) };
}

export function useGameState() {
  const [state, setState] = useState<GameState>(() => {
    const saved = loadAutoSave() as GameState | null;
    if (isCurrentSave(saved)) {
      return {
        ...saved,
        clock: { ...saved.clock, isPaused: true, speed: 'slow' },
        tutorial: { currentStep: 0, isActive: false, completed: true },
        bm: saved.bm ?? { offers: [], accepted: [] },
      };
    }
    return createGameState();
  });
  const [loading, setLoading] = useState(() => !isCurrentSave(loadAutoSave() as GameState | null));
  // dataSource describes TODAY's market data.
  const dataSource: DataSource = loading ? 'loading' : state.dayAhead.todaySource === 'real' ? 'live' : 'synthetic';
  // realMode: the player chose real data, so each new auction day is fetched from Elexon.
  const realModeRef = useRef(isCurrentSave(loadAutoSave() as GameState | null) && loadRealMode());
  const intervalRef = useRef<number | null>(null);
  const fetchedRef = useRef(false);
  const autosaveRef = useRef(0);

  const setRealMode = (on: boolean) => {
    realModeRef.current = on;
    storeRealMode(on);
  };

  const startLive = useCallback(() => {
    setLoading(true);
    fetchRealPair()
      .then(({ today, next }) => {
        setRealMode(true);
        setState(prev => loadMarketDays(prev, today, next));
        console.log(`Loaded real Elexon data: today ${today.date}, auction day ${next.date ?? '(simulated)'}`);
      })
      .catch(err => {
        console.warn('Elexon API unavailable, using synthetic data:', err.message);
        setRealMode(false);
        // Start a fresh simulated session rather than silently continuing an old save.
        setState(createGameState());
      })
      .finally(() => setLoading(false));
  }, []);

  // On mount: start a real-data session unless a current autosave exists.
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-off initial data load
    if (!isCurrentSave(loadAutoSave() as GameState | null)) startLive();
  }, [startLive]);

  // Real-data mode: when a new auction day appears (after midnight), try to
  // replace its synthetic placeholder with real Elexon data while the auction
  // is still open. If the day isn't published completely, it stays simulated.
  const nextDayKey = state.nextDay.day;
  const nextIsSynthetic = state.nextDay.source === 'synthetic';
  useEffect(() => {
    if (!realModeRef.current || !nextIsSynthetic) return;
    const day = nextDayKey;
    fetchDayData(utcDateString(day))
      .then(data => {
        if (!data.isComplete || !realModeRef.current) return;
        cacheElexonDay(data.date, data);
        setState(prev => replaceNextDay(prev, realMarketDay(day, data)));
      })
      .catch(() => { /* stays simulated */ });
  }, [nextDayKey, nextIsSynthetic]);

  // Autosave every 10 ticks
  useEffect(() => {
    autosaveRef.current++;
    if (autosaveRef.current % 10 === 0) {
      autoSave(state);
    }
  }, [state]);

  // Tick loop
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (state.clock.isPaused || state.clock.speed === 'manual') return;

    const ms = SPEED_MS[state.clock.speed as SpeedPreset] || 2500;
    if (ms <= 0) return;

    intervalRef.current = window.setInterval(() => {
      setState(prev => tickGameState(prev));
    }, ms);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [state.clock.isPaused, state.clock.speed]);

  const togglePause = useCallback(() => {
    setState(prev => ({
      ...prev,
      clock: { ...prev.clock, isPaused: !prev.clock.isPaused },
    }));
  }, []);

  const setSpeed = useCallback((speed: SpeedPreset) => {
    setState(prev => ({ ...prev, clock: { ...prev.clock, speed } }));
  }, []);

  const stepForward = useCallback(() => {
    setState(prev => stepForwardAction(prev));
  }, []);

  const chargeBattery = useCallback((mw: number) => {
    setState(prev => chargeBatteryAction(prev, mw));
  }, []);

  const dischargeBattery = useCallback((mw: number) => {
    setState(prev => dischargeBatteryAction(prev, mw));
  }, []);

  const placeDayAheadBids = useCallback((bids: DayAheadBid[]) => {
    setState(prev => submitDayAheadBids(prev, bids));
  }, []);

  const withdrawDayAheadBid = useCallback((hour?: number) => {
    setState(prev => withdrawDayAheadBids(prev, hour));
  }, []);

  const submitBlockOrder = useCallback((input: Omit<DaBlockOrder, 'id'>) => {
    setState(prev => submitBlockOrderAction(prev, input));
  }, []);

  const cancelBlockOrder = useCallback((id: string) => {
    setState(prev => cancelBlockOrderAction(prev, id));
  }, []);

  const subStep = useCallback(() => setState(prev => subStepAction(prev)), []);
  const setDeviation = useCallback((mw: number) => setState(prev => setDeviationAction(prev, mw)), []);
  const setAssetType = useCallback((t: AssetType) => setState(prev => setAssetTypeAction(prev, t)), []);
  const setBmOrder = useCallback((o: BmStandingOrder) => setState(prev => setBmOrderAction(prev, o)), []);

  const setBlockOrders = useCallback((auction: 'hourly' | 'half', blocks: DaBlockOrder[]) => {
    setState(prev => setBlockOrdersAction(prev, auction, blocks));
  }, []);

  const submitHalfHourBids = useCallback((bids: HalfHourBid[]) => {
    setState(prev => submitHalfHourBidsAction(prev, bids));
  }, []);

  const placeIntradayOrder = useCallback((input: PlaceOrderInput) => {
    setState(prev => placeIntradayOrderAction(prev, input));
  }, []);

  const cancelIntradayOrder = useCallback((orderId: string) => {
    setState(prev => cancelIntradayOrderAction(prev, orderId));
  }, []);

  const advanceTutorial = useCallback(() => {
    setState(prev => ({
      ...prev,
      tutorial: {
        ...prev.tutorial,
        currentStep: prev.tutorial.currentStep + 1,
        isActive: prev.tutorial.currentStep + 1 < 10,
        completed: prev.tutorial.currentStep + 1 >= 10,
      },
    }));
  }, []);

  const skipTutorial = useCallback(() => {
    setState(prev => ({
      ...prev,
      tutorial: { currentStep: 0, isActive: false, completed: true },
    }));
  }, []);

  const setMode = useCallback((mode: GameMode) => {
    setState(prev => ({ ...prev, mode }));
  }, []);

  const intradayCharge = useCallback((sp: number, mw: number) => {
    setState(prev => intradayChargeAction(prev, sp, mw));
  }, []);

  const intradayDischarge = useCallback((sp: number, mw: number) => {
    setState(prev => intradayDischargeAction(prev, sp, mw));
  }, []);

  const submitBmOffer = useCallback((period: number, direction: BmDirection, mw: number, price: number) => {
    setState(prev => submitBmOfferAction(prev, { period, direction, mw, price }));
  }, []);

  const playScenario = useCallback((day: HistoricalDay) => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    // Real Elexon days keep fetching real auction days; illustrative ones stay synthetic.
    setRealMode(Boolean(day.realData));
    if (!day.realData) {
      setState(prev => loadScenario(prev, day));
      setLoading(false);
      return;
    }
    // A real Elexon day becomes the auction day; the lead-in day is the real day before it.
    setLoading(true);
    const dayMs = Date.parse(day.date + 'T00:00:00Z');
    Promise.all([
      fetchDayData(utcDateString(dayMs - DAY_MS)).then(d => (d.isComplete ? realMarketDay(dayMs - DAY_MS, d) : undefined)).catch(() => undefined),
      fetchDayData(day.date).then(d => (d.isComplete ? realMarketDay(dayMs, d) : undefined)).catch(() => undefined),
    ])
      .then(([lead, real]) => setState(prev => loadScenario(prev, day, lead, real)))
      .finally(() => setLoading(false));
  }, []);

  // Explicitly (re)load the latest real Elexon days — used when the player picks
  // "Live" in the launcher, so a stale autosave / previous scenario can't linger.
  const loadLive = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    startLive();
  }, [startLive]);

  const configureBattery = useCallback((config: Partial<BatteryConfig>) => {
    setState(prev => reconfigureBattery(prev, config));
  }, []);

  const loadSavedState = useCallback((saved: GameState) => {
    if (!isCurrentSave(saved)) {
      console.warn('Save is from an older version of the simulator and cannot be loaded.');
      return;
    }
    if (intervalRef.current) clearInterval(intervalRef.current);
    // A saved game keeps its own market data; don't overwrite it with fetches.
    setRealMode(false);
    setState({ ...saved, bm: saved.bm ?? { offers: [], accepted: [] } });
  }, []);

  const reset = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    clearAutoSave();
    fetchedRef.current = false;
    setState(createGameState());
    startLive();
  }, [startLive]);

  return {
    state, dataSource, togglePause, setSpeed, stepForward,
    chargeBattery, dischargeBattery, placeDayAheadBids, withdrawDayAheadBid,
    placeIntradayOrder, cancelIntradayOrder,
    submitBlockOrder, cancelBlockOrder, submitHalfHourBids, setBlockOrders,
    subStep, setDeviation, setAssetType, setBmOrder,
    intradayCharge, intradayDischarge, submitBmOffer, playScenario, loadLive,
    advanceTutorial, skipTutorial, setMode, configureBattery,
    loadSavedState, reset,
  };
}
