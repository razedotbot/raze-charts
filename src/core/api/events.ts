// Chart-level subscriptions.

import type { ISubscription, ResolutionString } from "../../types/charting_library";
import type { ChartApi } from "../ChartApi";
import { apiScope } from "./scope";

type IntervalListener = (interval: ResolutionString, timeframeObj: unknown) => void;

// One live view per chart, so repeated onIntervalChanged() calls return the
// same subscription object.
const intervalSubscriptions = new WeakMap<ChartApi, ISubscription<IntervalListener>>();

export const eventsApi = {
  onIntervalChanged(this: ChartApi): ISubscription<IntervalListener> {
    let subscription = intervalSubscriptions.get(this);
    if (!subscription) {
      const delegate = apiScope(this).context.intervalChanged;
      subscription = {
        subscribe: (obj, fn, once) => delegate.subscribe(obj, fn as never, once),
        unsubscribe: (obj, fn) => delegate.unsubscribe(obj, fn as never),
        unsubscribeAll: (obj) => delegate.unsubscribeAll(obj),
      };
      intervalSubscriptions.set(this, subscription);
    }
    return subscription;
  },
};
