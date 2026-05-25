import { Play, Layers, BarChart3, LineChart, ShieldCheck } from 'lucide-react';
import ThemeToggle from './ThemeToggle';
import AboutProject from './AboutProject';

interface Props {
  onOpenSandbox: () => void;
}

export default function StartScreen({ onOpenSandbox }: Props) {
  return (
    <main className="start-screen">
      <section className="start-hero">
        <div className="start-title">
          <div>
            <h1>BESS Trading Simulator</h1>
            <p>Trade GB battery energy storage on real Elexon market data — day-ahead, intraday and imbalance. Pick the markets you want and jump in.</p>
          </div>
        </div>
        <div className="start-actions">
          <button className="btn btn-submit btn-buy" onClick={onOpenSandbox}>
            <Play size={17} /> Enter Sandbox
          </button>
          <ThemeToggle />
          <AboutProject />
        </div>
      </section>

      <section className="start-path">
        <div className="start-card">
          <Layers size={18} />
          <h2>Pick your markets</h2>
          <p>Choose any combination on the next screen, then trade them side by side:</p>
          <ol className="feature-steps">
            <li><strong>Day-Ahead</strong> — build a 48-period schedule before gate closure</li>
            <li><strong>Intraday</strong> — revise positions as forecasts update</li>
            <li><strong>Imbalance</strong> — chase NIV, read the signals, settle at SIP</li>
          </ol>
        </div>
        <div className="start-card">
          <BarChart3 size={18} />
          <h2>Real market data</h2>
          <p>Loads actual GB settlement prices, day-ahead forecasts, NIV, wind and demand from the Elexon BMRS API. Falls back to synthetic data if the API is unavailable.</p>
          <LineChart size={18} style={{ marginTop: 18 }} />
          <h2>Trade &amp; review</h2>
          <p>Half-hourly settlement, SoC and round-trip efficiency, NIV-derived cash-out, and a post-trade analysis that grades your hit-rate and forecast accuracy.</p>
        </div>
        <div className="start-card">
          <ShieldCheck size={18} />
          <h2>Public demo</h2>
          <p>An educational simulator for learning how battery trading works. Not a market replica, operational trading software, or intended for live trading decisions. Some prices or forecasts may occasionally show as 0 if the Elexon API is unavailable or returns incomplete data.</p>
        </div>
      </section>
    </main>
  );
}
