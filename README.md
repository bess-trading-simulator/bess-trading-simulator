# BESS Trading Simulator

I built this to teach myself how GB battery trading works. It's an interactive simulator that walks you through the key decisions a BESS trader makes: when to charge, discharge, or wait across day-ahead, intraday, and imbalance markets.

It's not a market replica or trading software. Market mechanics are simplified and a lot isn't modelled, but the core reasoning behind each trade is what I wanted to understand, and hopefully it's useful for others learning too.

## Live Demo

https://bess-trading-simulator.com

## What It Covers

- Settlement periods, MW vs MWh, SoC, efficiency, and power constraints
- Physical dispatch decisions: charge, discharge, wait
- Day-ahead scheduling across 48 half-hour periods (gate closure at 09:20 UK time)
- Intraday re-optimisation as forecasts update
- SIP/NIV outturn review and imbalance analysis
- Balancing Mechanism and ancillary services overview
- Post-trade analysis and mistake review

## Features

- Pulls real market data from the Elexon BMRS API (DA prices, SIP, NIV) with synthetic fallback
- Five guided lessons: Arbitrage, Day-Ahead, Intraday, Imbalance, and Market Context
- Decision Coach that adapts to current price, battery state, and forecast
- BST/GMT-aware gate closure
- Configurable battery (default 50 MW / 100 MWh, 90% efficiency)
- Rolling price chart with live SIP prices
- Scenario selector with bundled scenarios and Elexon date picker
- Sandbox mode for free experimentation
- Dark/light theme, save/load, glossary, strategy guide

## Data

No API keys needed. Uses the public Elexon BMRS endpoint (`data.elexon.co.uk/bmrs/api/v1`). Loads the most recent complete settlement day on startup and fetches fresh forecasts on each day rollover. Falls back to synthetic data if unavailable.

**Note:** Some prices, forecasts, or variables may occasionally show as 0 if the Elexon API is unavailable or returns incomplete data. This is a known issue being resolved.

## Simplifications

A lot is simplified compared to real markets:

- No order books, fees, collateral, or bid/offer spreads
- BM and ancillary services are shown for context but not fully simulated yet
- Imbalance settlement is simplified
- But the core ideas (reading price signals, managing SoC, scheduling, reviewing trades) carry across

## Running Locally

```bash
npm install
npm run dev
```

```bash
npm run build
npm run lint
```

## Deploying

Built with Vite. Works on Vercel with default settings:

- Framework: Vite
- Build: `npm run build`
- Output: `dist`

## Structure

- `src/engine/` - simulation logic (clock, battery, pricing, decision coach, Elexon API)
- `src/components/` - React UI (training lessons, trading cockpit, charts, panels)
- `src/data/` - curriculum and scenario data
