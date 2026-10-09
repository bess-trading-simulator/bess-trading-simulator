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
            <li><strong>Day-Ahead</strong> — bid in the 09:20 hourly and 15:30 half-hourly auctions for tomorrow</li>
            <li><strong>Intraday</strong> — continuous order book until one hour before delivery</li>
            <li><strong>Imbalance &amp; BM</strong> — deviate with the system at SIP, or offer to NESO as a BM unit</li>
          </ol>
        </div>
        <div className="start-card">
          <BarChart3 size={18} />
          <h2>Real market data</h2>
          <p>Real GB days from the Elexon BMRS API: imbalance prices and NIV, Market Index Price as the day-ahead reference, wind, demand and solar. Desk forecasts are simulated with realistic errors. Falls back to synthetic data if the API is unavailable.</p>
          <LineChart size={18} style={{ marginTop: 18 }} />
          <h2>Trade &amp; review</h2>
          <p>Half-hourly settlement of every MWh, SoC and efficiency limits, exchange fees and wear, a P&amp;L across all markets and a desk review against the hindsight optimum.</p>
        </div>
        <div className="start-card">
          <ShieldCheck size={18} />
          <h2>Public demo</h2>
          <p>An educational simulator for learning how battery trading works. Not a market replica, operational trading software, or intended for live trading decisions.</p>
        </div>
      </section>
    </main>
  );
}
