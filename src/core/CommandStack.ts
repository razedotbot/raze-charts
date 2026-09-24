export interface Command {
  undo(): void;
  redo(): void;
}

/** Undo steps kept by default; older steps are dropped first. */
export const DEFAULT_UNDO_LIMIT = 100;

export interface CommandStackOptions {
  /**
   * Maximum number of undo steps kept (default 100). A push beyond it drops
   * the oldest step, so long sessions do not retain every snapshot forever.
   * `Infinity` disables the cap.
   */
  limit?: number;
}

export class CommandStack {
  private undoList: Command[] = [];
  private redoList: Command[] = [];
  private executing = false;
  private enabledValue = true;
  private suppressionDepth = 0;
  private limitValue = DEFAULT_UNDO_LIMIT;

  constructor(options: CommandStackOptions = {}) {
    if (options.limit !== undefined) this.limit = options.limit;
  }

  /** Maximum undo depth. Lowering it drops the oldest steps immediately. */
  get limit(): number {
    return this.limitValue;
  }

  set limit(value: number) {
    if (!(value === Infinity || (Number.isInteger(value) && value >= 1))) {
      throw new RangeError(`[raze-charts] CommandStack limit must be a positive integer or Infinity, got ${String(value)}`);
    }
    this.limitValue = value;
    this.trim();
  }

  /** Steps undo() can revert. */
  get undoDepth(): number {
    return this.undoList.length;
  }

  /** Steps redo() can re-apply. */
  get redoDepth(): number {
    return this.redoList.length;
  }

  get enabled(): boolean {
    return this.enabledValue && this.suppressionDepth === 0;
  }

  set enabled(value: boolean) {
    this.enabledValue = value;
  }

  /** Nestable suppression for overlapping asynchronous restore operations. */
  suspend(): () => void {
    this.suppressionDepth += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.suppressionDepth = Math.max(0, this.suppressionDepth - 1);
    };
  }

  push(command: Command): void {
    // Stores record their own mutations so UI, keyboard and API entry points
    // all share one history. Mutations performed by undo/redo must therefore
    // not enqueue a second, recursive command.
    if (!this.enabled || this.executing) return;
    this.undoList.push(command);
    this.redoList.length = 0;
    this.trim();
  }

  undo(): boolean {
    const command = this.undoList.pop();
    if (!command) return false;
    this.executing = true;
    try {
      command.undo();
      this.redoList.push(command);
      return true;
    } catch (error) {
      // Keep history usable when a consumer-provided study or callback throws.
      this.undoList.push(command);
      throw error;
    } finally {
      this.executing = false;
    }
  }

  redo(): boolean {
    const command = this.redoList.pop();
    if (!command) return false;
    this.executing = true;
    try {
      command.redo();
      this.undoList.push(command);
      return true;
    } catch (error) {
      this.redoList.push(command);
      throw error;
    } finally {
      this.executing = false;
    }
  }

  private trim(): void {
    const excess = this.undoList.length - this.limitValue;
    if (excess > 0) this.undoList.splice(0, excess);
  }

  clear(): void {
    this.undoList.length = 0;
    this.redoList.length = 0;
  }
}
