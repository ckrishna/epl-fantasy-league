## Problem: GenBI feels slow, and the architecture makes streaming non-trivial

After switching to Sonnet 4.6 (see bedrock.mjs's model comment -- Haiku wasn't reliable
enough, Sonnet 5 is AccessDenied for this account), GenBI answers take noticeably
longer. Two smaller wins already shipped this pass (deduping the bootstrap-static fetch
and the fpl_entry_gameweek/fpl_entry_picks Scans in genbi.mjs -- see those commits), but
neither touches the biggest single contributor to *perceived* latency: `askClaude()` in
`utils/bedrock.mjs` uses `InvokeModelCommand`, which blocks until Bedrock has generated
the entire completion, and the frontend (`queryStats()` in `src/api/client.js`) does a
plain `await fetch()` for the full JSON body. The "Churning" loader (see App.jsx/Stats.jsx)
sits there for the whole generation, even though the model is producing text the whole
time -- the user just can't see any of it until the very last token.

Real per-token streaming would fix that: the first sentence could appear in well under a
second, even if total generation time is unchanged.

## Why this isn't a quick fix

This whole API (`stats-api` Lambda, function ARN
`arn:aws:lambda:us-west-2:564103198625:function:stats-api`) is fronted by a REST API
Gateway (`API_ID=3in32oonc3`, see `scripts/add-manager-squad-route.sh` /
`scripts/add_feedback_route.sh` for the exact resource/integration shape -- `AWS_PROXY`
integration, one Lambda, routed internally by `index.mjs`). **API Gateway REST APIs
buffer the entire Lambda response before returning anything to the client** -- there is
no way to stream through this integration type, regardless of what Bedrock itself
supports. AWS Lambda response streaming (the feature that would let a Lambda push chunks
to an HTTP client as they're produced) is *only* available via Lambda Function URLs
configured with `InvokeMode: RESPONSE_STREAM`, using the `awslambda.streamifyResponse()`
wrapper in the handler. It does not work through API Gateway (REST or HTTP API), and
does not work through the classic `InvokeModelCommand` -- Bedrock's streaming
counterpart is `InvokeModelWithResponseStreamCommand`, a separate SDK call that returns
an async-iterable event stream instead of one JSON blob.

So this is two independent things that both have to change together:
1. Bedrock call: `InvokeModelCommand` -> `InvokeModelWithResponseStreamCommand`.
2. Transport: the `/stats/query` route needs an execution path that isn't API Gateway's
   buffered REST integration.

## Options for the transport half

**A. New, dedicated Function URL on the existing `stats-api` Lambda, used only for
`/stats/query`.** Keep every other route (`/standings`, `/winners`, `/manager-squad`,
etc.) exactly as-is on API Gateway. Add a Function URL with `RESPONSE_STREAM` invoke
mode; the Lambda's handler would need a second code path (the top-level handler already
routes by path in `index.mjs`, so this is a branch, not a rewrite) that detects
"invoked via Function URL, streaming mode" and calls `awslambda.streamifyResponse()`
around a version of `handleGenBI` that writes SSE-style chunks instead of building one
JSON body. Frontend changes: `queryStats()` in `client.js` would need a second code
path that calls `fetch()` against the Function URL's own origin (different domain than
`API_BASE`) and reads the body via a `ReadableStream`/`TextDecoder` loop instead of
`res.json()`. CORS is configured directly on the Function URL (separate from API
Gateway's CORS setup) -- straightforward but another thing to get right.
Budget/logging/feedback (`checkBudget`, `recordUsage`, `recordQueryLog`) all currently
run *after* `askClaude()` resolves with a final `usage` object -- streaming still ends
with a final chunk carrying `usage`, so this bookkeeping doesn't fundamentally change,
just needs to run after the stream closes rather than after a single await.

**B. Migrate the entire `stats-api` Lambda off API Gateway onto a Function URL.**
Simpler in the sense of "one execution path," but touches every existing route
(standings, winners, trends, manager-squad, feedback, money config...) and their
existing CORS/OPTIONS handling, which is currently hand-wired per-resource via the
`add_*_route.sh` scripts. Higher blast radius for a change that's only needed by one
endpoint. Not recommended unless there's a separate reason to leave API Gateway
entirely.

**C. Don't do real token streaming; fake responsiveness instead.** E.g. show an
optimistic "thinking about it..." message that changes after N seconds, or (cheaper
still) just tighten `max_tokens` and the system prompt size (see the two dedup fixes
already shipped, plus prompt-caching -- a separate, cost-focused optimization, not a
latency one) so the *actual* wait shrinks, without touching the transport at all. Doesn't
give the "watching it type" feel, but zero infra risk.

Recommendation: **A**, if/when this is prioritized -- it isolates the risk to the one
endpoint that actually needs it and leaves every other route untouched.

## Rough scope if going with Option A

- `lambda/stats-api/utils/bedrock.mjs`: add a streaming variant of `askClaude()` using
  `InvokeModelWithResponseStreamCommand`; needs to accumulate the full text + final
  `usage` object anyway (for `recordUsage`/`recordQueryLog`), so it's an additive
  function, not a replacement of the existing one -- other callers (if any) keep working.
- `lambda/stats-api/handlers/genbi.mjs`: a streaming variant of `handleGenBI` (or a flag
  on the existing one) that writes to a Node `Writable` (what
  `awslambda.streamifyResponse()` hands you) instead of returning `{statusCode, body}`.
- New Lambda Function URL (`aws lambda create-function-url-config --invoke-mode
  RESPONSE_STREAM`), CORS configured to match the existing API Gateway CORS headers.
- `src/api/client.js`: new `queryStatsStreaming()` (or a flag) that reads a
  `ReadableStream` and calls an `onChunk` callback instead of returning one object.
- `src/pages/Stats.jsx`: render the answer incrementally as chunks arrive instead of
  waiting for one final `setAnswer(result)`; the existing "Churning" elapsed-time loader
  (task #61) becomes the *before-first-token* state, not the whole-request state.
- Tests: `tests/helpers/mock-bedrock.mjs` currently mocks the single-shot
  `InvokeModelCommand` response shape -- needs an equivalent for the streaming event
  iterable before any of this is testable the way the rest of this codebase is.

Not estimating effort in hours/days here -- flagging it as a real, multi-file,
cross-layer change so it gets picked up deliberately rather than folded into a "quick
latency fix" pass.
