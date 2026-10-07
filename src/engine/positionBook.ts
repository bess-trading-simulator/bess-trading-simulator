import type { GameState } from './types';
import { getUtcDayStart } from './clock';
import { findEntry } from './settlement';

export interface SettlementRow {
  period: number;
  timeLabel: string;
  daMwh: number;
  idMwh: number;
  contractedMwh: number;
  physicalMwh: number;
  imbalanceMwh: number;
  daCashflow: number;
  idCashflow: number;
  imbalanceCashflow: number;
  totalCashflow: number;
  sipPrice: number | null;
  status: 'settled' | 'delivered' | 'scheduled' | 'open';
}

export interface PositionBookSummary {
  rows: SettlementRow[];
  totalContractedMwh: number;
  totalPhysicalMwh: number;
  totalImbalanceMwh: number;
  totalDaCashflow: number;
  totalIdCashflow: number;
  totalImbalanceCashflow: number;
  totalCashflow: number;
}

const SP_HOURS = 0.5;

function periodLabel(period: number): string {
  return `${String(Math.floor(period / 2)).padStart(2, '0')}:${period % 2 === 0 ? '00' : '30'}`;
}

export function buildPositionBook(state: GameState): PositionBookSummary {
  // Today's delivery day only; physical/imbalance come from the settlement ledger.
  const day = getUtcDayStart(state.clock.currentTime);
  const rows: SettlementRow[] = Array.from({ length: 48 }, (_, period) => {
    const positions = state.dayAhead.playerSchedule.filter(p => p.deliveryDay === day && p.period === period);
    const entry = findEntry(state.ledger, day, period);
    const signedMwh = (action: 'charge' | 'discharge', mw: number) => (action === 'discharge' ? mw * SP_HOURS : -mw * SP_HOURS);
    const cashflow = (action: 'charge' | 'discharge', mw: number, price: number) => signedMwh(action, mw) * price;

    const daPositions = positions.filter(p => p.market === 'da');
    const idPositions = positions.filter(p => p.market !== 'da');
    const daMwh = daPositions.reduce((sum, p) => sum + signedMwh(p.action, p.mw), 0);
    const idMwh = idPositions.reduce((sum, p) => sum + signedMwh(p.action, p.mw), 0);
    const contractedMwh = daMwh + idMwh;
    const physicalMwh = (entry?.meteredMw ?? 0) * SP_HOURS;
    const daCashflow = daPositions.reduce((sum, p) => sum + cashflow(p.action, p.mw, p.price), 0);
    const idCashflow = idPositions.reduce((sum, p) => sum + cashflow(p.action, p.mw, p.price), 0);
    const sipPrice = entry?.settled ? entry.imbalancePrice : null;
    const imbalanceMwh = entry?.settled ? entry.imbalanceMwh : physicalMwh - (entry ? contractedMwh : 0);
    const imbalanceCashflow = entry?.settled ? entry.imbalanceCash : 0;
    const totalCashflow = daCashflow + idCashflow + imbalanceCashflow;
    const status: SettlementRow['status'] = entry?.settled
      ? 'settled'
      : entry
        ? 'delivered'
        : positions.length > 0
          ? 'scheduled'
          : 'open';

    return {
      period,
      timeLabel: periodLabel(period),
      daMwh,
      idMwh,
      contractedMwh,
      physicalMwh,
      imbalanceMwh,
      daCashflow,
      idCashflow,
      imbalanceCashflow,
      totalCashflow,
      sipPrice,
      status,
    };
  });

  const sum = (selector: (row: SettlementRow) => number) => rows.reduce((total, row) => total + selector(row), 0);

  return {
    rows,
    totalContractedMwh: sum(row => row.contractedMwh),
    totalPhysicalMwh: sum(row => row.physicalMwh),
    totalImbalanceMwh: sum(row => row.imbalanceMwh),
    totalDaCashflow: sum(row => row.daCashflow),
    totalIdCashflow: sum(row => row.idCashflow),
    totalImbalanceCashflow: sum(row => row.imbalanceCashflow),
    totalCashflow: sum(row => row.totalCashflow),
  };
}
