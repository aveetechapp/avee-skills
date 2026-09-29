# Streaming and limits

## SSE

```bash
curl -N 'https://astra.preview.avee.tech/v2/updates/price/stream?ids[]=<id>&ids[]=<id>&channel=real_time'
```

One `PriceUpdate` per event, for one feed. On connect you get the last value of each feed. A
`: keepalive` comment arrives every 30 seconds; treat about 45 seconds of silence as a dead
connection. `benchmarks_only=true` sends only the first update of each second.

## WebSocket

Connect to `wss://astra.preview.avee.tech/ws` (add `?channel=…` to pick a channel), then send:

```json
{"type": "subscribe", "ids": ["<id>"], "verbose": false, "binary": false}
```

Each `subscribe` or `unsubscribe` is answered with `{"type":"response","status":"success"}` or
`{"type":"response","status":"error","error":"…"}`. Updates arrive as:

```json
{"type": "price_update", "price_feed": {"id": "<id>", "price": {}, "ema_price": {}}}
```

The server pings every 30 seconds.

## Channels

| Channel | Behaviour |
|---|---|
| `real_time` | every update |
| `fixed_rate@200ms` | at most once per 200 ms per feed, only when it changed |
| `fixed_rate@1000ms` | default; at most once per second per feed, only when it changed |

Per feed a stream is in `publish_time` order and never repeats an update, so `allow_unordered` and
`allow_out_of_order` are accepted and change nothing.

## Limits

- At most 200 ids in a URL (REST and SSE): the server accepts 500, but a longer URL is rejected
  before it reaches Astra (`414`, or a framing error over HTTP/2). Split larger lists into several
  requests; to stream more than 200 feeds, use the WebSocket, where a `subscribe` takes up to 500 ids
  in the message body. The SDKs split REST reads for you and refuse SSE over 200 ids.
- Historical routes take at most 100 distinct feeds; a candle request returns at most 5000 bars; an
  interval window is at most 60 seconds.
- Per client address there is a request rate and a cap on concurrent streams. Over either: `429`
  with `Retry-After`.
- Streams close after 24 hours, as on Hermes.
- A WebSocket message is at most 64 KiB. A client that floods messages, or stops reading until its
  buffer fills, is closed with code `1008`.
- A restarting server closes streams (WebSocket `1001`) and refuses new ones with `503`.

## Reconnect rules

Reconnect on every close, `429` or `5xx`, with full-jitter exponential backoff (start around 500 ms,
cap around 30 s, honour `Retry-After` as a floor), and resubscribe to the same ids. After a
reconnect the server replays the last value of each feed: drop any update whose `publish_time` is
not newer than the last one you processed for that feed.
