export interface BatteryConfig {
  capacityMwh: number;
  powerRatingMw: number;
  efficiencyPct: number;
  minSocPct: number;
  maxSocPct: number;
  /** £ per MWh of throughput (wear cost, illustrative) */
  degradationCostPerMwh?: number;
}

export interface BatteryState {
  config: BatteryConfig;
  currentSocMwh: number;
  socPct: number;
  totalCycles: number;
  totalChargedMwh: number;
  totalDischargedMwh: number;
  totalChargeCost: number;
  totalDischargeRevenue: number;
  cycleLog: CycleEntry[];
}

export interface CycleEntry {
  timestamp: number;
  action: 'charge' | 'discharge';
  mw: number;
  price: number;
  energyMwh: number;
  cost: number;
}

const DEFAULT_CONFIG: BatteryConfig = {
  capacityMwh: 100,
  powerRatingMw: 50,
  efficiencyPct: 90,
  minSocPct: 0,
  maxSocPct: 100,
  degradationCostPerMwh: 5,
};

export function createBattery(config?: Partial<BatteryConfig>): BatteryState {
  const c = { ...DEFAULT_CONFIG, ...config };
  const initialSoc = c.capacityMwh * 0.5; // start at 50%
  return {
    config: c,
    currentSocMwh: initialSoc,
    socPct: 50,
    totalCycles: 0,
    totalChargedMwh: 0,
    totalDischargedMwh: 0,
    totalChargeCost: 0,
    totalDischargeRevenue: 0,
    cycleLog: [],
  };
}

export function getMaxChargeableMw(state: BatteryState): number {
  const maxSocMwh = state.config.capacityMwh * (state.config.maxSocPct / 100);
  const headroom = maxSocMwh - state.currentSocMwh;
  // Account for efficiency: we need to charge more from grid to store `headroom`
  const eff = state.config.efficiencyPct / 100;
  const gridMwNeeded = headroom / (eff * 0.5);
  return Math.min(state.config.powerRatingMw, Math.max(0, gridMwNeeded));
}

export function getMaxDischargeableMw(state: BatteryState): number {
  const minSocMwh = state.config.capacityMwh * (state.config.minSocPct / 100);
  const available = state.currentSocMwh - minSocMwh;
  return Math.min(state.config.powerRatingMw, Math.max(0, available / 0.5));
}

export function chargeBattery(
  state: BatteryState,
  mw: number,
  price: number,
  timestamp: number,
  durationHours = 0.5,
): { newState: BatteryState; entry: CycleEntry } | { error: string } {
  if (mw <= 0) return { error: 'Charge amount must be positive' };

  const maxMw = getMaxChargeableMw(state);
  if (maxMw < 0.01) return { error: 'Battery is full' };

  const actualMw = Math.min(mw, maxMw);
  const eff = state.config.efficiencyPct / 100;
  const gridMwh = actualMw * durationHours;
  const storedMwh = gridMwh * eff;
  const cost = gridMwh * price;

  const newSocMwh = state.currentSocMwh + storedMwh;
  const newTotalCharged = state.totalChargedMwh + storedMwh;

  const entry: CycleEntry = {
    timestamp,
    action: 'charge',
    mw: actualMw,
    price,
    energyMwh: storedMwh,
    cost: -cost,
  };

  const newState: BatteryState = {
    ...state,
    currentSocMwh: Math.min(newSocMwh, state.config.capacityMwh),
    socPct: Math.round((Math.min(newSocMwh, state.config.capacityMwh) / state.config.capacityMwh) * 10000) / 100,
    totalChargedMwh: newTotalCharged,
    totalChargeCost: state.totalChargeCost + cost,
    totalCycles: newTotalCharged / state.config.capacityMwh,
    cycleLog: [entry, ...state.cycleLog].slice(0, 100),
  };

  return { newState, entry };
}

export function dischargeBattery(
  state: BatteryState,
  mw: number,
  price: number,
  timestamp: number,
  durationHours = 0.5,
): { newState: BatteryState; entry: CycleEntry } | { error: string } {
  if (mw <= 0) return { error: 'Discharge amount must be positive' };

  const maxMw = getMaxDischargeableMw(state);
  if (maxMw < 0.01) return { error: 'Battery is empty' };

  const actualMw = Math.min(mw, maxMw);
  const dischargedMwh = actualMw * durationHours;
  const revenue = dischargedMwh * price;

  const newSocMwh = state.currentSocMwh - dischargedMwh;
  const newTotalDischarged = state.totalDischargedMwh + dischargedMwh;

  const entry: CycleEntry = {
    timestamp,
    action: 'discharge',
    mw: actualMw,
    price,
    energyMwh: dischargedMwh,
    cost: revenue,
  };

  const newState: BatteryState = {
    ...state,
    currentSocMwh: Math.max(newSocMwh, 0),
    socPct: Math.round((Math.max(newSocMwh, 0) / state.config.capacityMwh) * 10000) / 100,
    totalDischargedMwh: newTotalDischarged,
    totalDischargeRevenue: state.totalDischargeRevenue + revenue,
    totalCycles: (state.totalChargedMwh) / state.config.capacityMwh,
    cycleLog: [entry, ...state.cycleLog].slice(0, 100),
  };

  return { newState, entry };
}


/**
 * Physical dispatch only (no cash): signed MW for one SP, + = discharge,
 * − = charge, clipped to power and SoC limits. Cash is booked separately via
 * the settlement ledger (contracts at their price, imbalance at SIP).
 * `logPrice` is only used for the cycle log display.
 */
export function dispatchBattery(
  state: BatteryState,
  signedMw: number,
  timestamp: number,
  logPrice: number,
  durationHours = 0.5,
): { newState: BatteryState; actualMw: number } {
  if (Math.abs(signedMw) < 0.01) return { newState: state, actualMw: 0 };
  const eff = state.config.efficiencyPct / 100;
  if (signedMw > 0) {
    const mw = Math.min(signedMw, getMaxDischargeableMw(state));
    if (mw < 0.01) return { newState: state, actualMw: 0 };
    const mwh = mw * durationHours;
    const soc = Math.max(0, state.currentSocMwh - mwh);
    const entry: CycleEntry = { timestamp, action: 'discharge', mw, price: logPrice, energyMwh: mwh, cost: mwh * logPrice };
    return {
      actualMw: mw,
      newState: {
        ...state,
        currentSocMwh: soc,
        socPct: Math.round((soc / state.config.capacityMwh) * 10000) / 100,
        totalDischargedMwh: state.totalDischargedMwh + mwh,
        cycleLog: [entry, ...state.cycleLog].slice(0, 100),
      },
    };
  }
  const mw = Math.min(-signedMw, getMaxChargeableMw(state));
  if (mw < 0.01) return { newState: state, actualMw: 0 };
  const gridMwh = mw * durationHours;
  const stored = gridMwh * eff;
  const soc = Math.min(state.config.capacityMwh, state.currentSocMwh + stored);
  const totalCharged = state.totalChargedMwh + stored;
  const entry: CycleEntry = { timestamp, action: 'charge', mw, price: logPrice, energyMwh: stored, cost: -gridMwh * logPrice };
  return {
    actualMw: -mw,
    newState: {
      ...state,
      currentSocMwh: soc,
      socPct: Math.round((soc / state.config.capacityMwh) * 10000) / 100,
      totalChargedMwh: totalCharged,
      totalCycles: totalCharged / state.config.capacityMwh,
      cycleLog: [entry, ...state.cycleLog].slice(0, 100),
    },
  };
}

/** Book a cashflow: + = revenue received, − = cost paid. */
export function bookCash(state: BatteryState, amount: number): BatteryState {
  if (!Number.isFinite(amount) || amount === 0) return state;
  return amount > 0
    ? { ...state, totalDischargeRevenue: state.totalDischargeRevenue + amount }
    : { ...state, totalChargeCost: state.totalChargeCost - amount };
}

/**
 * Re-dispatch one SP: replace an already executed net dispatch `oldMw` by
 * `newMw` (signed, + = discharge). Physically the battery only ever ran the
 * NET of contract + deviation, so the old leg is undone first (no phantom
 * round-trip losses), then the new net is dispatched (clipped to limits).
 */
export function redispatchBattery(
  state: BatteryState,
  oldMw: number,
  newMw: number,
  timestamp: number,
  logPrice: number,
  durationHours = 0.5,
): { newState: BatteryState; actualMw: number } {
  const eff = state.config.efficiencyPct / 100;
  let soc = state.currentSocMwh;
  let charged = state.totalChargedMwh;
  let discharged = state.totalDischargedMwh;
  if (oldMw > 0) { soc += oldMw * durationHours; discharged -= oldMw * durationHours; }
  else if (oldMw < 0) { const stored = -oldMw * durationHours * eff; soc -= stored; charged -= stored; }
  soc = Math.max(0, Math.min(state.config.capacityMwh, soc));
  const undone: BatteryState = {
    ...state,
    currentSocMwh: soc,
    socPct: Math.round((soc / state.config.capacityMwh) * 10000) / 100,
    totalChargedMwh: Math.max(0, charged),
    totalDischargedMwh: Math.max(0, discharged),
    totalCycles: Math.max(0, charged) / state.config.capacityMwh,
  };
  return dispatchBattery(undone, newMw, timestamp, logPrice, durationHours);
}
