import type { LlmClient } from "./contracts.ts";
import { AiError, ensure } from "./errors.ts";
import { queueLane } from "./queue.ts";
import { createJsonClient, record } from "./http.ts";
import type { TransportOptions } from "./http.ts";
import { openAiSchema } from "./openai-schema.ts";

export type { UsageEvent } from "./http.ts";

export interface ClientOptions extends TransportOptions {
  apiKey: string;
  tuneGraphRelations?: boolean;
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
  const client = createJsonClient({
    provider: "openai",
    model: options.model,
    url: "https://api.openai.com/v1/responses",
    headers: { Authorization: `Bearer ${options.apiKey}` },
    body(request, _contextTokens, repair) {
      const tune = options.tuneGraphRelations && queueLane(request.name) === "graph";
      const limit = request.name === "relation_analysis" ? 2048 : request.name === "relation_review" ? 3072 : 6000;
      return {
        model: options.model, store: false, max_output_tokens: tune && !repair ? limit : 6000,
        instructions: request.instructions,
        input: [{ role: "user", content: JSON.stringify(request.data) }],
        text: { format: { type: "json_schema", name: request.name, strict: true, schema: request.schema.json } },
      };
    },
    ...(options.tuneGraphRelations ? { estimateTokens(body: string, task: string) {
      if (queueLane(task) !== "graph" || !["relation_analysis", "relation_review"].includes(task)) return;
      const payload = record(JSON.parse(body));
      ensure(typeof payload.max_output_tokens === "number", "Missing OpenAI output token limit.", "CONFIG");
      const ascii = body.match(/[\x00-\x7f]/g)?.length ?? 0;
      const nonAsciiBytes = Buffer.byteLength(body, "utf8") - ascii;
      // Include JSON schema and framing. Keep additional headroom for non-ASCII text.
      const input = Math.ceil(ascii / 2.7 + nonAsciiBytes / 1.7) + 128;
      const reservation = input + payload.max_output_tokens;
      return { reservation, pacingFloor: Math.max(input, Math.ceil(reservation * 0.65)) };
    } } : {}),
    output: responseText,
  }, options);
  return {
    generate(request) {
      return client.generate({ ...request, schema: openAiSchema(request.schema) });
    },
  };
}
