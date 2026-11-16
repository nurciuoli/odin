// postinstall: repair an Electron install whose binary download/extract did not finish (empty dist/, no path.txt).
// No-op when Electron is installed. Uses the zip in Electron's own cache when there is one, else runs Electron's
// install.js (which downloads). Never fails the install: it warns and exits 0.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PLATFORM_PATH: Partial<Record<NodeJS.Platform, string>> = {
  win32: "electron.exe",
  darwin: "Electron.app/Contents/MacOS/Electron",
  linux: "electron",
  freebsd: "electron",
  openbsd: "electron",
};

function warn(msg: string) {
  console.warn(`ensure-electron: ${msg}`);
}

function electronDir(): string | null {
  try {
    return dirname(createRequire(import.meta.url).resolve("electron/package.json"));
  } catch {
    return null;
  }
}

function installed(dir: string, version: string, platformPath: string): boolean {
  try {
    if (readFileSync(join(dir, "dist", "version"), "utf8").trim().replace(/^v/, "") !== version) return false;
    if (readFileSync(join(dir, "path.txt"), "utf8") !== platformPath) return false;
    return existsSync(join(dir, "dist", platformPath));
  } catch {
    return false;
  }
}

function cacheRoot(): string {
  if (process.env.electron_config_cache) return process.env.electron_config_cache;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "electron", "Cache");
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "electron");
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "electron");
}

/** @electron/get stores `<root>/<sha of url dir>/<name>.zip`; also accept a zip directly under the root. */
function findZip(root: string, name: string): string | null {
  if (!existsSync(root)) return null;
  const direct = join(root, name);
  if (existsSync(direct)) return direct;
  for (const entry of readdirSync(root)) {
    const p = join(root, entry, name);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return null;
}

function extract(zip: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  if (process.platform === "win32") {
    // bsdtar ships with Windows 10+ and reads zips.
    const tar = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    execFileSync(tar, ["-xf", zip, "-C", dest], { stdio: "inherit", windowsHide: true });
  } else {
    execFileSync("unzip", ["-o", "-q", zip, "-d", dest], { stdio: "inherit" });
  }
}

function main() {
  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) return;
  const dir = electronDir();
  if (!dir) return warn("electron is not installed; skipping");
  const platformPath = PLATFORM_PATH[process.platform];
  if (!platformPath) return;
  const version = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;
  if (installed(dir, version, platformPath)) return;

  const name = `electron-v${version}-${process.platform}-${process.arch}.zip`;
  const zip = findZip(cacheRoot(), name);
  if (zip) {
    console.log(`ensure-electron: extracting ${name} from the Electron cache`);
    extract(zip, join(dir, "dist"));
    writeFileSync(join(dir, "path.txt"), platformPath);
  } else {
    console.log(`ensure-electron: ${name} not cached; running Electron's installer`);
    execFileSync(process.execPath, [join(dir, "install.js")], { cwd: dir, stdio: "inherit" });
  }
  if (!installed(dir, version, platformPath)) warn("Electron still looks incomplete; see node_modules/electron/dist");
}

try {
  main();
} catch (err) {
  warn(err instanceof Error ? err.message : String(err));
}
