import { useState } from 'react';
import { HISTORICAL_DAYS } from '../data/historicalDays';
import type { HistoricalDay } from '../data/historicalDays';
import { fetchHistoricalDay } from '../engine/elexonApi';
import { getCachedDay, cacheElexonDay } from '../engine/persistence';
import { Calendar, X, Play, BookOpen, Download, Loader, Radio, Check } from 'lucide-react';

interface Props {
  onSelectScenario: (day: HistoricalDay) => void;
  onSelectLive?: () => void;
  activeId?: string;
}

const difficultyColors: Record<string, string> = {
  easy: '#00a15d',
  medium: '#ff874b',
  hard: '#ff5f62',
};

function scenarioFocus(day: HistoricalDay): string {
  const title = day.title.toLowerCase();
  const description = day.description.toLowerCase();
  if (title.includes('wind') || description.includes('wind') || description.includes('negative')) return 'Practise charging into oversupply';
  if (title.includes('scarcity') || description.includes('spike') || description.includes('cold')) return 'Practise preserving energy for scarcity';
  if (title.includes('flat') || description.includes('flat')) return 'Practise waiting when spread is weak';
  if (description.includes('forecast') || description.includes('outturn')) return 'Practise DA vs SIP forecast error';
  if (title.includes('bm') || description.includes('balancing')) return 'Practise BM optionality';
  return 'Practise choosing charge, discharge, or wait';
}

export default function ScenarioSelector({ onSelectScenario, onSelectLive, activeId = 'live' }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [selected, setSelected] = useState<HistoricalDay | null>(null);
  const [tab, setTab] = useState<'bundled' | 'elexon'>('bundled');
  const [fetchDate, setFetchDate] = useState('');
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [fetchedDay, setFetchedDay] = useState<HistoricalDay | null>(null);
  const [maxFetchDate] = useState(() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 2);
    return d.toISOString().split('T')[0];
  });
  const [suggestedDates] = useState<{ date: string; label: string }[]>(() => {
    return Array.from({ length: 5 }, (_, idx) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - (idx + 3));
      const ds = d.toISOString().split('T')[0];
      const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
      return { date: ds, label: `${dayName} ${ds}` };
    });
  });

  const handlePlay = (day: HistoricalDay) => {
    onSelectScenario(day);
    setIsOpen(false);
    setSelected(null);
    setFetchedDay(null);
  };

  const handleLive = () => {
    onSelectLive?.();
    setIsOpen(false);
    setSelected(null);
    setFetchedDay(null);
  };

  const handleFetchDate = async () => {
    if (!fetchDate) return;
    setFetching(true);
    setFetchError('');
    setFetchedDay(null);

    try {
      // Check cache first
      const cached = getCachedDay(fetchDate);
      let data: { daPrices: number[]; sipPrices: number[]; niv: number[] };
      if (cached) {
        data = cached;
      } else {
        const elexonData = await fetchHistoricalDay(fetchDate);
        data = { daPrices: elexonData.daPrices, sipPrices: elexonData.sipPrices, niv: elexonData.niv };
        cacheElexonDay(fetchDate, data);
      }

      const hasData = data.sipPrices.some((p: number) => p !== 0);
      if (!hasData) {
        setFetchError('No data available for this date. Try a date at least 3 days ago.');
        setFetching(false);
        return;
      }

      const maxPrice = Math.max(...data.sipPrices);
      const minPrice = Math.min(...data.sipPrices);
      const avgWind = 0.25; // can't determine from price data alone

      const day: HistoricalDay = {
        id: `elexon-${fetchDate}`,
        date: fetchDate,
        title: `Real Market Data — ${fetchDate}`,
        description: `Actual GB market data from Elexon. DA prices, SIP outturns, and NIV for ${fetchDate}. Price range: £${minPrice.toFixed(0)} to £${maxPrice.toFixed(0)}/MWh.`,
        difficulty: maxPrice > 200 ? 'hard' : maxPrice > 100 ? 'medium' : 'easy',
        daPrices: data.daPrices,
        sipPrices: data.sipPrices,
        niv: data.niv,
        windPct: avgWind,
        peakDemandGw: 0,
        isTriadRisk: false,
        keyEvents: [],
        optimalRevenue: 0,
        teachingPoints: [
          'This is real market data — prices reflect actual supply, demand, and weather conditions',
          `Peak SIP was £${maxPrice.toFixed(2)}, trough was £${minPrice.toFixed(2)} — a spread of £${(maxPrice - minPrice).toFixed(2)}/MWh`,
          'Compare your trades against the SIP outturn in the Analysis tab',
        ],
      };

      setFetchedDay(day);
    } catch (err: unknown) {
      setFetchError(err instanceof Error ? err.message : 'Failed to fetch data. Check your connection.');
    }
    setFetching(false);
  };

  return (
    <>
      <button className="btn btn-scenario" onClick={() => setIsOpen(true)}>
        <Calendar size={16} /> Scenarios
      </button>

      {isOpen && (
        <div className="modal-overlay" onClick={() => { setIsOpen(false); setSelected(null); setFetchedDay(null); }}>
          <div className="modal scenario-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Scenarios & Historical Data</h2>
              <button className="btn btn-icon" onClick={() => { setIsOpen(false); setSelected(null); setFetchedDay(null); }}>
                <X size={18} />
              </button>
            </div>

            <div className="scenario-tabs">
              <button className={`tab ${tab === 'bundled' ? 'active' : ''}`} onClick={() => setTab('bundled')}>
                Training Scenarios
              </button>
              <button className={`tab ${tab === 'elexon' ? 'active' : ''}`} onClick={() => setTab('elexon')}>
                <Download size={14} /> Load from Elexon
              </button>
            </div>

            {tab === 'bundled' && !selected && (
              <>
                <p className="scenario-intro">
                  Curated training scenarios based on real GB market patterns.
                </p>
                <div className="scenario-grid">
                  {onSelectLive && (
                    <button className={`scenario-card ${activeId === 'live' ? 'active' : ''}`} onClick={handleLive}>
                      <div className="scenario-card-header">
                        <span className="scenario-date">Today</span>
                        {activeId === 'live' && <span className="scenario-active-tag"><Check size={11} /> Active</span>}
                        <span className="scenario-difficulty" style={{ color: 'var(--charge)' }}>live</span>
                      </div>
                      <h3><Radio size={14} /> Live market data</h3>
                      <p>The latest real GB market day from Elexon — live prices, NIV, wind, demand and solar.</p>
                      <div className="scenario-focus">Trade today's real market</div>
                    </button>
                  )}
                  {HISTORICAL_DAYS.map(day => (
                    <button key={day.id} className={`scenario-card ${day.id === activeId ? 'active' : ''}`} onClick={() => setSelected(day)}>
                      <div className="scenario-card-header">
                        <span className="scenario-date">{day.date}</span>
                        {day.id === activeId && <span className="scenario-active-tag"><Check size={11} /> Active</span>}
                        <span className="scenario-difficulty" style={{ color: difficultyColors[day.difficulty] }}>
                          {day.difficulty}
                        </span>
                      </div>
                      <h3>{day.title}</h3>
                      <p>{day.description}</p>
                      <div className="scenario-focus">{scenarioFocus(day)}</div>
                      <div className="scenario-stats">
                        <span>Wind: {Math.round(day.windPct * 100)}%</span>
                        <span>Optimal: £{day.optimalRevenue.toLocaleString()}</span>
                      </div>
                      {day.isTriadRisk && <span className="scenario-triad-badge">TRIAD RISK</span>}
                    </button>
                  ))}
                </div>
              </>
            )}

            {tab === 'bundled' && selected && (
              <div className="scenario-detail">
                <button className="btn" onClick={() => setSelected(null)} style={{ marginBottom: 16 }}>
                  ← Back to list
                </button>
                <div className="scenario-detail-header">
                  <h3>{selected.title}</h3>
                  <span className="scenario-date">{selected.date}</span>
                  <span className="scenario-difficulty" style={{ color: difficultyColors[selected.difficulty] }}>
                    {selected.difficulty}
                  </span>
                </div>
                <p className="scenario-detail-desc">{selected.description}</p>
                <div className="scenario-focus detail">{scenarioFocus(selected)}</div>
                <div className="scenario-detail-stats">
                  <div className="stat-pill">Wind: {Math.round(selected.windPct * 100)}%</div>
                  <div className="stat-pill">Optimal: £{selected.optimalRevenue.toLocaleString()}</div>
                  {selected.isTriadRisk && <div className="stat-pill triad">TRIAD RISK</div>}
                </div>
                <div className="scenario-events">
                  <h4><BookOpen size={14} /> Key Events</h4>
                  {selected.keyEvents.map((evt, i) => (
                    <div key={i} className="scenario-event">
                      <span className="event-sp">SP{evt.sp}</span>
                      <span>{evt.text}</span>
                    </div>
                  ))}
                </div>
                <div className="scenario-lessons">
                  <h4>What You'll Learn</h4>
                  <ul>
                    {selected.teachingPoints.map((pt, i) => <li key={i}>{pt}</li>)}
                  </ul>
                </div>
                <button className="btn btn-submit btn-buy" onClick={() => handlePlay(selected)}>
                  <Play size={16} /> Play This Scenario
                </button>
              </div>
            )}

            {tab === 'elexon' && (
              <div className="elexon-fetch-section">
                <p className="scenario-intro">
                  Fetch real GB market data from the Elexon BMRS API. Pick any date (at least 3 days ago for complete data).
                  DA prices, SIP outturns, and NIV will be loaded for that day.
                </p>

                <div className="elexon-date-picker">
                  <label>Settlement Date:</label>
                  <input
                    type="date"
                    className="input"
                    value={fetchDate}
                    onChange={e => { setFetchDate(e.target.value); setFetchError(''); setFetchedDay(null); }}
                    max={maxFetchDate}
                  />
                  <button
                    className="btn btn-buy"
                    onClick={handleFetchDate}
                    disabled={fetching || !fetchDate}
                  >
                    {fetching ? <><Loader size={14} className="spin" /> Fetching...</> : <><Download size={14} /> Fetch</>}
                  </button>
                </div>

                <div className="elexon-quick-dates">
                  <span className="quick-dates-label">Recent days:</span>
                  {suggestedDates.map(d => (
                    <button
                      key={d.date}
                      className={`btn btn-preset ${fetchDate === d.date ? 'active' : ''}`}
                      onClick={() => { setFetchDate(d.date); setFetchError(''); setFetchedDay(null); }}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>

                {fetchError && <div className="elexon-error">{fetchError}</div>}

                {fetchedDay && (
                  <div className="elexon-result">
                    <div className="scenario-detail-header">
                      <h3>{fetchedDay.title}</h3>
                      <span className="scenario-difficulty" style={{ color: difficultyColors[fetchedDay.difficulty] }}>
                        {fetchedDay.difficulty}
                      </span>
                    </div>
                    <p className="scenario-detail-desc">{fetchedDay.description}</p>
                    <div className="scenario-lessons">
                      <h4>Notes</h4>
                      <ul>
                        {fetchedDay.teachingPoints.map((pt, i) => <li key={i}>{pt}</li>)}
                      </ul>
                    </div>
                    <button className="btn btn-submit btn-buy" onClick={() => handlePlay(fetchedDay)}>
                      <Play size={16} /> Play This Day
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
