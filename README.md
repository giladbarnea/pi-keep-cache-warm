# pi-keep-cache-warm (proof of concept)

Adds a `keep_cache_warm(minutes)` tool. An agent calls it when it knows it will be woken soon, for example next to a reminder. When the turn ends, the extension resends the last request's exact provider payload with `max_tokens: 1` once per refresh slot (Pi's delay plus 10 s) until the deadline or the next turn. It skips a slot when Pi's own warmer refreshed the cache in it, so it takes over only after Pi stops: either at Pi's 30-minute idle limit or when Pi's cost rule declines to warm.

- The deadline is capped at break-even: `floor(missCost / warmCost)` refreshes plus one TTL, from Pi's `evaluateCacheWarming`. That is about 55 minutes on Anthropic's 5-minute tier.
- Guard: if a warm writes to the cache or reads less than the saved prefix, warming stops and a visible message says so.
- Each warm is written as a `keep-cache-warm` custom entry with its usage. Extensions cannot write Pi `usage` entries, so these costs do not appear in Pi's session totals.
- It only works for models that Pi declares a `promptCache` lifetime for and that can be replayed with a one-token cap (`isCacheWarmingReplayable`).

Test: `npm test`. The live proof is in `desks/2026-11-11-keep-cache-warm/`.
