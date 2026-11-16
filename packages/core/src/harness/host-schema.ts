/** JSON schema for the flat parameters supported by Odin's host tools. */
export function hostToolSchema(params: Record<string, { type: string; description: string; optional?: boolean }>) {
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(params).map(([name, value]) => [name, { type: value.type, description: value.description }])),
    required: Object.entries(params).filter(([, value]) => !value.optional).map(([name]) => name),
    additionalProperties: false,
  };
}
