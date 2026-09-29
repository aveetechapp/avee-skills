---
name: avee-sdk
description: Point to avee's official client libraries — one package per language (TypeScript/Node, Go, Python) holding the data API client and the Astra oracle client — with install lines and three-line quickstarts, plus what to use until a package is published (plain HTTP, a Hermes client, or a client generated from the OpenAPI document). Use when the user wants to add avee or Astra to a TypeScript, JavaScript, Go or Python project, asks for an avee SDK or package name, or wants typed clients instead of raw HTTP.
license: MIT
metadata:
  author: avee
  version: "0.1.0"
---

# avee SDKs

No SDK is required: both APIs are keyless HTTPS. Check whether a package is published (npm, PyPI,
`go list -m`) before telling the user to install it; the docs site lists what is released:
https://docs.preview.avee.tech

One package per language carries both clients: `@avee/sdk` (npm), `github.com/aveetechapp/avee-go`
(Go) and `avee` (PyPI). The Astra client is a separate entry point inside it, so importing one never
loads the other.

## Astra oracle client

Astra's REST, SSE and WebSocket routes, with exact prices, retries that honour `Retry-After`, and
reconnecting streams. Pass the host explicitly while Astra runs on the preview host.

**TypeScript / Node** (`npm install @avee/sdk`, entry point `@avee/sdk/astra`, Node 22+ or a browser, no runtime deps)

```ts
import { AstraClient } from "@avee/sdk/astra";
const astra = new AstraClient({ baseUrl: "https://astra.preview.avee.tech" });
const [btc] = await astra.latestPrices(["0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"]);
console.log(btc.price.toDecimalString());
```

**Go** (`go get github.com/aveetechapp/avee-go`, import `github.com/aveetechapp/avee-go/astra`, Go 1.24+)

```go
c, _ := astra.New(astra.Options{BaseURL: "https://astra.preview.avee.tech"})
prices, _ := c.LatestPrices(ctx, []string{"0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"}, astra.PriceQuery{})
fmt.Println(prices[0].Price.Decimal())
```

**Python** (`pip install 'avee[astra]'`, module `avee.astra`, Python 3.10+, sync and asyncio clients)

```python
from avee.astra import AstraClient
[btc] = AstraClient("https://astra.preview.avee.tech").latest_prices(["0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"])
print(btc.price.to_decimal())
```

Streaming: `astra.subscribe(ids, { transport: "ws" })` in TypeScript (`for await`), channels in Go,
`async for` in Python. **Until the package is published**, any Pyth Hermes client works against
Astra by changing its base URL (the `astra-oracle` skill).

## Data API client

The same packages carry a typed client for `/api/v1`: `AveeClient` from `@avee/sdk`, the root
package of `github.com/aveetechapp/avee-go`, and `avee`. It is not released yet. Until it is:

```ts
const res = await fetch("https://api.preview.avee.tech/api/v1/pairs?chains=robinhood&sort=volume&timeframe=24h&limit=5");
if (!res.ok) throw new Error((await res.json()).code);
const { items, next_cursor } = await res.json();
```

Or generate a typed client from the served OpenAPI 3.1 document with any generator:

```bash
curl -o avee.yml 'https://api.preview.avee.tech/api/v1/openapi.yml'
npx @hey-api/openapi-ts -i avee.yml -o src/avee        # or oapi-codegen (Go), openapi-python-client
```

Whatever the client, follow the `avee-data-api` skill for limits, backoff and pagination, and ignore
unknown fields and enum values: both contracts grow additively.
