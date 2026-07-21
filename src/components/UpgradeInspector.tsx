import { Fragment, useCallback, useEffect, useState } from 'react';
import { getActiveAuctions, getBazaar, getItemMetadata, type ItemMetaRaw } from '../api/hypixel';
import { readExtraAttributes } from '../lib/nbt';
import { detectUpgrades, priceUpgrades, type PricedUpgrade, type PriceResolver } from '../lib/upgrades';
import { coins, exactCoins, pct } from '../lib/format';
import { ErrorState, Loading } from './Layout';
import { StatTile } from './Stat';

interface Row {
  auctionUuid: string;
  itemName: string;
  itemId: string;
  price: number;
  upgrades: PricedUpgrade[];
  upgradeCost: number;
  unpriced: number;
}

const SAMPLE_SIZE = 120;

/**
 * Decodes a sample of live auctions, extracts the upgrades applied to each item,
 * and prices them against the current bazaar. This is the argument for why the
 * tracker cannot treat a sold item as its base recipe.
 */
export function UpgradeInspector() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [scanned, setScanned] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [auctionData, bazaar, meta] = await Promise.all([
        getActiveAuctions(0),
        getBazaar(),
        getItemMetadata(),
      ]);

      const metaById = new Map<string, ItemMetaRaw>(meta.items.map((i) => [i.id, i]));

      /**
       * A product missing from the bazaar is genuinely unpriceable here (runes,
       * reforge stones, cosmetics — all auction-only). A product that IS listed
       * but shows a zero instant-buy is a different thing: low-level enchants
       * really are worth fractions of a coin. Collapsing those two cases makes
       * cheap enchants look like missing data, so they are kept apart.
       */
      const buyPrice: PriceResolver = (id) => {
        const q = bazaar.products[id]?.quick_status;
        if (!q) return null; // auction-only — /tracked prices these, this view does not
        if (q.buyPrice > 0) return { price: q.buyPrice, source: 'bazaar' };
        if (q.sellPrice > 0) return { price: q.sellPrice, source: 'bazaar' };
        return { price: 0, source: 'bazaar' };
      };

      const sample = auctionData.auctions.slice(0, SAMPLE_SIZE);
      const found: Row[] = [];

      for (const auction of sample) {
        if (!auction.item_bytes) continue;
        try {
          const ea = await readExtraAttributes(auction.item_bytes);
          if (!ea) continue;
          const itemId = typeof ea.id === 'string' ? ea.id : '?';
          const detected = detectUpgrades(ea, metaById.get(itemId));
          if (detected.length === 0) continue;

          const { priced, total, unpriced } = priceUpgrades(detected, buyPrice);
          found.push({
            auctionUuid: auction.uuid,
            itemName: auction.item_name,
            itemId,
            price: auction.highest_bid_amount || auction.starting_bid,
            upgrades: priced,
            upgradeCost: total,
            unpriced,
          });
        } catch {
          /* skip undecodable blobs */
        }
      }

      found.sort((a, b) => b.upgradeCost - a.upgradeCost);
      setScanned(sample.length);
      setRows(found);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const withUpgrades = rows?.length ?? 0;
  const totalUpgradeValue = (rows ?? []).reduce((s, r) => s + r.upgradeCost, 0);
  const unpricedCount = (rows ?? []).reduce((s, r) => s + r.unpriced, 0);
  const totalUpgrades = (rows ?? []).reduce((s, r) => s + r.upgrades.length, 0);

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Upgrades on live auctions</h2>
          <p className="sub">
            Decodes each auction's <code>item_bytes</code> NBT, extracts the upgrades applied to the item,
            and prices them against the bazaar right now. No key needed.
          </p>
        </div>
        <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
          {loading ? 'Scanning…' : 'Rescan'}
        </button>
      </div>

      {error && <ErrorState error={error} />}
      {loading && !rows && <Loading label={`Decoding ${SAMPLE_SIZE} live auctions…`} />}

      {rows && (
        <>
          <div className="grid grid-kpi" style={{ marginBottom: 16 }}>
            <StatTile
              label="Carrying upgrades"
              value={`${withUpgrades} / ${scanned}`}
              note={`${pct((withUpgrades / Math.max(scanned, 1)) * 100, 0)} of the sample`}
            />
            <StatTile label="Upgrades found" value={String(totalUpgrades)} />
            <StatTile
              label="Priced upgrade value"
              value={coins(totalUpgradeValue)}
              note="cost basis invisible to a recipe-only model"
            />
            <StatTile
              label="Could not price"
              value={String(unpricedCount)}
              note="reforges, runes, cosmetics — auction-only"
            />
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Asking price</th>
                  <th className="num">Upgrades</th>
                  <th className="num">Upgrade cost</th>
                  <th className="num">Share of ask</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 15).map((r) => (
                  <Fragment key={r.auctionUuid}>
                    <tr
                      onClick={() => setOpen(open === r.auctionUuid ? null : r.auctionUuid)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td style={{ fontWeight: 550 }}>
                        {open === r.auctionUuid ? '▾ ' : '▸ '}
                        {r.itemName}
                      </td>
                      <td className="num">{coins(r.price)}</td>
                      <td className="num muted">
                        {r.upgrades.length}
                        {r.unpriced > 0 && <span className="muted"> ({r.unpriced} unpriced)</span>}
                      </td>
                      <td className="num" style={{ fontWeight: 600 }}>
                        {coins(r.upgradeCost)}
                      </td>
                      <td className="num muted">
                        {r.price > 0 ? pct((r.upgradeCost / r.price) * 100, 0) : '—'}
                      </td>
                    </tr>
                    {open === r.auctionUuid && (
                      <tr>
                        <td colSpan={5} style={{ background: 'var(--ghost)' }}>
                          <div style={{ padding: '4px 0 8px' }}>
                            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                              {r.itemId}
                            </div>
                            {r.upgrades.map((u, i) => (
                              <div className="breakdown-row" key={`${u.label}-${i}`}>
                                <span className="breakdown-name">
                                  <span className="pill" style={{ marginRight: 6 }}>
                                    {u.kind.replace('_', ' ')}
                                  </span>
                                  {u.quantity > 1 && (
                                    <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
                                      {u.quantity}×{' '}
                                    </span>
                                  )}
                                  {u.label}
                                  {u.note && <span className="muted"> — {u.note}</span>}
                                </span>
                                <span className="breakdown-val">
                                  {u.totalPrice !== null ? exactCoins(u.totalPrice) : 'not priceable'}
                                </span>
                              </div>
                            ))}
                            <div className="total-row">
                              <span>Priced upgrade cost</span>
                              <span>{exactCoins(r.upgradeCost)}</span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <p className="sub" style={{ marginTop: 14 }}>
            Click a row for the per-upgrade breakdown. Every coin in the upgrade-cost column is cost basis a
            recipe-only tracker would miss, and would therefore book as profit. The unpriced column matters
            just as much: reforge stones, runes and cosmetics are auction-only, so the backend needs
            lowest-BIN history for them, not just the bazaar.
          </p>
          <p className="sub">
            Asking price is the current bid where one exists, otherwise the opening bid — so a share above
            100% usually means an unbid auction that opened cheap, not an item sold at a loss.
          </p>
        </>
      )}
    </div>
  );
}
