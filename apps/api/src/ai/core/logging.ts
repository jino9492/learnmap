import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

let warned = false;

export function logAiEvent(event: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  try {
    const directory = resolve("logs");
    mkdirSync(directory, { recursive: true });
    // Append immediately so completed events survive even an abrupt process exit.
    appendFileSync(resolve(directory, `ai-${timestamp.slice(0, 10)}.jsonl`),
      `${JSON.stringify({ ...event, timestamp, pid: process.pid })}\n`, "utf8");
  } catch {
    if (!warned) {
      warned = true;
      process.stderr.write("Could not write AI runtime logs to ./logs.\n");
    }
  }
}
