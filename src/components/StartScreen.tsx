import { Battery, GraduationCap, Play, BarChart3, Clock, TrendingUp, ShieldCheck } from 'lucide-react';
import ThemeToggle from './ThemeToggle';
import AboutProject from './AboutProject';

interface Props {
  onStartTraining: () => void;
  onOpenSandbox: () => void;
}

export default function StartScreen({ onStartTraining, onOpenSandbox }: Props) {
  return (
    <main className="start-screen">
      <section className="start-hero">
        <div className="start-title">
          <Battery size={34} className="logo-icon" />
          <div>
            <h1>BESS Trading Simulator</h1>
            <p>Learn GB battery energy storage trading from first principles. Guided missions, real Elexon market data, and post-trade review.</p>
          </div>
        </div>
        <div className="start-actions">
          <button className="btn btn-submit btn-buy" onClick={onStartTraining}>
            <GraduationCap size={17} /> Start Training
          </button>
          <button className="btn" onClick={onOpenSandbox}>
            <Play size={17} /> Open Sandbox
          </button>
          <ThemeToggle />
          <AboutProject />
        </div>
      </section>

      <section className="start-path">
        <div className="start-card">
          <GraduationCap size={18} />
          <h2>Guided Learning Path</h2>
          <ol className="feature-steps">
            <li><strong>Arbitrage</strong> — charge low, discharge high</li>
            <li><strong>Day-Ahead</strong> — build a 48-period schedule</li>
            <li><strong>Intraday</strong> — revise as forecasts update</li>
            <li><strong>Imbalance</strong> — read SIP, NIV, and outturn</li>
            <li><strong>Market Context</strong> — BM, frequency response, and triad overview</li>
          </ol>
        </div>
        <div className="start-card">
          <BarChart3 size={18} />
          <h2>Real Market Data</h2>
          <p>Loads actual GB settlement prices, day-ahead forecasts, and NIV from the Elexon BMRS API. Falls back to synthetic data if the API is unavailable.</p>
          <Clock size={18} style={{ marginTop: 18 }} />
          <h2>Half-Hourly Settlement</h2>
          <p>48 settlement periods per day, MW vs MWh, SoC constraints, round-trip efficiency, gate closure at 09:20 UK time — the mechanics that matter.</p>
          <TrendingUp size={18} style={{ marginTop: 18 }} />
          <h2>Decision Coach</h2>
          <p>Live guidance that adapts to current price, battery state, and forecast. Tells you what to do, why, and what the risk is — then grades your trades.</p>
        </div>
        <div className="start-card">
          <ShieldCheck size={18} />
          <h2>Public Demo</h2>
          <p>An educational simulator for learning how battery trading works. Not a market replica, operational trading software, or intended for live trading decisions. Some prices, forecasts, or variables may occasionally show as 0 if the Elexon API is unavailable or returns incomplete data. This is a known issue being resolved.</p>
        </div>
      </section>
    </main>
  );
}
