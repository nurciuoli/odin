// Host tools (HostTool) as SDK MCP tool definitions, served by one in-process server named ODIN_MCP_SERVER. Each
// tool's input schema is built with zod from its flat `params`.
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { HostTool } from "../types.ts";
import { mcpHostContent } from "../host-result.ts";

export function paramsShape(params: HostTool["params"]): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, p] of Object.entries(params)) {
    const base = p.type === "number" ? z.number() : p.type === "boolean" ? z.boolean() : z.string();
    const described = base.describe(p.description);
    shape[name] = p.optional ? described.optional() : described;
  }
  return shape;
}

export function hostToolDefinitions(tools: readonly HostTool[]): SdkMcpToolDefinition<any>[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: paramsShape(t.params),
    handler: async (args: Record<string, unknown>) => {
      try {
        const out = await t.handler(args ?? {});
        return { content: mcpHostContent(out), ...(out.isError ? { isError: true } : {}) };
      } catch (err) {
        return { content: [{ type: "text" as const, text: "Odin host tool failed" }], isError: true };
      }
    },
  }));
}
