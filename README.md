# SkyBlock Flip Tracker — frontend

Tracks coins gained from craft-flipping on the Hypixel SkyBlock Auction House: for
every item you crafted and sold, it reconstructs what the ingredients cost **on the
day you crafted it**, subtracts the AH fees you actually paid, and reports the net.

This repo is the frontend only. The backend it talks to is specified in
[BACKEND.md](./BACKEND.md).

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
```

It ships with `VITE_USE_MOCKS` defaulting to on, so it runs standalone with
deterministic demo data and never touches the network. Any username works —
try `/u/Technoblade`.

To point it at a real backend:

```bash
cp .env.example .env.local
# set VITE_USE_MOCKS=false
```

`/api` is proxied to `http://localhost:4000` in dev (`VITE_API_PROXY_TARGET`), so
there is no CORS setup to do.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Dev server with HMR |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Typecheck then production build to `dist/` |
| `npm run preview` | Serve the built output |

## Layout

```
src/
  api/
    types.ts       the wire contract — mirrors BACKEND.md exactly
    client.ts      fetch layer; swaps to mocks via VITE_USE_MOCKS
    mock.ts        deterministic demo data (seeded, stable across reloads)
  components/
    charts/        hand-rolled SVG charts (see "Charts" below)
    FlipsTable.tsx sortable table view of the same data the charts encode
    Layout.tsx     shell, theme toggle, loading/error states
    Stat.tsx       hero figure + stat tiles
  lib/
    format.ts      coin/percent/date/duration formatting
    useAsync.ts    fetch-on-deps hook with race protection
    useMeasure.ts  element width for pixel-accurate chart rendering
    nbt.ts         minimal NBT reader (no deps) for decoding item_bytes
    upgrades.ts    extracts and prices upgrades off ExtraAttributes
  pages/
    Landing.tsx      username entry
    Dashboard.tsx    /u/:username — KPIs, profit curve, per-item bars, recent flips
    FlipDetail.tsx   /flip/:auctionUuid — cost basis, fees, timeline
    ItemExplorer.tsx /item/:itemId — craft cost vs market price history
    Live.tsx         /live — real Hypixel data, no backend required
    Settings.tsx     /settings — local API key (development only)
  styles/
    tokens.css     design tokens, light + dark
    global.css     layout and component styles
```

## Charts

The three charts are hand-written SVG rather than a chart library, so the mark
specs (2px strokes, 4px rounded bar ends anchored to the zero baseline, ≥2px
surface gaps, crosshair tooltips) are exact instead of fought for.

Colors come from `styles/tokens.css` and were checked with a palette validator
against both surfaces — lightness band, chroma floor, colorblind separation,
normal-vision separation, and contrast all pass in light and dark. **If you change
a `--series-*`, `--pos`, or `--neg` value, re-validate rather than eyeballing it.**

Two deliberate choices worth not "fixing":

- **Profit/loss is blue↔red, not green↔red.** Green/red is the classic red-green
  colorblindness failure case, and it is exactly the encoding a money dashboard
  reaches for by reflex. Every bar also carries a signed value label, so the sign
  never depends on color.
- **No dual-axis charts.** Craft cost and market price share one coin axis because
  they are the same unit; a second y-scale would make the margin gap meaningless.

Each chart has a table equivalent on the same page, so nothing is color-only.

## The `/live` page

Unlike the tracker pages, `/live` uses **real Hypixel data** — the public endpoints
serve CORS headers, so the browser can call them directly. No backend, no key:

- **Upgrades on live auctions** — decodes real `item_bytes` NBT in the browser,
  extracts the upgrades applied to each item, and prices them against the current
  bazaar. This is the demonstration of why cost basis ≠ recipe cost.
- **Bazaar spreads** — every product, ranked by spread × weekly volume.
- **A player's auctions** — the one panel that needs a key.

It is deliberately not the flip tracker: profit needs recipes, price history and
craft timestamps, none of which exist client-side.

## Cost basis, not craft cost

A sold item is not its recipe. Items carry upgrades bought and applied after
crafting — enchantments, reforges, hot potato books, recombobulators, dungeon
stars, gemstones — and every one of them is cost basis:

```
costBasis = craftCost + upgradeCost
netProfit = salePrice − ahFees − costBasis
```

Pricing only the recipe books all of that as profit. In the demo data alone,
upgrades account for ~26% of what a recipe-only model would report as profit.

When an upgrade is detected but cannot be priced (reforge stones, runes and
cosmetics are auction-only, not on the bazaar), it is reported as unpriced and the
UI marks the flip's profit as an over-estimate. **It is never silently treated as
zero** — a missing cost that reads as free is exactly how a tracker lies.

## Data confidence

Not every flip can be priced exactly — the backend reports a `priceSource` per
ingredient and per flip:

| Source | Meaning | Shown as |
|---|---|---|
| `own_snapshot` | our own price archive covered the craft timestamp | no marker |
| `coflnet` | backfilled from third-party history | `~` |
| `live_fallback` | no history existed; today's price stood in | `~` + warning |

The dashboard surfaces the share priced from archived snapshots, and the flip
detail page states plainly when a number is an estimate. This matters: a
craft-flip tracker that silently prices old crafts at today's rates produces
confidently wrong profit figures.
