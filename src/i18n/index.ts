// Translation runtime for built-in chrome.
//
// Every user-visible string in library UI is written as
// `t("scope.key", "English default")`. The English default lives inline next
// to the code that uses it, so the library never ships an English pack and a
// missing translation always degrades to readable text instead of a raw key.
// `scripts/extract-messages.mjs` collects those calls into a catalog that
// translators (or `--check`) work from.
//
// Locale packs are flat `{ key: message }` objects registered eagerly or via
// a lazy loader, so a consumer only downloads the languages it uses. Messages
// may contain `{name}` placeholders; `plural()` selects `key.one`,
// `key.other`, … through `Intl.PluralRules`.
//
// The exported functions operate on one page-wide runtime shared by built-in
// chrome. They are separate top-level functions so bundles only pay for what
// they call (the widget itself only needs `t`). `createI18n()` returns an
// isolated runtime for hosts that need one per widget.

/** Flat message table for one locale. Keys are dotted `scope.name` ids. */
export type Messages = Readonly<Record<string, string>>;

/** Values substituted into `{name}` placeholders. */
export type MessageParams = Readonly<Record<string, string | number>>;

/** Lazily loads a locale pack (for example `() => import("./de.js")`). */
export type MessageLoader = () => Promise<Messages | { default: Messages }>;

/**
 * Host translation hook, consulted before registered packs. Return a string to
 * use it, or `null`/`undefined` to fall through. It receives the English
 * default so TradingView-style `custom_translate_function` adapters can key on
 * either value.
 */
export type TranslateHook = (key: string, fallback: string, locale: string) => string | null | undefined;

/** CLDR plural forms accepted by `plural()`; `other` is required. */
export type PluralForms = Readonly<Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }>;

export interface I18n {
  /** Translate `key`, falling back to the inline English default. */
  t(key: string, fallback: string, params?: MessageParams): string;
  /**
   * Plural-aware translation. Looks up `key.<category>` (for example
   * `kit.toast.more.one`) and falls back to the matching inline form.
   * `{count}` is always available as a placeholder.
   */
  plural(key: string, count: number, forms: PluralForms, params?: MessageParams): string;
  /** Active BCP 47 locale tag (defaults to `"en"`). */
  getLocale(): string;
  /**
   * Switch the active locale. Resolves after a registered lazy pack for the
   * locale (or its base language) has loaded; listeners run once the new
   * messages are available. A locale without any messages keeps the English
   * defaults and warns once, so a typo is visible rather than silently ignored.
   * Overlapping calls resolve in call order: the most recent call wins even
   * when an earlier call's pack loads later, and a superseded call resolves
   * without changing the locale or notifying listeners.
   */
  setLocale(locale: string): Promise<void>;
  /** Register or extend a locale pack. Later registrations win per key. */
  registerMessages(locale: string, messages: Messages): void;
  /** Register a lazy pack loader used the first time `locale` is selected. */
  registerLocaleLoader(locale: string, loader: MessageLoader): void;
  /** Whether `key` has a translation for the active locale chain. */
  hasMessage(key: string): boolean;
  /** Install (or clear with `null`) a host translation hook. */
  setTranslateHook(hook: TranslateHook | null): void;
  /** Subscribe to locale changes; returns an unsubscribe function. */
  onLocaleChange(listener: (locale: string) => void): () => void;
  /** Text direction for the active locale, for mirroring chrome. */
  direction(): "ltr" | "rtl";
}

interface State {
  locale: string;
  chain: string[];
  hook: TranslateHook | null;
  rules: Intl.PluralRules | null;
  /** Ticket of the most recent setLocale() call; older calls are superseded. */
  requested: number;
  readonly packs: Map<string, Record<string, string>>;
  readonly loaders: Map<string, MessageLoader>;
  readonly loading: Map<string, Promise<void>>;
  readonly listeners: Set<(locale: string) => void>;
  readonly warned: Set<string>;
}

const RTL_LANGUAGES = /^(?:ar|arc|ckb|dv|fa|he|iw|ku|ps|sd|ug|ur|yi)$/i;

/** Normalise `pt_br` / `PT-br` to the canonical `pt-BR` BCP 47 form. */
export function normalizeLocale(locale: string): string {
  const raw = String(locale ?? "").trim().replace(/_/g, "-");
  if (!raw) return "en";
  try {
    return Intl.getCanonicalLocales(raw)[0] ?? raw;
  } catch {
    return raw;
  }
}

/** `pt-BR` → [`pt-BR`, `pt`]; the English defaults are the implicit last step. */
export function localeChain(locale: string): string[] {
  const parts = normalizeLocale(locale).split("-");
  const chain: string[] = [];
  for (let length = parts.length; length > 0; length--) chain.push(parts.slice(0, length).join("-"));
  return chain;
}

/** Whether a locale is written right-to-left. */
export function isRtlLocale(locale: string): boolean {
  return RTL_LANGUAGES.test(normalizeLocale(locale).split("-")[0]!);
}

/** Replace `{name}` placeholders. Unknown placeholders stay visible. */
export function formatMessage(message: string, params?: MessageParams): string {
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
}

function createState(locale: string): State {
  const normalized = normalizeLocale(locale);
  return {
    locale: normalized,
    chain: localeChain(normalized),
    hook: null,
    rules: null,
    requested: 0,
    packs: new Map(),
    loaders: new Map(),
    loading: new Map(),
    listeners: new Set(),
    warned: new Set(),
  };
}

function lookup(state: State, key: string): string | undefined {
  for (const tag of state.chain) {
    const message = state.packs.get(tag)?.[key];
    if (typeof message === "string") return message;
  }
  return undefined;
}

function translate(state: State, key: string, fallback: string, params?: MessageParams): string {
  let message: string | undefined;
  if (state.hook) {
    try {
      const hooked = state.hook(key, fallback, state.locale);
      if (typeof hooked === "string") message = hooked;
    } catch (error) {
      console.warn(`[raze-charts] translate hook threw for "${key}"; using the default text.`, error);
    }
  }
  return formatMessage(message ?? lookup(state, key) ?? fallback, params);
}

function translatePlural(state: State, key: string, count: number, forms: PluralForms, params?: MessageParams): string {
  if (!state.rules) {
    try {
      state.rules = new Intl.PluralRules(state.locale);
    } catch {
      state.rules = new Intl.PluralRules("en");
    }
  }
  const category = state.rules.select(count);
  return translate(state, `${key}.${category}`, forms[category] ?? forms.other, { count, ...params });
}

function register(state: State, locale: string, messages: Messages): void {
  const tag = normalizeLocale(locale);
  if (!messages || typeof messages !== "object") {
    throw new TypeError(`[raze-charts] registerMessages("${tag}") expects a { key: message } object.`);
  }
  const target = state.packs.get(tag) ?? {};
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value !== "string") {
      throw new TypeError(`[raze-charts] message "${key}" for locale "${tag}" must be a string.`);
    }
    target[key] = value;
  }
  state.packs.set(tag, target);
}

function registerLoader(state: State, locale: string, loader: MessageLoader): void {
  if (typeof loader !== "function") {
    throw new TypeError(`[raze-charts] registerLocaleLoader("${locale}") expects a function returning a Promise.`);
  }
  state.loaders.set(normalizeLocale(locale), loader);
}

function load(state: State, tag: string): Promise<void> {
  const loader = state.loaders.get(tag);
  if (!loader) return Promise.resolve();
  let pending = state.loading.get(tag);
  if (!pending) {
    pending = loader().then((result) => {
      const pack = result && typeof (result as { default?: unknown }).default === "object"
        ? (result as { default: Messages }).default
        : result as Messages;
      register(state, tag, pack);
      state.loaders.delete(tag);
    }).finally(() => state.loading.delete(tag));
    state.loading.set(tag, pending);
  }
  return pending;
}

async function changeLocale(state: State, next: string): Promise<void> {
  const locale = normalizeLocale(next);
  const chain = localeChain(locale);
  // Packs load asynchronously, so overlapping calls can settle out of order.
  // Only the most recent call may apply its locale; earlier ones still load
  // (and cache) their packs but must not overwrite a newer choice.
  // A failing loader still rejects the call that asked for it.
  const ticket = ++state.requested;
  await Promise.all(chain.map((tag) => load(state, tag)));
  if (ticket !== state.requested) return;
  const english = chain[chain.length - 1]!.toLowerCase() === "en";
  if (!english && !state.hook && !chain.some((tag) => state.packs.has(tag)) && !state.warned.has(locale)) {
    state.warned.add(locale);
    console.warn(
      `[raze-charts] no messages are registered for locale "${locale}"; built-in UI stays in English. ` +
      "Register a pack with registerMessages()/registerLocaleLoader() or install a translate hook.",
    );
  }
  if (locale === state.locale) return;
  state.locale = locale;
  state.chain = chain;
  state.rules = null;
  for (const listener of [...state.listeners]) {
    try {
      listener(locale);
    } catch (error) {
      console.warn("[raze-charts] locale change listener threw.", error);
    }
  }
}

function subscribe(state: State, listener: (locale: string) => void): () => void {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

/** Create an isolated translation runtime. */
export function createI18n(initialLocale = "en"): I18n {
  const state = createState(initialLocale);
  return {
    t: (key, fallback, params) => translate(state, key, fallback, params),
    plural: (key, count, forms, params) => translatePlural(state, key, count, forms, params),
    getLocale: () => state.locale,
    setLocale: (locale) => changeLocale(state, locale),
    registerMessages: (locale, messages) => register(state, locale, messages),
    registerLocaleLoader: (locale, loader) => registerLoader(state, locale, loader),
    hasMessage: (key) => lookup(state, key) !== undefined,
    setTranslateHook(hook) {
      state.hook = hook;
    },
    onLocaleChange: (listener) => subscribe(state, listener),
    direction: () => (isRtlLocale(state.locale) ? "rtl" : "ltr"),
  };
}

// ── Page-wide runtime used by built-in chrome ──────────────────────────────

const shared: State = /* @__PURE__ */ createState("en");

/** Translate with the shared runtime: `t("kit.dialog.ok", "OK")`. */
export function t(key: string, fallback: string, params?: MessageParams): string {
  return translate(shared, key, fallback, params);
}

/** Plural-aware translation with the shared runtime. */
export function plural(key: string, count: number, forms: PluralForms, params?: MessageParams): string {
  return translatePlural(shared, key, count, forms, params);
}

export function getLocale(): string {
  return shared.locale;
}

export function setLocale(locale: string): Promise<void> {
  return changeLocale(shared, locale);
}

export function registerMessages(locale: string, messages: Messages): void {
  register(shared, locale, messages);
}

export function registerLocaleLoader(locale: string, loader: MessageLoader): void {
  registerLoader(shared, locale, loader);
}

export function hasMessage(key: string): boolean {
  return lookup(shared, key) !== undefined;
}

export function setTranslateHook(hook: TranslateHook | null): void {
  shared.hook = hook;
}

export function onLocaleChange(listener: (locale: string) => void): () => void {
  return subscribe(shared, listener);
}

export function direction(): "ltr" | "rtl" {
  return isRtlLocale(shared.locale) ? "rtl" : "ltr";
}
