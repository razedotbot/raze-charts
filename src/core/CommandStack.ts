export interface Command {
  undo(): void;
  redo(): void;
}

export class CommandStack {
  private undoList: Command[] = [];
  private redoList: Command[] = [];
  private executing = false;
  private enabledValue = true;
  private suppressionDepth = 0;

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

  clear(): void {
    this.undoList.length = 0;
    this.redoList.length = 0;
  }
}
