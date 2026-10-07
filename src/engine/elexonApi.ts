// Elexon BMRS API integration for real GB market data
// Public API, no key required. Initial system prices are published ~15-30 min
// after each SP; we load the most recent *complete* settlement day.
//
// Conventions (Elexon):
//  - NIV > 0  ⇒ system SHORT (needed more energy; SIP set by offers, usually high)
//  - NIV < 0  ⇒ system LONG  (needed less energy; SIP set by bids, usually low)
//  - NIV is a volume in MWh per SP.
//  - Settlement days run in UK local time: SP1 starts 00:00 Europe/London, so in
//    BST SP1 is 23:00Z on the previous calendar day. Every series is therefore
//    fetched over a widened UTC window and filtered by `settlementDate`.

const BASE = 'https://data.elexon.co.uk/bmrs/api/v1';

export interface ElexonSystemPrice {
  settlementDate: string;
  settlementPeriod: number;
  systemSellPrice: number;
  systemBuyPrice: number;
  netImbalanceVolume: number;
}

export interface ElexonMID {
  settlementDate: string;
  settlementPeriod: number;
  price: number;
  volume: number;
  dataProvider: string;
}

export interface ElexonDayData {
  date: string;
  daPrices: number[];      // 48 SPs, £/MWh — Market Index Price (MID, APXMIDP); a short-term
                           // traded-price index used as DA proxy, NOT the EPEX/N2EX auction result
  sipPrices: number[];     // 48 SPs, real single imbalance price (SSP = SBP since P305)
  niv: number[];           // 48 SPs, net imbalance volume, MWh (Elexon sign: + = short)
  demandForecast: number[];  // 48 SPs, MW (national demand forecast)
  windForecast: number[];    // 48 SPs, MW (wind generation forecast)
  solarForecast: number[];   // 48 SPs, MW (solar generation forecast)
  demandOutturn: number[];   // 48 SPs, MW (actual demand outturn)
  windOutturn: number[];     // 48 SPs, MW (actual wind generation)
  solarOutturn: number[];    // 48 SPs, MW (actual solar generation)
  isComplete: boolean;
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return formatDate(d);
}

// UTC window that covers the whole UK-local settlement day in both GMT and BST
// (SP1 can start at 23:00Z the day before). Results must be filtered by date.
function settlementWindow(date: string): { from: string; to: string } {
  return { from: `${addDays(date, -1)}T22:00:00Z`, to: `${addDays(date, 1)}T02:00:00Z` };
}

const londonDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
});

/** UK-local calendar date (YYYY-MM-DD) of a UTC timestamp — the settlement date of the SP starting then. */
export function londonSettlementDate(iso: string): string {
  return londonDateFmt.format(new Date(iso));
}

async function fetchJson(url: string): Promise<{ data?: unknown[] }> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Elexon API ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

// Fetch system prices (SIP + NIV) for a given date
// Uses the path-style endpoint: /balancing/settlement/system-prices/{date}
async function fetchSystemPrices(date: string): Promise<ElexonSystemPrice[]> {
  const url = `${BASE}/balancing/settlement/system-prices/${date}?format=json`;
  const data = await fetchJson(url);
  return (data.data ?? []) as ElexonSystemPrice[];
}

// Fetch Market Index Data for a given settlement date. MID is a volume-weighted
// index of short-term exchange trades (APX/EPEX), used here as a DA price proxy.
async function fetchMID(date: string): Promise<ElexonMID[]> {
  const { from, to } = settlementWindow(date);
  const url = `${BASE}/datasets/MID?from=${from}&to=${to}&format=json`;
  const data = await fetchJson(url);
  return ((data.data ?? []) as ElexonMID[]).filter(d => d.settlementDate === date);
}

async function fetchDemandForecast(date: string): Promise<{ settlementPeriod: number; nationalDemand: number }[]> {
  const { from, to } = settlementWindow(date);
  const url = `${BASE}/forecast/demand/day-ahead/latest?from=${from}&to=${to}&format=json`;
  const data = await fetchJson(url);
  const all = (data.data ?? []) as { settlementDate: string; settlementPeriod: number; nationalDemand: number }[];
  return all.filter(d => d.settlementDate === date);
}

async function fetchWindSolarForecast(date: string): Promise<{ settlementPeriod: number; businessType: string; quantity: number }[]> {
  // This endpoint takes calendar dates; query a day either side and filter.
  const url = `${BASE}/forecast/generation/wind-and-solar/day-ahead?from=${addDays(date, -1)}&to=${addDays(date, 1)}&processType=day%20ahead&format=json`;
  const data = await fetchJson(url);
  const all = (data.data ?? []) as { settlementDate: string; settlementPeriod: number; businessType: string; quantity: number }[];
  return all.filter(d => d.settlementDate === date);
}

async function fetchDemandOutturn(date: string): Promise<{ settlementPeriod: number; initialDemandOutturn: number }[]> {
  const url = `${BASE}/demand/outturn?settlementDateFrom=${date}&settlementDateTo=${date}&format=json`;
  const data = await fetchJson(url);
  const all = (data.data ?? []) as { settlementDate: string; settlementPeriod: number; initialDemandOutturn: number }[];
  return all.filter(d => d.settlementDate === date);
}

interface GenActualRecord {
  startTime: string;
  settlementPeriod: number;
  data: { psrType: string; quantity: number }[];
}

async function fetchActualGeneration(date: string): Promise<GenActualRecord[]> {
  const { from, to } = settlementWindow(date);
  const url = `${BASE}/generation/actual/per-type?from=${from}&to=${to}&format=json`;
  const data = await fetchJson(url);
  // No settlementDate field here — derive it from the SP start time in UK local time.
  return ((data.data ?? []) as GenActualRecord[]).filter(r => r.startTime && londonSettlementDate(r.startTime) === date);
}

// Build a complete day's data from Elexon APIs
export async function fetchDayData(date: string): Promise<ElexonDayData> {
  const [sysPrices, midData, demandData, genData, demandActual, genActual] = await Promise.all([
    fetchSystemPrices(date).catch(() => []),
    fetchMID(date).catch(() => []),
    fetchDemandForecast(date).catch(() => []),
    fetchWindSolarForecast(date).catch(() => []),
    fetchDemandOutturn(date).catch(() => []),
    fetchActualGeneration(date).catch(() => []),
  ]);

  // Extract DA prices from APXMIDP provider
  const apxPrices = midData.filter(d => d.dataProvider === 'APXMIDP');
  const daPrices = new Array(48).fill(0);
  for (const d of apxPrices) {
    const sp = d.settlementPeriod - 1; // 0-indexed
    if (sp >= 0 && sp < 48) daPrices[sp] = d.price;
  }

  // Extract system prices and NIV
  const sipPrices = new Array(48).fill(0);
  const niv = new Array(48).fill(0);
  for (const d of sysPrices) {
    const sp = d.settlementPeriod - 1;
    if (sp >= 0 && sp < 48) {
      // Single imbalance price since P305: SSP = SBP.
      sipPrices[sp] = d.systemSellPrice ?? d.systemBuyPrice ?? 0;
      // Keep Elexon's sign convention: + = system short, − = system long.
      niv[sp] = Math.round(d.netImbalanceVolume ?? 0);
    }
  }

  // No fallback for missing MID: substituting the imbalance price would leak the
  // outturn into the "DA" curve. A day without MID is treated as incomplete.
  const midCount = apxPrices.filter(d => d.volume > 0).length;

  // Extract demand forecast
  const demandForecast = new Array(48).fill(0);
  for (const d of demandData) {
    const sp = d.settlementPeriod - 1;
    if (sp >= 0 && sp < 48) demandForecast[sp] = Math.round(d.nationalDemand ?? 0);
  }

  // Extract wind and solar forecasts
  const windForecast = new Array(48).fill(0);
  const solarForecast = new Array(48).fill(0);
  for (const d of genData) {
    const sp = d.settlementPeriod - 1;
    if (sp >= 0 && sp < 48) {
      const bt = (d.businessType ?? '').toLowerCase();
      if (bt.includes('wind')) {
        windForecast[sp] += Math.round(d.quantity ?? 0);
      } else if (bt.includes('solar')) {
        solarForecast[sp] = Math.round(d.quantity ?? 0);
      }
    }
  }

  // Extract actual demand outturn
  const demandOutturn = new Array(48).fill(0);
  for (const d of demandActual) {
    const sp = d.settlementPeriod - 1;
    if (sp >= 0 && sp < 48) demandOutturn[sp] = Math.round(d.initialDemandOutturn ?? 0);
  }

  // Extract actual wind and solar generation (nested data structure)
  const windOutturn = new Array(48).fill(0);
  const solarOutturn = new Array(48).fill(0);
  for (const record of genActual) {
    const sp = record.settlementPeriod - 1;
    if (sp >= 0 && sp < 48 && record.data) {
      for (const item of record.data) {
        const psr = (item.psrType ?? '').toLowerCase();
        if (psr.includes('wind')) {
          windOutturn[sp] += Math.round(item.quantity ?? 0);
        } else if (psr.includes('solar')) {
          solarOutturn[sp] = Math.round(item.quantity ?? 0);
        }
      }
    }
  }

  // 46/50 SPs on clock-change days. (Arrays are still 48 long: SP49-50 of a
  // 50-SP day are dropped, SP47-48 of a 46-SP day stay 0 — known limitation.)
  const isComplete = sysPrices.length >= 46 && midCount >= 46;

  return { date, daPrices, sipPrices, niv, demandForecast, windForecast, solarForecast, demandOutturn, windOutturn, solarOutturn, isComplete };
}

// Fetch the most recent complete settlement day (usually yesterday)
export async function fetchLatestDay(): Promise<ElexonDayData> {
  const today = new Date();
  for (const lag of [1, 2, 3, 4, 5]) {
    const target = new Date(today);
    target.setUTCDate(target.getUTCDate() - lag);
    const dateStr = formatDate(target);

    try {
      const data = await fetchDayData(dateStr);
      if (data.isComplete) return data;
    } catch {
      continue;
    }
  }

  throw new Error('Could not fetch recent Elexon data');
}

// Fetch a specific historical date
export async function fetchHistoricalDay(date: string): Promise<ElexonDayData> {
  return fetchDayData(date);
}
