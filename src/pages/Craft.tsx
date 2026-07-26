import { useMemo, useState } from 'react';
import { fetchCraftPlan } from '../api/client';
import type { CraftComponent, CraftNode, CraftPlan, CraftVariant } from '../api/types';
import { useAsync } from '../lib/useAsync';
import { ErrorState, Loading } from '../components/Layout';
import { duration, exactCoins, unitPrice } from '../lib/format';

/**
 * "What does it cost to make one, right now?"
 *
 * One tree, and nothing else. Depth here is not a view control — it is the
 * costing decision. An OPEN tier is crafted, and costs the sum of its
 * ingredients; a CLOSED tier is bought outright at its market price. Closing
 * Aspect of the End stops costing 32 Enchanted Eyes of Ender and starts costing
 * one Aspect of the End off the auction house, and every total above it changes
 * on the spot.
 *
 * That makes the tree a calculator for the question that actually matters —
 * which layers are worth crafting and which are cheaper to just buy — rather
 * than a static breakdown. Each item decides independently.
 *
 * Prices are live: the bazaar as of a minute ago, and a full sweep of the
 * auction book for what the bazaar does not carry.
 */

const ITEM_ID = 'ASPECT_OF_THE_VOID';

const VARIANTS: { key: CraftVariant; label: string }[] = [
  { key: 'etherwarp', label: 'Etherwarp' },
  { key: 'clean', label: 'Clean' },
];

/** Where a bought row's price came from. */
const VIA_LABEL: Record<string, string> = {
  bazaar: 'bazaar',
  auction: 'BIN',
};

export function Craft() {
  const [variant, setVariant] = useState<CraftVariant>('etherwarp');
  const { data: plan, error, loading } = useAsync(() => fetchCraftPlan(ITEM_ID, variant), [variant]);

  return (
    <main className="container">
      <div className="page-head">
        <div>
          <h1>Craft cost</h1>
        </div>
        <div className="seg seg-sm" role="group" aria-label="Variant">
          {VARIANTS.map((v) => (
            <button key={v.key} aria-pressed={v.key === variant} onClick={() => setVariant(v.key)}>
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <Loading label="Loading…" />}
      {error && <ErrorState error={error} />}
      {/* Keyed on the variant so the open/closed choices reset deliberately
          when the build changes. */}
      {plan && !loading && (
        <div className="stack">
          <CraftTree key={plan.variant} plan={plan} />
          {/* The frontend and the API deploy separately, so an API older than
              this build omits nextCheapest entirely. Tolerate that by dropping
              the box rather than throwing on undefined.length. */}
          {plan.components
            .filter((c) => c.craftCost === null && (c.nextCheapest?.length ?? 0) > 0)
            .map((c) => (
              <ListingsBox key={c.key} component={c} />
            ))}
        </div>
      )}
    </main>
  );
}

/**
 * The order book behind a component that can only be bought.
 *
 * The tree costs the floor, which is one listing and may be gone in a minute.
 * What you would actually pay next is the useful number — and a floor sitting
 * far below the ten behind it is a listing about to be sniped rather than a
 * price to plan around.
 *
 * Shown only for components with no recipe (the Etherwarp Merger), because
 * those are the ones where the AH is the only option.
 */
function ListingsBox({ component: c }: { component: CraftComponent }) {
  const now = new Date().toISOString();

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>
            Next {c.nextCheapest.length} cheapest {c.name}
            {c.nextCheapest.length === 1 ? '' : 's'}
          </h2>
          <p className="card-note">
            {c.marketPrice === null ? (
              'Nothing listed.'
            ) : (
              <>
                Costed at {exactCoins(c.marketPrice)}; {c.marketListings} listed in total.
              </>
            )}
          </p>
        </div>
      </div>

      {c.nextCheapest.map((l, i) => (
        <div className="breakdown-row" key={l.auctionId}>
          <span className="breakdown-name">
            <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {i + 2}.
            </span>{' '}
            {exactCoins(l.price)}
            {c.marketPrice !== null && (
              <span className="muted"> · +{exactCoins(l.price - c.marketPrice)}</span>
            )}
          </span>
          <span className="breakdown-val">
            {l.endsAt ? `ends in ${duration(now, l.endsAt)}` : <span className="muted">—</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------- */

/**
 * The finished item as a single node.
 *
 * The API returns the build as a flat list of components — for Etherwarp that
 * is the sword, the Conduit and the Merger — because only some have recipes.
 * Hanging them off one root makes the whole build one tree, and gives the root
 * the same choice as every other tier: craft the parts, or buy the finished
 * item at the cheapest equivalent listing.
 */
function rootNode(plan: CraftPlan): CraftNode {
  return {
    itemId: plan.itemId,
    // "Aspect of the Void + Etherwarp" names a build; "+ Clean" names nothing.
    name: plan.variant === 'clean' ? plan.itemName : `${plan.itemName} + ${plan.variantLabel}`,
    quantity: 1,
    unitPrice: plan.total,
    totalPrice: plan.total,
    via: 'craft',
    craftCost: plan.total,
    marketPrice: plan.market.lowestBin,
    outputCount: 1,
    children: plan.components.map((c) => c.tree),
  };
}

/**
 * Cost of a node under the current open/closed choices.
 *
 * Closed (or recipe-less) means bought. Open means crafted, which is the sum of
 * the children under THEIR choices — so closing something three tiers down
 * propagates all the way to the headline figure. Null anywhere makes the whole
 * branch null: a partial sum understates cost, which is the direction every
 * trap in this project points.
 */
function costOf(node: CraftNode, path: string, closed: Set<string>): number | null {
  // No recipe: it can only ever be bought, and totalPrice already carries the
  // quantity the parent needs.
  if (node.children.length === 0) return node.totalPrice;

  if (closed.has(path)) {
    const unit = node.marketPrice ?? null;
    return unit === null ? null : unit * node.quantity;
  }

  let sum = 0;
  for (let i = 0; i < node.children.length; i++) {
    const c = costOf(node.children[i], `${path}.${i}`, closed);
    if (c === null) return null;
    sum += c;
  }
  // Ingredient totals are for one batch of `outputCount`.
  return Math.round(sum / (node.outputCount ?? 1)) * node.quantity;
}

/** The same set with one path flipped — used to price the road not taken. */
function flipped(closed: Set<string>, path: string): Set<string> {
  const next = new Set(closed);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

function CraftTree({ plan }: { plan: CraftPlan }) {
  const root = useMemo(() => rootNode(plan), [plan]);

  /**
   * Paths costed as a purchase rather than a craft. Empty means "craft
   * everything that has a recipe", which is the deepest the tree goes.
   */
  const [closed, setClosed] = useState<Set<string>>(new Set());

  const toggle = (path: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="card">
      <div className="craft-root">
        <Node node={root} path="r" closed={closed} onToggle={toggle} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- */

interface NodeProps {
  node: CraftNode;
  path: string;
  closed: Set<string>;
  onToggle: (path: string) => void;
}

function Node({ node, path, closed, onToggle }: NodeProps) {
  const craftable = node.children.length > 0;
  const buyable = (node.marketPrice ?? null) !== null;
  const isClosed = closed.has(path);
  const open = craftable && !isClosed;

  const cost = costOf(node, path, closed);

  /**
   * What this row would cost the other way, priced by actually flipping it —
   * so a bought row's "craft" figure reflects the choices still set beneath it
   * rather than a fixed full-depth number. Highlighted when it is the cheaper
   * of the two, since that is the whole reason to move a tier.
   */
  const alt = craftable ? costOf(node, path, flipped(closed, path)) : null;
  const altLabel = open ? 'buy' : 'craft';
  const altIsCheaper = alt !== null && cost !== null && alt < cost;

  // A tier can only close if the item can actually be bought, and can only open
  // if it has a recipe. Anything with neither is a plain leaf.
  const canToggle = craftable && (isClosed || buyable);

  return (
    <div>
      <div className="craft-row">
        {canToggle ? (
          <button
            className="craft-toggle"
            onClick={() => onToggle(path)}
            aria-expanded={open}
            aria-label={
              open ? `Buy ${node.name} instead of crafting it` : `Craft ${node.name} instead of buying it`
            }
            title={open ? 'Buy this instead — costs its market price' : 'Craft this instead — costs its ingredients'}
          >
            {open ? '▼' : '▶'}
          </button>
        ) : (
          <span
            className="craft-toggle"
            aria-hidden="true"
            title={craftable && !buyable ? 'Nothing listed, so this cannot be bought' : undefined}
          />
        )}

        <span className="craft-name" title={node.name}>
          {node.quantity > 1 && (
            <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {node.quantity}×{' '}
            </span>
          )}
          {node.name}
          {!open && (
            <span className="pill" style={{ marginLeft: 6 }}>
              {craftable ? 'bought' : (VIA_LABEL[node.via ?? ''] ?? 'bought')}
            </span>
          )}
          {!craftable && node.unitPrice !== null && node.quantity > 1 && (
            <span className="muted"> @ {unitPrice(node.unitPrice)}</span>
          )}
        </span>

        <span className="craft-lead" aria-hidden="true" />

        {alt !== null && (
          <span
            className={altIsCheaper ? 'craft-alt is-cheaper' : 'craft-alt'}
            title={
              altIsCheaper
                ? `Cheaper to ${altLabel} — ${exactCoins(cost! - alt)} less`
                : `Cost to ${altLabel} instead`
            }
          >
            {altLabel} {exactCoins(alt)}
          </span>
        )}
        <span className="craft-val">
          {cost === null ? <span className="muted">—</span> : exactCoins(cost)}
        </span>
      </div>

      {open && (
        <div className="craft-children">
          {node.children.map((child, i) => (
            <Node
              key={`${child.itemId}-${i}`}
              node={child}
              path={`${path}.${i}`}
              closed={closed}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}
