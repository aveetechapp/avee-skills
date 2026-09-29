# Feeds, IDs and statuses

## Finding a feed

- `GET /v2/price_feeds?query=<substring>&asset_type=<category>` lists each feed **once**, under its
  Pyth id when it has one, otherwise its Astra id. The Astra id is always in
  `attributes.astra_id`; the symbol in `attributes.symbol` (`Crypto.BTC/USD`).
- `GET /v2/price_feeds/{id}` is one feed.
- `GET /v1/feed-ids` maps ids: every served feed once, sorted by symbol, as `symbol`, `asset_type`,
  `category`, `astra_id` and `pyth_id` (omitted when there is none). Filter with `pyth_ids` or
  `astra_ids` (comma-separated or repeated, `0x` optional, any case; send at most 200 together, a
  longer URL is rejected before it reaches Astra) to get
  the matches plus `missing`, the requested ids Astra does not serve. `category` narrows the items.
  The answer changes only on a deploy: `Cache-Control: max-age=3600`, and the full list has an
  `ETag`.
- `GET /v1/feeds?category=<category>` returns `id` (Astra), `pyth_id` (when there is one), `symbol`,
  `category` and the live value with its status. Use it when you need both ids side by side.
- Categories are lower-case asset types: `crypto`, `equity`, `fx`, `metal`, `commodities`, … The set
  is open; `GET /v1/feeds` shows what is served today.

## Computing an Astra id

```ts
import { keccak256, toUtf8Bytes } from "ethers";
keccak256(toUtf8Bytes("astra:Crypto.BTC/USD"));
// 0x1de769477ecf66f69ca287676658956a211c207a9ca608ad5235bd095b02f4b2
```

Ids are accepted with or without `0x`, in any case, and returned lower-case without `0x`. A response
echoes the id you asked with, so code that matches updates by Pyth id keeps working.

## Tokenized stocks

| Symbol | Price | Id |
|---|---|---|
| `Equity.US.<TICKER>/USD` | share price = token price ÷ the token's share multiplier | Pyth and Astra |
| `Equity.RH.<TICKER>/USD` | the Robinhood token price itself | Astra only |

Equity feeds follow market hours. By Pyth id that is Pyth's session, 09:30–16:00 New York with Pyth's
holidays and early closes, served in `attributes.schedule`; by Astra id it is 24/5, Sunday 20:00 to
Friday 20:00 New York. Outside its hours a view is frozen with `is_open: false`.
`market_hours.next_open` and `next_close` are always `null`; only `is_open` is set.

## Statuses

| Status | Hermes routes by Pyth id | Hermes routes by Astra id | Native routes (`/v1/…`) |
|---|---|---|---|
| `trading` | served within Pyth's session | served | live |
| `degraded` | frozen at the last trading value and its `publish_time` | frozen | live, marked `degraded` |
| `market_closed` | frozen, `is_open: false` | frozen, `is_open: false` | live, marked `market_closed` |
| `reference` | **frozen** | served | live, marked `reference` |
| `no_data` | counts as not found (`404`) | counts as not found (`404`) | marked `no_data` |

`GET /v1/status` gives per feed: `status`, `age_seconds`, `sources`, `publish_time`,
`served_publish_time` (what the Hermes routes serve) and `stale`.

`GET /v1/status?feed=<id>` (Pyth or Astra id) returns the same report with that feed alone, and the
status code is the verdict: `200` while it is `trading` and not `stale`, `503` with the same body
otherwise, `404` for an unknown id. An uptime checker needs only the code; a stock feed answers `503`
while its market is closed and a `reference` feed always does.

**Decision rule for anything that moves money:** act only on `trading` with `stale: false` and a
fresh `publish_time`. By Pyth id that is already enforced: a Pyth id never serves anything else, so
a fresh `publish_time` is enough. By Astra id a `reference` price, from one source, is served and
cannot be told from `trading` on a Hermes route, so never liquidate on it.

## Differences from Hermes

- No signed payload: `binary.data` is `[]`, `vaa` is `""`. No on-chain Pyth verification.
- `slot` and `emitter_chain` are `0`.
- Historical routes return `ema_price` equal to `price`. By Pyth id they answer only with a trading,
  in-session update; when the first update at or after the time is not one, the id is not found.
- Feed attributes are strings, never `null`; `base` and `schedule` are omitted when unknown.
- `fixed_rate@50ms` is refused with `400`.
- The avee data API also serves oracle prices at `GET /prices` and `GET /prices/at` under
  `https://api.preview.avee.tech/api/v1`, in its own JSON shape rather than Hermes'.

## Other routes

- Hermes v1, for older clients such as `pythclient`: `GET /api/latest_price_feeds`,
  `GET /api/price_feed_ids`, `GET /api/get_price_feed`.
- Health: `GET /live` (the process is up) and `GET /ready` (it can serve prices).
