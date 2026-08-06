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
 * The same is true one level down, for anything bought off the bazaar: an
 * INSTANT row is taken from the sell offers at the higher price, an ORDER row
 * joins the buy orders at the lower one and waits to fill. That is the other
 * real decision this build involves, so it gets the same treatment — per row,
 * re-priced on the spot, with a header control for the common case of picking
 * one strategy for everything.
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
 * What one unit of a bought row costs, under its bazaar choice.
 *
 * `orders` holds the paths priced as buy orders; everything else takes the
 * instant price, which is what the API costed and therefore what `unitPrice`
 * and `marketPrice` already carry. Rows with no `bazaar` block — auction
 * purchases, and anything from an API older than this build — have only the one
 * price and ignore the set entirely.
 */
function unitOf(node: CraftNode, path: string, orders: Set<string>): number | null {
  const fallback = node.children.length === 0 ? node.unitPrice : (node.marketPrice ?? null);
  if (!node.bazaar) return fallback;
  return orders.has(path) ? node.bazaar.order : node.bazaar.instant;
}

/**
 * Cost of a node under the current open/closed and instant/order choices.
 *
 * Closed (or recipe-less) means bought. Open means crafted, which is the sum of
 * the children under THEIR choices — so closing something three tiers down, or
 * moving it to a buy order, propagates all the way to the headline figure. Null
 * anywhere makes the whole branch null: a partial sum understates cost, which
 * is the direction every trap in this project points.
 */
function costOf(node: CraftNode, path: string, closed: Set<string>, orders: Set<string>): number | null {
  // No recipe: it can only ever be bought, and the unit price carries whichever
  // side of the bazaar this row is on.
  if (node.children.length === 0) {
    const unit = unitOf(node, path, orders);
    return unit === null ? null : Math.round(unit * node.quantity);
  }

  if (closed.has(path)) {
    const unit = unitOf(node, path, orders);
    return unit === null ? null : Math.round(unit * node.quantity);
  }

  let sum = 0;
  for (let i = 0; i < node.children.length; i++) {
    const c = costOf(node.children[i], `${path}.${i}`, closed, orders);
    if (c === null) return null;
    sum += c;
  }
  // Ingredient totals are for one batch of `outputCount`.
  return Math.round(sum / (node.outputCount ?? 1)) * node.quantity;
}

/** The same set with one path flipped — used to price the road not taken. */
function flipped(paths: Set<string>, path: string): Set<string> {
  const next = new Set(paths);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/**
 * Whether this row can be bought either way. An item with no buy orders to join
 * reports the same price twice (the API refuses to call an empty order book
 * free), and offering a switch that changes nothing is worse than not offering
 * one.
 */
const orderable = (node: CraftNode) => !!node.bazaar && node.bazaar.order !== node.bazaar.instant;

/** Stable identity for "nothing on order", so it is not a new Set per render. */
const EMPTY: Set<string> = new Set();

/** Every path in the tree with a real instant/order choice. */
function bazaarPathsIn(node: CraftNode, path: string, out: string[] = []): string[] {
  if (orderable(node)) out.push(path);
  node.children.forEach((c, i) => bazaarPathsIn(c, `${path}.${i}`, out));
  return out;
}

function CraftTree({ plan }: { plan: CraftPlan }) {
  const root = useMemo(() => rootNode(plan), [plan]);

  /**
   * Paths costed as a purchase rather than a craft. Empty means "craft
   * everything that has a recipe", which is the deepest the tree goes.
   */
  const [closed, setClosed] = useState<Set<string>>(new Set());

  /**
   * Paths bought with a buy order rather than instantly. Empty means the whole
   * build is priced at instant-buy, which is what the API costed and the
   * conservative default — an order is a price you might wait a day to get.
   */
  const [orders, setOrders] = useState<Set<string>>(new Set());

  const toggle = (path: string) => setClosed((prev) => flipped(prev, path));
  const toggleOrder = (path: string) => setOrders((prev) => flipped(prev, path));

  const bazaarPaths = useMemo(() => bazaarPathsIn(root, 'r'), [root]);
  const allInstant = orders.size === 0;
  const allOrder = bazaarPaths.length > 0 && bazaarPaths.every((p) => orders.has(p));

  /**
   * What switching the whole build to buy orders is worth, under the open/closed
   * choices currently made. Priced by costing it both ways rather than summing
   * spreads, so a tier that is bought outright — and whose bazaar ingredients
   * therefore are not being paid for at all — contributes nothing.
   */
  const instantTotal = costOf(root, 'r', closed, EMPTY);
  const orderTotal = costOf(root, 'r', closed, new Set(bazaarPaths));
  const spread = instantTotal !== null && orderTotal !== null ? instantTotal - orderTotal : null;

  return (
    <div className="card">
      {bazaarPaths.length > 0 && (
        <div className="craft-tools">
          <span className="card-note">Bazaar ingredients</span>
          <div className="seg seg-sm" role="group" aria-label="Bazaar price">
            <button aria-pressed={allInstant} onClick={() => setOrders(new Set())}>
              Instant buy
            </button>
            <button aria-pressed={allOrder} onClick={() => setOrders(new Set(bazaarPaths))}>
              Buy order
            </button>
          </div>
          {spread !== null && spread > 0 && (
            /* The title carries what the number means; buy orders only save
               anything if they actually fill, and that caveat should not be
               lost just because the label got shorter. */
            <span className="craft-save" title="What buy orders take off this build — if they fill.">
              -{exactCoins(spread)}
            </span>
          )}
        </div>
      )}
      <div className="craft-root">
        <Node node={root} path="r" closed={closed} orders={orders} onToggle={toggle} onOrder={toggleOrder} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- */

interface NodeProps {
  node: CraftNode;
  path: string;
  closed: Set<string>;
  orders: Set<string>;
  onToggle: (path: string) => void;
  onOrder: (path: string) => void;
}

function Node({ node, path, closed, orders, onToggle, onOrder }: NodeProps) {
  const craftable = node.children.length > 0;
  const buyable = (node.marketPrice ?? null) !== null;
  const isClosed = closed.has(path);
  const open = craftable && !isClosed;

  const cost = costOf(node, path, closed, orders);
  const unit = unitOf(node, path, orders);

  /**
   * What this row would cost the other way, priced by actually flipping it —
   * so a bought row's "craft" figure reflects the choices still set beneath it
   * rather than a fixed full-depth number. Highlighted when it is the cheaper
   * of the two, since that is the whole reason to move a tier.
   */
  const alt = craftable ? costOf(node, path, flipped(closed, path), orders) : null;
  const altLabel = open ? 'buy' : 'craft';
  const altIsCheaper = alt !== null && cost !== null && alt < cost;

  /**
   * The bazaar side this row is bought on. Only offered while the row is
   * actually being bought — an open tier is paying for its ingredients, each of
   * which carries its own choice.
   */
  const canOrder = !open && orderable(node);
  const isOrder = orders.has(path);
  const orderSaving = node.bazaar ? (node.bazaar.instant - node.bazaar.order) * node.quantity : 0;

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
          {!open &&
            (canOrder ? (
              /* The pill doubles as the switch: it already says where the price
                 came from, and on a bazaar row that is exactly the choice. */
              <button
                className={isOrder ? 'pill pill-btn is-on' : 'pill pill-btn'}
                style={{ marginLeft: 6 }}
                onClick={() => onOrder(path)}
                aria-pressed={isOrder}
                aria-label={
                  isOrder
                    ? `Buy ${node.name} instantly instead of with a buy order`
                    : `Buy ${node.name} with a buy order instead of instantly`
                }
                title={
                  isOrder
                    ? `Buy order at ${unitPrice(node.bazaar!.order)} — instant is ${unitPrice(node.bazaar!.instant)}`
                    : `Instant buy at ${unitPrice(node.bazaar!.instant)} — a buy order at ${unitPrice(
                        node.bazaar!.order,
                      )} saves ${exactCoins(orderSaving)}, once it fills`
                }
              >
                {isOrder ? 'buy order' : 'instant'}
              </button>
            ) : (
              <span className="pill" style={{ marginLeft: 6 }}>
                {craftable ? 'bought' : (VIA_LABEL[node.via ?? ''] ?? 'bought')}
              </span>
            ))}
          {!craftable && unit !== null && node.quantity > 1 && (
            <span className="muted"> @ {unitPrice(unit)}</span>
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
              orders={orders}
              onToggle={onToggle}
              onOrder={onOrder}
            />
          ))}
        </div>
      )}
    </div>
  );
}
