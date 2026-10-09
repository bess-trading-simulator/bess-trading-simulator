// Save/load game state to localStorage with multiple slots

import type { GameState } from './types';

const SAVE_INDEX_KEY = 'bess-saves-index';
const SAVE_PREFIX = 'bess-save-';
const AUTOSAVE_KEY = 'bess-autosave';
// v2: settlement-date filtering + real SIP — older cached days had wrong SP1-2 in BST
const ELEXON_CACHE_KEY = 'bess-elexon-cache-v2';

export interface SaveSlot {
  id: string;
  name: string;
  date: string; // scenario date or sim date
  savedAt: number; // epoch ms
  mode: string;
  netProfit: number;
  totalCycles: number;
  dataSource: string;
}

export interface ElexonCache {
  [date: string]: {
    daPrices: number[];
    sipPrices: number[];
    niv: number[];
    fetchedAt: number;
  };
}

// ===== SAVE SLOTS =====

export function listSaves(): SaveSlot[] {
  try {
    const raw = localStorage.getItem(SAVE_INDEX_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function updateIndex(saves: SaveSlot[]) {
  try { localStorage.setItem(SAVE_INDEX_KEY, JSON.stringify(saves)); } catch { /* ignore */ }
}

export function saveGame(state: GameState, name: string, dataSource: string): string {
  const id = `save-${Date.now()}`;
  const revenue = state.battery.totalDischargeRevenue - state.battery.totalChargeCost;

  const slot: SaveSlot = {
    id,
    name,
    date: new Date(state.clock.currentTime).toISOString().split('T')[0],
    savedAt: Date.now(),
    mode: state.mode,
    netProfit: Math.round(revenue * 100) / 100,
    totalCycles: Math.round(state.battery.totalCycles * 100) / 100,
    dataSource,
  };

  // Strip internal state before saving
  const toSave: GameState & { _priceGenState?: unknown } = { ...state };
  delete toSave._priceGenState;

  try {
    localStorage.setItem(SAVE_PREFIX + id, JSON.stringify(toSave));
  } catch {
    return ''; // storage full — caller shows that nothing was saved
  }

  const saves = listSaves();
  saves.unshift(slot);
  // Keep max 20 saves
  if (saves.length > 20) {
    const removed = saves.splice(20);
    removed.forEach(s => localStorage.removeItem(SAVE_PREFIX + s.id));
  }
  updateIndex(saves);

  return id;
}

export function loadGame(id: string): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_PREFIX + id);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function deleteSave(id: string) {
  localStorage.removeItem(SAVE_PREFIX + id);
  const saves = listSaves().filter(s => s.id !== id);
  updateIndex(saves);
}

// ===== AUTOSAVE =====

export function autoSave(state: GameState) {
  try {
    const toSave: GameState & { _priceGenState?: unknown } = { ...state };
    delete toSave._priceGenState;
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(toSave));
  } catch {
    // localStorage full — silently fail
  }
}

export function loadAutoSave(): GameState | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearAutoSave() {
  localStorage.removeItem(AUTOSAVE_KEY);
}

// ===== ELEXON DATA CACHE =====

export function getCachedElexonData(): ElexonCache {
  try {
    const raw = localStorage.getItem(ELEXON_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function cacheElexonDay(date: string, data: { daPrices: number[]; sipPrices: number[]; niv: number[] }) {
  const cache = getCachedElexonData();
  cache[date] = { ...data, fetchedAt: Date.now() };

  // Keep the 10 most recent days cached
  const dates = Object.keys(cache).sort();
  while (dates.length > 10) {
    const oldest = dates.shift()!;
    delete cache[oldest];
  }

  // The cache is a convenience: never let a full localStorage break a live load.
  try {
    localStorage.setItem(ELEXON_CACHE_KEY, JSON.stringify(cache));
  } catch {
    try { localStorage.removeItem(ELEXON_CACHE_KEY); } catch { /* ignore */ }
  }
}

export function getCachedDay(date: string) {
  const cache = getCachedElexonData();
  return cache[date] ?? null;
}

// Check if we need to refresh (latest cached day is older than D-2)
export function needsRefresh(): boolean {
  const cache = getCachedElexonData();
  const dates = Object.keys(cache).sort();
  if (dates.length === 0) return true;

  const latest = dates[dates.length - 1];
  const latestDate = new Date(latest + 'T00:00:00Z');
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 3); // refresh if latest is older than D-3

  return latestDate < cutoff;
}
