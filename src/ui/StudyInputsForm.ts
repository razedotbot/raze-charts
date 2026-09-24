// Schema-driven study inputs form: one kit control per declared input
// (number stepper, checkbox, select, colour swatch, text or UTC date-time),
// grouped into labelled fieldsets by `group` and laid out on shared rows by
// `inline`. Values are resolved through the same rules as createStudy()
// (defaults, clamping, documented errors), so what the form commits is what
// the store accepts. The study settings dialog renders this form in its
// Inputs tab; hosts can also mount it in their own UI.

import { t } from "../i18n";
import type { StudyInputPrimitive, StudyInputSchema, StudySource } from "../types/charting_library";
import { checkboxField, colorField, numberField, parseColor, selectField, textField, toCssColor, type Field } from "./kit/controls";
import { uid } from "./kit/dom";
import { attachTooltip, type TooltipHandle } from "./kit/Tooltip";
import { adoptStyles, defineStyles } from "./styles";
import {
  normalizeInputSchema,
  resolveStudyInputs,
  studyInputFields,
  type StudyInputField,
} from "../studies/inputs";

const FORM_STYLES = /* @__PURE__ */ defineStyles(
  "study-inputs-form",
  ".raze-study-inputs{display:flex;flex-direction:column;gap:8px;min-width:0}" +
  ".raze-study-inputs-group{margin:4px 0 0;padding:0;border:0;display:flex;flex-direction:column;gap:8px;min-width:0}" +
  ".raze-study-inputs-group>legend{padding:0 0 4px;font-size:.85em;font-weight:600;letter-spacing:.02em;" +
  "text-transform:uppercase;color:var(--raze-text-muted,currentColor);opacity:.8}" +
  ".raze-study-inputs-inline{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}" +
  ".raze-study-inputs-inline>.raze-kit-field{flex:1 1 12em}" +
  ".raze-study-inputs-error{margin:0;color:var(--raze-danger,#f23645);font-size:.9em}" +
  ".raze-study-inputs-error:empty{display:none}",
);

export interface StudyInputsFormOptions {
  /** Study name used in error messages. */
  study: string;
  schema: StudyInputSchema;
  /** Current values; missing inputs show their defaults. */
  values?: Readonly<Record<string, unknown>>;
  /** Called with the full resolved value set after every committed change. */
  onChange?(values: Readonly<Record<string, StudyInputPrimitive>>, id: string): void;
}

export interface StudyInputsForm {
  readonly el: HTMLElement;
  /** Current resolved values. */
  readonly values: Readonly<Record<string, StudyInputPrimitive>>;
  /** Show different values without firing onChange (for example after undo). */
  setValues(values: Readonly<Record<string, unknown>>): void;
  /** Restore every input to its declared default and fire onChange once. */
  reset(): void;
  /** Focus the first control. */
  focus(): void;
  destroy(): void;
}

const SOURCE_TITLES: () => Record<StudySource, string> = () => ({
  open: t("studies.source.open", "Open"),
  high: t("studies.source.high", "High"),
  low: t("studies.source.low", "Low"),
  close: t("studies.source.close", "Close"),
  hl2: t("studies.source.hl2", "(H + L)/2"),
  hlc3: t("studies.source.hlc3", "(H + L + C)/3"),
  ohlc4: t("studies.source.ohlc4", "(O + H + L + C)/4"),
  hlcc4: t("studies.source.hlcc4", "(H + L + C + C)/4"),
  volume: t("studies.source.volume", "Volume"),
});

/** `datetime-local` text in UTC for Unix seconds, and back. */
function secondsToUtcInput(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 16);
}
function utcInputToSeconds(text: string): number | null {
  const ms = Date.parse(`${text}:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

interface Control {
  readonly field: StudyInputField;
  readonly ui: Field<unknown>;
  show(value: StudyInputPrimitive): void;
}

export function createStudyInputsForm(options: StudyInputsFormOptions): StudyInputsForm {
  const schema = normalizeInputSchema(options.schema, options.study);
  let values: Readonly<Record<string, StudyInputPrimitive>> = resolveStudyInputs(schema, options.values, options.study);
  const el = document.createElement("div");
  el.className = "raze-study-inputs";
  adoptStyles(el, FORM_STYLES);
  const error = document.createElement("p");
  error.className = "raze-study-inputs-error";
  error.setAttribute("role", "alert");
  error.id = uid("study-inputs-error");
  const controls: Control[] = [];
  const tooltips: TooltipHandle[] = [];

  const commit = (id: string, raw: unknown, control: Control): void => {
    try {
      values = resolveStudyInputs(schema, { ...values, [id]: raw }, options.study);
    } catch (reason) {
      control.ui.control.setAttribute("aria-invalid", "true");
      control.ui.control.setAttribute("aria-errormessage", error.id);
      error.textContent = reason instanceof Error ? reason.message.replace(/^\[raze-charts\] /, "") : String(reason);
      return;
    }
    control.ui.control.removeAttribute("aria-invalid");
    control.ui.control.removeAttribute("aria-errormessage");
    error.textContent = "";
    // Clamped or coerced values are shown as stored.
    control.show(values[id]!);
    options.onChange?.(values, id);
  };

  const build = (field: StudyInputField): Control => {
    const label = field.title;
    let control: Control;
    const self = (): Control => control;
    switch (field.control) {
      case "number": {
        const ui = numberField({
          label,
          value: field.value as number,
          ...(field.min !== undefined ? { min: field.min } : {}),
          ...(field.max !== undefined ? { max: field.max } : {}),
          ...(field.step !== undefined ? { step: field.step } : {}),
          ...(field.precision !== undefined ? { precision: field.precision } : {}),
          onChange: (next) => commit(field.id, next, self()),
        });
        control = { field, ui: ui as Field<unknown>, show: (value) => { ui.value = value as number; } };
        break;
      }
      case "checkbox": {
        const ui = checkboxField({ label, value: field.value === true, onChange: (next) => commit(field.id, next, self()) });
        control = { field, ui: ui as Field<unknown>, show: (value) => { ui.value = value === true; } };
        break;
      }
      case "select": {
        const titles = field.type === "source" ? SOURCE_TITLES() : null;
        const ui = selectField({
          label,
          value: String(field.value),
          options: (field.options ?? []).map((option) => ({
            value: option.value,
            label: titles?.[option.value as StudySource] ?? option.title,
          })),
          onChange: (next) => commit(field.id, next, self()),
        });
        control = { field, ui: ui as Field<unknown>, show: (value) => { ui.value = String(value); } };
        break;
      }
      case "color": {
        const parsed = parseColor(String(field.value));
        if (parsed) {
          const ui = colorField({ label, value: parsed, onChange: (next) => commit(field.id, toCssColor(next), self()) });
          control = {
            field,
            ui: ui as Field<unknown>,
            show: (value) => { const next = parseColor(String(value)); if (next) ui.value = next; },
          };
          break;
        }
        // Named or hsl() colours keep a text field so they stay editable.
        const ui = textField({ label, value: String(field.value), onChange: (next) => commit(field.id, next, self()) });
        control = { field, ui: ui as Field<unknown>, show: (value) => { ui.value = String(value); } };
        break;
      }
      case "datetime": {
        const ui = textField({
          label: t("studies.inputs.utcTime", "{label} (UTC)", { label }),
          type: "datetime-local",
          value: secondsToUtcInput(field.value as number),
          onChange: (next) => {
            const seconds = utcInputToSeconds(next);
            commit(field.id, seconds ?? next, self());
          },
        });
        control = { field, ui: ui as Field<unknown>, show: (value) => { ui.value = secondsToUtcInput(value as number); } };
        break;
      }
      default: {
        const ui = textField({ label, value: String(field.value), onChange: (next) => commit(field.id, next, self()) });
        control = { field, ui: ui as Field<unknown>, show: (value) => { ui.value = String(value); } };
      }
    }
    control.ui.el.dataset.input = field.id;
    control.ui.el.dataset.type = field.type;
    if (field.tooltip) tooltips.push(attachTooltip(control.ui.control, field.tooltip));
    return control;
  };

  // Group consecutive inputs sharing `group`, and rows sharing `inline`.
  let groupHost: HTMLElement = el;
  let groupName: string | undefined;
  let rowHost: HTMLElement | null = null;
  let rowTitles: string[] = [];
  let rowName: string | undefined;
  for (const field of studyInputFields(schema, values, options.study)) {
    if (field.group !== groupName) {
      groupName = field.group;
      rowHost = null;
      rowName = undefined;
      if (groupName) {
        const fieldset = document.createElement("fieldset");
        fieldset.className = "raze-study-inputs-group";
        const legend = document.createElement("legend");
        legend.textContent = groupName;
        fieldset.append(legend);
        el.append(fieldset);
        groupHost = fieldset;
      } else {
        groupHost = el;
      }
    }
    const control = build(field);
    controls.push(control);
    if (field.inline) {
      if (!rowHost || rowName !== field.inline) {
        rowHost = document.createElement("div");
        rowHost.className = "raze-study-inputs-inline";
        rowHost.setAttribute("role", "group");
        rowTitles = [];
        rowName = field.inline;
        groupHost.append(rowHost);
      }
      rowHost.append(control.ui.el);
      // The row is named by its members ("Multiplier, Offset").
      rowTitles.push(field.title);
      rowHost.setAttribute("aria-label", rowTitles.join(", "));
    } else {
      rowHost = null;
      rowName = undefined;
      groupHost.append(control.ui.el);
    }
  }
  el.append(error);

  const showAll = (): void => {
    for (const control of controls) {
      control.show(values[control.field.id]!);
      control.ui.control.removeAttribute("aria-invalid");
    }
    error.textContent = "";
  };

  return {
    el,
    get values() {
      return values;
    },
    setValues(next) {
      values = resolveStudyInputs(schema, next, options.study);
      showAll();
    },
    reset() {
      values = resolveStudyInputs(schema, {}, options.study);
      showAll();
      const first = controls[0];
      if (first) options.onChange?.(values, first.field.id);
    },
    focus() {
      controls[0]?.ui.control.focus();
    },
    destroy() {
      for (const tooltip of tooltips) tooltip.destroy();
      tooltips.length = 0;
      el.remove();
    },
  };
}
