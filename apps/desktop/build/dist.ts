// Builds the Windows installer from the staged app (run build/bundle.ts first). electron-builder needs an exact
// Electron version and package.json holds a range, so pass the installed one.
import { Platform, build } from "electron-builder";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const desktop = resolve(import.meta.dirname, "..");
const electronPkg = createRequire(import.meta.url).resolve("electron/package.json");
const electronVersion: string = JSON.parse(readFileSync(electronPkg, "utf8")).version;

try {
  const out = await build({
    projectDir: desktop,
    targets: Platform.WINDOWS.createTarget("nsis", 1 /* Arch.x64 */),
    publish: "never",
    config: {
      extends: resolve(desktop, "electron-builder.yml"),
      electronVersion,
      // electronDist copies Electron's default_app.asar (the "drop an app here" page); the packaged app never uses it.
      afterPack: async (ctx) => rmSync(join(ctx.appOutDir, "resources", "default_app.asar"), { force: true }),
    },
  });
  console.log(out.join("\n"));
} catch (err) {
  console.error(err);
  process.exit(1);
}
