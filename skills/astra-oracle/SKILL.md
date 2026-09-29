---
name: astra-oracle
description: Use Astra, avee's free and keyless price oracle that speaks the Pyth Hermes API — crypto, tokenized stocks, FX, metals and commodities. Use when the user wants price feeds, Pyth or Hermes prices without a paid key, to migrate code that uses @pythnetwork/hermes-client or Hermes REST (hermes.pyth.network) to another host, to stream prices over SSE or WebSocket, to fetch historical prices or candles, to look up feed IDs, or to decide whether a price is safe to act on (liquidations, keepers, bots). Covers the one-line switch, REST and streaming routes, Pyth vs Astra feed IDs, stock share vs Robinhood token feeds, feed statuses, and what is not compatible (no on-chain Pyth verification).
license: MIT
metadata:
  author: avee
  version: "0.1.0"
---

# Astra oracle

Astra serves avee's composite index of exchange order books over the **routes and JSON shapes of
Pyth's Hermes**. No key; an `Authorization` header is accepted and ignored; CORS is open.

- Host: `https://astra.preview.avee.tech` (preview). Routes are served from the host root.
- WebSocket: `wss://astra.preview.avee.tech/ws`
- Contract: the OpenAPI document on the docs site, https://docs.preview.avee.tech

## Switch an existing Hermes client in one line

```ts
import { HermesClient } from "@pythnetwork/hermes-client";

const hermes = new HermesClient("https://astra.preview.avee.tech");   // the only change
const BTC_USD = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"; // Pyth's own id
const { parsed } = await hermes.getLatestPriceUpdates([BTC_USD]);
const { price, expo } = parsed![0].price;
console.log(Number(price) * 10 ** expo);
```

Before switching, check three things:

1. **The feeds exist:** paste every Pyth id the code uses into
   `GET /v1/feed-ids?pyth_ids=<id>,<id>,…`. `items` are served, each with its Astra id, and keep
   working unchanged on the Hermes routes; `missing` are not served. On a Hermes route an unknown id
   is `404`, or silently dropped with `ignore_invalid_price_ids=true`.
2. **Keep the staleness check.** A degraded or closed feed stops moving `publish_time`, like a Pyth
   feed below quorum. The age check you already have is the right guard.
3. **Read `parsed`, never `binary`.** Astra prices are **not signed**: `binary.data` is always `[]`
   and `vaa` is `""`. On-chain Pyth verification (`updatePriceFeeds`, pull-oracle contracts) cannot
   work. Astra is for off-chain consumers that read the parsed price: liquidation engines, keepers,
   backends, bots and UIs.

## REST

```bash
H='https://astra.preview.avee.tech'
curl "$H/v2/updates/price/latest?ids[]=e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43&parsed=true"
curl "$H/v2/updates/price/1790540000?ids[]=<id>"            # first price at or after a unix time
curl "$H/v2/updates/price/1790540000/60?ids[]=<id>"         # every price in a window (≤ 60 s)
curl "$H/v2/price_feeds?asset_type=equity"                  # feed catalogue
curl "$H/v1/feeds?category=crypto"                          # both ids, live value and status
curl "$H/v1/feed-ids?pyth_ids=<id>,<id>"                    # which Pyth ids Astra serves, + missing
curl "$H/v1/status"                                         # per feed: status, age, sources, stale
curl -i "$H/v1/status?feed=<id>"                            # one feed: 200 healthy, 503 otherwise
curl "$H/v1/candles?feed=Crypto.BTC/USD&resolution=1h&from=1790500000&to=1790540000"
```

The value is `price × 10^expo`; `price` and `conf` are integer strings, `publish_time` is in seconds.
Keep them as strings or big integers when precision matters. `ema_price` is a one-hour average
weighted by `1/conf`, as Pyth's is, so a move with a wide confidence barely shifts it; after a
restart it needs about an hour to settle.

## Streaming

- **SSE:** `GET /v2/updates/price/stream?ids[]=<id>&channel=fixed_rate@1000ms` — one `PriceUpdate`
  per event, the last value of each feed on connect, `: keepalive` every 30 s.
- **WebSocket:** connect to `wss://astra.preview.avee.tech/ws`, send
  `{"type":"subscribe","ids":["<id>"],"verbose":false,"binary":false}`, receive
  `{"type":"price_update","price_feed":{…}}`.
- Channels: `real_time`, `fixed_rate@200ms`, `fixed_rate@1000ms` (default). `fixed_rate@50ms` is `400`.
- Streams close after 24 hours and on server restarts: always reconnect with backoff.
- More than 200 feeds on one stream: use the WebSocket; an SSE URL that long is rejected.

Limits and reconnect rules: [references/streaming.md](references/streaming.md).

## Feed IDs, categories, stocks

- **Pyth id:** where a feed measures the same quantity as a Pyth feed, Pyth's id works and behaves as
  Pyth's feed does: Pyth's session schedule (a US stock only 09:30–16:00 New York, holidays
  included), and it moves only on a `trading` price.
- **Astra id:** `keccak256("astra:" + symbol)`, for example `astra:Crypto.BTC/USD`. Stable forever.
  It serves every usable price: US stocks 24/5 and `reference` prices too.
- Both work on every route, with or without `0x`, in any case; answers echo the id you asked with.
- **Tokenized stocks have two feeds.** `Equity.US.<T>/USD` is the **share** price (Pyth-compatible id);
  `Equity.RH.<T>/USD` is the Robinhood **token** price (Astra id only). They differ whenever a token
  represents more or less than one share. Value a held token with `RH`; replace a Pyth equity feed
  with `US`.

Details: [references/feeds-and-statuses.md](references/feeds-and-statuses.md).

## Statuses: what not to act on

| Status | Pyth id | Astra id (Hermes routes) | Act on it? |
|---|---|---|---|
| `trading` | served, within Pyth's session | served live | yes |
| `degraded` | frozen at the last trading value | frozen | no: too few sources |
| `market_closed` | frozen; `market_hours.is_open` is `false` | frozen | no: the market is shut |
| `reference` | **frozen** | served | **never liquidate**: a single source, and Hermes has no field to show it |

By Pyth id, the staleness check you already have is the whole guard: a price that is not safe to act
on never reaches you. By Astra id, a Hermes client cannot see the status, so anything that moves
money (liquidations, margin, settlement) must check `GET /v1/status` or `GET /v1/feeds` and refuse
`degraded`, `market_closed` and `reference`, as well as any feed with `stale: true`. `GET /v1/status?feed=<id>` does that check for one feed:
`200` when it is `trading` and not stale, `503` with the same body otherwise.

## Errors and limits

Errors follow Hermes: plain-text `400` (malformed input), `404` (unknown id), `422` (malformed id in
a path). History and candles answer `503` with a problem document when history is unavailable.
The native `/v1/feed-ids` and `/v1/status?feed=` answer a malformed id with a `400` problem document,
and `/v1/status?feed=` an unknown one with `404`. Over
the per-address rate or stream cap: `429` with `Retry-After`, so wait and retry.

**Send at most 200 ids per request** on every route that takes ids in the URL (`latest`, the
historical routes, SSE, `/api/latest_price_feeds`, `/v1/feed-ids`). The server accepts 500, but a
longer URL is rejected before it reaches Astra: `414` over HTTP/1.1, a framing error over HTTP/2.
For more feeds, split into several requests, or subscribe over WebSocket, where ids travel in the
message body (up to 500 per `subscribe`). The SDKs split REST reads into requests of 200 for you
(`MAX_IDS_PER_URL`, `MaxIDsPerURL`), and refuse an SSE subscription over 200 ids with a hint to use
the `ws` transport.
