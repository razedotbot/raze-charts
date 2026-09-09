export interface Command {
  undo(): void;
  redo(): void;
}

export class CommandStack {
  private undoList: Command[] = [];
  private redoList: Command[] = [];
  enabled = true;

  push(command: Command): void {
    if (!this.enabled) return;
    this.undoList.push(command);
    this.redoList.length = 0;
  }

  undo(): boolean {
    const command = this.undoList.pop();
    if (!command) return false;
    command.undo();
    this.redoList.push(command);
    return true;
  }

  redo(): boolean {
    const command = this.redoList.pop();
    if (!command) return false;
    command.redo();
    this.undoList.push(command);
    return true;
  }

  clear(): void {
    this.undoList.length = 0;
    this.redoList.length = 0;
  }
}
