import { isRecord } from "./schema.ts";
import type { Schema } from "./schema.ts";

// OpenAI strict output requires every property; optional values use null on the wire.
function strictJson(json: Record<string, unknown>): Record<string, unknown> {
  if (json.type === "object" && isRecord(json.properties)) {
    const required = new Set(Array.isArray(json.required) ? json.required : []);
    return { ...json,
      properties: Object.fromEntries(Object.entries(json.properties).map(([key, value]) => {
        if (!isRecord(value)) return [key, value];
        const child = strictJson(value);
        return [key, required.has(key) ? child : { anyOf: [child, { type: "null" }] }];
      })),
      required: Object.keys(json.properties), additionalProperties: false,
    };
  }
  if (json.type === "array" && isRecord(json.items)) return { ...json, items: strictJson(json.items) };
  return json;
}

function restoreOptionalValues(value: unknown, json: Record<string, unknown>): unknown {
  if (json.type === "array" && Array.isArray(value) && isRecord(json.items)) {
    const items = json.items;
    return value.map((item: unknown) => restoreOptionalValues(item, items));
  }
  if (json.type === "object" && isRecord(value) && isRecord(json.properties)) {
    const properties = json.properties;
    const required = new Set(Array.isArray(json.required) ? json.required : []);
    return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
      const field = properties[key];
      // Preserve unknown fields and required nulls so the original parser rejects them.
      if (!isRecord(field)) return [[key, child]];
      if (child === null && !required.has(key)) return [];
      return [[key, restoreOptionalValues(child, field)]];
    }));
  }
  return value;
}

export function openAiSchema<T>(schema: Schema<T>): Schema<T> {
  return {
    json: strictJson(schema.json),
    parse: (value) => schema.parse(restoreOptionalValues(value, schema.json)),
  };
}
