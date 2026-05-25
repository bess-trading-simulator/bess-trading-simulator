import type { SpeedPreset } from './types';

export const HOUR_MS = 3600_000;
export const HALF_HOUR_MS = 1800_000;

export function createClock(startDate?: Date) {
  const start = startDate ?? new Date(2024, 0, 15, 0, 0, 0);
  return {
    currentTime: start.getTime(),
    isPaused: true,
    speed: 'slow' as SpeedPreset,
    startTime: start.getTime(),
  };
}

export function tick(clock: { currentTime: number; isPaused: boolean; speed: number | string; startTime: number }) {
  if (clock.isPaused) return clock;
  return {
    ...clock,
    currentTime: clock.currentTime + HALF_HOUR_MS,
  };
}

export function getHour(time: number): number {
  return new Date(time).getUTCHours();
}

export function getMinute(time: number): number {
  return new Date(time).getUTCMinutes();
}

export function getSettlementPeriod(time: number): number {
  const d = new Date(time);
  return d.getUTCHours() * 2 + (d.getUTCMinutes() >= 30 ? 1 : 0) + 1; // 1-48
}

export function getDayOfWeek(time: number): number {
  return new Date(time).getUTCDay();
}

export function isWeekend(time: number): boolean {
  const day = getDayOfWeek(time);
  return day === 0 || day === 6;
}

export function formatTime(time: number): string {
  const d = new Date(time);
  return d.toUTCString().replace('GMT', 'UTC');
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

// BST: last Sunday of March 01:00 UTC → last Sunday of October 01:00 UTC
export function isBST(time: number): boolean {
  const d = new Date(time);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-indexed: March=2, October=9

  if (month > 2 && month < 9) return true;   // Apr–Sep: always BST
  if (month < 2 || month > 9) return false;   // Nov–Feb: always GMT

  // March: BST starts last Sunday at 01:00 UTC
  if (month === 2) {
    const lastSun = 31 - new Date(Date.UTC(year, 2, 31)).getUTCDay();
    const switchTime = Date.UTC(year, 2, lastSun, 1, 0, 0);
    return time >= switchTime;
  }

  // October: BST ends last Sunday at 01:00 UTC
  const lastSun = 31 - new Date(Date.UTC(year, 9, 31)).getUTCDay();
  const switchTime = Date.UTC(year, 9, lastSun, 1, 0, 0);
  return time < switchTime;
}

// EPEX SPOT GB DA gate closure: 09:20 UK local time
// BST: 09:20 UK = 08:20 UTC | GMT: 09:20 UK = 09:20 UTC
function gateClosureUtcHour(time: number): { hour: number; minute: number } {
  return isBST(time) ? { hour: 8, minute: 20 } : { hour: 9, minute: 20 };
}

export function getGateClosureTime(currentTime: number): number {
  const d = new Date(currentTime);
  const { hour, minute } = gateClosureUtcHour(currentTime);
  const gateClosure = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute, 0));

  if (d.getTime() >= gateClosure.getTime()) {
    const nextDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0);
    const next = gateClosureUtcHour(nextDay);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, next.hour, next.minute, 0)).getTime();
  }
  return gateClosure.getTime();
}

export function getNextDeliveryDay(currentTime: number): number {
  const d = new Date(currentTime);
  const { hour, minute } = gateClosureUtcHour(currentTime);
  const gateClosure = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute, 0));

  if (d.getTime() >= gateClosure.getTime()) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 2, 0, 0, 0)).getTime();
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0)).getTime();
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
