// Which native notifications to raise (docs/desktop.md#tray-and-notifications). Pure: the caller feeds every
// observed session record (events and seeds alike) plus what the window is showing, and shows what comes back.
import type { SessionLite } from "./counts.ts";

export interface NotifySettings {
  notifyOnWaiting: boolean;
  notifyOnFinished: boolean;
}

export interface WindowView {
  /** The window is visible and focused. */
  focused: boolean;
  /** The session id of the route the window shows (`/s/<id>`), if any. */
  sessionId: string | null;
}

export interface NotificationSpec {
  kind: "waiting" | "finished";
  sessionId: string;
  /** Titles only: never tool input or file contents. */
  title: string;
  body: string;
}

const LIVE = new Set(["running", "waiting"]);
const DONE = new Set(["idle", "ended", "failed"]);

/** `/s/<id>` (with optional suffix) → id. */
export function sessionIdFromUrl(url: string): string | null {
  try {
    const m = /^\/s\/([^/?#]+)/.exec(new URL(url).pathname);
    return m ? decodeURIComponent(m[1]!) : null;
  } catch {
    return null;
  }
}

export function promptTitle(waitingFor: SessionLite["waitingFor"]): string {
  if (waitingFor === "permission") return "Wants your permission";
  if (waitingFor === "question") return "Has a question for you";
  return "Needs you";
}

export function notifier() {
  /** Sessions already notified for their current waiting episode. */
  const notified = new Set<string>();
  /** Last state seen per session, to spot a live session finishing. */
  const last = new Map<string, string>();

  const observe = (s: SessionLite, settings: NotifySettings, view: WindowView): NotificationSpec | null => {
    const prev = last.get(s.id);
    last.set(s.id, s.state);
    if (s.aside || s.archived) return null;
    const looking = view.focused && view.sessionId === s.id;
    const title = s.title || "Untitled session";

    if (s.state !== "waiting") notified.delete(s.id);
    if (s.state === "waiting") {
      if (notified.has(s.id)) return null;
      // The episode counts as handled even when suppressed: looking at it, or notifications off.
      notified.add(s.id);
      if (!settings.notifyOnWaiting || looking) return null;
      return { kind: "waiting", sessionId: s.id, title, body: promptTitle(s.waitingFor) };
    }
    if (prev && LIVE.has(prev) && DONE.has(s.state)) {
      if (!settings.notifyOnFinished || view.focused) return null;
      return {
        kind: "finished",
        sessionId: s.id,
        title,
        body: s.state === "failed" ? "Stopped with an error" : "Finished",
      };
    }
    return null;
  };

  return {
    observe,
    /**
     * A fresh list after (re)connect. Sessions missing from it are forgotten (their episode ended or they went away),
     * so a later waiting episode notifies again; the ones present go through `observe`, so a reconnect never repeats a
     * notification for an episode already seen.
     */
    seed(list: SessionLite[], settings: NotifySettings, view: WindowView): NotificationSpec[] {
      const ids = new Set(list.map((s) => s.id));
      for (const id of [...notified]) if (!ids.has(id)) notified.delete(id);
      for (const id of [...last.keys()]) if (!ids.has(id)) last.delete(id);
      const out: NotificationSpec[] = [];
      for (const s of list) {
        const n = observe(s, settings, view);
        if (n) out.push(n);
      }
      return out;
    },
    forget(id: string) {
      notified.delete(id);
      last.delete(id);
    },
  };
}
