// Navigation is confined to the core origin; http(s) links elsewhere go to the system browser, anything else is dropped.

export function isCoreUrl(url: string, coreOrigin: string): boolean {
  try {
    return new URL(url).origin === coreOrigin;
  } catch {
    return false;
  }
}

/** IPC handlers answer only the core origin's top frame: never the artifact iframe or an error page. */
export function isTrustedSender(frame: { url: string; isTop: boolean } | null | undefined, coreOrigin: string): boolean {
  return !!frame && frame.isTop && isCoreUrl(frame.url, coreOrigin);
}

export function isExternalOpenable(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return p === "https:" || p === "http:" || p === "mailto:";
  } catch {
    return false;
  }
}
