import { Fragment, useState } from 'react';
import {
  getBazaar,
  getItemMetadata,
  sweepAuctions,
  type ActiveListing,
  type ItemMetaRaw,
} from '../api/hypixel';
import { costOf, type CostBreakdown, type CostContext } from '../api/neu';
import { readCraftTimestamp, readExtraAttributes } from '../lib/nbt';
import {
  AUCTION_ONLY_UPGRADES,
  detectUpgrades,
  isCleanBase,
  priceUpgrades,
  type PricedUpgrade,
  type PriceResolver,
} from '../lib/upgrades';
import { TRACKED_PLAYERS, TRACKED_UUIDS, playerByUuid } from '../config/trackedPlayers';
import { coins, exactCoins, signedCoins, signedPct } from '../lib/format';

/** Base item plus the upgrades applied to it. Null when the base is unpriceable. */
function costBasis(l: { baseCost: number | null; upgradeCost: number }): number | null {
  return l.baseCost === null ? null : l.baseCost + l.upgradeCost;
}

/** Gross margin at the current ask, before AH fees. */
function margin(l: { baseCost: number | null; upgradeCost: number; ask: number }): number | null {
  const basis = costBasis(l);
  return basis === null ? null : l.ask - basis;
}
import { ErrorState } from '../components/Layout';
import { StatTile } from '../components/Stat';

interface Listing {
  auctionUuid: string;
  seller: string;
  itemName: string;
  itemId: string;
  tier: string;
  ask: number;
  bin: boolean;
  upgrades: PricedUpgrade[];
  upgradeCost: number;
  unpriced: number;
  craftedAt: Date | null;
  /** What the base item costs to obtain — craft cost preferred over buying. */
  baseCost: number | null;
  /** Full craft-vs-buy breakdown for the base item. */
  base: CostBreakdown | null;
  /** How many clean listings the market comparison came from. */
  baseSampleSize: number;
}

export function Tracked() {
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [scanned, setScanned] = useState(0);
  const [ahPrices, setAhPrices] = useState<Map<string, number>>(new Map());
  const [upgradeBreakdowns, setUpgradeBreakdowns] = useState<Map<string, CostBreakdown>>(new Map());
  const [phase, setPhase] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  async function scan() {
    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: 0 });
    try {
      const [bazaar, meta] = await Promise.all([getBazaar(), getItemMetadata()]);
      const metaById = new Map<string, ItemMetaRaw>(meta.items.map((i) => [i.id, i]));

      // Pass 1: find the tracked players' listings, and harvest prices for the
      // auction-only upgrade items in the same trip.
      setPhase('Pass 1 of 2 — finding listings');
      const {
        sellerHits: raw,
        nameHits: priceCandidates,
        scanned: total,
      } = await sweepAuctions(
        { sellers: TRACKED_UUIDS, names: AUCTION_ONLY_UPGRADES.map((u) => u.name) },
        (done, totalPages) => setProgress({ done, total: totalPages }),
      );
      setScanned(total);

      // Confirm each candidate's real item id by decoding it — an auction's
      // display name carries reforge prefixes and can be set by skins, so
      // name matching alone would mis-price.
      const lowestBin = new Map<string, number>();
      for (const c of priceCandidates) {
        try {
          const ea = await readExtraAttributes(c.item_bytes);
          const id = typeof ea?.id === 'string' ? ea.id : null;
          if (!id) continue;
          const price = c.starting_bid;
          const cur = lowestBin.get(id);
          if (cur === undefined || price < cur) lowestBin.set(id, price);
        } catch {
          /* skip */
        }
      }
      setAhPrices(new Map(lowestBin));

      const bazaarPrice = (id: string): number | null => {
        const q = bazaar.products[id]?.quick_status;
        if (!q) return null;
        if (q.buyPrice > 0) return q.buyPrice;
        if (q.sellPrice > 0) return q.sellPrice;
        return 0;
      };

      const ctx: CostContext = {
        bazaar: bazaarPrice,
        auction: (id) => lowestBin.get(id) ?? null,
      };

      // Upgrade items get craft-costed too. The Etherwarp Conduit is the case
      // that matters: 17.23M to craft against 18.60M to buy, and it is the
      // single largest line on an Aspect of the Void.
      const upgradeCosts = new Map<string, CostBreakdown>();
      const resolve: PriceResolver = (id) => {
        const bz = bazaarPrice(id);
        if (bz !== null) return { price: bz, source: 'bazaar' };
        const c = upgradeCosts.get(id);
        if (c?.price != null) {
          return { price: c.price, source: c.source === 'craft' ? 'craft' : 'auction' };
        }
        return null;
      };

      // Pass 2: price the base items. We only know which items to look up after
      // decoding pass 1's hits, so this needs its own trip through the book.
      // A real backend never does this — it queries its own ah_snapshots table.
      setPhase('Costing upgrade recipes');
      for (const u of AUCTION_ONLY_UPGRADES) {
        upgradeCosts.set(u.id, await costOf(u.id, ctx));
      }
      setUpgradeBreakdowns(new Map(upgradeCosts));

      // Decode the tracked listings up front so pass 2 can search by the item's
      // CANONICAL name from metadata. Searching by the auction's display name
      // would carry the reforge prefix ("Heroic Aspect of the Void") and match
      // nothing, or match the wrong thing when a skin has renamed the item.
      const trackedDecoded = [];
      for (const a of raw as ActiveListing[]) {
        const ea = await readExtraAttributes(a.item_bytes).catch(() => null);
        const id = typeof ea?.id === 'string' ? ea.id : null;
        trackedDecoded.push({ auction: a, ea, itemId: id ?? '?' });
      }

      setPhase('Pass 2 of 2 — pricing base items');
      setProgress({ done: 0, total: 0 });
      const baseNames = [
        ...new Set(
          trackedDecoded.map((t) => metaById.get(t.itemId)?.name ?? t.auction.item_name),
        ),
      ];

      const { nameHits: baseCandidates } = await sweepAuctions(
        { names: baseNames, excludeSellers: TRACKED_UUIDS },
        (done, totalPages) => setProgress({ done, total: totalPages }),
      );

      // Cheapest CLEAN listing per item id. Upgraded listings are excluded
      // outright — their price includes upgrades we would otherwise double-count.
      const cleanBase = new Map<string, { price: number; count: number }>();
      for (const c of baseCandidates) {
        try {
          const ea = await readExtraAttributes(c.item_bytes);
          if (!ea || !isCleanBase(ea)) continue;
          const id = typeof ea.id === 'string' ? ea.id : null;
          if (!id) continue;
          const cur = cleanBase.get(id);
          if (!cur) cleanBase.set(id, { price: c.starting_bid, count: 1 });
          else cleanBase.set(id, { price: Math.min(cur.price, c.starting_bid), count: cur.count + 1 });
        } catch {
          /* skip */
        }
      }

      // Base items: craft cost where a recipe exists, clean market price where
      // it does not (Divan armor has no NEU recipe, so it must be bought).
      setPhase('Costing base-item recipes');
      const baseCosts = new Map<string, CostBreakdown>();
      for (const id of new Set(trackedDecoded.map((t) => t.itemId))) {
        if (id === '?') continue;
        baseCosts.set(
          id,
          await costOf(id, { bazaar: bazaarPrice, auction: (x) => cleanBase.get(x)?.price ?? null }),
        );
      }

      const decoded: Listing[] = [];
      for (const { auction: a, ea, itemId } of trackedDecoded) {
        let upgrades: PricedUpgrade[] = [];
        let upgradeCost = 0;
        let unpriced = 0;
        let craftedAt: Date | null = null;

        if (ea) {
          craftedAt = readCraftTimestamp(ea);
          const result = priceUpgrades(detectUpgrades(ea, metaById.get(itemId)), resolve);
          upgrades = result.priced;
          upgradeCost = result.total;
          unpriced = result.unpriced;
        }

        decoded.push({
          auctionUuid: a.uuid,
          seller: a.auctioneer,
          itemName: a.item_name,
          itemId,
          tier: a.tier,
          ask: a.highest_bid_amount || a.starting_bid,
          bin: a.bin,
          upgrades,
          upgradeCost,
          unpriced,
          craftedAt,
          baseCost: baseCosts.get(itemId)?.price ?? cleanBase.get(itemId)?.price ?? null,
          base: baseCosts.get(itemId) ?? null,
          baseSampleSize: cleanBase.get(itemId)?.count ?? 0,
        });
      }

      decoded.sort((x, y) => y.ask - x.ask);
      setListings(decoded);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const byPlayer = TRACKED_PLAYERS.map((p) => {
    const mine = (listings ?? []).filter((l) => l.seller === p.uuid);
    return {
      player: p,
      count: mine.length,
      askTotal: mine.reduce((s, l) => s + l.ask, 0),
      upgradeTotal: mine.reduce((s, l) => s + l.upgradeCost, 0),
    };
  });

  return (
    <main className="container">
      <div className="page-head">
        <div>
          <h1>Tracked players</h1>
          <p className="sub">
            {TRACKED_PLAYERS.map((p) => p.name).join(' and ')} — live ingest straight from the public API,
            no key and no backend.
          </p>
        </div>
        <button className="btn" onClick={() => void scan()} disabled={busy}>
          {busy ? 'Scanning…' : listings ? 'Rescan' : 'Scan auction house'}
        </button>
      </div>

      {error && <ErrorState error={error} />}

      {progress && (
        <div className="card">
          <div className="tile-label">
            {phase || 'Reading the auction house'} — page {progress.done} of {progress.total || '…'}
          </div>
          <div
            style={{
              marginTop: 10,
              height: 8,
              borderRadius: 4,
              background: 'var(--gridline)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                borderRadius: 4,
                background: 'var(--series-1)',
                width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
                transition: 'width .2s',
              }}
            />
          </div>
          <p className="sub" style={{ marginBottom: 0, marginTop: 10 }}>
            There is no server-side seller filter, so finding a player's listings means reading every page
            of the auction house — about 50MB. This is why the real system ingests continuously instead.
          </p>
        </div>
      )}

      {!listings && !busy && (
        <div className="card">
          <p className="sub" style={{ margin: 0 }}>
            Press <strong>Scan auction house</strong> to page through all active auctions and pull every
            listing by these two players, decoding each item's NBT for the upgrades applied to it.
          </p>
        </div>
      )}

      {listings && (
        <div className="stack">
          <div className="grid grid-kpi">
            {byPlayer.map((b) => (
              <StatTile
                key={b.player.uuid}
                label={b.player.name}
                value={`${b.count} listing${b.count === 1 ? '' : 's'}`}
                note={b.count > 0 ? `${coins(b.askTotal)} asked · ${coins(b.upgradeTotal)} in upgrades` : 'nothing listed right now'}
              />
            ))}
            <StatTile label="Auctions scanned" value={scanned.toLocaleString('en-US')} note="entire active book" />
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <h2>Active listings</h2>
                <p className="sub">
                  Click a row for the upgrades decoded from that item's NBT, priced against the bazaar now.
                </p>
              </div>
            </div>

            {listings.length === 0 ? (
              <div className="state">Neither player has anything listed right now.</div>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Seller</th>
                      <th className="num">Crafted</th>
                      <th className="num">Type</th>
                      <th className="num">Ask</th>
                      <th className="num">Base item</th>
                      <th className="num">Upgrades</th>
                      <th className="num">Cost basis</th>
                      <th className="num">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listings.map((l) => (
                      <Fragment key={l.auctionUuid}>
                        <tr
                          onClick={() => setOpen(open === l.auctionUuid ? null : l.auctionUuid)}
                          style={{ cursor: 'pointer' }}
                        >
                          <td style={{ fontWeight: 550 }}>
                            {open === l.auctionUuid ? '▾ ' : '▸ '}
                            {l.itemName}
                          </td>
                          <td className="muted">{playerByUuid(l.seller)?.name ?? '—'}</td>
                          <td className="num muted" title={l.craftedAt?.toISOString() ?? 'no NBT timestamp'}>
                            {l.craftedAt
                              ? l.craftedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
                              : '—'}
                          </td>
                          <td className="num muted">{l.bin ? 'BIN' : 'Auction'}</td>
                          <td className="num">{coins(l.ask)}</td>
                          <td className="num" title={l.baseCost !== null ? `cheapest of ${l.baseSampleSize} clean listings` : 'no clean listing found'}>
                            {l.baseCost !== null ? coins(l.baseCost) : <span className="muted">—</span>}
                          </td>
                          <td className="num muted">
                            {l.upgradeCost > 0 ? coins(l.upgradeCost) : '—'}
                            {l.unpriced > 0 && ` +${l.unpriced}?`}
                          </td>
                          <td className="num" style={{ fontWeight: 600 }}>
                            {costBasis(l) !== null ? coins(costBasis(l)!) : <span className="muted">—</span>}
                          </td>
                          <td
                            className="num"
                            style={{
                              fontWeight: 600,
                              color:
                                margin(l) === null
                                  ? undefined
                                  : margin(l)! >= 0
                                    ? 'var(--good-text)'
                                    : 'var(--critical)',
                            }}
                          >
                            {margin(l) !== null ? signedCoins(margin(l)!) : <span className="muted">—</span>}
                          </td>
                        </tr>
                        {open === l.auctionUuid && (
                          <tr>
                            <td colSpan={7} style={{ background: 'var(--ghost)' }}>
                              <div style={{ padding: '4px 0 8px' }}>
                                <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                                  {l.itemId} · {l.tier}
                                </div>
                                <div className="breakdown-row">
                                  <span className="breakdown-name">
                                    <span className="pill" style={{ marginRight: 6 }}>
                                      base item
                                    </span>
                                    {l.base?.source === 'craft' ? 'Crafted from recipe' : 'Cheapest clean listing'}
                                    {l.base?.source !== 'craft' && l.baseSampleSize > 0 && (
                                      <span className="muted"> — of {l.baseSampleSize} clean</span>
                                    )}
                                  </span>
                                  <span className="breakdown-val">
                                    {l.baseCost !== null ? (
                                      <>
                                        {exactCoins(l.baseCost)}{' '}
                                        <span className="muted">
                                          {l.base?.source === 'craft' ? 'CRAFT' : 'AH'}
                                        </span>
                                      </>
                                    ) : (
                                      <span className="muted">unpriceable</span>
                                    )}
                                  </span>
                                </div>

                                {l.base?.source === 'craft' &&
                                  l.base.parts.map((p) => (
                                    <div
                                      className="breakdown-row"
                                      key={p.itemId}
                                      style={{ paddingLeft: 18, borderBottom: 0, paddingTop: 2, paddingBottom: 2 }}
                                    >
                                      <span className="breakdown-name muted" style={{ fontSize: 12.5 }}>
                                        {p.quantity}× {p.itemId}
                                      </span>
                                      <span className="breakdown-val muted" style={{ fontSize: 12.5 }}>
                                        {p.unitPrice !== null ? exactCoins(p.unitPrice * p.quantity) : '?'}
                                      </span>
                                    </div>
                                  ))}

                                {l.base?.craftCost != null && l.base.marketPrice != null && (
                                  <div className="breakdown-row">
                                    <span className="breakdown-name muted">
                                      Buying it instead would cost {exactCoins(l.base.marketPrice)}
                                    </span>
                                    <span className="breakdown-val muted">
                                      {signedCoins(l.base.craftCost - l.base.marketPrice)} vs crafting
                                    </span>
                                  </div>
                                )}
                                {l.upgrades.length === 0 ? (
                                  <div className="muted" style={{ padding: '6px 0' }}>
                                    No upgrades on this item — a straight resell.
                                  </div>
                                ) : (
                                  <>
                                    {l.upgrades.map((u, i) => (
                                      <div className="breakdown-row" key={`${u.label}-${i}`}>
                                        <span className="breakdown-name">
                                          <span className="pill" style={{ marginRight: 6 }}>
                                            {u.kind.replace('_', ' ')}
                                          </span>
                                          {u.quantity > 1 && (
                                            <span
                                              className="muted"
                                              style={{ fontVariantNumeric: 'tabular-nums' }}
                                            >
                                              {u.quantity}×{' '}
                                            </span>
                                          )}
                                          {u.label}
                                        </span>
                                        <span className="breakdown-val">
                                          {u.totalPrice !== null ? (
                                            <>
                                              {exactCoins(u.totalPrice)}
                                              {u.pricedFrom === 'auction' && (
                                                <span className="muted" title="Not on the bazaar — lowest BIN from the auction house">
                                                  {' '}
                                                  AH
                                                </span>
                                              )}
                                              {u.pricedFrom === 'craft' && (
                                                <span className="muted" title="Costed from its crafting recipe, which is cheaper than buying it">
                                                  {' '}
                                                  CRAFT
                                                </span>
                                              )}
                                            </>
                                          ) : (
                                            <span className="muted">no price</span>
                                          )}
                                        </span>
                                      </div>
                                    ))}
                                    <div className="total-row">
                                      <span>Priced upgrades</span>
                                      <span>{exactCoins(l.upgradeCost)}</span>
                                    </div>
                                  </>
                                )}
                                {costBasis(l) !== null && (
                                  <>
                                    <div className="total-row" style={{ borderTopWidth: 2 }}>
                                      <span>Cost basis (base + upgrades)</span>
                                      <span>{exactCoins(costBasis(l)!)}</span>
                                    </div>
                                    <div className="total-row" style={{ border: 0 }}>
                                      <span>Margin at this ask, before fees</span>
                                      <span
                                        style={{
                                          color: margin(l)! >= 0 ? 'var(--good-text)' : 'var(--critical)',
                                        }}
                                      >
                                        {signedCoins(margin(l)!)} ({signedPct((margin(l)! / costBasis(l)!) * 100)})
                                      </span>
                                    </div>
                                    {l.unpriced > 0 && (
                                      <p className="sub" style={{ marginBottom: 0 }}>
                                        ⚠ {l.unpriced} upgrade{l.unpriced === 1 ? '' : 's'} could not be
                                        priced, so the real cost basis is higher and this margin is
                                        optimistic.
                                      </p>
                                    )}
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {ahPrices.size > 0 && (
            <div className="card">
              <div className="card-head">
                <div>
                  <h2>Auction-only upgrade prices</h2>
                  <p className="sub">
                    Not sold on the bazaar. Craft cost is used where a recipe exists, with the auction
                    lowest BIN shown for comparison.
                  </p>
                </div>
              </div>
              {AUCTION_ONLY_UPGRADES.map((u) => {
                const c = upgradeBreakdowns.get(u.id);
                const bin = ahPrices.get(u.id) ?? c?.marketPrice ?? null;
                return (
                  <div className="breakdown-row" key={u.id}>
                    <span className="breakdown-name">
                      {u.name}{' '}
                      {c?.craftCost != null && bin != null && (
                        <span className="muted">
                          — crafting saves {exactCoins(bin - c.craftCost)}
                        </span>
                      )}
                    </span>
                    <span className="breakdown-val">
                      {c?.craftCost != null ? (
                        <>
                          {exactCoins(c.craftCost)} <span className="muted">CRAFT</span>
                        </>
                      ) : bin != null ? (
                        <>
                          {exactCoins(bin)} <span className="muted">AH</span>
                        </>
                      ) : (
                        <span className="muted">none listed</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <div className="card">
            <h2>What this cannot show yet</h2>
            <p className="sub">
              These are <strong>active listings</strong>, not sales. Profit needs the sold price, and sold
              auctions are only visible in a 60-second rolling window that nothing has been recording. Until
              the ingest in BACKEND.md §4.2 has been running, there is no sales history for these players —
              not because the code is missing, but because the data does not exist anywhere to fetch.
            </p>
          </div>
        </div>
      )}
    </main>
  );
}
