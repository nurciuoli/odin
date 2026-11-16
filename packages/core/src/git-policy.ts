/** Conservative branch policy shared by launch requests, project defaults and worktree creation. */
export function validBranchName(branch: string): boolean {
  return branch.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) &&
    !branch.endsWith("/") && !branch.endsWith(".") && !branch.includes("..") && !branch.includes("//") &&
    !branch.split("/").some(part => part.startsWith(".") || part.endsWith(".lock"));
}
