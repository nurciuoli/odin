// Where core and its resources live, packaged or from the repo (docs/desktop.md#packaging).
// Packaged layout (apps/desktop/build/bundle.ts writes it under <resources>):
//   core/index.js (+ schema.sql, migrations/, host-mcp.js, node_modules/@anthropic-ai/...)
//   web/  library/  tokens.css  adapter/{odin-hook.js,odin-hook.cmd}
import { join } from "node:path";

export interface CoreEnvInput {
  packaged: boolean;
  /** process.resourcesPath when packaged. */
  resourcesPath: string;
  /** The repo checkout, used when not packaged. */
  repoRoot: string;
  /** The app's own executable (process.execPath), run as Node when packaged. */
  execPath?: string;
}

export interface CoreLaunch {
  /** The runtime to spawn. */
  command: string;
  /** Arguments: the core entry. */
  args: string[];
  /** Env to add to core's environment. */
  env: Record<string, string>;
}

export function coreEnv({ packaged, resourcesPath, repoRoot, execPath = process.execPath }: CoreEnvInput): CoreLaunch {
  if (packaged) {
    const r = resourcesPath;
    return {
      command: execPath,
      args: [join(r, "core", "index.js")],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        ODIN_WEB_DIST: join(r, "web"),
        ODIN_LIBRARY_SEED: join(r, "library"),
        ODIN_ARTIFACT_THEME: join(r, "tokens.css"),
        ODIN_ADAPTER_DIR: join(r, "adapter"),
      },
    };
  }
  return {
    command: "node",
    args: [join(repoRoot, "packages", "core", "src", "index.ts")],
    env: {
      ODIN_WEB_DIST: join(repoRoot, "packages", "web", "dist"),
      ODIN_LIBRARY_SEED: join(repoRoot, "templates", "library"),
      ODIN_ARTIFACT_THEME: join(repoRoot, "packages", "web", "src", "styles", "tokens.css"),
      ODIN_ADAPTER_DIR: join(repoRoot, "adapters", "claude-code", "src"),
    },
  };
}
