-- Per-project opt-out of global agent context. JSON { instruction?: string[], skill?: string[], agent?: string[], mcp?: string[], settings?: string[] }.
ALTER TABLE projects ADD COLUMN context_disabled TEXT NOT NULL DEFAULT '{}';
