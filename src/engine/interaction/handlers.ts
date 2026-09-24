// Registered interaction handlers (union-merged, append-only).
//
// Add a handler by creating a module in this directory that exports an
// InteractionHandler and appending it below. List order does not matter: the
// coordinator (../gestures.ts) runs handlers by ascending `priority` and
// rejects duplicate ids. See ./types.ts for the contract.

import { priceAxisHandler, timeAxisHandler } from "./axes";
import { drawingDraftHandler, drawingEditHandler } from "./drawing";
import { tradingHandler } from "./trading";
import type { InteractionHandler } from "./types";
import { viewportHandler } from "./viewport";

export const INTERACTION_HANDLERS: readonly InteractionHandler[] = [
  drawingDraftHandler,
  tradingHandler,
  drawingEditHandler,
  priceAxisHandler,
  timeAxisHandler,
  viewportHandler,
];
