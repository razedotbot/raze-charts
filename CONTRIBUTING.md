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

## Running and adding tests

`npm test` runs `scripts/run-tests.mjs`: typecheck, build,
`examples/smoke.mjs`, then every `tests/*.mjs` file in name order, with the
slow `build-watch` and `package-contract` suites last. Tests are discovered;
never add a test to `package.json`.

- Add a regression as `tests/<name>.mjs`: a self-executing Node script that
  exits non-zero on failure (a thrown assertion is enough). Tests may import
  `dist/` because the runner builds first.
- Put shared test modules in `tests/helpers/`; they are never run directly.
  `tests/static-server.mjs` is the Playwright web server, not a test.
- Run a subset while iterating. It builds, then runs only the named tests:

  ```bash
  npm test -- chart data-manager
  npm test -- "chart*" --no-build
  node scripts/run-tests.mjs --list
  ```

  A name that matches no test fails and lists the available ones.
- Real-browser behaviour belongs in a Playwright spec (`tests/*.spec.ts`),
  run by `npm run test:visual`.

## Adding a package subpath

Public entrypoints are one table, `PACKAGE_ENTRIES` in `scripts/entries.mjs`.
It drives the esbuild outputs, `package.json` `exports` and `typesVersions`,
the prepare script, the packed package contract, and the bundle-size gate. To
add a subpath:

1. Add the entry row and its `src/<name>/index.ts` barrel with real exports.
2. Run `node scripts/entries.mjs --write` to regenerate the `package.json`
   fields (`tests/package-entries.mjs` fails while they are out of sync).
3. Add `benchmarks/budgets/<id>.json` with an artifact budget and at least one
   consumer scenario, then `node scripts/check-bundle-size.mjs --write-docs`
   to refresh the table in [performance](./docs/performance.md#bundle-budgets).
4. Document the subpath in the README surface table and the
   [capability matrix](./docs/capabilities.md).

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
- Declare TradingView-compatible types in the matching `src/types/tv/` module,
  not in the `src/types/charting_library.d.ts` barrel. After an intentional
  public type change, review the diff reported by
  `node tests/types-api-report.mjs` and refresh the snapshot with
  `node tests/types-api-report.mjs --update`. See
  [TradingView-compatible declarations](./docs/architecture.md#tradingview-compatible-declarations).

## Test layers

| Layer | Purpose |
| --- | --- |
| TypeScript strict check | Public types, unused code, and cross-module contracts |
| Widget smoke test | Basic DOM integration and public widget behavior |
| Native chart tests | Scales, composition, mark/plugin boundaries, color semantics, renderer parity, and hit testing |
| Data/time/study tests | Async races, gapped sessions, teardown, and incremental indicators |
| React adapter tests | Exact series props, measured sizing, immutable handles, lifecycle, and React 17/18 types |
| Build-watch test | Type-only and hand-authored declaration changes rebuild without restarting the watcher |
| Test runner and entry table | Test discovery, subset selection, and `package.json` exports generated from `scripts/entries.mjs` |
| Declaration API report | Every published export and resolved member type matches `tests/types-api-report/*.api.txt` |
| Compatibility types flattening | `src/types/tv/` modules flatten into a self-contained `dist/charting_library.d.ts` |
| Packed package contract | ESM, CommonJS, NodeNext declarations for every entry, shared runtime identity, optional React peer, export paths, standalone global |
| Playwright goldens | Product-level financial and native-dashboard appearance and interaction states |
| Bundle budget | Gzip size of each published ESM entrypoint and of tree-shaken, minified consumer scenarios, one budget file per entry |
| Compiler benchmark | Repeatable 1k through 1M native scene compilation and regression budget |

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
