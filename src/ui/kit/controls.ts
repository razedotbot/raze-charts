// Labelled, keyboard-operable form controls for settings surfaces: checkbox,
// text, number stepper, select, colour swatch (with opacity), line width and
// line style. Every factory returns a `Field` whose `el` is a complete row
// (label + control) ready to append to a dialog panel.

import { t } from "../../i18n";
import { adoptStyles, defineStyles, shareStyles, type StyleChunk } from "../styles";
import { uid } from "./dom";
import { openPopover, type PopoverHandle } from "./Popover";
import { ICON_MINUS, ICON_PLUS, iconButton, SURFACE_STYLES } from "./surface";

export const CONTROL_STYLES: StyleChunk = /* @__PURE__ */ defineStyles(
  "kit-controls",
  ".raze-kit-field{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;min-height:var(--raze-row-height,32px)}" +
  ".raze-kit-field>label,.raze-kit-field-label{min-width:0}" +
  ".raze-kit-field[data-kind=checkbox]{grid-template-columns:auto minmax(0,1fr);gap:10px}" +
  ".raze-kit-field[data-kind=checkbox] label{cursor:pointer}" +
  ".raze-kit-checkbox{width:16px;height:16px;margin:0;accent-color:var(--raze-accent,#2962ff);cursor:pointer}" +
  ".raze-kit-input,.raze-kit-select{min-height:32px;padding:0 10px;border:1px solid var(--raze-border,#363a45);border-radius:var(--raze-radius,6px);" +
  "background:transparent;color:inherit;font:inherit;min-width:0}" +
  ".raze-kit-select{padding-right:8px;background:var(--raze-surface,#1e222d)}" +
  ".raze-kit-input:hover,.raze-kit-select:hover{border-color:currentColor}" +
  ".raze-kit-input:focus,.raze-kit-select:focus{outline:none;border-color:var(--raze-focus,#2962ff);box-shadow:0 0 0 1px var(--raze-focus,#2962ff)}" +
  ".raze-kit-input[aria-invalid=true]{border-color:var(--raze-danger,#f23645)}" +
  ".raze-kit-input:disabled,.raze-kit-select:disabled,.raze-kit-checkbox:disabled{opacity:.5;cursor:default}" +
  ".raze-kit-stepper{display:inline-flex;align-items:center;border:1px solid var(--raze-border,#363a45);border-radius:var(--raze-radius,6px)}" +
  ".raze-kit-stepper:focus-within{border-color:var(--raze-focus,#2962ff);box-shadow:0 0 0 1px var(--raze-focus,#2962ff)}" +
  ".raze-kit-stepper .raze-kit-input{border:0;box-shadow:none;width:6.5em;text-align:end;padding:0 4px}" +
  ".raze-kit-stepper .raze-kit-icon-button{width:28px;height:30px}" +
  ".raze-kit-unit{padding-inline-end:6px;opacity:.72}" +
  ".raze-kit-segmented{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--raze-border,#363a45);border-radius:var(--raze-radius,6px)}" +
  ".raze-kit-segment{display:inline-flex;align-items:center;justify-content:center;width:36px;height:28px;padding:0;border:0;" +
  "border-radius:var(--raze-radius-sm,4px);background:transparent;color:inherit;cursor:pointer}" +
  ".raze-kit-segment:hover{background:var(--raze-hover,rgba(255,255,255,.08))}" +
  ".raze-kit-segment[aria-checked=true]{background:var(--raze-active,rgba(41,98,255,.18));color:var(--raze-accent,#2962ff)}" +
  ".raze-kit-segment:focus{outline:none}" +
  ".raze-kit-segment:focus-visible{outline:2px solid var(--raze-focus,#2962ff);outline-offset:-2px}" +
  ".raze-kit-line{display:block;width:22px;border-top:var(--raze-line-width,1px) var(--raze-line-style,solid) currentColor}" +
  ".raze-kit-swatch-button{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:3px;" +
  "border:1px solid var(--raze-border,#363a45);border-radius:var(--raze-radius,6px);background:transparent;cursor:pointer}" +
  ".raze-kit-swatch-button:focus{outline:none}" +
  ".raze-kit-swatch-button:focus-visible,.raze-kit-swatch:focus-visible{outline:2px solid var(--raze-focus,#2962ff);outline-offset:1px}" +
  ".raze-kit-swatch-chip,.raze-kit-swatch{display:block;width:100%;height:100%;border-radius:var(--raze-radius-sm,4px);" +
  "background-image:linear-gradient(var(--raze-swatch),var(--raze-swatch)),conic-gradient(#c7c7c7 25%,#fff 0 50%,#c7c7c7 0 75%,#fff 0);" +
  "background-size:auto,8px 8px}" +
  ".raze-kit-palette{display:grid;grid-template-columns:repeat(10,20px);gap:4px}" +
  ".raze-kit-swatch{width:20px;height:20px;padding:0;border:1px solid rgba(127,127,127,.35);cursor:pointer}" +
  ".raze-kit-swatch[aria-selected=true]{box-shadow:0 0 0 2px var(--raze-surface,#1e222d),0 0 0 4px var(--raze-accent,#2962ff)}" +
  ".raze-kit-color-panel{display:flex;flex-direction:column;gap:12px;padding:4px}" +
  ".raze-kit-color-row{display:flex;align-items:center;gap:8px}" +
  ".raze-kit-color-row .raze-kit-input{flex:1 1 auto;width:7em}" +
  ".raze-kit-range{flex:1 1 auto;accent-color:var(--raze-accent,#2962ff)}" +
  ".raze-kit-output{min-width:3.2em;text-align:end;font-variant-numeric:tabular-nums}" +
  ".raze-kit-sheet-content .raze-kit-palette{grid-template-columns:repeat(10,minmax(24px,1fr))}" +
  ".raze-kit-sheet-content .raze-kit-swatch{width:auto;height:auto;aspect-ratio:1}" +
  "@media (pointer:coarse){.raze-kit-input,.raze-kit-select{min-height:44px}.raze-kit-segment{width:44px;height:40px}.raze-kit-swatch-button{width:44px;height:44px}}" +
  "@media (forced-colors:active){.raze-kit-segment[aria-checked=true]{outline:2px solid Highlight}.raze-kit-swatch[aria-selected=true]{outline:2px solid Highlight}}",
);

export interface Field<T> {
  /** Complete labelled row. */
  readonly el: HTMLElement;
  /** The focusable control. */
  readonly control: HTMLElement;
  /** Current value. Setting it does not fire `onChange`. */
  value: T;
  setDisabled(disabled: boolean): void;
}

interface FieldBase<T> {
  label: string;
  value: T;
  onChange?(value: T): void;
  disabled?: boolean;
}

/** Adopt control styles into the root that will render `node`. */
export function adoptControlStyles(node: Node): void {
  // Shared chunks are also adopted by every kit portal, so fields rendered
  // into a dialog inside a shadow root or fullscreen element are styled.
  shareStyles(SURFACE_STYLES);
  shareStyles(CONTROL_STYLES);
  adoptStyles(node, [SURFACE_STYLES, CONTROL_STYLES]);
}

function row(kind: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = "raze-kit-field";
  element.dataset.kind = kind;
  adoptControlStyles(element);
  return element;
}

function labelFor(control: HTMLElement, text: string): HTMLLabelElement {
  if (!control.id) control.id = uid("field");
  const label = document.createElement("label");
  label.htmlFor = control.id;
  label.textContent = text;
  return label;
}

function emit<T>(options: FieldBase<T>, value: T): void {
  try {
    options.onChange?.(value);
  } catch (error) {
    console.error(`[raze-charts] onChange for "${options.label}" threw.`, error);
  }
}

// ── Checkbox ──────────────────────────────────────────────────────────────

export function checkboxField(options: FieldBase<boolean>): Field<boolean> {
  const el = row("checkbox");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "raze-kit-checkbox";
  input.checked = options.value;
  input.disabled = !!options.disabled;
  input.addEventListener("change", () => emit(options, input.checked));
  el.append(input, labelFor(input, options.label));
  return {
    el,
    control: input,
    get value() {
      return input.checked;
    },
    set value(next) {
      input.checked = next;
    },
    setDisabled(disabled) {
      input.disabled = disabled;
    },
  };
}

// ── Text ──────────────────────────────────────────────────────────────────

export interface TextFieldOptions extends FieldBase<string> {
  type?: "text" | "search" | "url" | "date" | "time" | "datetime-local";
  placeholder?: string;
  maxLength?: number;
  /** Fires on every keystroke when true; otherwise on commit (blur/Enter). */
  live?: boolean;
}

export function textField(options: TextFieldOptions): Field<string> {
  const el = row("text");
  const input = document.createElement("input");
  input.type = options.type ?? "text";
  input.className = "raze-kit-input";
  input.value = options.value;
  input.disabled = !!options.disabled;
  input.autocomplete = "off";
  input.spellcheck = false;
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.maxLength) input.maxLength = options.maxLength;
  input.addEventListener(options.live ? "input" : "change", () => emit(options, input.value));
  el.append(labelFor(input, options.label), input);
  return {
    el,
    control: input,
    get value() {
      return input.value;
    },
    set value(next) {
      input.value = next;
    },
    setDisabled(disabled) {
      input.disabled = disabled;
    },
  };
}

// ── Number stepper ────────────────────────────────────────────────────────

export interface NumberFieldOptions extends FieldBase<number> {
  min?: number;
  max?: number;
  step?: number;
  /** Decimal places shown (default: derived from `step`). */
  precision?: number;
  /** Unit suffix, e.g. "px" or "%". */
  unit?: string;
}

function decimalsOf(step: number): number {
  const text = String(step);
  const exponent = /e-(\d+)$/.exec(text);
  if (exponent) return Number(exponent[1]);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** Parse user input, accepting a comma decimal separator. */
export function parseNumberInput(text: string): number | null {
  let normalized = text.trim().replace(/[\s  ]/g, "").replace(/−/g, "-");
  if (normalized.includes(",") && !normalized.includes(".")) normalized = normalized.replace(",", ".");
  else normalized = normalized.replace(/,/g, "");
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export function numberField(options: NumberFieldOptions): Field<number> {
  const el = row("number");
  const step = options.step && options.step > 0 ? options.step : 1;
  const precision = options.precision ?? decimalsOf(step);
  const min = options.min ?? -Infinity;
  const max = options.max ?? Infinity;
  const clampValue = (value: number): number => {
    const rounded = Number(value.toFixed(precision));
    return Math.min(max, Math.max(min, rounded));
  };
  let current = clampValue(options.value);

  const group = document.createElement("div");
  group.className = "raze-kit-stepper";
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = precision > 0 ? "decimal" : "numeric";
  input.className = "raze-kit-input";
  input.autocomplete = "off";
  input.setAttribute("role", "spinbutton");
  if (Number.isFinite(min)) input.setAttribute("aria-valuemin", String(min));
  if (Number.isFinite(max)) input.setAttribute("aria-valuemax", String(max));
  const decrease = iconButton(document, t("kit.number.decrease", "Decrease {label}", { label: options.label }), ICON_MINUS);
  const increase = iconButton(document, t("kit.number.increase", "Increase {label}", { label: options.label }), ICON_PLUS);
  decrease.tabIndex = -1;
  increase.tabIndex = -1;

  const render = (): void => {
    const text = current.toFixed(precision);
    input.value = text;
    input.setAttribute("aria-valuenow", String(current));
    input.setAttribute("aria-valuetext", options.unit ? `${text} ${options.unit}` : text);
    input.removeAttribute("aria-invalid");
    decrease.disabled = input.disabled || current <= min;
    increase.disabled = input.disabled || current >= max;
  };
  const commit = (value: number): void => {
    const next = clampValue(value);
    const changed = next !== current;
    current = next;
    render();
    if (changed) emit(options, current);
  };
  const commitText = (): void => {
    const parsed = parseNumberInput(input.value);
    if (parsed === null) render();
    else commit(parsed);
  };

  input.addEventListener("input", () => {
    input.setAttribute("aria-invalid", String(parseNumberInput(input.value) === null));
  });
  input.addEventListener("change", commitText);
  input.addEventListener("keydown", (event) => {
    let next: number | null = null;
    if (event.key === "ArrowUp") next = current + step;
    else if (event.key === "ArrowDown") next = current - step;
    else if (event.key === "PageUp") next = current + step * 10;
    else if (event.key === "PageDown") next = current - step * 10;
    else if (event.key === "Home" && Number.isFinite(min)) next = min;
    else if (event.key === "End" && Number.isFinite(max)) next = max;
    else if (event.key === "Enter") commitText();
    if (next === null) return;
    event.preventDefault();
    commit(next);
  });

  // Press-and-hold repeats, like native spinners.
  const repeat = (target: HTMLButtonElement, delta: number): void => {
    let timer = 0;
    const stop = (): void => {
      window.clearTimeout(timer);
      timer = 0;
    };
    target.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || target.disabled) return;
      event.preventDefault(); // keep focus in the input
      commit(current + delta);
      const tick = (delay: number): void => {
        timer = window.setTimeout(() => {
          if (target.disabled) return stop();
          commit(current + delta);
          tick(60);
        }, delay);
      };
      tick(400);
    });
    for (const type of ["pointerup", "pointerleave", "pointercancel"] as const) target.addEventListener(type, stop);
    // Keyboard/assistive activation of the (non-tabbable) buttons.
    target.addEventListener("click", (event) => {
      if (event.detail === 0) commit(current + delta);
    });
  };
  repeat(decrease, -step);
  repeat(increase, step);

  group.append(decrease, input);
  if (options.unit) {
    const unit = document.createElement("span");
    unit.className = "raze-kit-unit";
    unit.setAttribute("aria-hidden", "true");
    unit.textContent = options.unit;
    group.append(unit);
  }
  group.append(increase);
  input.disabled = !!options.disabled;
  render();
  el.append(labelFor(input, options.label), group);
  return {
    el,
    control: input,
    get value() {
      return current;
    },
    set value(next) {
      current = clampValue(next);
      render();
    },
    setDisabled(disabled) {
      input.disabled = disabled;
      render();
    },
  };
}

// ── Select ────────────────────────────────────────────────────────────────

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectFieldOptions<T extends string> extends FieldBase<T> {
  options: readonly SelectOption<T>[];
}

export function selectField<T extends string>(options: SelectFieldOptions<T>): Field<T> {
  if (!options.options.some((option) => option.value === options.value)) {
    throw new RangeError(
      `[raze-charts] selectField("${options.label}") value "${options.value}" is not one of: ${options.options.map((option) => option.value).join(", ")}.`,
    );
  }
  const el = row("select");
  const select = document.createElement("select");
  select.className = "raze-kit-select";
  for (const option of options.options) {
    const element = document.createElement("option");
    element.value = option.value;
    element.textContent = option.label;
    element.disabled = !!option.disabled;
    select.appendChild(element);
  }
  select.value = options.value;
  select.disabled = !!options.disabled;
  select.addEventListener("change", () => emit(options, select.value as T));
  el.append(labelFor(select, options.label), select);
  return {
    el,
    control: select,
    get value() {
      return select.value as T;
    },
    set value(next) {
      select.value = next;
    },
    setDisabled(disabled) {
      select.disabled = disabled;
    },
  };
}

// ── Segmented radio group (line width / line style) ───────────────────────

interface SegmentOption<T> {
  value: T;
  label: string;
  render(target: HTMLElement): void;
}

function segmentedField<T>(kind: string, options: FieldBase<T>, segments: readonly SegmentOption<T>[]): Field<T> {
  const el = row(kind);
  const labelId = uid("field-label");
  const label = document.createElement("span");
  label.className = "raze-kit-field-label";
  label.id = labelId;
  label.textContent = options.label;
  const group = document.createElement("div");
  group.className = "raze-kit-segmented";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-labelledby", labelId);
  let current = options.value;
  let disabled = !!options.disabled;
  const buttons: HTMLButtonElement[] = [];

  const sync = (): void => {
    const selected = Math.max(0, segments.findIndex((segment) => segment.value === current));
    buttons.forEach((segmentButton, index) => {
      segmentButton.setAttribute("aria-checked", String(index === selected));
      segmentButton.tabIndex = index === selected ? 0 : -1;
      segmentButton.disabled = disabled;
    });
  };
  const choose = (index: number, focus: boolean): void => {
    const segment = segments[index];
    if (!segment) return;
    const changed = segment.value !== current;
    current = segment.value;
    sync();
    if (focus) buttons[index]!.focus();
    if (changed) emit(options, current);
  };

  segments.forEach((segment, index) => {
    const segmentButton = document.createElement("button");
    segmentButton.type = "button";
    segmentButton.className = "raze-kit-segment";
    segmentButton.setAttribute("role", "radio");
    segmentButton.setAttribute("aria-label", segment.label);
    segment.render(segmentButton);
    segmentButton.addEventListener("click", () => choose(index, false));
    buttons.push(segmentButton);
    group.appendChild(segmentButton);
  });
  group.addEventListener("keydown", (event) => {
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const rtl = getComputedStyle(group).direction === "rtl";
    let next = -1;
    if (event.key === "ArrowDown" || event.key === (rtl ? "ArrowLeft" : "ArrowRight")) next = (index + 1) % buttons.length;
    else if (event.key === "ArrowUp" || event.key === (rtl ? "ArrowRight" : "ArrowLeft")) next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    if (next < 0) return;
    event.preventDefault();
    choose(next, true);
  });
  sync();
  el.append(label, group);
  return {
    el,
    control: group,
    get value() {
      return current;
    },
    set value(next) {
      current = next;
      sync();
    },
    setDisabled(next) {
      disabled = next;
      sync();
    },
  };
}

function lineSample(width: number, style: LineStyleValue): (target: HTMLElement) => void {
  return (target) => {
    const line = document.createElement("span");
    line.className = "raze-kit-line";
    line.setAttribute("aria-hidden", "true");
    line.style.setProperty("--raze-line-width", `${width}px`);
    line.style.setProperty("--raze-line-style", style);
    target.appendChild(line);
  };
}

export interface LineWidthFieldOptions extends FieldBase<number> {
  /** Offered widths in CSS px (default 1–4). */
  widths?: readonly number[];
}

export function lineWidthField(options: LineWidthFieldOptions): Field<number> {
  const widths = options.widths ?? [1, 2, 3, 4];
  return segmentedField("line-width", options, widths.map((width) => ({
    value: width,
    label: t("kit.line.width", "{width}px", { width }),
    render: lineSample(width, "solid"),
  })));
}

export type LineStyleValue = "solid" | "dashed" | "dotted";

export function lineStyleField(options: FieldBase<LineStyleValue>): Field<LineStyleValue> {
  return segmentedField("line-style", options, [
    { value: "solid", label: t("kit.line.solid", "Solid"), render: lineSample(2, "solid") },
    { value: "dashed", label: t("kit.line.dashed", "Dashed"), render: lineSample(2, "dashed") },
    { value: "dotted", label: t("kit.line.dotted", "Dotted"), render: lineSample(2, "dotted") },
  ]);
}

// ── Colour ────────────────────────────────────────────────────────────────

export interface ColorValue {
  /** `#rrggbb`. */
  color: string;
  /** 0–1. */
  opacity: number;
}

/** Default palette: greys, then saturated hues and two tint rows. */
export const DEFAULT_PALETTE: readonly string[] = [
  "#ffffff", "#d1d4dc", "#b2b5be", "#9598a1", "#787b86", "#5d606b", "#434651", "#2a2e39", "#131722", "#000000",
  "#f23645", "#ff9800", "#ffeb3b", "#4caf50", "#089981", "#00bcd4", "#2962ff", "#673ab7", "#9c27b0", "#e91e63",
  "#fccbcd", "#ffe0b2", "#fff9c4", "#c8e6c9", "#ace5dc", "#b2ebf2", "#bbd9fb", "#d1c4e9", "#e1bee7", "#f8bbd0",
  "#b22833", "#f57c00", "#fbc02d", "#388e3c", "#056656", "#0097a7", "#1848cc", "#512da8", "#7b1fa2", "#c2185b",
];

/** Parse `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` or `rgba()` into a colour value. */
export function parseColor(input: string): ColorValue | null {
  const text = input.trim().toLowerCase();
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex) {
    let digits = hex[1]!;
    if (digits.length === 3) digits = digits.split("").map((digit) => digit + digit).join("");
    const opacity = digits.length === 8 ? parseInt(digits.slice(6), 16) / 255 : 1;
    return { color: `#${digits.slice(0, 6)}`, opacity: Math.round(opacity * 100) / 100 };
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(text);
  if (rgb) {
    const channels = rgb.slice(1, 4).map(Number);
    if (channels.some((channel) => channel > 255)) return null;
    const alphaText = rgb[4];
    let opacity = alphaText === undefined ? 1 : alphaText.endsWith("%") ? parseFloat(alphaText) / 100 : parseFloat(alphaText);
    if (!Number.isFinite(opacity)) return null;
    opacity = Math.min(1, Math.max(0, opacity));
    return { color: `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`, opacity };
  }
  return null;
}

/** CSS colour for a value (`#rrggbb` when opaque, otherwise `rgba()`). */
export function toCssColor(value: ColorValue): string {
  const opacity = Math.min(1, Math.max(0, value.opacity));
  if (opacity >= 1) return value.color;
  const channel = (offset: number): number => parseInt(value.color.slice(offset, offset + 2), 16);
  return `rgba(${channel(1)},${channel(3)},${channel(5)},${Math.round(opacity * 100) / 100})`;
}

export interface ColorFieldOptions extends FieldBase<ColorValue> {
  palette?: readonly string[];
  /** Hide the opacity slider (default shown). */
  opacity?: boolean;
}

export function colorField(options: ColorFieldOptions): Field<ColorValue> {
  const initial = parseColor(options.value.color);
  if (!initial) {
    throw new TypeError(`[raze-charts] colorField("${options.label}") expects a hex or rgb() colour, got "${options.value.color}".`);
  }
  let current: ColorValue = { color: initial.color, opacity: options.value.opacity ?? initial.opacity };
  const palette = options.palette ?? DEFAULT_PALETTE;
  const el = row("color");
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "raze-kit-swatch-button";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  const chip = document.createElement("span");
  chip.className = "raze-kit-swatch-chip";
  chip.setAttribute("aria-hidden", "true");
  trigger.appendChild(chip);
  const label = labelFor(trigger, options.label);
  let popover: PopoverHandle | null = null;

  // The current value is part of the button's description so screen readers
  // announce "Line colour, button, #2962ff, 80% opacity".
  const description = document.createElement("span");
  description.className = "raze-kit-visually-hidden";
  description.id = uid("color-value");
  trigger.setAttribute("aria-describedby", description.id);
  trigger.appendChild(description);
  const sync = (): void => {
    chip.style.setProperty("--raze-swatch", toCssColor(current));
    description.textContent = t("kit.color.value", "{color}, {opacity}% opacity", {
      color: current.color,
      opacity: Math.round(current.opacity * 100),
    });
  };
  const update = (next: ColorValue): void => {
    const changed = next.color !== current.color || next.opacity !== current.opacity;
    current = next;
    sync();
    if (changed) emit(options, { ...current });
  };

  const open = (): void => {
    popover = openPopover({
      anchor: trigger,
      label: options.label,
      placement: "bottom-start",
      content: (surface) => buildColorPanel(surface, palette, () => current, update, options.opacity !== false, () => popover?.close()),
      onClose: () => {
        popover = null;
      },
    });
  };
  trigger.addEventListener("click", () => {
    if (popover) popover.close();
    else open();
  });
  trigger.disabled = !!options.disabled;
  sync();
  el.append(label, trigger);
  return {
    el,
    control: trigger,
    get value() {
      return { ...current };
    },
    set value(next) {
      const parsed = parseColor(next.color);
      if (!parsed) throw new TypeError(`[raze-charts] invalid colour "${next.color}".`);
      current = { color: parsed.color, opacity: next.opacity ?? parsed.opacity };
      sync();
    },
    setDisabled(disabled) {
      trigger.disabled = disabled;
      if (disabled) popover?.close({ restoreFocus: false });
    },
  };
}

function buildColorPanel(
  surface: HTMLElement,
  palette: readonly string[],
  read: () => ColorValue,
  write: (value: ColorValue) => void,
  withOpacity: boolean,
  close: () => void,
): void {
  const panel = document.createElement("div");
  panel.className = "raze-kit-color-panel";
  adoptControlStyles(surface);

  const grid = document.createElement("div");
  grid.className = "raze-kit-palette";
  grid.setAttribute("role", "listbox");
  grid.setAttribute("aria-label", t("kit.color.palette", "Palette"));
  const swatches: HTMLElement[] = [];
  const columns = 10;
  const syncSelection = (): void => {
    const selected = read().color;
    let focusable = swatches.findIndex((swatch) => swatch.dataset.color === selected);
    if (focusable < 0) focusable = 0;
    swatches.forEach((swatch, index) => {
      swatch.setAttribute("aria-selected", String(swatch.dataset.color === selected));
      swatch.tabIndex = index === focusable ? 0 : -1;
    });
  };
  palette.forEach((color, index) => {
    const swatch = document.createElement("div");
    swatch.className = "raze-kit-swatch";
    swatch.setAttribute("role", "option");
    swatch.setAttribute("aria-label", color);
    swatch.dataset.color = color;
    swatch.style.setProperty("--raze-swatch", color);
    swatch.addEventListener("click", () => {
      write({ color, opacity: read().opacity });
      syncSelection();
      hex.value = color;
      swatch.focus();
    });
    swatch.addEventListener("keydown", (event) => {
      let next = -1;
      if (event.key === "ArrowRight") next = index + 1;
      else if (event.key === "ArrowLeft") next = index - 1;
      else if (event.key === "ArrowDown") next = index + columns;
      else if (event.key === "ArrowUp") next = index - columns;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = swatches.length - 1;
      else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        swatch.click();
        if (event.key === "Enter") close();
        return;
      }
      if (next < 0 || next >= swatches.length) return;
      event.preventDefault();
      swatches.forEach((item, itemIndex) => {
        item.tabIndex = itemIndex === next ? 0 : -1;
      });
      swatches[next]!.focus();
    });
    swatches.push(swatch);
    grid.appendChild(swatch);
  });
  syncSelection();

  const hexRow = document.createElement("div");
  hexRow.className = "raze-kit-color-row";
  const hex = document.createElement("input");
  hex.type = "text";
  hex.className = "raze-kit-input";
  hex.id = uid("color-hex");
  hex.value = read().color;
  hex.autocomplete = "off";
  hex.spellcheck = false;
  const hexLabel = document.createElement("label");
  hexLabel.htmlFor = hex.id;
  hexLabel.textContent = t("kit.color.custom", "Custom");
  const commitHex = (): void => {
    const parsed = parseColor(hex.value);
    if (!parsed) {
      hex.setAttribute("aria-invalid", "true");
      return;
    }
    hex.removeAttribute("aria-invalid");
    write({ color: parsed.color, opacity: parsed.opacity < 1 ? parsed.opacity : read().opacity });
    hex.value = parsed.color;
    syncSelection();
    if (range) {
      range.value = String(Math.round(read().opacity * 100));
      syncRange();
    }
  };
  hex.addEventListener("change", commitHex);
  hex.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitHex();
    }
  });
  hexRow.append(hexLabel, hex);

  let range: HTMLInputElement | null = null;
  const output = document.createElement("span");
  const syncRange = (): void => {
    if (!range) return;
    const percent = `${range.value}%`;
    output.textContent = percent;
    range.setAttribute("aria-valuetext", percent);
  };
  panel.append(grid, hexRow);
  if (withOpacity) {
    const opacityRow = document.createElement("div");
    opacityRow.className = "raze-kit-color-row";
    range = document.createElement("input");
    range.type = "range";
    range.className = "raze-kit-range";
    range.id = uid("color-opacity");
    range.min = "0";
    range.max = "100";
    range.step = "1";
    range.value = String(Math.round(read().opacity * 100));
    const opacityLabel = document.createElement("label");
    opacityLabel.htmlFor = range.id;
    opacityLabel.textContent = t("kit.color.opacity", "Opacity");
    output.className = "raze-kit-output";
    output.setAttribute("aria-hidden", "true");
    const slider = range;
    slider.addEventListener("input", () => {
      syncRange();
      write({ color: read().color, opacity: Number(slider.value) / 100 });
    });
    syncRange();
    opacityRow.append(opacityLabel, slider, output);
    panel.append(opacityRow);
  }
  surface.appendChild(panel);
}
