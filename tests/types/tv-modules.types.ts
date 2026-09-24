// Type-only checks, compiled by `npm run typecheck` (tsconfig.type-tests.json).
// The `.types.ts` suffix keeps this file out of Playwright's test discovery.
//
// The TradingView-compatible surface is authored as src/types/tv/ domain
// modules behind the src/types/charting_library.d.ts barrel. These checks keep
// the modules, the barrel and the package root pointing at one set of
// declarations, and keep declaration merging (module augmentation) working
// through the public entry the way it did for the single-file declaration.

import type * as Root from "../../src";
import type * as Barrel from "../../src/types/charting_library";
import type { ISubscription, ResolutionString } from "../../src/types/tv/common";
import type { Bar, IBasicDataFeed } from "../../src/types/tv/datafeed";
import type { CreateShapeOptions } from "../../src/types/tv/shapes";
import type { ITradingLineAdapter } from "../../src/types/tv/trading";
import type { IChartWidgetApi } from "../../src/types/tv/chart-api";
import type { ChartLayoutSnapshot } from "../../src/types/tv/layout";
import type { ContextMenuCallback, ContextMenuItem } from "../../src/types/tv/context-menu";
import type { IChartingLibraryWidget, widget } from "../../src/types/tv/widget";
import type { ChartingLibraryWidgetOptions, RazeChartsOptions } from "../../src/types/tv/options";
import type { StudyDefinition } from "../../src/types/tv/studies";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

export type ModulesAreTheBarrel = [
  Expect<Equal<ResolutionString, Barrel.ResolutionString>>,
  Expect<Equal<ISubscription, Barrel.ISubscription>>,
  Expect<Equal<Bar, Barrel.Bar>>,
  Expect<Equal<IBasicDataFeed, Barrel.IBasicDataFeed>>,
  Expect<Equal<CreateShapeOptions, Barrel.CreateShapeOptions>>,
  Expect<Equal<ITradingLineAdapter, Barrel.ITradingLineAdapter>>,
  Expect<Equal<IChartWidgetApi, Barrel.IChartWidgetApi>>,
  Expect<Equal<ChartLayoutSnapshot, Barrel.ChartLayoutSnapshot>>,
  Expect<Equal<ContextMenuItem, Barrel.ContextMenuItem>>,
  Expect<Equal<Parameters<IChartingLibraryWidget["onContextMenu"]>[0], ContextMenuCallback>>,
  Expect<Equal<IChartingLibraryWidget, Barrel.IChartingLibraryWidget>>,
  Expect<Equal<widget, Barrel.widget>>,
  Expect<Equal<ChartingLibraryWidgetOptions, Barrel.ChartingLibraryWidgetOptions>>,
  Expect<Equal<StudyDefinition, Barrel.StudyDefinition>>,
];

export type RootReExportsTheBarrel = [
  Expect<Equal<Root.IChartWidgetApi, IChartWidgetApi>>,
  Expect<Equal<Root.ChartingLibraryWidgetOptions, ChartingLibraryWidgetOptions>>,
  Expect<Equal<Root.RazeChartsOptions, RazeChartsOptions>>,
];

// Augmenting the public entry merges into the declaring tv module. Members are
// optional so the augmentation does not change what src/ must implement.
declare module "../../src" {
  interface IChartWidgetApi {
    typeTestPluginMethod?(): number;
  }
  interface RazeChartsOptions {
    type_test_plugin_flag?: boolean;
  }
}

export type AugmentationMerges = [
  Expect<Equal<ReturnType<NonNullable<IChartWidgetApi["typeTestPluginMethod"]>>, number>>,
  Expect<Equal<NonNullable<NonNullable<ChartingLibraryWidgetOptions["raze"]>["type_test_plugin_flag"]>, boolean>>,
];
