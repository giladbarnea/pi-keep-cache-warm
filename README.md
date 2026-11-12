# pi-keep-cache-warm

A Pi extension that lets an agent keep its prompt cache warm while it waits for something it knows will wake it, such as a reminder it set or a report it asked for, past Pi's own 30-minute idle limit.

Pi's idle cache warmer stops 30 minutes after the last request, whatever the cost. Pi also skips small contexts, where its 15% chance that a request comes in time does not pay for a refresh. An agent waiting for a scheduled wake-up knows better than either guess. This extension lets it say so.

## Install

```bash
pi install npm:@giladbarnea/pi-keep-cache-warm
```

Requires Pi 1.5.1 or later, which exports the cache-warming economics this extension uses.

## The tool

`keep_cache_warm(minutes)`: keep the cache warm until `minutes` from now. The agent calls it in the same turn as setting its reminder. Warming starts when the turn ends and stops at the deadline or at the agent's next turn, whichever comes first. The tool replies in the agent's terms, for example `Keeping the cache warm until 50 min from now (14:32:10).`

While armed, the extension resends the last request's exact provider payload with `max_tokens: 1`, once per refresh slot (Pi's refresh delay plus 10 s, every 280 s on a 5-minute cache). The prefix is byte for byte the same, so each warm reads it from the cache.

- **It hands over from Pi.** Pi's own idle warmer goes first. The extension counts each of Pi's refreshes as one of its own: a `cache_warm` record marks a finished refresh, and Pi's `cache_warming_decision` with action `warm` marks one still in flight, since the record only lands when the refresh completes. When a slot passes with neither, Pi has stopped: at its 30-minute idle limit, earlier, or never started because its cost rule declined. The extension then warms, one slot after Pi's last refresh and before the cache entry expires.
- **The deadline is capped at break-even.** When the next request is certain, a refresh costs about 0.1× the prompt's input price, and a cold resume costs a 1.25× write instead of a 0.1× read. Refreshing pays until the refreshes add up to that difference, `floor(missCost / warmCost)` of them, priced by Pi's own `evaluateCacheWarming`. The budget starts after Pi's free idle warms, and the last refresh's cache lifetime covers the tail. On Anthropic's 5-minute tier the cap is about 55 minutes from the last request when Pi will not warm, and about 81 minutes when it will. Longer requests are capped, and the reply says so.
- **Guard.** If a warm writes to the cache or reads less than the saved prefix, the cache entry was lost. Warming stops at once, and a visible message in the session reports what the warm read.
- **Scope.** It only works for models that Pi declares a prompt-cache lifetime for and can replay with a one-token cap. Models with budget-based thinking (for example Claude Haiku 4.5 with thinking on) and OpenAI Codex models are refused, as Pi's own warmer refuses them.

## Cost visibility gap

Pi records its own warms as `usage` entries of kind `cache_warm`, which count in the session totals. Extensions cannot write `usage` entries: the documented channels for extension usage are tool results and compaction or branch summaries, and an idle warm fits neither. So each warm is written as a `keep-cache-warm` custom entry with its full usage, and the footer shows a running total. These costs do not appear in Pi's `/session` and footer totals.

## Measured

A proof of concept on Pi 1.5.2, with `anthropic/claude-haiku-5-5` on low thinking and a 2.7k-token prompt:

| Run | Setup | Request after the gap: cache read / write |
|---|---|---|
| Warmed | armed for 50 min, idle 49.9 min | 2,741 / 15 (only the new turn) |
| Control | no warming, idle 50 min | 0 / 2,418 (cold) |

- **Warms:** there were 10, one every 280 s. Each read all 2,741 saved tokens from the cache and wrote nothing, at $0.0000281 per warm.
- **Economics:** at 50 minutes the warms saved $0.000273 and cost $0.000281, which is break-even, as the cap predicts.
- **Guard:** a run whose process was suspended past the cache lifetime made one late warm, which read only 1,651 of 2,741 tokens. The guard stopped warming and reported the numbers.
- **Codex:** on `openai-codex/gpt-6-luna`, with no warming, the cache survived 50 minutes idle and was gone after 75. Codex models do not need this extension for gaps under 50 minutes.

## Development

```bash
npm install
npm test
```

The tests cover the scheduling and the economics, and drive the extension against a fake Pi with mocked timers, including a Pi refresh that is still in flight.

## License

MIT
