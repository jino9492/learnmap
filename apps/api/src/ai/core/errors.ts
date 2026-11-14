export type ErrorCode = "INPUT" | "OCR_REQUIRED" | "CONFIG" | "CONNECTION" | "TIMEOUT" | "PROVIDER" | "FORMAT" | "SEMANTIC" | "REFUSAL";

export class AiError extends Error {
  readonly code: ErrorCode;
  readonly reason?: "CONTEXT_LIMIT" | "RATE_LIMIT" | "AUTH" | "MODEL_NOT_FOUND" | "UNAVAILABLE";
  constructor(code: ErrorCode, message: string, reason?: AiError["reason"]) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.reason = reason;
  }
}

export function ensure(condition: unknown, message: string, code: ErrorCode = "SEMANTIC"): asserts condition {
  if (!condition) throw new AiError(code, message);
}
