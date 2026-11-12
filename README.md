# pi-keep-cache-warm (proof of concept)

Adds a `keep_cache_warm(minutes)` tool. An agent calls it when it knows it will be woken soon, for example next to a reminder. When the turn ends, the extension resends the last request's exact provider payload with `max_tokens: 1` once per refresh slot (Pi's delay plus 10 s) until the deadline or the next turn. It skips a slot when Pi's own warmer refreshed the cache in it, so it takes over only after Pi stops: either at Pi's 30-minute idle limit or when Pi's cost rule declines to warm.

- `minutes` means "keep the cache warm until N minutes from now". The result states the time it will stay warm until.
- That time is capped at break-even, counted from the last request. When Pi's idle warming is on and Pi's cost rule will warm this context, Pi's first 30 idle minutes cost nothing extra here, and the budget of `floor(missCost / warmCost)` refreshes (from Pi's `evaluateCacheWarming`) starts after them. The last refresh's TTL covers the tail. On Anthropic's 5-minute tier the cap is about 55 minutes when Pi will not warm, and about 81 minutes when it will.
- Guard: if a warm writes to the cache or reads less than the saved prefix, warming stops and a visible message says so.
- Each warm is written as a `keep-cache-warm` custom entry with its usage. Extensions cannot write Pi `usage` entries, so these costs do not appear in Pi's session totals.
- It only works for models that Pi declares a `promptCache` lifetime for and that can be replayed with a one-token cap (`isCacheWarmingReplayable`).

Test: `npm test`. The live proof is in `desks/2026-11-11-keep-cache-warm/`.
