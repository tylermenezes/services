import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
