import type { LlmClient } from "./contracts.ts";
import { AiError, ensure } from "./errors.ts";
import { createJsonClient, record } from "./http.ts";
import type { TransportOptions } from "./http.ts";

export interface GeminiOptions extends TransportOptions {
  apiKey: string;
  model: string;
}

function responseText(value: unknown): { text: string; usage: unknown } {
  const body = record(value);
  if (body.promptFeedback !== undefined) {
    const feedback = record(body.promptFeedback);
    if (feedback.blockReason && feedback.blockReason !== "BLOCK_REASON_UNSPECIFIED") {
      throw new AiError("REFUSAL", "Gemini blocked this request.");
    }
  }
  ensure(Array.isArray(body.candidates) && body.candidates.length === 1, "Missing or ambiguous Gemini candidate.", "FORMAT");
  const candidate = record(body.candidates[0]);
  if (["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"].includes(String(candidate.finishReason))) {
    throw new AiError("REFUSAL", "Gemini declined this request.");
  }
  ensure(candidate.finishReason === "STOP", "The Gemini response was incomplete.", "FORMAT");
  const content = record(candidate.content);
  ensure(Array.isArray(content.parts), "Missing Gemini content.", "FORMAT");
  const parts: string[] = [];
  for (const value of content.parts) {
    const part = record(value);
    if (part.thought === true) continue;
    ensure(typeof part.text === "string", "Unexpected Gemini content.", "FORMAT");
    parts.push(part.text);
  }
  ensure(parts.join("").trim(), "Missing Gemini output text.", "FORMAT");
  return { text: parts.join(""), usage: body.usageMetadata };
}

export function createGeminiClient(options: GeminiOptions): LlmClient {
  ensure(options.apiKey.trim() && options.model.trim(), "Set GEMINI_API_KEY and GEMINI_MODEL.", "CONFIG");
  const model = options.model.replace(/^models\//, "");
  ensure(/^[a-zA-Z0-9._-]+$/.test(model), "Invalid Gemini model ID.", "CONFIG");
  return createJsonClient({
    provider: "gemini",
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    headers: { "x-goog-api-key": options.apiKey },
    body(request) {
      return {
        systemInstruction: { parts: [{ text: request.instructions }] },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(request.data) }] }],
        generationConfig: {
          candidateCount: 1, maxOutputTokens: 6000,
          responseMimeType: "application/json", responseJsonSchema: request.schema.json,
        },
      };
    },
    output: responseText,
  }, { ...options, timeoutMs: options.timeoutMs ?? 180000 });
}
