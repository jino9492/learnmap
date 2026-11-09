export type ErrorCode = "INPUT" | "CONFIG" | "CONNECTION" | "TIMEOUT" | "PROVIDER" | "FORMAT" | "SEMANTIC" | "REFUSAL";

export class AiError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AiError";
    this.code = code;
  }
}

export function ensure(condition: unknown, message: string, code: ErrorCode = "SEMANTIC"): asserts condition {
  if (!condition) throw new AiError(code, message);
}
