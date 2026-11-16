// `yarn dev:core`: core from source on the dev channel (~/.odin-dev, port 8791) unless ODIN_HOME/ODIN_PORT say
// otherwise. Pair with `yarn dev:web` for browser UI work; set ODIN_FAKE_HARNESS=1 to avoid real model calls.
import { spawn } from "node:child_process";
import { join } from "node:path";

const env = { ...process.env, ODIN_HOME: process.env.ODIN_HOME || "~/.odin-dev", ODIN_PORT: process.env.ODIN_PORT || "8791" };
const child = spawn(process.execPath, [join(import.meta.dirname, "..", "packages", "core", "src", "index.ts")], {
  env,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
