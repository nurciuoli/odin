// `yarn dev:desktop`: the Odin Dev desktop app from source. A terminal inside the installed Odin app inherits ODIN_*
// (the dev app would attach to the stable core on 8790) and ELECTRON_RUN_AS_NODE=1 (Electron would run as plain Node).
// Strip both before spawning `yarn workspace @odin/desktop dev`.
import { spawn } from "node:child_process";
import { join } from "node:path";

export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(out)) if (key.startsWith("ODIN_")) delete out[key];
  delete out.ELECTRON_RUN_AS_NODE;
  return out;
}

const args = ["workspace", "@odin/desktop", "dev"];
const yarnJs = process.env.npm_execpath;
const cmd = yarnJs ? process.execPath : "corepack";
const cmdArgs = yarnJs ? [yarnJs, ...args] : ["yarn", ...args];
const child = spawn(cmd, cmdArgs, {
  cwd: join(import.meta.dirname, ".."),
  env: cleanEnv(process.env),
  stdio: "inherit",
  shell: !yarnJs && process.platform === "win32", // corepack is a .cmd shim on Windows; argv is constant
});
child.on("exit", (code) => process.exit(code ?? 1));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
