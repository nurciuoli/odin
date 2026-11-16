// The error window's page. Its buttons are links to sentinel URLs that main intercepts in will-navigate, so the page
// needs no preload or IPC.

export const ACTION_RESTART = "https://odin.invalid/restart";
export const ACTION_OPEN_LOG = "https://odin.invalid/open-log";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function errorPage(title: string, detail: string, canRestart: boolean): string {
  const restart = canRestart ? `<a class="b" href="${ACTION_RESTART}">Restart</a>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Odin</title><style>
body{font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#121211;color:#eceae4}
.drag{position:fixed;top:0;left:0;right:0;height:48px;-webkit-app-region:drag}
main{max-width:34rem;padding:2rem}h1{font-size:1.25rem}p{line-height:1.5}
.b{display:inline-block;margin-right:.75rem;padding:.5rem 1rem;border:1px solid currentColor;border-radius:.375rem;color:inherit;text-decoration:none}
.b:focus-visible{outline:2px solid Highlight;outline-offset:2px}
</style></head><body><div class="drag"></div><main role="alert"><h1>${esc(title)}</h1><p>${esc(detail)}</p>
<p>${restart}<a class="b" href="${ACTION_OPEN_LOG}">Open log</a></p></main></body></html>`;
}
