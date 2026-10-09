import type { SpeedPreset } from './types';

// TIME CONVENTION: the simulator clock is UK local WALL-CLOCK time (London),
// stored as epoch ms and always formatted with timeZone 'UTC'. A settlement day
// runs 00:00–24:00 on this clock, SP1 starts at 00:00 — exactly how Elexon
// numbers settlement periods in UK local time. Gate closures are therefore plain
// wall-clock times (09:20, 15:30). Simplification: every day has 48 SPs (the
// 46/50-SP clock-change days are not modelled).

export const HOUR_MS = 3600_000;
export const HALF_HOUR_MS = 1800_000;

export function createClock(startDate?: Date) {
  // UTC midnight (not browser-local) so the synthetic day starts at SP1.
  const start = startDate ?? new Date(Date.UTC(2024, 0, 15, 0, 0, 0));
  return {
    currentTime: start.getTime(),
    isPaused: true,
    speed: 'slow' as SpeedPreset,
    startTime: start.getTime(),
  };
}

/** 5-minute steps inside a settlement period (intra-SP control). */
export const SUB_STEP_MS = 5 * 60 * 1000;
export const SUB_STEPS_PER_SP = 6;

/** Advance to the start of the next settlement period (snaps if mid-SP). */
export function tick(clock: { currentTime: number; isPaused: boolean; speed: number | string; startTime: number }) {
  if (clock.isPaused) return clock;
  return {
    ...clock,
    currentTime: Math.floor(clock.currentTime / HALF_HOUR_MS) * HALF_HOUR_MS + HALF_HOUR_MS,
  };
}

/** Index (0-5) of the 5-minute interval within the running SP. */
export function subStepIndex(time: number): number {
  return Math.floor((time % HALF_HOUR_MS) / SUB_STEP_MS);
}



export function getSettlementPeriod(time: number): number {
  const d = new Date(time);
  return d.getUTCHours() * 2 + (d.getUTCMinutes() >= 30 ? 1 : 0) + 1; // 1-48
}




export function formatHour(time: number): string {
  const d = new Date(time);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function formatDate(time: number): string {
  const d = new Date(time);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// EPEX SPOT GB DA gate closure: 09:20 UK local time (wall clock).
function gateOnDay(dayStart: number): number {
  return dayStart + (9 * 60 + 20) * 60_000;
}

export function getGateClosureTime(currentTime: number): number {
  const day = getUtcDayStart(currentTime);
  const gate = gateOnDay(day);
  return currentTime >= gate ? gateOnDay(day + 24 * HOUR_MS) : gate;
}

export function getNextDeliveryDay(currentTime: number): number {
  const day = getUtcDayStart(currentTime);
  return day + (currentTime >= gateOnDay(day) ? 2 : 1) * 24 * HOUR_MS;
}

export function hoursUntilGateClosure(currentTime: number): number {
  const gate = getGateClosureTime(currentTime);
  return Math.max(0, Math.round((gate - currentTime) / HOUR_MS * 10) / 10);
}

/** UTC midnight ms for the calendar day containing `time` */
export function getUtcDayStart(time: number): number {
  const d = new Date(time);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0);
}

export function formatDeliveryDay(time: number | null | undefined): string {
  if (!time || !Number.isFinite(time)) return '—';
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' });
}

/**
 * Intraday gate closure for a battery's physical position: GB BM Gate Closure is
 * 1 hour before the start of the SP — after that the notified position (FPN /
 * ECVN) is frozen, so the product can no longer change the physical schedule.
 */
export const ID_GATE_CLOSURE_MS = HOUR_MS;

/** True while SP `sp` (0-indexed) of the current day can still be traded intraday. */
export function isIntradayGateOpen(currentTime: number, sp: number): boolean {
  const spStart = getUtcDayStart(currentTime) + sp * HALF_HOUR_MS;
  return currentTime < spStart - ID_GATE_CLOSURE_MS;
}

/** First SP (0-indexed) of the current day still open for intraday trading. */
export function firstIntradayTradableSp(currentTime: number): number {
  const msIntoDay = currentTime - getUtcDayStart(currentTime);
  return Math.floor((msIntoDay + ID_GATE_CLOSURE_MS) / HALF_HOUR_MS) + 1;
}

/** EPEX GB 30-min day-ahead auction gate closure: 15:30 UK on D-1. */
export function getHalfHourGateClosureTime(currentTime: number): number {
  return getUtcDayStart(currentTime) + (15 * 60 + 30) * 60_000;
}
