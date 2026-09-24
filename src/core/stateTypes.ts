// Persistence contracts (AD-10). Each store serialises its own StateSlice;
// W3-16 owns the registry, schema, migration pipeline, save_load_adapter and
// URL codec that compose slices into a layout snapshot. Broker/trading state is
// deliberately excluded from snapshots and must never be registered as a slice.
//
// Producers: StudyStore (`studies`, W3-06), ShapeStore (`drawings`, W3-14),
// the viewport store (`viewport`/`chart`, W2-02). Consumer: the W3-16 registry.

import type { IdAllocator } from "./ids";

/** A JSON value: what a slice may emit and what a snapshot stores. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export interface JsonArray extends ReadonlyArray<JsonValue> {}
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** One validation problem, addressed by a JSON-pointer-like path (`/drawings/3/points/0/time`). */
export interface StateIssue {
  readonly path: string;
  readonly message: string;
  /** Stable machine-readable code, for example `type`, `range`, `unknown-kind`. */
  readonly code?: string;
}

/** Why a slice is being applied. `setState` is the diffing path that must not refetch bars. */
export type StateApplyReason = "load" | "setState" | "undo" | "redo" | "url" | "hydrate";

/** Services handed to a slice while it applies a snapshot. */
export interface StateApplyContext {
  readonly reason: StateApplyReason;
  /** The widget's allocator: slices reserve restored ids so later allocations never collide. */
  readonly ids: IdAllocator;
}

/** Why a slice reported a change (drives debounced onStateChange/autosave). */
export type StateChangeKind = "add" | "remove" | "update" | "reorder" | "replace";

export interface StateSliceChange {
  readonly key: string;
  readonly kind: StateChangeKind;
  /** Ids of the affected entities when the change is entity-scoped. */
  readonly ids?: readonly string[];
}

/**
 * The contract a store implements to take part in persistence. A slice owns
 * exactly one top-level snapshot key and never reads or writes another slice's
 * payload; cross-slice links (a drawing owned by a study pane) are expressed by id.
 */
export interface StateSlice<TSnapshot extends JsonValue = JsonValue> {
  /** Snapshot key (`drawings`, `studies`, `viewport` ...): lowercase, `[a-z][a-z0-9_]*`. */
  readonly key: string;
  /** Payload schema version; a positive integer bumped on breaking payload changes. */
  readonly version: number;
  /**
   * True when applying this slice requires reloading bars (symbol/interval).
   * setState() skips the data reload when every changed slice reports false.
   */
  readonly requiresDataReload: boolean;
  /** Serialise the live state. Derived data (study values, screen geometry) is never included. */
  save(): TSnapshot;
  /** Validate an untrusted payload without applying it. An empty array means valid. */
  validate(payload: unknown): StateIssue[];
  /** Replace the live state with a validated payload. */
  apply(payload: TSnapshot, context: StateApplyContext): void | Promise<void>;
  /** Upgrade a payload written by an older `version`. Required once `version` exceeds 1. */
  migrate?(payload: JsonValue, fromVersion: number): TSnapshot;
  /** Subscribe to changes; returns an unsubscribe function. */
  subscribe?(listener: (change: StateSliceChange) => void): () => void;
}

/** A persisted slice payload with its schema version. */
export interface VersionedSlicePayload<TSnapshot extends JsonValue = JsonValue> {
  readonly version: number;
  readonly data: TSnapshot;
}

const SLICE_KEY = /^[a-z][a-z0-9_]*$/;
/** Keys a slice may never claim: trading state is host-owned (AD-10) and `version` is the envelope's. */
export const RESERVED_SLICE_KEYS: readonly string[] = Object.freeze(["trading", "version", "meta"]);

/**
 * Validate a slice definition and return it unchanged. Throws a TypeError that
 * names the slice and the broken field, so a malformed slice fails at
 * registration instead of producing an unreadable snapshot later.
 */
export function defineStateSlice<TSnapshot extends JsonValue>(slice: StateSlice<TSnapshot>): StateSlice<TSnapshot> {
  const issues = stateSliceIssues(slice);
  if (issues.length) {
    const name = typeof (slice as { key?: unknown })?.key === "string" ? `"${(slice as { key: string }).key}"` : "(unnamed)";
    throw new TypeError(`[raze-charts] invalid state slice ${name}: ${issues.join("; ")}`);
  }
  return slice;
}

/** Structural problems with a slice definition (empty when valid). */
export function stateSliceIssues(slice: unknown): string[] {
  if (!slice || typeof slice !== "object") return ["a slice must be an object"];
  const s = slice as Partial<StateSlice>;
  const issues: string[] = [];
  if (typeof s.key !== "string" || !SLICE_KEY.test(s.key)) {
    issues.push("key must match [a-z][a-z0-9_]*");
  } else if (RESERVED_SLICE_KEYS.includes(s.key)) {
    issues.push(`key "${s.key}" is reserved (${RESERVED_SLICE_KEYS.join(", ")})`);
  }
  if (!Number.isSafeInteger(s.version) || (s.version as number) < 1) {
    issues.push("version must be a positive integer");
  } else if ((s.version as number) > 1 && typeof s.migrate !== "function") {
    issues.push(`version ${s.version} needs migrate() to upgrade older payloads`);
  }
  if (typeof s.requiresDataReload !== "boolean") issues.push("requiresDataReload must be a boolean");
  for (const method of ["save", "validate", "apply"] as const) {
    if (typeof s[method] !== "function") issues.push(`${method}() is required`);
  }
  if (s.migrate !== undefined && typeof s.migrate !== "function") issues.push("migrate must be a function");
  if (s.subscribe !== undefined && typeof s.subscribe !== "function") issues.push("subscribe must be a function");
  return issues;
}

/**
 * Report the first non-JSON value in `value` as a StateIssue path, or null when
 * the value round-trips through JSON unchanged (finite numbers, plain objects,
 * arrays, strings, booleans, null).
 */
export function findNonJsonValue(value: unknown, path = ""): StateIssue | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : { path: path || "/", message: `${value} is not a finite number`, code: "type" };
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const issue = findNonJsonValue(value[i], `${path}/${i}`);
      if (issue) return issue;
    }
    return null;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return { path: path || "/", message: "only plain objects are serialisable", code: "type" };
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const issue = findNonJsonValue(child, `${path}/${escapePointer(key)}`);
      if (issue) return issue;
    }
    return null;
  }
  return { path: path || "/", message: `${typeof value} is not serialisable`, code: "type" };
}

function escapePointer(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}
