// Registered widget controllers (union-merged, append-only).
//
// Add a controller by creating a module in this directory that implements
// WidgetController, adds its id to WidgetControllerMap (see ./host.ts) and is
// appended below. Order is significant: controllers are created, attached and
// booted in this order and destroyed in reverse, and a controller may only
// touch controllers registered before it while it is being created.

import { ActionController } from "./ActionController";
import { ApiController } from "./ApiController";
import { ChromeController } from "./ChromeController";
import { CompareController } from "./CompareController";
import { ContextMenuController } from "./ContextMenuController";
import { EventHub } from "./EventHub";
import { defineWidgetController, type WidgetControllerDefinition } from "./host";
import { LayoutController } from "./LayoutController";
import { LegendController } from "./LegendController";
import { PersistenceController } from "./PersistenceController";

export const WIDGET_CONTROLLERS: readonly WidgetControllerDefinition[] = [
  defineWidgetController("chrome", (host) => new ChromeController(host)),
  defineWidgetController("layout", (host) => new LayoutController(host)),
  defineWidgetController("api", (host) => new ApiController(host)),
  defineWidgetController("events", (host) => new EventHub(host)),
  defineWidgetController("actions", (host) => new ActionController(host)),
  defineWidgetController("compare", (host) => new CompareController(host)),
  defineWidgetController("persistence", (host) => new PersistenceController(host)),
  defineWidgetController("contextMenu", (host) => new ContextMenuController(host)),
  defineWidgetController("legend", (host) => new LegendController(host)),
];
