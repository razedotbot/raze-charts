// Public entry point for @raze/charts.
//
// Exports the `widget` constructor matching TradingView's
// `import { widget } from "charting_library"` usage, plus a `version` string.
// All type exports live in the hand-authored ./types/charting_library.d.ts,
// which the build copies to dist/charting_library.d.ts.

import { Widget } from "./core/Widget";

export { Widget as widget };
export const version = "0.0.0-raze";

// Convenience: a default export object mirroring the TradingView namespace
// shape (some integrations reference `TradingView.widget`).
export default { widget: Widget, version };
