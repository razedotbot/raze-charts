// Per-instance id allocation (AD-10). Each widget owns one IdAllocator on its
// ChartContext, so identical operation sequences on two widgets produce
// identical ids regardless of page-wide creation order. Stores adopt it in
// wave 1B (StudyStore: W1B-15, ShapeStore/TradingStore: W1B-20); the
// `raze.idFactory` option (W2-15) injects a host factory.
//
// Ids keep the historical `<label>_<n>` shape (`shape_3`, `study_ema_2`,
// `order_5`), so snapshots saved before adoption still reserve correctly.

/**
 * Id families. Every namespace owns an independent counter; labels inside one
 * namespace share it (for example `study_ema_1`, `study_rsi_2`), matching the
 * historical module-level counters.
 */
export type IdNamespace = "shape" | "study" | "trading" | "compare" | "alert" | "pane";

/** Every namespace an allocator accepts. */
export const ID_NAMESPACES: readonly IdNamespace[] = Object.freeze([
  "shape",
  "study",
  "trading",
  "compare",
  "alert",
  "pane",
]);

/** Arguments given to a host id factory for one allocation (frozen). */
export interface IdRequest {
  readonly namespace: IdNamespace;
  /** Human-readable stem, for example `shape` or `study_ema`. */
  readonly label: string;
  /** 1-based sequence number the default factory would use. */
  readonly sequence: number;
}

/** Host-supplied id generator (the future `raze.idFactory`). Must return a non-empty string. */
export type IdFactory = (request: IdRequest) => string;

export interface IdAllocatorOptions {
  /** Replaces the default `<label>_<sequence>` format. */
  factory?: IdFactory;
  /** Upper bound on retries when candidates are taken: a positive safe integer. Defaults to 10,000. */
  maxAttempts?: number;
}

export interface NextIdOptions {
  /** Stem used by the default format. Defaults to the namespace. */
  label?: string;
  /** Returns true when a candidate collides with a live entity (retry with the next sequence). */
  isTaken?: (id: string) => boolean;
}

/**
 * Lowercase slug for a free-form label such as a study name
 * (`Bollinger Bands` -> `bollinger_bands`). Every run of characters outside
 * `[a-z0-9]` becomes one `_`, edges included, exactly like the historical
 * StudyStore ids (`MACD (12, 26)` -> `macd_12_26_`), so adopting the allocator
 * never changes the id a given name produces. Only a name with no characters
 * at all falls back to `item`, because an allocator label cannot be empty.
 */
export function idSlug(value: string): string {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "_") || "item";
}

/**
 * Deterministic, per-instance id source. Not a UUID generator: ids are stable
 * across runs for the same operation sequence, which hydration, collaboration
 * and golden tests rely on.
 */
export class IdAllocator {
  private readonly counters = new Map<IdNamespace, number>();
  private readonly factory: IdFactory | undefined;
  private readonly maxAttempts: number;

  constructor(options: IdAllocatorOptions = {}) {
    const maxAttempts = options.maxAttempts ?? 10_000;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new RangeError(
        `[raze-charts] IdAllocator maxAttempts must be a positive integer (got ${String(maxAttempts)}); omit it for the default of 10000`,
      );
    }
    this.factory = options.factory;
    this.maxAttempts = maxAttempts;
  }

  /** Allocate the next free id in `namespace`. */
  next(namespace: IdNamespace, options: NextIdOptions = {}): string {
    this.check(namespace);
    const label = options.label ?? namespace;
    if (!/^\S+$/.test(label)) {
      throw new TypeError(`[raze-charts] id label "${label}" must be non-empty without whitespace; use idSlug()`);
    }
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const sequence = this.peek(namespace) + 1;
      this.counters.set(namespace, sequence);
      const id = this.factory ? this.factory(Object.freeze({ namespace, label, sequence })) : `${label}_${sequence}`;
      if (typeof id !== "string" || !id) {
        throw new TypeError(`[raze-charts] the id factory must return a non-empty string (namespace "${namespace}")`);
      }
      if (!options.isTaken?.(id)) return id;
    }
    throw new Error(
      `[raze-charts] no free "${namespace}" id after ${this.maxAttempts} attempts; the id factory must return distinct ids per sequence`,
    );
  }

  /**
   * Record an id that entered the store from outside (load(), undo, a host
   * supplied id) so later allocations never reuse its sequence. Ids without a
   * trailing `_<n>` are accepted and leave the counter alone.
   */
  reserve(namespace: IdNamespace, id: string): void {
    this.check(namespace);
    const value = Number(/_(\d+)$/.exec(String(id))?.[1]);
    if (Number.isSafeInteger(value) && value > this.peek(namespace)) this.counters.set(namespace, value);
  }

  /** Current sequence for a namespace (0 before the first allocation). */
  peek(namespace: IdNamespace): number {
    return this.counters.get(namespace) ?? 0;
  }

  /** Forget every counter (tests and full state replacement only). */
  reset(): void {
    this.counters.clear();
  }

  private check(namespace: IdNamespace): void {
    if (!ID_NAMESPACES.includes(namespace)) {
      throw new TypeError(`[raze-charts] unknown id namespace "${namespace}". Supported namespaces: ${ID_NAMESPACES.join(", ")}`);
    }
  }
}
