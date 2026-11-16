import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeGitHub } from "./fake-github.ts";
import { GitHubClient, GitHubError, scrub } from "./github.ts";

function client(gh: FakeGitHub, o: { token?: string; fetch?: typeof fetch; now?: () => number } = {}) {
  return new GitHubClient({ token: o.token ?? gh.token, baseUrl: gh.base, fetch: o.fetch ?? gh.fetch, now: o.now });
}

test("scrub replaces every occurrence, ignores short or empty secrets", () => {
  assert.equal(scrub("a tok_1234 b tok_1234", ["tok_1234"]), "a *** b ***");
  assert.equal(scrub("abc", ["", null, "ab"]), "abc");
});

test("lists paginate through Link headers and drop PRs from issues", async () => {
  const gh = new FakeGitHub();
  for (let i = 0; i < 130; i++) gh.addIssue({ title: `i${i}` });
  gh.addIssue({ title: "pr", pull_request: {} });
  const res = await client(gh).listIssues(gh.repo, null);
  assert.equal(res.items.length, 130);
  assert.equal(res.pages, 2);
  assert.ok(res.etag);
  const again = await client(gh).listIssues(gh.repo, null, res.etag);
  assert.deepEqual([again.notModified, again.items.length, again.pages], [true, 0, 1]);
});

test("getIssue: 304 on a matching ETag", async () => {
  const gh = new FakeGitHub();
  gh.addIssue({ title: "x" });
  const c = client(gh);
  const first = await c.getIssue(gh.repo, 1);
  assert.equal(first.issue!.title, "x");
  const second = await c.getIssue(gh.repo, 1, first.etag);
  assert.equal(second.issue, null);
  gh.editIssue(1, { title: "y" });
  assert.equal((await c.getIssue(gh.repo, 1, first.etag)).issue!.title, "y");
});

test("no token, a bad repo, or a URL outside the API: refused locally", async () => {
  const gh = new FakeGitHub();
  await assert.rejects(client(gh, { token: "" }).listMilestones(gh.repo), (e: unknown) => e instanceof GitHubError && e.status === 0);
  await assert.rejects(client(gh).listMilestones("not-a-repo"), /invalid repo/);
  // A Link header pointing elsewhere must not get the token.
  const evil: typeof fetch = (async () =>
    new Response("[]", { status: 200, headers: { link: '<https://evil.example/steal?page=2>; rel="next"' } })) as typeof fetch;
  const seen: string[] = [];
  const spy: typeof fetch = (async (u: any, i: any) => { seen.push(String(u)); return evil(u, i); }) as typeof fetch;
  await assert.rejects(client(gh, { fetch: spy }).listMilestones(gh.repo), /outside the API/);
  assert.deepEqual(seen.length, 1);
  assert.equal(gh.requests.length, 0);
});

test("errors carry GitHub's status and message, scrubbed of the token", async () => {
  const gh = new FakeGitHub();
  gh.failWith = { status: 404, message: `nope ${gh.token}` };
  await assert.rejects(client(gh).getIssue(gh.repo, 1), (e: unknown) => {
    assert.ok(e instanceof GitHubError);
    assert.equal(e.status, 404);
    assert.ok(!e.message.includes(gh.token));
    assert.match(e.message, /GET \/repos\/acme\/odin\/issues\/1 → 404: nope \*\*\*/);
    return true;
  });
  const failing: typeof fetch = (async () => { throw new Error(`socket closed for ${gh.token}`); }) as typeof fetch;
  await assert.rejects(client(gh, { fetch: failing }).getIssue(gh.repo, 1), (e: unknown) => e instanceof GitHubError && e.status === 0 && !e.message.includes(gh.token));
});

test("retry-after blocks until it passes; a spent window blocks before the 403", async () => {
  const gh = new FakeGitHub();
  let now = Date.parse("2026-10-17T12:00:00Z");
  const c = client(gh, { now: () => now });
  gh.failWith = { status: 429, headers: { "retry-after": "30" } };
  await assert.rejects(c.listMilestones(gh.repo), (e: unknown) => e instanceof GitHubError && e.status === 429);
  gh.failWith = null;
  const n = gh.requests.length;
  await assert.rejects(c.listMilestones(gh.repo), /rate limit/);
  assert.equal(gh.requests.length, n);
  now += 31_000;
  await c.listMilestones(gh.repo);

  const reset = Math.floor(now / 1000) + 600;
  const spent: typeof fetch = (async () =>
    new Response("[]", { status: 200, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } })) as typeof fetch;
  const c2 = client(gh, { fetch: spent, now: () => now });
  await c2.listMilestones(gh.repo);
  await assert.rejects(c2.listMilestones(gh.repo), /rate limit/);
});
