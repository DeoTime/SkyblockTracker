# Backend implementation instructions

The frontend in this repo is complete and runs against mocks. To make it real you
need a service that implements the three endpoints in §1. Everything else here is
guidance on how to produce those numbers correctly.

Read §0 first — it is the part most likely to be got wrong.

---

## 0. The three things that will make your numbers wrong

The Hypixel API can tell you what an auction sold for. It cannot, on its own, tell
you what the item cost to produce. Three gaps:

1. **There are no crafting recipes.** Measured against a live pull of
   `/v2/resources/skyblock/items`: **1 item out of 5,524 carries a recipe field.**
   Mirror the NEU repo (§5).
2. **There is no price history.** Every price endpoint is live-only. Start
   collecting on day one and you can price flips from day one forward — and
   *nothing before that* without a third-party archive.
3. **A sold item is not its recipe.** Items carry upgrades bought and applied after
   crafting: enchantments, reforges, hot potato books, recombobulators, dungeon
   stars, gemstones. **Every one of those is cost basis.** Price only the recipe
   and you book all of it as profit.

Gap 3 is the one that silently produces confidently wrong output, so it is worth
being concrete. Decoding 1,000 live auctions on 2026-07-20:

| ExtraAttributes field | Share of auctions | What it costs |
|---|---:|---|
| `enchantments` | 17.6% | one bazaar book per enchant, per level |
| `modifier` (reforge) | 16.9% | a reforge stone for the good ones |
| `upgrade_level` (stars) | 5.0% | essence, exactly quantified in item metadata |
| `rarity_upgrades` (recombobulator) | 4.7% | ~10.3M each |
| `hot_potato_count` | 2.9% | 90k each, 1.26M once past 10 |
| `gems` | 1.9% | up to ~11.8M for a Perfect gem |
| `runes` | 2.1% | auction-only, not on the bazaar |
| `ethermerge` | 0.2% | ~19.4M — a Conduit **and** a Merger, both auction-only |

A sample of 120 live auctions priced against the live bazaar found **359M coins of
upgrade cost across 24 items** — the frontend's `/live` page reproduces this on
demand. On several items the upgrades exceeded the entire asking price.

4. **Sold auctions vanish once claimed.** There is no "all auctions this player
   sold" endpoint. The only durable record is a 60-second rolling window you must
   poll forever, server-wide (§4.2). Miss a slice and it is gone.

Consequences, in build order: **stand up both collectors (§4.1, §4.2) first** —
neither price history nor sales history can be created retroactively. Then make
the resolver upgrade-aware (§6.2) before you show anyone a profit figure.

---

## 1. API contract

Base path `/api`. All responses JSON. All coin amounts are **integers** (whole
coins). All timestamps are **ISO-8601 UTC strings**. The authoritative types are
[`src/api/types.ts`](./src/api/types.ts) — keep them in sync, or generate them.

### `GET /api/players/:username/dashboard?range=7d|30d|90d|all`

```jsonc
{
  "player": { "uuid": "...", "username": "Technoblade" },
  "range": "30d",
  "stats": {
    "netProfit": 66700000,      // grossRevenue - totalCraftCost - totalFees
    "grossRevenue": 346305511,
    "totalCraftCost": 272183749,
    "totalFees": 7125256,
    "flipCount": 28,
    "winRatePct": 89.3,         // share of flips with netProfit > 0
    "avgMarginPct": 13.5,       // mean of per-flip profitPct
    "coinsPerHour": 53800,      // netProfit / total craft→sale hold hours
    "bestFlip": { /* FlipSummary, or null */ },
    "confidencePct": 36.0       // share of flips priced from own_snapshot
  },
  "profitSeries": [             // one entry per day in range, ascending, no gaps
    { "date": "2026-06-20", "daily": 0, "cumulative": 0 }
  ],
  "byItem": [                   // descending by netProfit
    { "itemId": "GEMSTONE_GAUNTLET", "itemName": "Gemstone Gauntlet",
      "flips": 11, "netProfit": 54800000, "avgMarginPct": 27.9, "revenue": 623000000 }
  ],
  "recentFlips": [ /* FlipSummary[], newest first, every flip in range (cap 500) */ ]
}
```

`profitSeries` must include **every day in the range including zero-profit days** —
the chart plots by index and will distort if days are omitted.

`recentFlips` carries **every flip in the range** — the dashboard table renders
the lot and sorts client-side. The 500 cap exists only so a prolific seller
cannot produce an unbounded payload; past it the UI falls back to the paginated
endpoint below, and `stats.flipCount` remains the true total either way.

### `GET /api/players/:username/flips?range=&page=&pageSize=`

```jsonc
{
  "player": { "uuid": "...", "username": "Technoblade" },
  "flips": [ /* FlipSummary[] */ ],
  "page": 0, "pageSize": 50,
  "totalFlips": 78, "totalPages": 2
}
```

`page` is zero-based. Default `pageSize` 50, cap it at something sane (200).
`totalFlips` must be the count for the whole range, not the page.

### `GET /api/flips/:auctionUuid`

`FlipSummary` plus `ingredients[]`, `fees[]`, `listedAt`, `currentCraftCost`,
`currentMarketPrice`. The last two may be `null` when the item is unpriceable
today; the UI renders `—`.

```jsonc
{
  "auctionUuid": "...", "itemId": "GEMSTONE_GAUNTLET", "itemName": "Gemstone Gauntlet",
  "rarity": "MYTHIC",
  "craftedAt": "2026-07-17T16:30:00Z", "listedAt": "...", "soldAt": "...",
  "ageEstimated": false,

  "acquisition": "crafted",   // or "bought" — different businesses (§7.1)
  "baseItemCost": 46789797,   // recipe total, OR cheapest CLEAN listing if bought
  "upgradeCost": 3829344,     // enchants, stars, gems, books…
  "costBasis": 50619141,      // baseItemCost + upgradeCost
  "unpricedUpgrades": 1,      // detected but unvaluable — see below

  "salePrice": 61532005, "ahFees": 1230640,
  "netProfit": 9682224, "profitPct": 19.1,   // profitPct is over costBasis
  "priceSource": "live_fallback", "bin": false,

  "ingredients": [
    { "itemId": "PERFECT_RUBY_GEM", "name": "Perfect Ruby Gemstone",
      "quantity": 1, "unitPrice": 15959434, "totalPrice": 15959434,
      "source": "coflnet" }
  ],
  "upgrades": [
    { "kind": "gemstone", "label": "Flawless Aquamarine Gemstone", "quantity": 2,
      "unitPrice": 1914672, "totalPrice": 3829344, "source": "own_snapshot" },
    { "kind": "reforge", "label": "Fabled reforge", "quantity": 1,
      "unitPrice": null, "totalPrice": null, "source": null }
  ],
  "metadata": {
    "itemId": "GEMSTONE_GAUNTLET", "name": "Gemstone Gauntlet", "tier": "MYTHIC",
    "category": "GAUNTLET", "npcSellPrice": null,
    "starCosts": null, "gemstoneSlots": 3
  },
  "fees": [ { "label": "Claiming tax (2.0%)", "amount": 1230640 } ],
  "currentCraftCost": 44079047, "currentMarketPrice": 56579194
}
```

Three rules the UI depends on:

- `netProfit = salePrice − ahFees − costBasis`. Not `− baseItemCost`.
- `ingredients` is empty when `acquisition` is `bought` — there is no recipe, and
  `baseItemCost` is a market price instead.
- An upgrade you cannot price gets `totalPrice: null` and increments
  `unpricedUpgrades`. **Never coerce it to zero** — the UI shows a warning that the
  profit figure is an over-estimate, and that warning is the honest output.
- The flip-level `priceSource` is the **worst** source across ingredients and
  upgrades.

### `GET /api/items/:itemId/history?player=<username>`

```jsonc
{
  "itemId": "GEMSTONE_GAUNTLET", "itemName": "Gemstone Gauntlet", "rarity": "MYTHIC",
  "points": [ { "date": "2026-04-21", "craftCost": 41000000, "marketPrice": 55000000 } ],
  "flips": [ /* FlipSummary[] for this item and player */ ]
}
```

### Errors

Non-2xx with `{ "error": "human readable message" }`. The frontend surfaces that
string directly, so write it for a user. 404 for unknown player/flip/item.

---

## 2. Stack

TypeScript + Node 20+, Fastify (or NestJS), PostgreSQL, Redis, one worker process.
Prisma or Kysely for the DB layer. Nothing here needs more than a single box.

Postgres matters more than the framework choice: the snapshot tables get large and
you want partitioning or TimescaleDB.

---

## 3. Data sources

| Data | Endpoint | Key? |
|---|---|---|
| Player's auctions | `GET api.hypixel.net/v2/skyblock/auction?player=<uuid>` | **yes** |
| Recently ended auctions | `GET /v2/skyblock/auctions_ended` | no |
| Active auctions (paginated) | `GET /v2/skyblock/auctions?page=N` | no |
| Bazaar snapshot | `GET /v2/skyblock/bazaar` | no |
| Item metadata | `GET /v2/resources/skyblock/items` | no |
| Username ↔ UUID | `https://api.mojang.com/users/profiles/minecraft/<name>` | no |
| **Crafting recipes** | NEU repo, see §5 | no |
| **Historical prices** | Coflnet SkyApi (`sky.coflnet.com`) | free tier |

Get a Hypixel key at `developer.hypixel.net`. Send it as the `API-Key` **header**.

### Rate limits

Default key: **120 requests/minute**, per key (not per IP — every process sharing a
key draws from the same bucket). Responses carry `RateLimit-Limit`,
`RateLimit-Remaining`, `RateLimit-Reset`.

Budget it in Redis as a shared token bucket:

| Job | Cost | Keyed? |
|---|---|---|
| bazaar snapshot | 1/min | no |
| auctions_ended | 2–3/min (20–30s cadence) | no |
| item metadata | 1/day | no |
| player reconciliation | batched, ≤10/min | **yes** |
| **headroom** | ~110/min | |

Only the reconciliation job spends key budget. The two collectors that must never
miss a beat are keyless, so a key outage cannot cause permanent data loss.

Back off on 429 and never retry tighter than the `RateLimit-Reset` window. Apply
for a production key once you have real traffic.

---

## 4. Services

### 4.1 Snapshot collector — build this first

Cron, every 60s: `GET /v2/skyblock/bazaar`, upsert every product into
`bazaar_snapshots`. To keep the table sane, write a row only when the price moved
more than ~0.5% since the last stored row, plus a heartbeat row every 5 minutes so
gaps are bounded.

Hourly: page `/v2/skyblock/auctions` and record the lowest BIN per item ID into
`ah_snapshots`. This is the only way to price AH-only ingredients later. It costs
30+ requests per sweep — schedule it away from other jobs.

### 4.2 Sales watcher — record EVERY sale, not just tracked players

This is the part most likely to be built wrong, so read the constraint first.

**Sold auctions are not retrievable after the fact.** `/v2/skyblock/auction?player=`
returns a player's *active* auctions plus ended ones **whose payout has not been
claimed**. Claiming is the deletion event, and players claim promptly. So that
endpoint is a safety net for the last few minutes/hours, **not a backfill.** There
is no endpoint anywhere that returns "every auction this player ever sold."

The only durable capture is `/v2/skyblock/auctions_ended`. Two consequences:

1. **Record every ended auction server-wide, not only tracked players.** If you
   filter to known players at ingest, a new signup has *zero* history forever. The
   endpoint is keyless, so recording everything costs one request per poll.
2. **A gap in polling is permanent data loss.** There is no recovering it.

Measured behaviour (2026-07-20, five polls over 100s):

| Property | Observed |
|---|---|
| Records per snapshot | 133–147 |
| Snapshot rotation | ~60s, **non-overlapping** |
| Two polls 25s apart | byte-identical set, 0 new |
| Next rotation | 137 records, **0 overlap** with previous |
| Sales rate | ~140/min ≈ **200k/day** |
| Fields | `auction_id, seller, seller_profile, buyer, buyer_profile, timestamp, price, bin, item_bytes` |

Because consecutive snapshots do not overlap, **poll every 20–30s and dedupe on
`auction_id`.** Polling at 60s risks skipping an entire slice on any drift, and
each skipped slice is ~140 sales gone for good.

Note the payload carries `seller` and `item_bytes` — everything a flip record
needs. **The whole sales ingest requires no API key.**

⚠ In a 417-sale sample, **100% had `bin: true`.** Either bid auctions are rare
enough to miss in that window, or they are not reported here. Verify before
assuming you capture non-BIN sales; if they are absent you need a separate
strategy for them.

**Storage.** 200k sales/day with NBT blobs is roughly 300MB/day raw, ~110GB/year.
Decode at ingest, keep the parsed item id + timestamp + upgrades, and retain raw
`item_bytes` only for sellers you actually track (or on a short TTL).

Nightly reconciliation via `?player=` is still worth running, but understand what
it does: it catches *unclaimed* auctions the watcher missed during a short outage.
It cannot recover older history.

### 4.3 Flip resolver (queue worker)

Per auction:

1. Decode `item_bytes` → NBT (§6).
2. Read `ExtraAttributes.id` and `ExtraAttributes.timestamp`.
3. Determine `baseItemCost` (§7.1): recipe total if the item is craftable,
   cheapest clean market listing if not, the cheaper of the two if both.
   **No recipe is not a reason to skip** — it usually means an upgrade-flip.
4. Price each ingredient at `craftedAt` (§7) when the base was crafted.
5. Extract upgrades from the same `ExtraAttributes` (§6.2), price them at
   `craftedAt` → `upgradeCost`, counting anything unpriceable.
6. `costBasis = baseItemCost + upgradeCost`.
7. Compute fees (§8); `netProfit = salePrice − fees − costBasis`.
8. Insert into `flips` (idempotent on `auction_uuid`).

### 4.4 Recipe syncer

Daily: pull the NEU repo, re-parse, upsert `recipes` and `recipe_ingredients`.

---

## 5. Recipes (NEU repo)

Source: `github.com/NotEnoughUpdates/NotEnoughUpdates-REPO`, directory `items/`,
one JSON per item. Clone it and `git pull` daily; do not hit raw.githubusercontent
per item.

The relevant field is a 3×3 grid keyed `A1`–`C3`, values `"ITEM_ID:count"` (empty
string for an empty slot):

```jsonc
{
  "internalname": "ENCHANTED_DIAMOND_BLOCK",
  "recipe": { "A1": "ENCHANTED_DIAMOND:32", "A2": "ENCHANTED_DIAMOND:32", "…": "" }
}
```

Real recipes retrieved live (2026-07-20), showing the two-level recursion:

```
ETHERWARP_CONDUIT   = 24× NULL_OVOID + 16× REFINED_TITANIUM      → 16.9–17.2M
ASPECT_OF_THE_VOID  = 32× NULL_OVOID + 1× ASPECT_OF_THE_END      →  5.8–6.2M
ASPECT_OF_THE_END   = 32× ENCHANTED_EYE_OF_ENDER + 1× ENCHANTED_DIAMOND → ~346k
DIVAN_*             = no recipe — buy it
```

Note `ETHERWARP_MERGER` also has no recipe, so it stays an auction-only purchase
even though the Conduit beside it is craftable. Do not assume the components of
one upgrade share a source.

Parse rules:

- Sum counts across slots — the same ingredient appears in several slots and each
  contributes.
- Ids may carry a `;variant` suffix (`ENCHANTED_LAPIS;1`); split it off before
  pricing.
- `count` inside the grid object is the **output** quantity, not an ingredient —
  divide the ingredient total by it. Treating it as an ingredient silently
  inflates every craft cost.
- Some items carry `recipes` (plural, an array) for multiple craft paths. Store all
  of them and pick the cheapest at pricing time; record which one you used.
- Ignore recipes whose output is not the item itself (forge, NPC trades) unless you
  deliberately model those too.
- Recursive crafts (an ingredient that is itself craftable): for v1, price the
  ingredient at its market price and do not recurse. Add one level of recursion
  later behind a flag, and only take the cheaper branch.

---

## 6. NBT decoding

`item_bytes` is base64 → gzip → NBT. Use `prismarine-nbt`:

```ts
import { gunzipSync } from 'node:zlib';
import * as nbt from 'prismarine-nbt';

const buf = gunzipSync(Buffer.from(itemBytes, 'base64'));
const { parsed } = await nbt.parse(buf);
const tag = parsed.value.i.value.value[0].tag.value.ExtraAttributes.value;

const itemId = tag.id.value;             // "GEMSTONE_GAUNTLET"
const rawTs  = tag.timestamp?.value;     // epoch millis OR legacy string
```

### ⚠ The timestamp will silently give you the wrong date

This one field anchors every historical price lookup, and there are three ways to
get it wrong. All three were observed in real data.

**1. It is a TAG_Long, and most parsers do not hand you a number.** A real listing
decoded with `prismarine-nbt` gives:

```js
timestamp: [415, -2117798302]     // NOT a number — two signed 32-bit halves
```

Recombine as `high * 2**32 + (low >>> 0)`:
`415 * 4294967296 + 2177168994` = `1784588596834` — epoch millis, which is the
correct craft date. Pass the raw array to `new Date()` and you get a nonsense
date, silently, with no error. Every ingredient price then gets looked up against
the wrong day.

**2. Legacy items store a string** like `"7/17/26 4:30 PM"` instead.

**3. Some items have no timestamp at all** — fall back to the auction `start` as an
upper bound and set `ageEstimated: true`.

Reference implementation, covering all three shapes:
[`src/lib/nbt.ts › readCraftTimestamp`](./src/lib/nbt.ts).

**Write a test that asserts a known blob decodes to a plausible date.** A
timestamp bug produces confident, well-formed, entirely wrong output — the worst
failure mode this system has.

If there is no timestamp at all, fall back to the auction's `start` time as an
upper bound and set `ageEstimated: true` — the UI shows a warning for this.

Note the base64 may contain unicode escapes for non-alphabetical symbols; some
languages mangle this silently. Decode from bytes, not from a decoded string.

Decoding is reliable: **1,000 of 1,000 live auction blobs parsed with zero
failures.** If yours fail, the bug is in your gzip/base64 handling.

## 6.1 Item metadata

`GET /v2/resources/skyblock/items` — keyless, 5,524 items, cache for a day. Fields:
`id, name, tier, category, material, stats, npc_sell_price, requirements,
dungeon_item, gemstone_slots, museum_data, upgrade_costs`.

Two are load-bearing:

- **`upgrade_costs`** — an array per star tier, each listing exact costs. Hyperion:
  `[[{type:'ESSENCE', essence_type:'WITHER', amount:150}], [{…300}], [{…500}], …]`.
  An item at 3★ cost the sum of the first three tiers. This makes star cost
  *exact*, not estimated — no third-party data needed.
- **`gemstone_slots`** — which slots exist and what unlocking them costs. Unlocking
  is itself a coin cost, separate from the gem you put in.

## 6.2 Upgrades — the cost basis the recipe misses

Read these off `ExtraAttributes`. Field names below were observed in live data, not
recalled; the frontend implements the same extraction in
[`src/lib/upgrades.ts`](./src/lib/upgrades.ts) if you want a reference.

| Field | Shape | Price against |
|---|---|---|
| `enchantments` | `{ sharpness: 6, ultimate_wisdom: 5 }` | `ENCHANTMENT_{NAME}_{LEVEL}` on bazaar (763 such products) |
| `modifier` | `"fabled"` | reforge-stone lookup table — **you must build this** |
| `hot_potato_count` | `10` | first 10 → `HOT_POTATO_BOOK`, remainder → `FUMING_POTATO_BOOK` |
| `rarity_upgrades` | `1` | `RECOMBOBULATOR_3000` |
| `upgrade_level` / `dungeon_item_level` | `3` | `upgrade_costs` from metadata → `ESSENCE_{TYPE}` |
| `gems` | `{ AQUAMARINE_0: "FLAWLESS", unlocked_slots: [...] }` | `{QUALITY}_{TYPE}_GEM` (62 products) |
| `runes` | `{ PEAFOWL: 3 }` | **not on the bazaar** — auction lowest-BIN only |
| `art_of_war_count` | `1` | `THE_ART_OF_WAR` |
| `ability_scroll` | `["IMPLOSION_SCROLL", …]` | the scroll id directly |
| `dye_item`, `skin` | `"DYE_WARDEN"` | auction-only |
| `tuned_transmission`, `ethermerge`, `wood_singularity_count`, `mana_disintegrator_count`, `talisman_enrichment` | counts/flags | the corresponding item id |

Read `upgrade_level ?? dungeon_item_level` — both appear in live data and mean the
same thing.

**Fields that are NOT costs** — do not price them: `baseStatBoostPercentage` and
`item_tier` (dungeon roll quality), `dungeon_skill_req`, `bossId`, `spawnedFor`,
`anvil_uses`, `seconds_held`, and the kill-counters (`champion_combat_xp`,
`eman_kills`, `runic_kills`, `expertise_kills`, `hecatomb_s_runs`). They affect
*value*, not *cost*.

### Pricing subtleties that will bite you

**A zero bazaar price is not missing data.** `ENCHANTMENT_SHARPNESS_1` through `_5`
all report `buyPrice: 0.0` — those books really are worth roughly nothing. Meanwhile
`SHARPNESS_6` is ~886k and `SHARPNESS_7` is ~130M. Distinguish three cases:

| Case | Meaning | Do |
|---|---|---|
| product absent from bazaar | auction-only (runes, reforge stones, dyes) | mark unpriced, use AH history |
| product present, `buyPrice` 0, `sellPrice` > 0 | no buy-side liquidity | fall back to `sellPrice` |
| product present, both 0 | genuinely negligible | price at 0, still count it |

Collapsing case 3 into case 1 makes ordinary items look like data gaps; collapsing
case 1 into case 3 silently inflates profit. Keep them apart.

**Enchantment levels above what the bazaar sells** must be derived: combining two
level-N books yields N+1, so a missing level roughly doubles from the highest
available level below it. Record that the number was derived.

**One NBT flag can mean several purchased items.** `ethermerge: 1` is the worked
example, and it is expensive to get wrong. Applying Etherwarp to an Aspect of the
Void consumes **both** an Etherwarp Conduit and an Etherwarp Merger, and neither
is on the bazaar:

| Item | Bazaar | Auction lowest BIN (2026-07-20) |
|---|---|---|
| `ETHERWARP_CONDUIT` | no | **18,599,990** (10 listings, all identical) |
| `ETHERWARP_MERGER` | no | **800k–1.1M** (29 listings, median 1.8M) |
| `TRANSMISSION_TUNER` | yes | 73,207 instabuy |

Emitting only the Merger — and skipping the Conduit, which is ~20× dearer —
understated one real listing's upgrade cost from **21,386,452 to 1,998,830**, i.e.
from 71.3% of its asking price down to 6.7%. Audit every flag that represents a
*process* rather than a single item.

Note also `tuned_transmission: 4` is a **level**, not a count of one item: reaching
level 4 consumes 4 Transmission Tuners.

### Pricing auction-only items

There is no server-side item filter on `/skyblock/auctions`, so lowest-BIN means
reading the whole book (~52 pages, ~50MB). Do **not** run a separate sweep per
item — harvest prices from a pass you are already making:

1. During the sweep, keep any BIN auction whose `item_name` matches a watchlist.
2. Decode only those blobs and index `min(starting_bid)` by the real
   `ExtraAttributes.id`.

Step 2 is not optional. Display names carry reforge prefixes ("Heroic Aspect of
the Void"), and skins can change them outright, so name matching alone mis-prices.
In a live sweep 39 of 51,793 auctions matched the etherwarp watchlist by name —
cheap to decode, and only the decode tells you which is which.

Your `sold_auctions` table (§9) is the better long-term source: it already records
every completed sale with `item_id`, which is real transacted lowest-BIN history
rather than a snapshot of current asks. Use the sweep until that table has depth.

**You cannot tell when an upgrade was applied.** NBT timestamps the item's
creation, not each upgrade. Price upgrades at `craftedAt` — the only anchor there
is — and treat upgrade cost as inherently more estimated than ingredient cost.
Document this rather than hiding it.

**Pets are a separate economy.** `petInfo` appeared on 12.2% of auctions and
carries level, held item and `candyUsed` (which *reduces* value). Pets are not
crafted from recipes; either model them properly or exclude them explicitly.

---

## 7.1 The base item — not every flip starts from a recipe

The model is **not** "recipe + upgrades". It is:

```
costBasis = baseItemCost + upgradeCost
```

**Prefer the craft cost.** Where a recipe exists, cost the base item from its
ingredients — that is what the seller actually spent. Falling back to someone
else's asking price overstates their costs, and can flip a profitable flip into a
reported loss.

| Acquisition | baseItemCost |
|---|---|
| `crafted` | sum of recipe ingredients at `craftedAt` (§5, §7) — **preferred** |
| `bought` | cheapest **clean** market listing, when no recipe exists |

This is not a rounding difference. Live, for the tracked seller's Aspect of the
Void listings:

| | Base | Upgrades | Cost basis | Margin at their ask |
|---|---:|---:|---:|---:|
| Market-price basis | 6.80M | 19.70M | 26.50M | **−401k** |
| Craft-cost basis | 5.81M | 17.94M | 23.75M | **+2.35M** |

Same listing, same moment — the sign flips. A market-price basis said they were
selling below cost; costing the recipe shows a 9.9% margin.

**Apply this to upgrades too, not just the base.** The Etherwarp Conduit is the
worked example: **16,939,222 to craft** against **18,599,990 lowest BIN**, saving
1.66M on the single largest line of an Aspect of the Void.

Where an item is both craftable and buyable, take the cheaper — that is what a
rational flipper does — and record which. The frontend reports `source: 'craft' |
'bazaar' | 'auction'` per line so a reader can see the basis for every number.

Many profitable items are never crafted. The tracked player s_floW runs both
businesses at once: they craft Aspect of the Void swords and apply Etherwarp, and
they resell Divan armor untouched — Divan has **no NEU recipe**, so it can only be
bought. Price only recipes and the second business is invisible; price the base at
zero and every upgrade-flip looks like pure profit.

Recursion rule: stop expanding an ingredient as soon as it trades on the bazaar.
Aspect of the Void → 32× Null Ovoid + 1× Aspect of the End, and Aspect of the End
expands once more into Enchanted Eye of Ender + Enchanted Diamond. Without the
bazaar stop condition you would keep descending into raw materials, which is both
slow and wrong: nobody mines their own diamonds to save 3 coins.

### ⚠ Price the base from CLEAN listings only

The cheapest listing of an item id is usually **not** a clean one. Live counts:

| Item | Listings | Clean | Naive lowest BIN | Clean lowest BIN |
|---|---:|---:|---:|---:|
| `ASPECT_OF_THE_VOID` | 155 | 20 (13%) | 6,636,700 | 6,636,700 |
| `DIVAN_CHESTPLATE` | 94 | 44 | 27,000,000 | **27,400,000** |
| `DIVAN_HELMET` | 62 | 4 (6%) | 29,389,999 | 29,389,999 |

For `DIVAN_CHESTPLATE` the overall cheapest listing is an *upgraded* one priced
below clean stock, so naive lowest-BIN understates the base by 400k — understated
cost, overstated profit, the same direction as every other trap in this document.
Worse, taking an upgraded listing as your base then **double-counts**: you pay for
its enchants in the base price and again in `upgradeCost`.

"Clean" = `detectUpgrades()` returns empty. Reference:
[`src/lib/upgrades.ts › isCleanBase`](./src/lib/upgrades.ts).

The model validates against the market. Buying every component at asking price —
clean Aspect of the Void 6,636,700 + Conduit 18,599,990 + Merger ~800k — totals
26.04M, against a real etherwarped listing asking 26,098,000. Within 0.3%.

That is the *buy-everything* ceiling, and it is why the craft-cost basis matters:
the seller is not paying it. Their real basis is 23.75M, and the gap between the
two numbers is the margin the business runs on.

### Finding base prices

Same rule as §6.2: no server-side item filter exists, so pre-filter a sweep by
display name and confirm by decoding NBT. Two wrinkles:

- Search by the item's **canonical name from metadata**, not the auction's
  `item_name` — the latter carries reforge prefixes ("Heroic Aspect of the Void")
  and skins can rename items outright.
- Exclude the tracked player's own listings, or a player who is the only seller
  prices their base off themselves.

The frontend does two full sweeps for this because it has no storage. **Your
backend should not.** `ah_snapshots` and `sold_auctions` (§9) already give you
clean-lowest-BIN over time — record `is_clean` at ingest and this becomes an
indexed query.

## 7. Historical pricing

For an ingredient at timestamp `t`:

1. **Own bazaar archive** — nearest `bazaar_snapshots` row within ±10 min of `t`.
   → `source: "own_snapshot"`.
2. **Own AH archive** — for non-bazaar ingredients, nearest `ah_snapshots` lowest
   BIN within ±2h. → `own_snapshot`.
3. **Coflnet backfill** — for `t` before your archive begins. Cache every result
   permanently in your own tables; never re-fetch the same day twice.
   → `source: "coflnet"`.
4. **Live price** — last resort. → `source: "live_fallback"`, and the UI will warn.

Which bazaar price to use is a real modelling decision, so make it explicit:

- **Instant-buy cost** (`quick_status.buyPrice`) — what it costs to craft *now*.
  Conservative, and the right default.
- **Buy-order cost** (`sell_summary` top order) — what a patient flipper pays.

Ship the conservative default; consider exposing both as a per-user setting later.
Whichever you choose, be consistent, because switching mid-dataset makes the
profit curve meaningless.

---

## 8. Fee model

Net profit is `salePrice - fees - craftCost`. Fees have two parts: a claiming tax
on sale, and a listing fee.

⚠ **Verify the current rates in game before trusting them.** The values baked into
the frontend mock (1% base, 2% at 1M+, 2.5% at 100M+, plus a 0.1% BIN listing fee)
are placeholders for demo data, not researched constants, and Hypixel has changed
AH fees more than once. Confirm against current game behavior, then:

- Put the rates in a **versioned table with effective dates** (`fee_schedule`), and
  price each flip with the schedule in force at `soldAt`. A single hardcoded rate
  will silently corrupt historical figures the next time Hypixel changes it.
- Return the breakdown as `fees[]` with human labels — the UI renders each line.

---

## 9. Schema

```sql
users            (id, mc_uuid UNIQUE, mc_username, created_at);
tracked_profiles (id, user_id, profile_uuid);

recipes            (item_id PK, source, output_count, variant, updated_at);
recipe_ingredients (recipe_item_id, ingredient_id, quantity);

-- partition monthly or use a TimescaleDB hypertable; these get big
bazaar_snapshots (item_id, ts, buy_price, sell_price, buy_volume, sell_volume,
                  PRIMARY KEY (item_id, ts));
-- lowest_bin_clean is the one base-item pricing may use (§7.1); the plain
-- lowest_bin usually belongs to an upgraded listing and would double-count.
ah_snapshots     (item_id, ts, lowest_bin, lowest_bin_clean, clean_count,
                  avg_bin_24h, PRIMARY KEY (item_id, ts));

fee_schedule (id, effective_from, effective_to, rules jsonb);

item_metadata (item_id PK, name, tier, category, npc_sell_price,
               upgrade_costs jsonb, gemstone_slots jsonb, fetched_at);

-- Every ended auction server-wide, recorded because it can never be re-fetched.
-- Most rows will never belong to a tracked player; keep them anyway.
sold_auctions (
  auction_id text PRIMARY KEY,
  seller uuid, seller_profile uuid, buyer uuid,
  sold_at timestamptz, price bigint, bin bool,
  item_id text, crafted_at timestamptz,   -- decoded at ingest
  upgrades jsonb,                          -- decoded at ingest
  is_clean bool,                           -- no upgrades → usable as a base price
  item_bytes text,                         -- retain only for tracked sellers / short TTL
  ingested_at timestamptz DEFAULT now()
);
CREATE INDEX ON sold_auctions (seller, sold_at DESC);
CREATE INDEX ON sold_auctions (item_id, sold_at DESC);  -- doubles as AH price history

flips (
  id, user_id, auction_uuid UNIQUE, item_id, item_name, rarity,
  crafted_at, listed_at, sold_at, age_estimated bool,
  acquisition text,           -- 'crafted' | 'bought' | 'unknown'
  base_item_cost bigint,      -- recipe total, or cheapest clean listing
  upgrade_cost bigint,        -- enchants, stars, gems, books
  cost_basis bigint,          -- base_item_cost + upgrade_cost
  unpriced_upgrades int,      -- detected but unvaluable; never fold into 0
  price_source text, recipe_variant text,
  sale_price bigint, ah_fees bigint, net_profit bigint, profit_pct numeric,
  ingredients jsonb, upgrades jsonb, fee_lines jsonb, raw_nbt jsonb, created_at
);
CREATE INDEX ON flips (user_id, sold_at DESC);
CREATE INDEX ON flips (item_id, sold_at DESC);
```

`auction_uuid UNIQUE` is what makes the resolver idempotent — the watcher and the
nightly reconciliation will both see the same sale.

---

## 10. Tracked players

This instance tracks a hardcoded pair, pinned in
[`src/config/trackedPlayers.ts`](./src/config/trackedPlayers.ts):

| Name | UUID |
|---|---|
| `s_floW` | `826bf8088bf9406a88b1bf2242f1d317` |
| `cloudyv2` | `b7e55bf27a754acc9f105cb5472a6997` |

UUIDs are pinned rather than resolved at runtime: Mojang's lookup is rate-limited
and unreliable for browser CORS, and the UUID is the stable identity — note that
`s_flow` canonicalises to `s_floW`, so matching on name would be fragile. The
Hypixel API matches on undashed UUIDs in both `auctioneer` (active auctions) and
`seller` (ended auctions).

To add players later, extend that file; the ingest keys off `TRACKED_UUIDS`.

### Onboarding generally

1. Resolve username → UUID via Mojang, **once**, and store the UUID.
2. Optional ownership verification: have the user put a short code in their Hypixel
   social-media field and check it. Worth doing before you let anyone see profit
   figures under someone else's name.
3. Their history begins whenever your §4.2 ingest started — not when they signed
   up. This is why the ingest records every seller, not just known ones.

Auction data is public, so **no player API-settings dependency exists for the core
flow** — `item_bytes` comes back regardless of their in-game privacy settings.
Profile/purse endpoints would be gated, but this product does not need them.

---

## 11. Build order

0. **M0 — today.** The two keyless collectors: bazaar snapshots (§4.1) and
   server-wide `auctions_ended` (§4.2). Nothing else. Both capture data that
   cannot be reconstructed later, and every hour they are not running is an hour
   permanently missing from every future user's history.
1. **M1** — Mojang lookup, NBT decoder, item-metadata sync, NEU recipe sync,
   `flips` populated for one hardcoded player. No HTTP API yet.
2. **M2** — Upgrade extraction and pricing (§6.2). Do this *before* showing anyone
   a profit number; a recipe-only figure is not a conservative estimate, it is
   wrong in one direction.
3. **M3** — The three endpoints in §1. Point the frontend at it
   (`VITE_USE_MOCKS=false`) and delete nothing from `mock.ts` — it stays useful for
   frontend work offline.
4. **M4** — Coflnet backfill, versioned fee schedule, AH lowest-BIN history for the
   auction-only upgrades (reforge stones, runes, dyes).
5. **M5** — Multi-user, ownership verification, sold-notification, production key.

Start at §4.1 today even if nothing else gets built this week. Price history is the
one input you cannot retroactively create.

---

## 12. Policy

Read-only use of a public API, which is squarely within Hypixel's API terms. Stay
inside the rate limit, cache aggressively, identify your application honestly when
applying for a production key, and do not resell raw API data. Note that Hypixel's
policy explicitly refuses increased limits for some use cases, so read the current
terms at `developer.hypixel.net/policies` before applying.
