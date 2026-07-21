# skyblock-ingest

Continuous capture of Hypixel SkyBlock sales and bazaar prices. Runs forever,
needs no API key, and is the one component whose data **cannot be recreated
later** — see "Why this must run first".

## Deploy (Chicago) — currently live

The host sits behind Cloudflare Access, so authenticate first. This opens a
browser and cannot be scripted:

```bash
cloudflared access login https://ssh-chicago.nerfchess.com
```

Then, from this directory:

```bash
./deploy.sh            # packages, uploads, builds, restarts, verifies
```

**That host has Docker 26.1.3 with no compose plugin**, and it already runs
nerfchess, so `deploy.sh` uses plain `docker` rather than installing packages on
it. The flags reproduce `docker-compose.yml` exactly — if you ever add the
compose plugin, `docker compose up -d --build` gives the identical container.

The host is **aarch64**, so `node_modules` is never uploaded; `better-sqlite3`
compiles inside the build stage (~3 minutes).

`deploy.sh` removes and recreates the container, but the `skyblock-data` volume
is untouched, so redeploying never loses captured history.

### Operating

```bash
ssh nerfchess 'docker logs -f skyblock-ingest'
ssh nerfchess 'docker exec skyblock-ingest npm run --silent stats'
```

## Isolation from the existing stack

This host already runs nerfchess. The compose file keeps the two apart:

| Concern | Measure |
|---|---|
| Stack collisions | own project name `skyblock-tracker` |
| Network | own bridge `skyblock-net`, not the default |
| Storage | named volume `skyblock-data`, no bind mounts into shared paths |
| Ports | **none published** — the ingest is outbound-only |
| Blast radius | `mem_limit 512m`, `cpus 0.5`, `pids_limit 128` |
| Privilege | runs as `node`, `no-new-privileges` |
| Disk creep | json-file logs capped at 5×10 MB |

`docker compose down` in this directory cannot affect another stack.

## Why this must run first

Sold auctions are visible only in `/v2/skyblock/auctions_ended`, a 60-second
window. Measured behaviour: consecutive snapshots **do not overlap** — two polls
25s apart return a byte-identical set, then the next rotation is ~140 wholly new
records. Poll at 60s and any drift silently drops an entire slice, permanently.

So the poller runs at **20s** and dedupes on `auction_id`. `npm run stats`
reports the largest gap between polls and flags anything over 60s as lost data.

There is no backfill. An hour not running is an hour missing from every future
report, for every tracked player.

## Storage: what is kept, and what is not

Keeping every sale's NBT costs ~262 MB/day (~93 GB/yr) for data that is almost
entirely about players nobody is tracking. But discarding non-tracked sales
outright breaks the product: pricing *our* players' cost basis depends on what
an Etherwarp Conduit or a clean Aspect of the Void was selling for at the time,
and those are other people's sales.

Two shapes solve it:

| Table | Scope | Contents |
|---|---|---|
| `tracked_sales` | our players only | full row **including raw NBT** |
| `price_rollup` | everyone | per (item, hour, clean?) min/max/avg/count, **no NBT** |
| `bazaar_snapshot` | all products | written on >0.5% move or a 5-minute heartbeat |

Expect roughly **5 MB/day (~2 GB/yr)** in steady state — about 50× smaller than
retaining raw sales, while keeping full historical pricing power.

`is_clean` on the rollup is load-bearing: it separates base-item prices from
upgraded ones. Mixing them is how a tracker ends up pricing someone else's
enchantments into your base cost.

## Operating

```bash
docker compose exec ingest npm run stats   # size, coverage, gap check
docker compose logs -f --tail 100
docker compose restart
```

Tracked sales are rare and get logged loudly when they land:

```
[...] ended: 133 returned, 133 new, 1 TRACKED
[...]   >> ASPECT_OF_THE_VOID sold for 26,098,000 by 826bf808
```

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `TRACKED_UUIDS` | s_floW, cloudyv2 | undashed, comma-separated |
| `ENDED_INTERVAL_MS` | `20000` | keep well under the 60s rotation |
| `BAZAAR_INTERVAL_MS` | `60000` | |
| `DB_PATH` | `/data/skyblock.db` | inside the named volume |

## Backup

One SQLite file. `docker compose exec ingest sh -c 'sqlite3 /data/skyblock.db ".backup /data/backup.db"'`,
or just snapshot the `skyblock-data` volume. Given the data is unrecreatable,
back it up somewhere off this host.
