import { useState, useEffect, useCallback, useRef } from 'react';
import type { GameState, DayAheadBid, SpeedPreset, BmDirection } from '../engine/types';
import { GameMode, SPEED_MS } from '../engine/types';
import {
  createGameState, tickGameState, stepForwardAction,
  chargeBatteryAction, dischargeBatteryAction, submitDayAheadBids,
  reconfigureBattery, intradayChargeAction, intradayDischargeAction, loadScenario,
  submitBmOfferAction,
} from '../engine/gameState';
import type { BatteryConfig } from '../engine/battery';
import type { HistoricalDay } from '../data/historicalDays';
import { fetchLatestDay, fetchDayData } from '../engine/elexonApi';
import type { ElexonDayData } from '../engine/elexonApi';
import { getGateClosureTime, getNextDeliveryDay, getUtcDayStart } from '../engine/clock';
import { generateSIPOutturn } from '../engine/ukMarket';
import { autoSave, loadAutoSave, clearAutoSave, needsRefresh, cacheElexonDay } from '../engine/persistence';

export function useGameState() {
  const [state, setState] = useState<GameState>(() => {
    const saved = loadAutoSave();
    if (saved) {
      // Migrate old saves: backfill missing deliveryDay fields and drop stale positions.
      const currentTime = saved.clock.currentTime;
      const currentDayStart = getUtcDayStart(currentTime);
      const migratedDeliveryDay = saved.dayAhead?.deliveryDay ?? getNextDeliveryDay(currentTime);
      const migratedSchedule = (saved.dayAhead?.playerSchedule ?? [])
        .filter((p) => p && typeof p.period === 'number')
        .map((p) => ({
          ...p,
          deliveryDay: typeof p.deliveryDay === 'number' ? p.deliveryDay : currentDayStart,
        }))
        .filter((p) => !p.delivered && p.deliveryDay >= currentDayStart);

      return {
        ...saved,
        clock: { ...saved.clock, isPaused: true, speed: 'slow' },
        tutorial: { currentStep: 0, isActive: false, completed: true },
        bm: saved.bm ?? { offers: [], accepted: [] },
        dayAhead: {
          ...saved.dayAhead,
          deliveryDay: migratedDeliveryDay,
          nextDeliveryDay: saved.dayAhead?.nextDeliveryDay ?? migratedDeliveryDay,
          playerSchedule: migratedSchedule,
        },
      };
    }
    return createGameState();
  });
  const [dataSource, setDataSource] = useState<'loading' | 'live' | 'synthetic'>(
    loadAutoSave() ? 'live' : 'loading'
  );
  const intervalRef = useRef<number | null>(null);
  const fetchedRef = useRef(false);
  const autosaveRef = useRef(0);

  // Apply Elexon data: reset clock to data date 00:00, reset DA state fully
  const applyElexonData = (dayData: ElexonDayData) => {
    const dataDate = new Date(dayData.date + 'T00:00:00Z');
    const t = dataDate.getTime();
    const firstSip = dayData.sipPrices[0] ?? 0;
    const initialPrice = {
      timestamp: t,
      price: firstSip,
      demandMw: 30000,
      renewablePct: 0.25,
      basePrice: dayData.daPrices[0] ?? firstSip,
      eventImpact: 0,
    };
    setState(prev => ({
      ...prev,
      clock: {
        ...prev.clock,
        currentTime: t,
        startTime: t,
        isPaused: true,
      },
      priceHistory: [initialPrice],
      currentPrice: initialPrice,
      dayAhead: {
        bids: [],
        results: [],
        gateClosureTime: getGateClosureTime(t),
        isAuctionOpen: true,
        deliveryDay: getNextDeliveryDay(t),
        nextDeliveryDay: getNextDeliveryDay(t),
        forecastPrices: dayData.daPrices,
        sipOutturn: generateSIPOutturn(dayData.daPrices, dayData.niv),
        niv: dayData.niv,
        demandForecast: dayData.demandForecast,
        windForecast: dayData.windForecast,
        solarForecast: dayData.solarForecast,
        demandOutturn: dayData.demandOutturn,
        windOutturn: dayData.windOutturn,
        solarOutturn: dayData.solarOutturn,
        revealedPeriods: 0,
        playerSchedule: [],
      },
      bm: { offers: [], accepted: [] },
      trades: [],
      analysis: null,
      battery: {
        ...prev.battery,
        cycleLog: [],
        totalChargedMwh: 0,
        totalDischargedMwh: 0,
        totalChargeCost: 0,
        totalDischargeRevenue: 0,
        totalCycles: 0,
        currentSocMwh: prev.battery.config.capacityMwh * 0.5,
        socPct: 50,
      },
    }));
  };

  // On mount: fetch real Elexon data (or refresh if stale)
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    const shouldFetch = needsRefresh() || !loadAutoSave();

    if (shouldFetch) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDataSource('loading');
      fetchLatestDay()
        .then(dayData => {
          cacheElexonDay(dayData.date, dayData);
          applyElexonData(dayData);
          setDataSource('live');
          console.log(`Loaded real Elexon data for ${dayData.date}`);
        })
        .catch(err => {
          console.warn('Elexon API unavailable, using synthetic data:', err.message);
          setDataSource('synthetic');
        });
    }
  }, []);

  // Fetch new forecasts when sim day changes
  const simDateRef = useRef('');
  useEffect(() => {
    const d = new Date(state.clock.currentTime);
    const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    if (dateStr === simDateRef.current) return;
    simDateRef.current = dateStr;

    fetchDayData(dateStr)
      .then(dayData => {
        cacheElexonDay(dayData.date, dayData);
        setState(prev => ({
          ...prev,
          dayAhead: {
            ...prev.dayAhead,
            forecastPrices: dayData.daPrices.some(p => p !== 0) ? dayData.daPrices : prev.dayAhead.forecastPrices,
            sipOutturn: dayData.daPrices.some(p => p !== 0) ? generateSIPOutturn(dayData.daPrices, dayData.niv) : prev.dayAhead.sipOutturn,
            niv: dayData.niv.some(v => v !== 0) ? dayData.niv : prev.dayAhead.niv,
            demandForecast: dayData.demandForecast.some(v => v > 0) ? dayData.demandForecast : prev.dayAhead.demandForecast,
            windForecast: dayData.windForecast.some(v => v > 0) ? dayData.windForecast : prev.dayAhead.windForecast,
            solarForecast: dayData.solarForecast.some(v => v > 0) ? dayData.solarForecast : prev.dayAhead.solarForecast,
          },
        }));
      })
      .catch(() => {});
  }, [state.clock.currentTime]);

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
    setState(prev => loadScenario(prev, day));
    setDataSource(day.id.startsWith('elexon-') ? 'live' : 'synthetic');
  }, []);

  // Explicitly (re)load the latest real Elexon day — used when the player picks
  // "Live" in the launcher, so a stale autosave / previous scenario can't linger.
  const loadLive = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setDataSource('loading');
    fetchLatestDay()
      .then(dayData => {
        cacheElexonDay(dayData.date, dayData);
        applyElexonData(dayData);
        setDataSource('live');
        console.log(`Loaded real Elexon data for ${dayData.date}`);
      })
      .catch(err => {
        console.warn('Elexon API unavailable, using synthetic data:', err.message);
        setDataSource('synthetic');
      });
  }, []);

  const configureBattery = useCallback((config: Partial<BatteryConfig>) => {
    setState(prev => reconfigureBattery(prev, config));
  }, []);

  const loadSavedState = useCallback((saved: GameState) => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setState({ ...saved, bm: saved.bm ?? { offers: [], accepted: [] } });
  }, []);

  const reset = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    clearAutoSave();
    fetchedRef.current = false;
    const fresh = createGameState();
    setState(fresh);
    setDataSource('loading');

    fetchLatestDay()
      .then(dayData => {
        cacheElexonDay(dayData.date, dayData);
        applyElexonData(dayData);
        setDataSource('live');
      })
      .catch(() => setDataSource('synthetic'));
  }, []);

  return {
    state, dataSource, togglePause, setSpeed, stepForward,
    chargeBattery, dischargeBattery, placeDayAheadBids,
    intradayCharge, intradayDischarge, submitBmOffer, playScenario, loadLive,
    advanceTutorial, skipTutorial, setMode, configureBattery,
    loadSavedState, reset,
  };
}
