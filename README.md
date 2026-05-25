# BESS Trading Simulator

We built this to learn how GB battery trading works. It's an interactive simulator that walks you through the key decisions a BESS trader makes: when to charge, discharge, or wait across day-ahead, intraday, and imbalance markets.

It's not a market replica or trading software. Market mechanics are simplified and a lot isn't modelled, but the core reasoning behind each trade is what we wanted to understand, and hopefully it's useful for others learning too.

## Live Demo

https://bess-trading-simulator.com

## What It Covers

- Settlement periods, MW vs MWh, SoC, efficiency, and power constraints
- Physical dispatch decisions: charge, discharge, wait
- Day-ahead scheduling across 48 half-hour periods (gate closure at 09:20 UK time, BST/GMT-aware)
- Intraday re-optimisation as forecasts update
- Imbalance trading with NIV-derived cash-out and SIP settlement
- Post-trade analysis with hit-rate grading and forecast accuracy review

## Features

- **Pick your markets** — choose any combination of Day-Ahead, Intraday, and Imbalance from the sandbox launcher
- **Live Elexon data** — pulls DA prices, SIP, NIV, demand/wind/solar forecasts from the BMRS API, with synthetic fallback
- **Imbalance trading** — NIV signal reading, conviction-based dispatch, and SIP settlement
- **Day-ahead auction** — 48-period schedule builder with forecast chart, SoC projection, and preset strategies
- **Intraday revision** — update positions as new information arrives after gate closure
- **Decision Coach** — adapts recommendations to current price, battery state, and forecast
- **Post-trade analysis** — grades trades, shows missed periods, and reviews forecast vs outturn
- **Guided training** — five structured lessons covering Arbitrage, Day-Ahead, Intraday, Imbalance, and Market Context
- Configurable battery (default 50 MW / 100 MWh, 90% efficiency)
- Scenario selector with bundled scenarios and Elexon date picker
- Dark/light theme, save/load, glossary, strategy guide

## Data

No API keys needed. Uses the public Elexon BMRS endpoint (`data.elexon.co.uk/bmrs/api/v1`). Loads the most recent complete settlement day on startup and fetches fresh data on each day rollover. Falls back to synthetic data if unavailable.

**Note:** Some prices, forecasts, or variables may occasionally show as 0 if the Elexon API is unavailable or returns incomplete data. This is a known issue being resolved.

## Simplifications

A lot is simplified compared to real markets:

- No order books, fees, collateral, or bid/offer spreads
- BM and ancillary services are shown for context but not fully simulated yet
- Imbalance settlement is simplified (single NIV-derived SIP)
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

Built with Vite. Static output in `dist/`. Includes `.htaccess` for Apache SPA routing.

- Build: `npm run build`
- Output: `dist`
- Upload `dist/` contents to web root via FTP

## Structure

- `src/engine/` — simulation logic (clock, battery, pricing, decision coach, Elexon API)
- `src/components/` — React UI (sandbox, training, trading views, charts, panels)
- `src/data/` — curriculum, scenarios, and strategy definitions
