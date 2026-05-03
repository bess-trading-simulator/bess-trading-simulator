# BESS Trading Simulator

An interactive GB battery energy storage system (BESS) trading simulator for learning how grid-scale batteries earn revenue across day-ahead, intraday, imbalance, balancing mechanism, and revenue-stacking workflows.

The project is intentionally public and educational. It is designed as a portfolio project for learning power trading concepts, not as production trading software or financial advice.

## Live Demo

https://trading-sim-two.vercel.app/

## What It Teaches

- Settlement periods, MW vs MWh, SoC, efficiency, headroom, and power constraints.
- Physical BESS dispatch: charge, discharge, wait, and preserve optionality.
- Day-ahead scheduling across 48 half-hour periods.
- Intraday re-optimisation when forecast information changes.
- SIP/NIV outturn review and imbalance-style learning.
- Balancing Mechanism and revenue-stack concepts.
- Post-trade analysis, mistake patterns, benchmarks, and trader review workflow.

## Key Features

- Guided Training mode with lesson walkthroughs and spotlight tutorial.
- Beginner, Trader, and Quant training levels.
- Sandbox mode for independent experimentation.
- Configurable 50 MW / 100 MWh default BESS.
- Half-hour battery accounting using `MW * 0.5h`.
- Synthetic GB-style price, demand, renewables, SIP, and NIV paths.
- Optional public Elexon BMRS data loading with synthetic fallback.
- Day-ahead, intraday, imbalance analysis, BM training, and revenue-stack panels.
- Dark/light theme, save/load, glossary, strategy guide, and post-trade reports.

## Data and API Notes

The simulator does not require private API keys.

- Public Elexon BMRS endpoint: `https://data.elexon.co.uk/bmrs/api/v1`
- If public data cannot be fetched, the simulator falls back to synthetic training data.
- No secrets are required for Vercel deployment.

## Market Simplifications

This is a learning simulator, not a full GB market replica.

- Day-ahead and intraday are simplified into schedule decisions, not full order books.
- Intraday liquidity, bid/offer spread, fees, collateral, and full imbalance settlement are simplified.
- BM and ancillary services are represented for training context rather than full dispatch replication.
- Network charging and historical Triad concepts are included for context, but modern BESS economics should focus on wholesale optimisation, intraday re-optimisation, BM participation, ancillary services, constraints, and degradation-aware dispatch.

## Local Development

```bash
npm install
npm run dev
```

Quality checks:

```bash
npm run lint
npm run build
```

## Deployment

Recommended Vercel settings:

- Framework preset: Vite
- Build command: `npm run build`
- Output directory: `dist`
- Install command: `npm install`

## Project Structure

- `src/engine/battery.ts` - SoC, efficiency, MWh, cycle, and revenue accounting.
- `src/engine/gameState.ts` - simulator state transitions and scheduled trade delivery.
- `src/engine/ukMarket.ts` - GB-style forecast/outturn generation and post-trade scoring.
- `src/components/TrainingLesson.tsx` - guided training mode.
- `src/components/TradingCockpit.tsx` - spot trading cockpit.
- `src/components/DayAheadAuction.tsx` - 48-period DA schedule entry.
- `src/components/IntradayTrading.tsx` - selected-period intraday trading UI.

## Portfolio Framing

This project demonstrates:

- Frontend product design for a complex trading education workflow.
- React and TypeScript application architecture.
- Simulation state management and domain modelling.
- Data visualisation with Recharts.
- Practical understanding of BESS trading concepts and GB power market workflows.
