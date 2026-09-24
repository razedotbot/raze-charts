# Contributing to Raze Charts

Raze Charts values small public contracts, excellent defaults, deterministic
behavior, and explicit limitations. A contribution is complete when its API,
interaction, documentation, tests, and cleanup path agree.

## Setup

Use Node 18 or newer and TypeScript 5.0 or newer. Install the locked dependency
graph:

```bash
npm ci
npm run build
```

Open the local examples with any static server:

```bash
python3 -m http.server 8799
```

Then visit `http://localhost:8799/examples/index.html` for the financial widget
or `http://localhost:8799/examples/dashboard.html` for native charts.

## Before opening a pull request

Run the same deterministic checks as CI:

```bash
npm run quality
npm run test:visual
```

The visual command requires Chromium installed through Playwright. Install it
once with:

```bash
npx playwright install chromium
```

Do not update screenshots to make an unexplained diff disappear. Inspect the
result, confirm the visual change is intentional, and then use:

```bash
npm run test:visual:update
```

`npm test` starts with the strict source and API type tests. During development,
`npm run typecheck` runs that faster type-only feedback loop by itself.

## Change checklist

- Keep the root widget, native `/chart`, and React `/react` responsibilities
  distinct. Compatibility adapters should translate into a native behavior.
- Add a focused regression for correctness, async ownership, lifecycle, or
  rendering behavior. Exercise teardown when a feature owns listeners,
  observers, subscriptions, timers, or pending callbacks.
- Preserve datum inference in native builders. A new escape hatch should not
  weaken the common typed path.
- Make known unsupported behavior throw a useful error. Do not add silent
  no-op props or compatibility components.
- Add accessible names, states, focus behavior, and reduced-motion/forced-color
  behavior with any new UI.
- Update [capabilities](./docs/capabilities.md) and
  [migration guidance](./docs/migration.md) when the public support boundary
  changes.
- Add a reproducible performance case before making or changing a performance
  claim. Do not tune the portable budget to one workstation result.
- Verify the packed package when exports, types, build artifacts, or peer
  dependencies change. `npm test` runs the isolated package contract.

## Test layers

| Layer | Purpose |
| --- | --- |
| TypeScript strict check | Public types, unused code, and cross-module contracts |
| Widget smoke test | Basic DOM integration and public widget behavior |
| Native chart tests | Scales, composition, mark/plugin boundaries, color semantics, renderer parity, and hit testing |
| Data/time/study tests | Async races, gapped sessions, teardown, and incremental indicators |
| React adapter tests | Exact series props, measured sizing, immutable handles, lifecycle, and React 17/18 types |
| Build-watch test | Type-only and hand-authored declaration changes rebuild without restarting the watcher |
| Packed package contract | ESM, CommonJS, NodeNext declarations, shared runtime identity, optional React peer, export paths, standalone global |
| Playwright goldens | Product-level financial and native-dashboard appearance and interaction states |
| Bundle budget | Gzip size of root, native chart, and React ESM entrypoints |
| Compiler benchmark | Repeatable 1k through 1M native scene compilation and regression budget |
| Widget browser benchmark | `node scripts/benchmark-widget.mjs --check`: Chromium frame, crosshair, pan, wheel, live-tick and heap budgets at 1k through 500k bars ([details](./docs/performance.md#financial-widget-browser-benchmark)) |

## Architecture and style

Read [architecture](./docs/architecture.md) before adding a new subsystem.
Prefer pure domain calculations and renderer-neutral data over DOM work. Keep
browser ownership at mount/widget boundaries and return explicit cleanup.

The project is dependency-free at runtime. A new dependency needs a concrete
benefit, bundle-cost analysis, licensing check, and maintainer agreement.

Use error messages that say what failed, identify the relevant plugin/target
when possible, and tell a developer what to do next. Error codes are useful for
stable validation branches; they are not a replacement for readable text.

## Performance results

`node scripts/benchmark.mjs` prints local timings. `--json` produces
machine-readable output, and `--check` compares medians with the portable CI
budgets in
[dashboard-baseline.json](./benchmarks/dashboard-baseline.json).

The checked-in baseline records the scenario and one reference machine. Treat
it as a historical comparison point, not a universal SLA. If a change is
intentionally slower, explain the product tradeoff and provide before/after
results before proposing a budget adjustment.
