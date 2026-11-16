import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitBinary } from "../tools/resolve.ts";

/** Native project checkout and worktrees, including ordinary non-git directories. */
export async function projectDirectories(projectPath: string): Promise<string[]> {
  try {
    const result = await promisify(execFile)(gitBinary(), ["-C", projectPath, "worktree", "list", "--porcelain"], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
    return [...new Set([projectPath, ...result.stdout.split(/\r?\n/)
      .filter(line => line.startsWith("worktree ")).map(line => line.slice(9))])];
  } catch { return [projectPath]; }
}
