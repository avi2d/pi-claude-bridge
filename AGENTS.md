# Agent Guidelines

## Restricted Actions

Do **not** auto-commit.

Do **not** interact with the public without explicit permission. For example, do not open PRs or comment on github issues unless I say so.

## Claims about how Claude Code behaves

`~/.claude/projects/**` is **not** evidence of what CC does. The bridge writes into
the same files and CC re-serializes imported records under synthetic ids, so a scan
of that directory largely reflects our own output handed back to us — 352 of 1,810
files hold both shapes. Before asserting "CC does X" from disk, split by provenance
(CC-live records carry a real `requestId`/`promptId`; ours carry
`msg_syn_*`/`req_syn_*`) and regroup by `message.id`, since CC stores one content
block per record while cc-session-io stores one record per message.
`diag/audit-transcripts.mjs` does both.

Better still, prove it with a live probe. `tests/int-cc-contracts.mjs` pins each
undocumented behavior we depend on against the installed CC/SDK and is the right
home for a new assumption; `diag/capture-proxy.mjs` captures the actual request
bodies when the question is what CC sends. `claude-code-rip/` lags the installed
CLI by an unknown margin, so read it for mechanism, never for current behavior:
what it gates, defaults, or omits may already have changed. And before
reverse-engineering an SDK option at all, grep
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — it documents every
settings field, several of which solve problems the CC source makes look
intractable.

The same skepticism applies to any *rate* computed from the debug log. Before
believing one, check the metric against a case whose answer you know: the
cache-break scanner counted a request's uncached `input` as if the next request
should read it back, which turned every tool-heavy turn into a false break and
manufactured a dose-response that looked like a real finding.

Bin by era before comparing groups. A correlation computed over a window that
straddles the onset of the phenomenon will credit whatever else changed. Three
independent analyses agreed one account state was safe on 5,611 clean requests —
every one of which predated the first failure; switching to that state reproduced
the failure in five minutes.

Five wrong conclusions across two sessions came from skipping the above.

## Adding a model

The picker is built from pi-ai's static builtin catalog (`getModels("anthropic")`
in `src/index.ts`), so an id pi-ai has not shipped never appears in `/model` —
check `node_modules/@earendil-works/pi-ai/dist/providers/data/anthropic.json`
before concluding a bridge change made a model reachable. `--model
claude-bridge/<unlisted-id>` still launches, because pi's `buildFallbackModel`
clones the provider's first registered model and overrides its id: the window
that session reports comes from that clone, not from
`resolveClaudeCodeRuntimeModel`.

Measure before allowlisting: `node diag/context-size.mjs max <id>` records what
the SDK actually serves (see `diag/CONTEXT-SIZE.md`), and
`BRIDGE_MODEL=claude-bridge/<id> node --import tsx tests/int-served-window.mjs`
shows served vs registered through a real pi session.

## Changelog

Maintain an entry in the `## UNRELEASED` section at the top of `CHANGELOG.md` for every significant change, using the existing format:

```
- **Tag: summary** — detail
```

Do not add changelog entries for docs-only changes. If multiple entries in the UNRELEASED section pertain to the same feature, try to combine them into one entry,

Tags: `Add`, `Fix`, `Refactor`, `Tests`, `Bump`, `Deprecate`, `Remove`.

## Release

No build step — the package ships `src` TypeScript as-is (see `files` in `package.json`). To cut version `X.Y.Z`:

1. **Changelog** — rename the `## UNRELEASED` section to `## X.Y.Z — YYYY-MM-DD`.
2. **Bump** — set `version` to `X.Y.Z` in `package.json`.
3. **Commit** — `git commit -m "Release X.Y.Z"` (changelog + package.json only).
4. **Tag** — `git tag vX.Y.Z` (note the `v` prefix).
5. **Push commit and tag together** — `git push --follow-tags`. 
6. **Publish** — `npm login` and `npm publish`.

## Tests

Smoke tests typically need to run outside a sandbox because they access local pi/Claude settings and auth state.

An end-to-end reproduction needs no API spend: `tests/int-compact-midreply.mjs` runs pi, the bridge and a real Claude Code against a scripted stub Messages API through `ANTHROPIC_BASE_URL`, and asserts on the request bodies CC sent.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
