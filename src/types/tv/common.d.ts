// Shared primitives of the TradingView-compatible type surface.
//
// Branded ids, theme and timezone names, and the subscription shape used by
// every event source.

// ── Branded primitives (match TV's Nominal brand so assignments are compatible) ──
export type Nominal<T, Name extends string> = T & {
  [Symbol.species]?: Name;
};
export type ResolutionString = Nominal<string, "ResolutionString">;
export type EntityId = Nominal<string, "EntityId">;
export type ThemeName = "light" | "dark";
export type SeriesFormat = "price" | "volume";
export type Timezone = string;

// ── Subscriptions ───────────────────────────────────────────────────────────
export interface ISubscription<TFunc extends (...args: never[]) => void = (...args: never[]) => void> {
  subscribe(
    obj: object | null,
    member: TFunc,
    singleshot?: boolean,
  ): void;
  unsubscribe(obj: object | null, member: TFunc): void;
  unsubscribeAll(obj: object | null): void;
}
