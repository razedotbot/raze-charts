// Chart-level subscriptions.

import type { ISubscription, ResolutionString } from "../../types/charting_library";
import type { ChartApi } from "../ChartApi";
import { apiScope } from "./scope";

type IntervalListener = (interval: ResolutionString, timeframeObj: unknown) => void;

// One consumer view per chart, so repeated onIntervalChanged() calls return
// the same subscription object. The view only reaches host registrations: the
// widget's own listeners (header interval sync) survive unsubscribeAll(null).
const intervalSubscriptions = new WeakMap<ChartApi, ISubscription<IntervalListener>>();

export const eventsApi = {
  onIntervalChanged(this: ChartApi): ISubscription<IntervalListener> {
    let subscription = intervalSubscriptions.get(this);
    if (!subscription) {
      subscription = apiScope(this).context.intervalChanged.consumerView<IntervalListener>("onIntervalChanged");
      intervalSubscriptions.set(this, subscription);
    }
    return subscription;
  },
};
