// Priority-ordered view of the registered interaction handlers.

import { INTERACTION_HANDLERS } from "./handlers";
import type { InteractionHandler } from "./types";

/** Sort handlers by priority and reject duplicate ids from merged registrations. */
export function orderHandlers(list: readonly InteractionHandler[]): readonly InteractionHandler[] {
  const ids = new Set<string>();
  for (const { id } of list) {
    if (ids.has(id)) throw new Error(`[raze-charts] interaction handler "${id}" is registered twice`);
    ids.add(id);
  }
  return [...list].sort((a, b) => a.priority - b.priority);
}

export const HANDLERS = orderHandlers(INTERACTION_HANDLERS);

/** Run handlers by priority until one returns a truthy result, and return it. */
export function firstHandled<T>(run: (handler: InteractionHandler) => T): T | undefined {
  for (const handler of HANDLERS) {
    const result = run(handler);
    if (result) return result;
  }
  return undefined;
}
