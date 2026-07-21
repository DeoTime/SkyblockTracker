import { Link, useParams } from 'react-router-dom';
import { fetchFlip } from '../api/client';
import { useAsync } from '../lib/useAsync';
import { ErrorState, Loading } from '../components/Layout';
import { HeroFigure } from '../components/Stat';
import {
  duration,
  exactCoins,
  fullDate,
  pct,
  priceSourceLabel,
  signedCoins,
  signedPct,
  titleCase,
} from '../lib/format';

export function FlipDetail() {
  const { auctionUuid = '' } = useParams();
  const { data: flip, error, loading } = useAsync(() => fetchFlip(auctionUuid), [auctionUuid]);

  if (loading) return <main className="container"><Loading /></main>;
  if (error) return <main className="container"><ErrorState error={error} /></main>;
  if (!flip) return null;

  const maxIngredient = Math.max(...flip.ingredients.map((i) => i.totalPrice), 1);
  const currentSpread =
    flip.currentMarketPrice !== null && flip.currentCraftCost !== null
      ? flip.currentMarketPrice - flip.currentCraftCost
      : null;

  return (
    <main className="container">
      <div className="page-head">
        <div>
          <h1>{flip.itemName}</h1>
          <p className="sub">
            <span className="pill">{titleCase(flip.rarity)}</span>{' '}
            <span className="pill">{flip.bin ? 'BIN' : 'Auction'}</span>{' '}
            <Link className="link" to={`/item/${flip.itemId}`}>
              price history →
            </Link>
          </p>
        </div>
      </div>

      <div className="stack">
        <div className="card">
          <HeroFigure
            label="Net profit on this flip"
            value={signedCoins(flip.netProfit)}
            note={`${signedPct(flip.profitPct)} margin · held ${duration(flip.craftedAt, flip.soldAt)}`}
          />
          {flip.priceSource !== 'own_snapshot' && (
            <p className="sub" style={{ marginTop: 12 }}>
              ⚠ Pricing confidence: <strong>{priceSourceLabel(flip.priceSource)}</strong>.{' '}
              {flip.priceSource === 'live_fallback'
                ? 'No archived price covered this craft date, so current market rates stood in — treat this as an approximation.'
                : 'Ingredient prices were backfilled from a third-party history rather than our own snapshots.'}
            </p>
          )}
          {flip.ageEstimated && (
            <p className="sub" style={{ marginTop: 6 }}>
              ⚠ No craft timestamp in this item's NBT — the auction start time was used instead.
            </p>
          )}
        </div>

        <div className="grid grid-2">
          <div className="card">
            <div className="card-head">
              <div>
                <h2>Craft cost at {fullDate(flip.craftedAt)}</h2>
                <p className="sub">What each ingredient cost the day this item was made.</p>
              </div>
            </div>

            <div>
              {flip.ingredients.map((ing) => (
                <div className="breakdown-row" key={ing.itemId}>
                  <span className="breakdown-name" title={ing.name}>
                    <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {ing.quantity}×
                    </span>{' '}
                    {ing.name}
                    {ing.source !== 'own_snapshot' && (
                      <span className="pill" style={{ marginLeft: 6 }} title={priceSourceLabel(ing.source)}>
                        ~
                      </span>
                    )}
                  </span>
                  {/* Magnitude comparison → sequential, one hue. */}
                  <span
                    aria-hidden="true"
                    style={{
                      width: 64,
                      height: 8,
                      borderRadius: 4,
                      flex: 'none',
                      background: 'var(--gridline)',
                      overflow: 'hidden',
                      display: 'inline-block',
                    }}
                  >
                    <span
                      style={{
                        display: 'block',
                        height: '100%',
                        borderRadius: 4,
                        width: `${(ing.totalPrice / maxIngredient) * 100}%`,
                        background: 'var(--series-1)',
                      }}
                    />
                  </span>
                  <span className="breakdown-val">{exactCoins(ing.totalPrice)}</span>
                </div>
              ))}
              <div className="total-row">
                <span>{flip.acquisition === 'crafted' ? 'Recipe subtotal' : 'Base item'}</span>
                <span>{exactCoins(flip.baseItemCost)}</span>
              </div>
            </div>

            {flip.upgrades.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <h2 style={{ marginBottom: 4 }}>Upgrades applied</h2>
                <p className="sub" style={{ marginTop: 0 }}>
                  Bought and applied after crafting. Cost basis, not profit.
                </p>
                {flip.upgrades.map((u, i) => (
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
                    </span>
                    <span className="breakdown-val">
                      {u.totalPrice !== null ? (
                        exactCoins(u.totalPrice)
                      ) : (
                        <span className="muted">no price found</span>
                      )}
                    </span>
                  </div>
                ))}
                <div className="total-row">
                  <span>Upgrade subtotal</span>
                  <span>{exactCoins(flip.upgradeCost)}</span>
                </div>
              </div>
            )}

            <div className="total-row" style={{ borderTopWidth: 2 }}>
              <span>Total cost basis</span>
              <span>{exactCoins(flip.costBasis)}</span>
            </div>

            {flip.unpricedUpgrades > 0 && (
              <p className="sub" style={{ marginTop: 10 }}>
                ⚠ {flip.unpricedUpgrades} upgrade{flip.unpricedUpgrades === 1 ? '' : 's'} could not be
                priced, so the real cost basis is higher than shown and this flip's profit is an
                over-estimate.
              </p>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <h2>Sale and fees</h2>
                <p className="sub">What the Auction House actually paid out.</p>
              </div>
            </div>

            <div>
              <div className="breakdown-row">
                <span className="breakdown-name">Sale price</span>
                <span className="breakdown-val">{exactCoins(flip.salePrice)}</span>
              </div>
              {flip.fees.map((fee) => (
                <div className="breakdown-row" key={fee.label}>
                  <span className="breakdown-name">{fee.label}</span>
                  <span className="breakdown-val">−{exactCoins(fee.amount)}</span>
                </div>
              ))}
              <div className="breakdown-row">
                <span className="breakdown-name">
                  {flip.acquisition === 'crafted' ? 'Recipe ingredients' : 'Base item purchase'}
                </span>
                <span className="breakdown-val">−{exactCoins(flip.baseItemCost)}</span>
              </div>
              {flip.upgradeCost > 0 && (
                <div className="breakdown-row">
                  <span className="breakdown-name">Upgrades applied</span>
                  <span className="breakdown-val">−{exactCoins(flip.upgradeCost)}</span>
                </div>
              )}
              <div className="total-row">
                <span>Net profit</span>
                <span style={{ color: flip.netProfit >= 0 ? 'var(--good-text)' : 'var(--critical)' }}>
                  {signedCoins(flip.netProfit)}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-2">
          <div className="card">
            <div className="card-head">
              <h2>Timeline</h2>
            </div>
            <div>
              <div className="breakdown-row">
                <span className="breakdown-name">Crafted</span>
                <span className="breakdown-val">{fullDate(flip.craftedAt)}</span>
              </div>
              <div className="breakdown-row">
                <span className="breakdown-name">Listed</span>
                <span className="breakdown-val">{fullDate(flip.listedAt)}</span>
              </div>
              <div className="breakdown-row">
                <span className="breakdown-name">Sold</span>
                <span className="breakdown-val">{fullDate(flip.soldAt)}</span>
              </div>
              <div className="total-row">
                <span>Total hold</span>
                <span>{duration(flip.craftedAt, flip.soldAt)}</span>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <h2>Would it still work today?</h2>
                <p className="sub">Current craft cost against the current market price.</p>
              </div>
            </div>
            <div>
              <div className="breakdown-row">
                <span className="breakdown-name">Craft cost now</span>
                <span className="breakdown-val">
                  {flip.currentCraftCost !== null ? exactCoins(flip.currentCraftCost) : '—'}
                </span>
              </div>
              <div className="breakdown-row">
                <span className="breakdown-name">Market price now</span>
                <span className="breakdown-val">
                  {flip.currentMarketPrice !== null ? exactCoins(flip.currentMarketPrice) : '—'}
                </span>
              </div>
              <div className="total-row">
                <span>Spread before fees</span>
                <span style={{ color: (currentSpread ?? 0) >= 0 ? 'var(--good-text)' : 'var(--critical)' }}>
                  {currentSpread !== null ? signedCoins(currentSpread) : '—'}
                </span>
              </div>
              {currentSpread !== null && flip.currentCraftCost ? (
                <p className="sub" style={{ marginTop: 10 }}>
                  That is {pct((currentSpread / flip.currentCraftCost) * 100)} against craft cost, versus{' '}
                  {pct(flip.profitPct)} when you actually ran it.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
