import { AiError } from "./errors.ts";

export interface Schema<T> {
  json: Record<string, unknown>;
  parse(value: unknown): T;
}

function invalid(): never {
  throw new AiError("FORMAT", "Data does not match the required schema.");
}

export const text: Schema<string> = {
  json: { type: "string", minLength: 1, maxLength: 12000 },
  parse(value) {
    if (typeof value !== "string" || !value.trim() || value.length > 12000) return invalid();
    return value;
  },
};

export const score: Schema<number> = {
  json: { type: "number", minimum: 0, maximum: 100 },
  parse(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return invalid();
    return value;
  },
};

export function choice<const T extends string>(...values: T[]): Schema<T> {
  return {
    json: { type: "string", enum: values },
    parse(value) {
      for (const item of values) if (value === item) return item;
      return invalid();
    },
  };
}

export function list<T>(item: Schema<T>, min = 0, max = 100): Schema<T[]> {
  return {
    json: { type: "array", items: item.json, minItems: min, ...(Number.isFinite(max) ? { maxItems: max } : {}) },
    parse(value) {
      if (!Array.isArray(value) || value.length < min || value.length > max) return invalid();
      return value.map((entry: unknown) => item.parse(entry));
    },
  };
}

export function object<T>(fields: { [K in keyof T]: Schema<T[K]> }): Schema<T> {
  return {
    json: {
      type: "object",
      properties: Object.fromEntries(Object.entries<Schema<unknown>>(fields).map(([key, schema]) => [key, schema.json])),
      required: Object.keys(fields), additionalProperties: false,
    },
    parse(value) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
      if (Object.keys(value).some((key) => !Object.hasOwn(fields, key))) return invalid();
      // Each field is validated before constructing the typed result.
      const result = {} as T;
      for (const key in fields) {
        result[key] = fields[key].parse(Reflect.get(value, key));
      }
      return result;
    },
  };
}
