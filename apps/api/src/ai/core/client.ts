import type { LlmClient } from "./contracts.ts";
import { AiError, ensure } from "./errors.ts";
import { createJsonClient, record } from "./http.ts";
import type { TransportOptions } from "./http.ts";

export type { UsageEvent } from "./http.ts";

export interface ClientOptions extends TransportOptions {
  apiKey: string;
  model: string;
}

function responseText(value: unknown): { text: string; usage: unknown } {
  const body = record(value);
  ensure(body.status === "completed", "The model response was incomplete.", "FORMAT");
  ensure(Array.isArray(body.output), "Missing model output.", "FORMAT");
  const parts: string[] = [];
  for (const output of body.output) {
    const item = record(output);
    if (item.type !== "message") continue;
    ensure(Array.isArray(item.content), "Missing message content.", "FORMAT");
    for (const content of item.content) {
      const part = record(content);
      if (part.type === "refusal") throw new AiError("REFUSAL", "The model declined this request.");
      if (part.type === "output_text" && typeof part.text === "string") parts.push(part.text);
    }
  }
  ensure(parts.length > 0, "Missing output text.", "FORMAT");
  return { text: parts.join(""), usage: body.usage };
}

export function createOpenAiClient(options: ClientOptions): LlmClient {
  ensure(options.apiKey.trim() && options.model.trim(), "Set OPENAI_API_KEY and OPENAI_MODEL.", "CONFIG");
  return createJsonClient({
    provider: "openai",
    url: "https://api.openai.com/v1/responses",
    headers: { Authorization: `Bearer ${options.apiKey}` },
    body(request) {
      return {
        model: options.model, store: false, max_output_tokens: 6000,
        instructions: request.instructions,
        input: [{ role: "user", content: JSON.stringify(request.data) }],
        text: { format: { type: "json_schema", name: request.name, strict: true, schema: request.schema.json } },
      };
    },
    output: responseText,
  }, options);
}
