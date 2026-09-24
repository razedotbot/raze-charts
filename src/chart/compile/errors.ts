export type ChartCompileErrorCode =
  | "E_CHART_SPEC"
  | "E_CHART_SIZE"
  | "E_CHART_PERFORMANCE"
  | "E_CHART_COMPOSITION"
  | "E_SCALE_TYPE"
  | "E_SCALE_DOMAIN"
  | "E_MARK_DATA"
  | "E_MARK_KIND"
  | "E_MARK_CHANNEL"
  | "E_MARK_OPTION"
  | "E_MARK_PLUGIN_KIND"
  | "E_MARK_PLUGIN_MISMATCH"
  | "E_MARK_PLUGIN_DOMAIN"
  | "E_MARK_PLUGIN_COMPILE"
  | "E_MARK_PLUGIN_RESULT";

export class ChartCompileError extends Error {
  override readonly name = "ChartCompileError";
  readonly cause: unknown;

  constructor(
    readonly code: ChartCompileErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[raze-charts:${code}] ${message}`);
    this.cause = options?.cause;
  }
}
