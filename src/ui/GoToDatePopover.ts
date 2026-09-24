// Go-to-date popover: a themed, anchored form with a date input (plus a time
// input on intraday charts) that replaces `window.prompt`, which sandboxed
// iframes ignore and which cannot be themed or translated. Dates are read in
// the chart's display timezone. Enter submits, Escape or Cancel closes, and
// focus returns to the opener.

import { t } from "../i18n";
import { fieldsFromWall, getTimeZone, UTC_ZONE_ID, wallFromFields, type TimeZone } from "../util/time";
import { h, uid } from "./kit/dom";
import { openPopover, type PopoverHandle } from "./kit/Popover";
import { button } from "./kit/surface";
import { defineStyles, shareStyles, type StyleChunk } from "./styles";

export const GO_TO_DATE_STYLES: StyleChunk = /* @__PURE__ */ defineStyles(
  "go-to-date",
  // Inputs follow the kit field look without pulling in every kit control.
  ".raze-go-to-date{display:flex;flex-direction:column;gap:10px;min-width:240px;padding:4px}" +
  ".raze-go-to-date>b{font-size:var(--raze-font-size-lg,14px)}" +
  ".raze-go-to-date label{display:flex;align-items:center;justify-content:space-between;gap:12px}" +
  ".raze-go-to-date input{min-height:32px;min-width:10em;padding:0 10px;border:1px solid var(--raze-border,#363a45);" +
  "border-radius:var(--raze-radius,6px);background:none;color:inherit;font:inherit}" +
  ".raze-go-to-date input:hover{border-color:currentColor}" +
  ".raze-go-to-date input:focus{outline:none;border-color:var(--raze-focus,#2962ff);box-shadow:0 0 0 1px var(--raze-focus,#2962ff)}" +
  ".raze-go-to-date input[aria-invalid=true]{border-color:var(--raze-danger,#f23645)}" +
  ".raze-go-to-date p{margin:0;font-size:11px;opacity:.72}" +
  ".raze-go-to-date [role=alert]{font-size:12px;opacity:1;color:var(--raze-danger,#f23645)}" +
  ".raze-go-to-date [role=alert]:empty{display:none}" +
  ".raze-go-to-date>div{display:flex;justify-content:flex-end;gap:8px}" +
  "@media (pointer:coarse){.raze-go-to-date input{min-height:44px}}" +
  "@media (forced-colors:active){.raze-go-to-date [role=alert]{color:CanvasText}.raze-go-to-date input:focus{outline:2px solid Highlight}}",
);

export interface GoToDateOptions {
  /** The control that opened the popover; focus returns here on close. */
  anchor: HTMLElement;
  /** IANA zone the date and time are entered in (the chart's display zone). */
  timeZone: string;
  /** Show the time input (intraday resolutions). */
  includeTime: boolean;
  /** Instant (epoch ms) the inputs start at, usually the centre of the view. */
  initial?: number | null;
  /** Latest instant (epoch ms) the date picker offers. */
  max?: number | null;
  /** Widget root whose theme tokens the popover mirrors. */
  themeRoot?: Element | null;
  /** Native picker palette matching the chart theme. */
  colorScheme?: "light" | "dark";
  fontFamily?: string;
  /**
   * Navigate to `timeMs` (`label` is the entered date and time, for
   * announcements). The popover closes when it settles; a rejection keeps it
   * open with an error so the user can try again.
   */
  onSubmit(timeMs: number, label: string): void | Promise<void>;
  onClose?(): void;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/** `YYYY-MM-DD` and `HH:MM` for an instant in `zone` (the formats of date/time inputs). */
export function formatDateInputs(timeMs: number, zone: TimeZone): { date: string; time: string } {
  const wall = fieldsFromWall(zone.toWall(timeMs));
  return {
    date: `${pad(wall.year, 4)}-${pad(wall.month + 1)}-${pad(wall.day)}`,
    time: `${pad(wall.hour)}:${pad(wall.minute)}`,
  };
}

/**
 * Epoch milliseconds for a `YYYY-MM-DD` date and optional `HH:MM[:SS]` time in
 * `zone`, or null when either is not a real calendar value.
 */
export function parseDateInputs(date: string, time: string, zone: TimeZone): number | null {
  const day = /^(\d{4,6})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!day) return null;
  const year = Number(day[1]);
  const month = Number(day[2]) - 1;
  const dayOfMonth = Number(day[3]);
  let hour = 0;
  let minute = 0;
  let second = 0;
  const clock = time.trim();
  if (clock) {
    const parts = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(clock);
    if (!parts) return null;
    hour = Number(parts[1]);
    minute = Number(parts[2]);
    second = Number(parts[3] ?? 0);
    if (hour > 23 || minute > 59 || second > 59) return null;
  }
  const wall = wallFromFields(year, month, dayOfMonth, hour, minute, second);
  const check = fieldsFromWall(wall);
  // Reject overflow such as 2026-02-30 instead of silently rolling over.
  if (check.year !== year || check.month !== month || check.day !== dayOfMonth) return null;
  const utc = zone.fromWall(wall);
  return Number.isFinite(utc) ? utc : null;
}

/** A native input labelled by the <label> that wraps it. */
function inputRow(type: "date" | "time", label: string, value: string): { row: HTMLElement; input: HTMLInputElement } {
  const input = h("input", { attrs: { type, autocomplete: "off" } });
  input.value = value;
  return { row: h("label", null, label, input), input };
}

export function openGoToDatePopover(options: GoToDateOptions): PopoverHandle {
  shareStyles(GO_TO_DATE_STYLES);
  const doc = options.anchor.ownerDocument;
  let zone: TimeZone;
  try {
    zone = getTimeZone(options.timeZone);
  } catch {
    zone = getTimeZone(UTC_ZONE_ID);
  }
  const initial = options.initial != null && Number.isFinite(options.initial)
    ? formatDateInputs(options.initial, zone)
    : { date: "", time: "00:00" };

  const title = t("goToDate.title", "Go to date");
  const dateField = inputRow("date", t("goToDate.date", "Date"), initial.date);
  const dateInput = dateField.input;
  dateInput.required = true;
  if (options.max != null && Number.isFinite(options.max)) dateInput.max = formatDateInputs(options.max, zone).date;
  const timeField = options.includeTime ? inputRow("time", t("goToDate.time", "Time"), initial.time) : null;
  const timeInput = timeField?.input;
  if (timeInput) timeInput.step = "60";

  const hintId = uid("go-to-date-hint");
  const errorId = uid("go-to-date-error");
  const hint = h("p", { attrs: { id: hintId }, text: t("goToDate.zone", "Time zone: {zone}", { zone: zone.id }) });
  const error = h("p", { attrs: { id: errorId, role: "alert" } });
  const inputs = [dateInput, ...(timeInput ? [timeInput] : [])];
  for (const input of inputs) input.setAttribute("aria-describedby", hintId);

  const cancel = button(doc, t("goToDate.cancel", "Cancel"), { variant: "ghost" });
  // Not a <form>: sandboxed iframes without allow-forms never dispatch
  // `submit`, so Enter and the primary button commit directly.
  const submit = button(doc, t("goToDate.submit", "Go to"), { variant: "primary" });
  const panel = h(
    "div",
    { class: "raze-go-to-date" },
    h("b", { attrs: { "aria-hidden": "true" }, text: title }),
    dateField.row,
    timeField?.row,
    hint,
    error,
    h("div", null, cancel, submit),
  );
  if (options.colorScheme) panel.style.colorScheme = options.colorScheme;

  const setError = (message: string, invalid: HTMLInputElement | null): void => {
    error.textContent = message;
    for (const input of inputs) {
      const isInvalid = input === invalid;
      input.setAttribute("aria-invalid", String(isInvalid));
      input.setAttribute("aria-describedby", isInvalid ? `${hintId} ${errorId}` : hintId);
    }
  };

  let busy = false;
  const setBusy = (next: boolean): void => {
    busy = next;
    submit.disabled = next;
    panel.setAttribute("aria-busy", String(next));
  };

  const commit = async (): Promise<void> => {
    if (busy || handle.closed) return;
    const dateText = dateInput.value;
    const timeText = timeInput?.value ?? "";
    const timeMs = parseDateInputs(dateText, timeText, zone);
    if (timeMs === null) {
      const timeInvalid = !!timeInput && parseDateInputs(dateText, "", zone) !== null;
      if (timeInvalid) setError(t("goToDate.invalidTime", "Enter a valid time."), timeInput!);
      else if (!dateText.trim()) setError(t("goToDate.required", "Enter a date."), dateInput);
      else setError(t("goToDate.invalidDate", "Enter a valid date."), dateInput);
      (timeInvalid ? timeInput! : dateInput).focus();
      return;
    }
    setError("", null);
    setBusy(true);
    try {
      await options.onSubmit(timeMs, timeText ? `${dateText} ${timeText}` : dateText);
      handle.close({ reason: "api" });
    } catch {
      if (handle.closed) return;
      setError(t("goToDate.failed", "That date could not be loaded. Try again."), null);
      dateInput.focus();
    } finally {
      setBusy(false);
    }
  };

  submit.addEventListener("click", () => void commit());
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || event.defaultPrevented) return;
    if ((event.target as Element | null)?.tagName !== "INPUT") return;
    event.preventDefault();
    void commit();
  });
  cancel.addEventListener("click", () => handle.close({ reason: "api" }));

  const handle = openPopover({
    anchor: options.anchor,
    label: title,
    content: panel,
    role: "dialog",
    placement: "bottom-start",
    themeRoot: options.themeRoot,
    fontFamily: options.fontFamily,
    initialFocus: dateInput,
    onClose: () => options.onClose?.(),
  });
  return handle;
}
