// Preserve the installed dependency layout, including nested versions and platform optional packages.
// Node would keep walking into parent folders. Those installs belong to other projects, so a peer
// that is only present there is skipped, and a required dependency there still counts as missing.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";

export function runtimePackages(modules: string, names: string[]): string[] {
  const root = resolve(modules);
  const repoRoot = dirname(root);
  const found = new Set<string>();
  function contained(path: string): boolean {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }
  function locate(name: string, from: string): string | null {
    let dir = from;
    while (true) {
      const candidate = join(dir, "node_modules", name);
      if (contained(candidate) && existsSync(join(candidate, "package.json"))) return candidate;
      if (resolve(dir) === repoRoot) return null;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
  function visit(directory: string) {
    if (!contained(directory)) throw new Error("Runtime dependency is outside node_modules");
    if (found.has(directory)) return;
    found.add(directory);
    const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    // An optional peer is the host's choice, not this package's need. Following them staged a second Electron
    // (an optional peer of @opencode/plugin) into the packaged core. A peer the runtime does use is still staged
    // through whichever package depends on it.
    const peers = Object.keys(pkg.peerDependencies ?? {}).filter((name) => !pkg.peerDependenciesMeta?.[name]?.optional);
    for (const name of new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...peers])) {
      const dependency = locate(name, directory);
      if (dependency) visit(dependency);
      else if (pkg.dependencies?.[name] && !pkg.optionalDependencies?.[name]) throw new Error(`Missing runtime dependency ${name}`);
    }
  }
  for (const name of names) {
    const directory = join(root, name);
    if (!existsSync(join(directory, "package.json"))) throw new Error(`Missing runtime package ${name}`);
    visit(directory);
  }
  return [...found];
}
