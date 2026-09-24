// The active drag: routes moves to the DragSession a handler claimed,
// commits it on the final pointer up, and cancels it on pointer cancel, when
// a pinch takes over, or on Escape. Escape is caught at the window while a
// drag is live, so it works wherever focus is, and it is consumed so it does
// not also clear the selection or the active tool. After a cancel, moves are
// ignored until every pointer is up, so nothing is re-applied on release.

import { t } from "../../i18n";
import type { DragSession, GestureHost } from "./types";

export class DragTracker {
  private session: DragSession | null = null;
  private cancelled = false;

  constructor(private readonly host: GestureHost) {}

  /** A session is live, or one was cancelled and its pointers are still down. */
  get busy(): boolean {
    return !!this.session || this.cancelled;
  }

  start(session: DragSession): void {
    this.drop();
    this.session = session;
    this.cancelled = false;
    window.addEventListener("keydown", this.onKey, true);
  }

  move(x: number, y: number): void {
    this.session?.move(x, y);
  }

  /** Every pointer is up: commit the live session. */
  end(): void {
    const session = this.session;
    this.drop();
    this.cancelled = false;
    session?.commit?.();
  }

  /** Roll the live session back. `hold` ignores later moves until every pointer is up. */
  cancel(hold = false): void {
    const session = this.session;
    this.drop();
    this.cancelled = hold && !!session;
    session?.cancel?.();
  }

  /** Forget the session without committing or rolling back (a pinch or long press took over). */
  drop(): void {
    this.session = null;
    window.removeEventListener("keydown", this.onKey, true);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !this.session) return;
    e.preventDefault();
    e.stopPropagation();
    this.cancel(true);
    this.host.requestPaint();
    this.host.engine.announce(t("chart.announce.dragCancelled", "Drag cancelled."));
  };
}
