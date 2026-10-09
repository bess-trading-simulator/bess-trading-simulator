# BESS Trading Simulator

We built this to learn how GB battery trading works. It's an interactive simulator that walks you through the key decisions a BESS trader makes: when to charge, discharge, or wait across day-ahead, intraday, and imbalance markets.

It's not a market replica or trading software. Market mechanics are simplified and a lot isn't modelled, but the core reasoning behind each trade is what we wanted to understand, and hopefully it's useful for others learning too.

## Live Demo

https://bess-trading-simulator.com

## What It Covers

- Settlement periods, MW vs MWh, SoC, efficiency and power constraints
- Day-ahead: hourly auction (gate 09:20 UK), block orders and the 15:30 half-hourly auction — bid for tomorrow, deliver the next day
- Intraday: continuous order book per half-hour (limit/market/IOC/FOK) until T-60
- Imbalance: deliberate deviations as a non-BM unit, steered in 5-minute steps, settled at the SIP
- Balancing Mechanism: as a BM unit, offers/bids to NESO with probabilistic, partial and skipped acceptances (pay-as-bid)
- P&L across all markets including exchange fees and degradation, plus a desk review against the hindsight optimum

## Features

- **Pick your markets** — any combination of Day-Ahead, Intraday and Imbalance/BM
- **Live Elexon data** — real SIP and NIV, Market Index Price as day-ahead reference, wind/demand/solar; synthetic fallback
- **Desk forecast** — simulated forecasts with realistic errors and signals (gas, wind revision, temperature, news/REMIT)
- **Settlement ledger** — every SP is settled: contracts at their prices, the rest at the SIP
- **Desk** — forward risk book (positions, SoC, imbalance risk, gate times) and a review with benchmarks and mistake patterns
- **Academy** — five guided lessons on the real market views (settlement, day-ahead, intraday, imbalance, BM)
- Curated scenarios (incl. live news and interconnector trips) and an Elexon date picker
- UK wall-clock time, dark/light theme, save/load, glossary

## Data

No API keys needed. Uses the public Elexon BMRS endpoint (`data.elexon.co.uk/bmrs/api/v1`). A live session trades the second-latest complete day and bids in the day-ahead auction for the latest one. Falls back to synthetic data if unavailable.

## Simplifications

- Other participants, order-book liquidity and NESO decisions are modelled, not real
- One 50 MW / 100 MWh battery; clock-change days are treated as 48 SPs
- Collateral, network charges (TNUoS/BSUoS) and ancillary services are not modelled
- Fees and degradation are illustrative assumptions

## Running Locally

```bash
npm install
npm run dev
```

```bash
npm run build
npm run lint
npm test
```

## Deploying

Built with Vite. Static output in `dist/`. Includes `.htaccess` for Apache SPA routing.

- Build: `npm run build`
- Output: `dist`
- Upload `dist/` contents to web root via FTP

## Structure

- `src/engine/` — market engine (clock, auctions, intraday book, settlement, BM, P&L, desk, Elexon API)
- `src/components/` — React UI (sandbox views, Academy, desk, charts)
- `src/data/` — Academy lessons, scenarios and revenue-stream definitions
