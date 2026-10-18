import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerObsidianTools } from "./obsidian";
import { registerOmniFocusTools } from "./omnifocus";
import { registerZoteroTools } from "./zotero";
import { registerZoteroCreateTools } from "./zoteroCreate";

export function createMcpServer() {
  const server = new McpServer({ name: "tylermenezes-services", version: "1.0.0" });
  registerObsidianTools(server);
  registerZoteroTools(server);
  registerZoteroCreateTools(server);
  registerOmniFocusTools(server);
  return server;
}
