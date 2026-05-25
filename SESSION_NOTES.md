# Session Notes — BESS Trader

Status snapshot for continuing work in a new session. Last updated: 2026-05-24.

> **Newest work is in "Session 3" at the bottom of this file** (then Session 2 above it).
> These supersede parts of sections 1–8: Imbalance is now `ImbalanceTrading` (not
> `TradingCockpit`); single NIV-derived SIP everywhere; NIV-chasing skill features
> (independent signals, conviction, forecast uncertainty, blind mode); strict Modo
> colour palette; one flat box-less header bar (Analysis + Speed + Reset live in the
> hamburger menu). Build + full functional sweep are green.

---

## 1. Project at a glance

- **App**: Vite + React 19 + TypeScript educational simulator for GB battery trading.
- **Working directory**: `/Users/webshape/Library/Mobile Documents/com~apple~CloudDocs/Dateien/UCL/BESS Trading Simulator/V1 TLW`
- **Start dev server**: `npm run dev` → http://localhost:5173/
- **Type-check**: `npx tsc -b --noEmit`
- **Build**: `npm run build`
- **Data source**: Elexon BMRS public API + synthetic fallback. No API keys.

---

## 2. App flow (current)

```
StartScreen
   ├─ Training → TrainingLesson (lessons 1–5, untouched in this session)
   └─ Sandbox  → SandboxLauncher (multi-select markets + GB region)
                  └─ Sandbox view (Tab-Bar + content)
```

### Sandbox tabs (visible only if user enabled them in the Launcher)
- **Imbalance** — spot/imbalance trading view (uses TradingCockpit)
- **Intraday** — continuous trading after gate closure
- **Day Ahead** — 48-period auction (rebuilt heavily this session)
- **Analysis** — post-trade review (always available as right-aligned button)

`AppView` type: `'imbalance' | 'intraday' | 'dayahead' | 'analysis'` (renamed from `'spot'` to `'imbalance'`).

---

## 3. What we changed this session

### 3.1 Layout / chrome
- **Removed** the entire right sidebar that used to render in every tab (DecisionCoach, NewsFeed, DailyBriefing, RegimeComparison, RiskLimits, ScenarioObjective, WorkflowChecklist, CommitmentWarnings). The main grid is now full-width.
- **Tab-Bar rebuilt** (`src/App.tsx` + `index.css`):
  - Left: 3 market tabs (Imbalance / Intraday / Day Ahead) — only the ones the user picked in the Launcher.
  - Middle: BESS indicator card with horizontal phone-style battery icon + SoC%, Stored MWh, Power MW, Capacity MWh.
  - Right: **Analysis** rendered as a standalone button (not a tab), with optional grade-badge.
- **Header aufgeräumt**:
  - Title: `BESS Trader` (was "BESS Trading Simulator").
  - Mode badge shows `ARBITRAGE / IMBALANCE / MIXED · GB`.
  - MarketClock moved into `header-right` (was its own `header-center`). Date is now a two-line label (`WED` caps + `20 May`). Status indicator separated by a vertical divider.
  - Speed selection: **`<select>` dropdown** instead of 5 buttons (`speed-select` class).
  - All secondary actions (Start, Training, Save/Load, Scenarios, Strategies, Learn, About, Theme) collapsed into a single **HeaderMenu** (`src/components/HeaderMenu.tsx`) — hamburger button → popover with vertical list.
- **`.app` is now `height:100vh; overflow:hidden`** so only `.grid-main-full` scrolls. App header + tab-bar stay pinned at the top automatically.
- **Background** changed: `--bg-primary` is now `#101521` (was `#0a0e17`).

### 3.2 SandboxLauncher (`src/components/SandboxLauncher.tsx`)
- Replaces the old binary "Arbitrage vs Imbalance" choice with a **multi-select**: any combination of Day Ahead / Intraday / Imbalance, plus a GB-only region selector.
- Type exports: `SandboxView = 'imbalance' | 'intraday' | 'dayahead'`, `SandboxMarket = 'GB'`.
- On confirm, App.tsx sets `enabledViews` and the initial view to the first selected market.
- Grouped UI: "Arbitrage" card group (Day Ahead, Intraday) and "Imbalance" card group, with `Select all` / `Clear` quick actions and a live "X markets selected · Analysis included" summary.

### 3.3 Day-Ahead page restructure (`src/components/DayAheadAuction.tsx`)
- **Sticky top zone** now contains: panel header (`Day-Ahead Market (EPEX SPOT)`) + a 2-column grid:
  - **Left 2/3**: 48-period forecast chart. Height 180 px. `barCategoryGap="28%"` for thinner bars. Compact axes.
  - **Right 1/3**: `da-quick-panel` card containing
    - Auction status (animated dot + `AUCTION OPEN/CLOSED`, gate-close countdown, delivery day)
    - "Submit Battery Schedule" heading
    - 2×2 grid of preset buttons (Arbitrage / Charge only / Discharge only / Clear)
    - **Submit Bids button** (also lives here now — was previously below the table)
- Below the sticky zone: Auction Results table (if any) + the 48-row Bid table. The old `max-height: 350px` internal scrolling on `.da-bid-scroll` and `.da-results-scroll` was **removed** so the outer container scrolls and `position: sticky` actually works.
- **Hover linkage**: hovering a row in the bid table highlights the matching bar in the chart above (opacity 1.0 + white stroke), and the row itself shows a blue inset.

### 3.4 Day-Ahead **delivery semantics fix** (engine)
This was the big technical change. Before, DA bids were "delivered" the same day they were placed, and a calendar-day rollover wiped `playerSchedule`. Now the auction running on day D-1 produces a schedule for day D and that schedule survives the rollover.

Implementation:
- **`TradePosition.deliveryDay: number`** (UTC midnight ms) added in `src/engine/ukMarket.ts`.
- **`DayAheadState.deliveryDay: number`** added in `src/engine/types.ts`. `nextDeliveryDay` is kept for backwards compatibility but now mirrors `deliveryDay`.
- **`src/engine/clock.ts`**:
  - Added `getUtcDayStart(time)` — UTC midnight of the calendar day containing `time`.
  - Added `formatDeliveryDay(time)` — locale-formatted short label, defensively handles `null/undefined/NaN` and returns `'—'`.
- **`src/engine/gameState.ts`**:
  - `createDayAheadState` now sets `deliveryDay = getNextDeliveryDay(currentTime)` and generates forecast/SIP/NIV against that day's weekday/wind profile (not the auction day's).
  - `submitDayAheadBids`, `intradayChargeAction`, `intradayDischargeAction`, `submitBmOfferAction` all stamp `deliveryDay` on every created `TradePosition`. Intraday and BM use *today* (`getUtcDayStart(currentTime)`); DA uses `state.dayAhead.deliveryDay`.
  - Delivery loop in `tickGameState` now requires `position.deliveryDay === currentDayStart && position.period === currentPeriod` to fire.
  - Day-rollover branch (`dayChanged`) now **preserves** `playerSchedule` entries with `deliveryDay >= currentDayStart` instead of wiping the schedule.
  - The legacy "start a new DA period when gate closure changes" branch was removed (it conflated auction restart with delivery, which was the root cause of the bug).
- **`src/hooks/useGameState.ts`**: migration in the initial `useState` lazy initializer — backfills `deliveryDay` on old autosaves, drops any stale `playerSchedule` entries (`delivered` or `deliveryDay < currentDayStart`).
- **UI**: `DayAheadAuction` now displays a `Delivery <weekday short date>` badge in the panel header and a `Delivery day: …` line inside the status card.

### 3.5 Minor polish
- Battery indicator in tab-bar colors by SoC band (red <15, orange <30, green <90, purple ≥90).
- Quick-Fill buttons in 2×2 grid (was vertical column).

---

## 4. File map of touched code

```
src/
├── App.tsx                                ← rewritten tab layout, SandboxLauncher wiring, HeaderMenu, BESS indicator
├── engine/
│   ├── types.ts                           ← AppView renamed; DayAheadState.deliveryDay added
│   ├── clock.ts                           ← getUtcDayStart, formatDeliveryDay
│   ├── gameState.ts                       ← delivery-day refactor (main logic change)
│   ├── ukMarket.ts                        ← TradePosition.deliveryDay added
│   └── …                                  (other modules untouched)
├── hooks/
│   └── useGameState.ts                    ← migration for old autosaves + deliveryDay backfill
├── components/
│   ├── DayAheadAuction.tsx                ← sticky-top, 2/3+1/3 split, hover linkage, submit in card
│   ├── SandboxLauncher.tsx                ← multi-select (rewritten)
│   ├── HeaderMenu.tsx                     ← new (hamburger popover wrapper)
│   ├── MarketClock.tsx                    ← speed select + new date layout
│   └── …                                  (other components untouched)
└── index.css                              ← extensive additions (see classes below)
```

### Key new/changed CSS classes
- `.app { height:100vh; overflow:hidden }` and `.grid-main-full { overflow-y:auto; min-height:0 }`
- `.tab-bar`, `.tab-bar-tabs`, `.tab-bar-right`, `.bess-indicator`, `.battery-icon` (+ body/fill/tip), `.tab-stat`, `.analysis-btn`
- `.sandbox-launcher`, `.launcher-step`, `.launcher-group`, `.launcher-card`, `.launcher-card.market`, `.launcher-card-check`, `.launcher-summary`
- `.da-sticky-top`, `.da-sticky-content`, `.da-quick-panel`, `.da-status-inline` (+ dot/sub/meta), `.da-quick-fill.vertical` (now grid), `.da-submit-inline`, `.da-delivery-badge`, `.da-panel-header`, `.da-forecast-chart.compact`, `.da-forecast-head`
- `.header-menu`, `.header-menu-pop`, `.header-menu-item`, `.speed-select`
- `.bid-table tbody tr.row-hovered`

---

## 5. Known good behaviour to verify next session

1. Open Sandbox → pick "Day Ahead" only → confirm only Day Ahead tab + Analysis button appear.
2. Day-Ahead view: header sticky, chart + quick-fill card sticky, scrolling only happens for results + bid table.
3. Hover any row in the bid table → matching bar in the chart highlights.
4. Submit bids before 09:20 UK; advance clock past midnight → schedule must survive into next day and deliver per-SP.
5. Old autosave with no `deliveryDay`: should auto-migrate, no `Invalid Date` text.

---

## 6. Open / next-up

- **Lesson data is still hard-coded** in `TrainingLesson.tsx`. Long-standing pain point flagged earlier — easy lift to extract into `src/data/lessons.ts`.
- **`tickGameState` is still ~200 lines** and touches clock, price, day-rollover, delivery, modes, analysis. Splitting into named helpers would help testability.
- **No tests yet**. Engine functions are pure and well-suited for `vitest`. Highest-value first targets: `createDayAheadState`, the delivery loop in `tickGameState`, `getUtcDayStart`/`getNextDeliveryDay`, and `useGameState` migration.
- **Save versioning**: the autosave migration we just added is ad-hoc. A real `version` field + a migration table in `src/engine/persistence.ts` would prevent the next breakage.
- **Intraday + BM "delivery day" semantics**: currently set to *today*. Realistic intraday can also trade near-future SPs. Worth a follow-up if intraday view becomes more sophisticated.
- **Old `nextDeliveryDay` field on `DayAheadState`** still exists. Kept for now to avoid touching scenario load + analysis paths; can be removed once we're confident nothing else reads it.
- **UI suggestions from the user that did not come up**: none unresolved as of end-of-session.

---

## 7. User context (for collaboration tone)

- Tim writes in German, prefers German replies. Technical follow-ups can be in English (he reads code/docs fine).
- Strongly UX-driven: iterative tweaks, screenshots, "schicker aber prägnant" type of feedback. Expect frequent layout micro-adjustments.
- Likes concrete deliverables — show before/after wiring, not architecture lectures.
- Uses the simulator personally as a learning tool (UCL context). Realism of GB market mechanics matters; if something is structurally wrong (like DA delivering same-day), he wants it fixed properly, not papered over.

---

## 8. Quick commands

```bash
# Start dev (HMR works for all changes we made)
npm run dev

# Type check (we kept this clean throughout)
npx tsc -b --noEmit

# Linter
npm run lint

# Production build sanity-check
npm run build
```

---

# Session 2 — Market-view rebuild, NIV chasing, Modo design pass (2026-05-23)

Big session. Rebuilt the three sandbox market views, added a Modo-Energy-style
design language across the app, and turned Imbalance into a proper NIV-chasing
teaching tool with forecast uncertainty.

## S2.1 Imbalance view — full rebuild (`src/components/ImbalanceTrading.tsx`)

Replaced the old `TradingCockpit` in the `imbalance` tab with a purpose-built
NIV-chasing trainer. App.tsx now renders `<ImbalanceTrading state onCharge onDischarge />`.

**Layout (top → bottom):**
- Header: title + SP/min-left badge + delivery-day badge
- One-time onboarding banner (`.im-intro`, dismissed via `localStorage` key `bess-niv-intro-dismissed`)
- **KPI strip** (4 cards): Today P&L (+ cumulative sparkline) · Hit Rate · Avg Slippage · NIV Regime (+ sparkline)
- Sticky grid (2fr / 1fr): left = 3 signal cards (Frequency, NIV forecast, Wind error) + SIP chart; right = action panel
- **NIV pattern heatmap** (`NivHeatmap`): 48 cells, cyan=long / magenta=short, ✓/✗ where traded
- **Trade table**: Time · SP · Dir · MW · NIV actual · Forecast £ · Settled £ · Δ · P&L · Call

**Component-local helpers (top of file):**
- `NIV_FORECAST_BAND = 220` — the ±MW uncertainty band shown on the NIV forecast.
- `nivForecastError(sp, dayIdx)` — deterministic (seeded by sp+day) uniform ±BAND error. Stable across renders; realises as slippage.
- `NivHeatmap({ niv, currentSp, revealedPeriods, tradeBySp })` — the 48-cell day-pattern strip.
- `Sparkline({ data, color, zeroBaseline })` — tiny inline SVG sparkline for KPI cards.

**Key derived values in the component body:**
- `currentSp = getSettlementPeriod(clock.currentTime) - 1` — **0-indexed** (was a 1-indexed off-by-one bug, now fixed; all array access uses this).
- `nivActual = dayAhead.niv[currentSp]` — engine truth.
- `niv` (the *displayed* value) = forecast = `nivActual + nivForecastError(...)` for the un-revealed current SP, else actual.
- `liveSettlePrice = imbalanceSettlementPrice(daHere, niv)` — the **expected** SIP from the forecast.
- `windError` — from real Elexon arrays if present, else synthetic `niv*0.5 + seededNoise` (the Elexon `windForecast/windOutturn` arrays are empty in the synthetic fallback — this was a "+0 always" bug).
- `imbRows[]` — today's SPOT trades with `forecastSip` (reconstructed), `settledSip` (= `t.price`, the actual settle), `settledPnL`, `isHit` (direction vs *actual* NIV sign).
- `avgSlippage = avg |settledSip − forecastSip|` — the realised forecast error.
- Risk/reward preview: `previewPnL` (from forecast) ± `previewBand` (= `avgSlippage × MWh`).
- `alreadyTradedThisSp` — one imbalance trade per SP (checks `state.trades` for a SPOT trade in this SP+day).

## S2.2 Day-Ahead (`src/components/DayAheadAuction.tsx`)

- **SoC projection line** (purple, right Y-axis 0–100%): `socPctByPeriod[]`. Start SoC = current SoC advanced through every *undelivered* position with `deliveryDay < this deliveryDay` (i.e. play out today before tomorrow's delivery). Then accumulate cleared positions + live form bids per SP.
- **KPI strip**: Net cashflow (revenue − charge cost) · Charge MWh · Discharge MWh · SoC swing (min–max%).
- SIP-outturn line **removed** from the DA chart (DA is about the upcoming auction, not settlement).

## S2.3 Intraday (`src/components/IntradayTrading.tsx`)

- Chart: DA bars (slate) + ID line (blue) + SIP line (orange, revealed only) + SoC projection (purple, right axis) + planned-trade markers (cyan charge dots / magenta discharge squares).
- `socAtEntry[]`/`socAtExit[]` — forward SoC projection from `revealedPeriods` using `planBySp` (today's positions). No double-count (forward only).
- SP grid starts at `revealedPeriods + 1` (the live SP can't be traded intraday).
- **KPI strip**: SoC now · Projected end-of-day SoC · Headroom (↓maxCharge / ↑maxDischarge) · Scheduled today.

## S2.4 Engine — NIV-driven settlement (`src/engine/`)

The core realism change so "watch NIV → it drives your P&L" holds.

- **`ukMarket.ts › generateNIV(daPrices, seed)`** — generates NIV first: structural `(avgDA − DA)×8` (cheap hours tend long) + uniform ±250 noise. (Was previously derived *from* SIP; order flipped.)
- **`ukMarket.ts › generateSIPOutturn(daPrices, niv, seed)`** — SIP now **NIV-driven**: `DA − NIV×0.08 + noise`, with a scarcity spike when NIV < −150.
- **`ukMarket.ts › imbalanceSettlementPrice(daPrice, niv)`** — the educational settlement price the player's spot/imbalance trade actually clears at:
  - `linear = −niv × 0.15`
  - `stress = max(0, |niv|−500) × 0.18` (sign inverse to NIV) — beyond ±500 MW the system runs out of cheap balancing, SIP crashes negative (long) or spikes (short)
  - returns `DA + linear + stress`
- **`gameState.ts › currentImbalancePrice(state)`** — helper: `imbalanceSettlementPrice(forecastPrices[sp], niv[sp])` for the current SP. Used by `chargeBatteryAction` / `dischargeBatteryAction` so spot trades settle at the **actual-NIV** price (not the old `currentPrice.price`). This is what makes charging into a long system cheap/paid and discharging into it a loss.
- `createDayAheadState` calls the two generators in the new order (NIV → SIP).

**Teaching loop:** player sees NIV *forecast* → expected SIP; engine settles at *actual* NIV → settled SIP; the gap is the slippage shown in the trade table. `t.price` on a SPOT trade = the actual settle; the forecast is reconstructed in the UI via the same deterministic `nivForecastError`.

**Single SIP source of truth (fix, verified via Playwright):** `generateSIPOutturn(daPrices, niv)` is now the *canonical* NIV-derived curve — literally `daPrices.map(imbalanceSettlementPrice)`, no separate noise/scarcity model (the stress term lives in `imbalanceSettlementPrice`). It's used for synthetic, **live Elexon** (we derive SIP from the real NIV instead of using Elexon's raw SIP, so the NIV signal always drives the outcome — `useGameState` both live paths + scenario load), and scenarios. `currentImbalancePrice(state)` now *reads* `sipOutturn[sp]` rather than recomputing. Result: imbalance settlement, the intraday SIP line, `generateFullAnalysis`, and PositionBook all read the same number (was a bug — Analysis graded against raw Elexon SIP £117.68 while the trade settled NIV-derived at £107.25; now both £107.25).

## S2.5 Modo-Energy design pass (`src/index.css` + all charts)

**Color tokens (`:root`, with `[data-theme="light"]` parity):**
- `--accent: #22d3ee` (cyan) — brand/charge/selection. Light: `#0891b2`.
- `--magenta: #ec4899` — discharge. Light: `#db2777`.
- `--chart-sip` orange · `--chart-da` slate · `--chart-soc` purple · `--chart-id` blue · `--chart-charge` cyan · `--chart-discharge` magenta.
- `--chart-grid`, `--niv-cell-base` (heatmap base), `--bg-secondary` == `--bg-primary` (flat cards, borders define boxes).

**Color semantics (consistent app-wide):**
- **Cyan = charge**, **magenta = discharge** (buttons, chart markers, DA price-zone bars, NIV heatmap, slider).
- **Orange = SIP / overlay lines.**
- **Green/red reserved for P&L** positive/negative and verdicts only.

**Recharts Modo style (all charts):** `vertical` 1h grid via `verticalCoordinatesGenerator`, dashed `5 5` at `#8b95a8`; `axisLine={false} tickLine={false}`; crosshair cursor; compact dark tooltip. Theme-aware overrides in CSS on `.recharts-*` classes read `var(--chart-grid)` etc.

**Other:** KPI strip (`.kpi-strip`/`.kpi-card`), pill tab-bar (`.tab-bar-tabs` segmented), `.data-table` with vertical grid lines + sticky header + row striping + hover, global `tabular-nums`.

Charts brought up to this style: Imbalance, Intraday, DayAhead, PostTradeAnalysis, PriceChart, CockpitContextCharts (last two only used in Training mode now).

## S2.6 Known notes / open items

- **Architectural simplification (pre-existing, not a regression):** `dayAhead` arrays describe the *next* delivery day but are reused as today's reference in Imbalance/Intraday. Internally consistent within each view. A clean "today-vs-tomorrow" data split is a larger refactor.
- Still no tests. Best first Vitest targets: `imbalanceSettlementPrice`, `generateImbalanceDay`, the SoC projections, `nivForecastError` determinism.
- Lesson data still hard-coded in `TrainingLesson.tsx`.

---

# Session 3 — Single-SIP fix, skill features, strict palette, header overhaul (2026-05-24)

## S3.1 Single SIP source of truth (correctness fix, verified)
The imbalance trade settled NIV-derived (£107.25) while Analysis/PositionBook graded
against raw Elexon SIP (£117.68) — two SIP notions. Unified:
- **`ukMarket.ts › generateSIPOutturn(daPrices, niv)`** is now the *canonical* curve: literally `daPrices.map(imbalanceSettlementPrice)`, no separate noise/scarcity (the stress term lives in `imbalanceSettlementPrice`).
- Used everywhere SIP is set: synthetic (`createDayAheadState`), **live Elexon** (`useGameState` both apply paths derive SIP from the real NIV instead of Elexon's raw SIP), and scenarios.
- **`gameState.ts › currentImbalancePrice(state)`** now *reads* `sipOutturn[sp]` instead of recomputing.
- Result (Playwright-verified): settle == Analysis "worst decision" == PositionBook SIP, all £107.25.

## S3.2 NIV-chasing skill features (`ImbalanceTrading.tsx`)
- **Independent signals**: `ukMarket.ts › generateImbalanceDay(seed, isWeekday)` returns `{niv, windForecast, windOutturn, demandForecast, demandOutturn}`. NIV *emerges* from drivers: `wind_surplus·0.6 − demand_excess·0.7 + residual` (wind = autocorrelated walk; demand = time-of-day bias, evening peak runs short). Wind/demand error are now real observable differences (the old "+0 wind in synthetic" bug is gone — arrays populated in synthetic too). `generateNIV` removed.
- **Conviction banner**: each driver votes long/short; aligned → "Favours CHARGE/DISCHARGE — high conviction, size up", conflicting → "trade small or sit out".
- **NIV forecast uncertainty**: `nivForecastError(sp, dayIdx)` — deterministic ±`NIV_FORECAST_BAND` (220 MW). You see NIV *forecast ± band*; the engine settles at the *actual* NIV. Trade table shows `NIV actual · Forecast £ · Settled £ · Δ` (Δ = realised forecast error = slippage). Avg-Slippage KPI = avg |settled − forecast|.
- **Risk/reward preview**: under the slider — Est. P&L ± band (band derived from avg slippage).
- **Blind mode**: eye toggle in the action head hides Expected SIP + its hint + the P&L preview (persists `bess-hide-sip`) so you trade purely on the raw signals; outcome revealed via the trade table after settlement.
- **Onboarding banner**: one-time NIV-chasing explainer (`bess-niv-intro-dismissed`).
- Decisions are **charge/discharge** (cyan/orange) everywhere; long/short stays only in the *explanatory* layer. A pre-commit "call" widget was built then **removed** (redundant with the Hit-rate KPI + confusing vs the slider).
- KPI strip on Imbalance was shrunk to a **compact one-line `.im-perf-bar`** (Today P&L · Hit rate · Avg slippage · NIV regime); the 4-card strip stays on DA/Intraday.

## S3.3 Strict Modo colour palette (replaces ALL prior colours)
Only these are allowed anywhere (+ neutrals: grays / bg / text):
- positive `#00A15D` · negative `#FF5F62`
- brand/accent `#9272F5` · charge `#007BE2` · discharge `#FF874B`
- SoC/NIV lavender `#C7B4F8` · ID line `#76B8EF` · SIP line `#FF5F62` (coral)
- medium/soft `#FF874B` / `#FFC2A2` · teal `#4EC392` reserved/unused

Tokens: `--accent` purple, added `--charge`/`--discharge` (charge usages split off `--accent`), `--magenta`→`--discharge` rename, green/red/blue/orange/purple remapped, full `--chart-*` set. A scan confirms **no hex outside this set** (grays excepted). Hover tints use `color-mix(var(--text-muted)…)` so they show in light too. Light theme uses the same palette on white.

## S3.4 Header overhaul — one flat box-less bar
- **Merged** the old app-header + tab-bar into a single `.app-header` row.
- **No boxes**: tabs are plain text (`.hdr-tab`, active = bold), battery is inline text (`50.0% · 50/100 MWh · 50 MW`, **icon removed**), clock is flat inline (`SP1 · FRI 22 May · 00:00 · ● Paused`), borderless icon buttons (`.mc-btn` / `.header-menu-trigger`), thin `.hdr-sep` dividers between segments only.
- **MarketClock** rewritten flat (`mc-sp/mc-date/mc-time/mc-status/mc-controls`); added `compact` prop. Time 22→16px. SP merged into the clock (no separate badge). Removed "MIXED · GB" mode badge, "LIVE" data badge, Battery logo.
- **Hamburger menu** holds: Speed (`<select>` with `stopPropagation` so it doesn't close the menu), Reset day, **Analysis** (moved out of the bar), Start, Training, Save/Load, Scenarios, Strategies, Learn, About, Light mode. Menu items flattened (no bordered/coloured boxes). Hamburger icon bolder (`strokeWidth 2.75`).
- **Theme toggle fix**: applied synchronously in the click handler (the menu unmounts the toggle on click, so the old `useEffect`-based apply was lost). Light theme now truly white (`#ffffff`).
- Delivery/SP badges neutralised (grey, not blue). Active tab neutral (no purple box).

## S3.5 Full functional sweep (Playwright + production build) — all green
- `npm run build` → exit 0.
- DA: arbitrage preset → submit 7 bids → KPI updates → midnight rollover (Sat→Sun deliveryDay) → **delivery fires** (SoC 50%→100% as scheduled charge SPs deliver).
- Intraday trade places + populates plan; Scenarios open; Training renders with full clock; light theme clean across views. **0 console/page errors** throughout.
- **Display findings:** (1) DA results table empties after a day rollover — confirmed **correct by design** (table shows the *current* auction; persisting old results would mislabel them as the new day's; "see today's clearing during delivery" needs the today-vs-tomorrow data split). (2) Auction-status "N scheduled" counted *all* playerSchedule incl. previous-day positions → **FIXED**: now uses `scheduledPositions` (current deliveryDay only), matching the SoC-swing KPI. Verified consistent across rollover.

## S3.6 Verification tooling note
No Playwright in repo deps. Verified by installing `playwright@1.60.0` + chromium into a **temp dir** (`/tmp` via `mktemp`) and driving the running dev server — project `package.json` left untouched. Scripts were one-offs; not committed.

## S3.7 Vitest engine tests added
- `vitest@3.2.4` devDep + scripts `test` (`vitest run`) / `test:watch`.
- **22 tests, all green** across `src/engine/{ukMarket,clock,battery}.test.ts`:
  - `imbalanceSettlementPrice`: NIV 0 → DA; long < DA; short > DA; symmetric in the linear band; goes negative when very long; stress term only beyond ±500 MW.
  - `generateImbalanceDay`: deterministic per seed; 48-period finite arrays; wind/demand outturn ≠ forecast.
  - `generateSIPOutturn`: equals `imbalanceSettlementPrice` per period (single-curve guarantee).
  - `clock`: `getSettlementPeriod` 1–48 mapping; `getUtcDayStart` midnight/idempotent; `getNextDeliveryDay` future midnight + after-gate = +1 day vs before-gate.
  - `battery`: full can't charge / empty can't discharge / power-rating cap; charge books a cost (negative price → positive cashflow); discharge books revenue (negative price → loss).
- `npm run build` stays green — test files are tree-shaken out of the bundle.

## S3.8 Open / next
- DA finding #2 fixed (scheduled count); finding #1 is correct-by-design.
- `src/index 2.css` is an unused Finder duplicate — safe to delete.
- More test coverage possible: SoC projections (currently inline in components — would need extracting), the `tickGameState` delivery loop / day-rollover.
