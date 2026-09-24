// Display timezone: TradingView's ITimezoneApi plus direct shortcuts on the
// chart. The setting drives the time axis, the crosshair and session breaks
// (see src/engine/paint/axes.ts); every change repaints.

import type { ISubscription, ITimezoneApi, TimezoneInfo } from "../../types/charting_library";
import { assertTimezoneSetting, customTimezoneAliases, resolveDisplayTimeZone } from "../../engine/timeAxis";
import type { ChartApi } from "../ChartApi";
import { apiScope } from "./scope";

type TimezoneListener = (timezone: string) => void;

const subscriptions = new WeakMap<ChartApi, ISubscription<TimezoneListener>>();
const timezoneApis = new WeakMap<ChartApi, ITimezoneApi>();

/** "Buenos Aires" for "America/Argentina/Buenos_Aires". */
const cityOf = (id: string): string => id.slice(id.lastIndexOf("/") + 1).replace(/_/g, " ");

export const timezoneApi = {
  /**
   * The display timezone setting: an IANA id, "exchange" (the symbol's
   * zone, also reported when no timezone was configured) or a
   * `custom_timezones` id.
   */
  timezone(this: ChartApi): string {
    return apiScope(this).context.timezone ?? "exchange";
  },

  /**
   * Show the time axis, crosshair and session breaks in another zone. Throws
   * a RangeError naming the zone (with guidance) when it is not a known IANA
   * zone, "exchange" or a `custom_timezones` id. Repaints and fires
   * onTimezoneChanged() when the setting changes.
   */
  setTimezone(this: ChartApi, timezone: string): void {
    const { context } = apiScope(this);
    assertTimezoneSetting(timezone, context.options);
    context.setTimezone(timezone);
  },

  onTimezoneChanged(this: ChartApi): ISubscription<TimezoneListener> {
    let subscription = subscriptions.get(this);
    if (!subscription) {
      const delegate = apiScope(this).context.timezoneChanged;
      subscription = {
        subscribe: (obj, fn, once) => delegate.subscribe(obj, fn as never, once),
        unsubscribe: (obj, fn) => delegate.unsubscribe(obj, fn as never),
        unsubscribeAll: (obj) => delegate.unsubscribeAll(obj),
      };
      subscriptions.set(this, subscription);
    }
    return subscription;
  },

  /** TradingView's timezone API object for this chart. */
  getTimezoneApi(this: ChartApi): ITimezoneApi {
    let api = timezoneApis.get(this);
    if (!api) {
      const chart = this;
      const { context } = apiScope(this);
      const custom = (): TimezoneInfo[] =>
        customTimezoneAliases(context.options).map((zone) => ({ id: zone.id, title: zone.title ?? cityOf(zone.alias) }));
      api = {
        availableTimezones(): TimezoneInfo[] {
          // Intl.supportedValuesOf is ES2022; older engines list the fixed entries only.
          const intl = Intl as { supportedValuesOf?: (key: "timeZone") => string[] };
          const zones = intl.supportedValuesOf?.("timeZone") ?? [];
          return [
            { id: "exchange", title: "Exchange" },
            { id: "Etc/UTC", title: "UTC" },
            ...custom(),
            ...zones.map((id) => ({ id, title: cityOf(id) })),
          ];
        },
        getTimezone(): TimezoneInfo {
          const id = chart.timezone();
          const zone = resolveDisplayTimeZone(id, context.symbolInfo?.timezone, context.options);
          const title = id === "exchange" ? "Exchange" : custom().find((c) => c.id === id)?.title ?? cityOf(zone.id);
          return { id, title, offset: Math.round(zone.zone.offset(context.now()) / 60_000) };
        },
        setTimezone: (timezone: string) => chart.setTimezone(timezone),
        onTimezoneChanged: () => chart.onTimezoneChanged(),
      };
      timezoneApis.set(this, api);
    }
    return api;
  },
};
