// ArtifactsService (docs/contracts.md#artifacts): HTML pages an agent posts through the `post_artifact` host tool,
// versioned per artifact, served sandboxed under /a/ (routes.ts), and answers from them sent back into the session.
// Owns the `artifacts` and `artifact_versions` tables; reads `sessions` for the session's project.
import type { Artifact, ArtifactDetail, ArtifactSubmitRequest, ArtifactVersion, Session } from "@odin/shared/api";
import { HttpError } from "../http/util.ts";
import type { ArtifactsService, Deps, Services } from "../services.ts";
import type { HostTool } from "../harness/types.ts";
import { SUBMIT_MAX_BYTES } from "./bridge.ts";

/** Largest artifact page, as UTF-8 bytes. */
export const HTML_MAX_BYTES = 8 * 1024 * 1024;
export const TITLE_MAX_CHARS = 200;
export const NOTE_MAX_CHARS = 2000;

export const POST_ARTIFACT_TOOL = "post_artifact";

interface ArtifactRow {
  id: number;
  project: string;
  session_id: string;
  title: string;
  latest_version: number | null;
  created_at: string;
  updated_at: string;
}

const ARTIFACT_SELECT = `SELECT a.id, a.project, a.session_id, a.title, a.created_at, a.updated_at,
  (SELECT max(v.version) FROM artifact_versions v WHERE v.artifact_id = a.id) AS latest_version
  FROM artifacts a`;

function toArtifact(r: ArtifactRow): Artifact {
  return {
    id: Number(r.id),
    project: r.project,
    sessionId: r.session_id,
    title: r.title,
    latestVersion: Number(r.latest_version ?? 0),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** A positive safe integer, or null. Accepts digit strings too (models sometimes quote numbers). */
function positiveInt(value: unknown): number | null {
  if (typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value.trim())) value = Number(value.trim());
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** One line: control characters and runs of whitespace become single spaces. */
function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
}

/** A fenced block whose fence is longer than any backtick run inside, so the content can't close it. */
function fenced(lang: string, body: string): string {
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${body}\n${fence}`;
}

/** The user message a submit sends into the artifact's session. */
export function submitMessage(title: string, version: number, data: unknown): string {
  return `Answer from "${title}" (v${version}):\n\n${fenced("json", JSON.stringify(data, null, 2))}`;
}

export function createArtifactsService(deps: Deps, services: Services): ArtifactsService {
  const { db, bus } = deps;
  const now = () => deps.now().toISOString();

  function row(id: number): ArtifactRow | null {
    return (db.prepare(`${ARTIFACT_SELECT} WHERE a.id = ?`).get(id) as ArtifactRow | undefined) ?? null;
  }

  function versionExists(id: number, version: number): boolean {
    return !!db.prepare("SELECT 1 FROM artifact_versions WHERE artifact_id = ? AND version = ?").get(id, version);
  }

  const service: ArtifactsService = {
    forSession(sessionId) {
      return (db.prepare(`${ARTIFACT_SELECT} WHERE a.session_id = ? ORDER BY a.id`).all(sessionId) as unknown as ArtifactRow[]).map(toArtifact);
    },

    forProject(project, limit) {
      const sql = `${ARTIFACT_SELECT} WHERE a.project = ? ORDER BY a.updated_at DESC, a.id DESC`;
      const rows = limit !== undefined
        ? db.prepare(`${sql} LIMIT ?`).all(project, Math.max(0, Math.floor(limit)))
        : db.prepare(sql).all(project);
      return (rows as unknown as ArtifactRow[]).map(toArtifact);
    },

    get(id) {
      const r = row(id);
      if (!r) return null;
      const versions = (db
        .prepare(
          `SELECT artifact_id, version, created_at, length(CAST(html AS BLOB)) AS bytes, note
           FROM artifact_versions WHERE artifact_id = ? ORDER BY version`,
        )
        .all(id) as { artifact_id: number; version: number; created_at: string; bytes: number; note: string }[])
        .map((v): ArtifactVersion => ({ artifactId: Number(v.artifact_id), version: Number(v.version), createdAt: v.created_at, bytes: Number(v.bytes), note: v.note }));
      return { artifact: toArtifact(r), versions } satisfies ArtifactDetail;
    },

    html(id, version) {
      const r = db.prepare("SELECT html FROM artifact_versions WHERE artifact_id = ? AND version = ?").get(id, version) as { html: string } | undefined;
      return r ? r.html : null;
    },

    post(sessionId, input) {
      const session = db.prepare("SELECT project FROM sessions WHERE id = ?").get(sessionId) as { project: string } | undefined;
      if (!session) throw new HttpError(404, `unknown session ${sessionId}`);
      if (typeof input.title !== "string" || !oneLine(input.title)) throw new HttpError(400, "title is required: a short name for the page, e.g. \"Pick a layout\"");
      const title = oneLine(input.title);
      if (title.length > TITLE_MAX_CHARS) throw new HttpError(400, `title is over ${TITLE_MAX_CHARS} characters; use a short name and put details in the page or the note`);
      if (typeof input.html !== "string" || !input.html.trim()) throw new HttpError(400, "html is required: one complete, self-contained HTML document");
      const bytes = Buffer.byteLength(input.html, "utf8");
      if (bytes > HTML_MAX_BYTES) {
        throw new HttpError(413, `html is ${formatBytes(bytes)}, over the 8 MB limit; make the page smaller (inline only the styles, scripts and images it needs)`);
      }
      if (input.note !== undefined && input.note !== null && typeof input.note !== "string") throw new HttpError(400, "note must be text");
      const note = (input.note ?? "").trim();
      if (note.length > NOTE_MAX_CHARS) throw new HttpError(400, `note is over ${NOTE_MAX_CHARS} characters`);
      let artifactId: number | null = null;
      if (input.artifactId !== undefined && input.artifactId !== null) {
        artifactId = positiveInt(input.artifactId);
        if (artifactId === null) throw new HttpError(400, "artifact_id must be the id of an artifact this session posted (a positive integer); omit it to post a new artifact");
      }

      const at = now();
      return bus.batch(() => {
        let version: number;
        let id: number;
        db.exec("BEGIN IMMEDIATE");
        try {
          if (artifactId !== null) {
            const existing = db.prepare("SELECT session_id FROM artifacts WHERE id = ?").get(artifactId) as { session_id: string } | undefined;
            if (!existing || existing.session_id !== sessionId) {
              throw new HttpError(404, `artifact ${artifactId} isn't one of this session's artifacts; omit artifact_id to post a new artifact`);
            }
            id = artifactId;
            const max = db.prepare("SELECT coalesce(max(version), 0) AS v FROM artifact_versions WHERE artifact_id = ?").get(id) as { v: number };
            version = Number(max.v) + 1;
            db.prepare("UPDATE artifacts SET title = ?, updated_at = ? WHERE id = ?").run(title, at, id);
          } else {
            const res = db
              .prepare("INSERT INTO artifacts (project, session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
              .run(session.project, sessionId, title, at, at);
            id = Number(res.lastInsertRowid);
            version = 1;
          }
          db.prepare("INSERT INTO artifact_versions (artifact_id, version, html, note, created_at) VALUES (?, ?, ?, ?, ?)").run(id, version, input.html, note, at);
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        const artifact = toArtifact(row(id)!);
        bus.emit({ type: "artifact.updated", sessionId, artifact });
        return { artifact, version };
      });
    },

    hostTools(sessionId) {
      const tool: HostTool = {
        name: POST_ARTIFACT_TOOL,
        description:
          "Show the user an HTML page in Odin (a mockup, a chart, a form to pick from options). Pass one complete, " +
          "self-contained HTML document (max 8 MB): inline all CSS, JS and images (data: URLs); it can't load anything " +
          "from the network. It runs in a sandbox. `window.odin.submit(data)` sends JSON (max 64 KB) back to you as " +
          "the user's answer, after they confirm; `window.odin.theme` has Odin's --iu-* CSS token values. Pass " +
          "artifact_id to post a new version of an artifact you posted earlier in this session.",
        params: {
          title: { type: "string", description: "Short name for the page, shown to the user." },
          html: { type: "string", description: "The complete HTML document." },
          note: { type: "string", description: "What changed or what you want from the user (shown with this version).", optional: true },
          artifact_id: { type: "number", description: "An artifact id from an earlier post_artifact in this session, to post a new version of it.", optional: true },
        },
        async handler(input) {
          try {
            const { artifact, version } = service.post(sessionId, {
              title: input.title as string,
              html: input.html as string,
              note: input.note as string | undefined,
              artifactId: input.artifact_id as number | undefined,
            });
            return { text: `Posted artifact ${artifact.id} v${version}` };
          } catch (err) {
            const message = err instanceof HttpError ? err.message : "couldn't store the artifact";
            if (!(err instanceof HttpError)) console.error("post_artifact failed:", err instanceof Error ? err.message : err);
            return { text: `post_artifact failed: ${message}`, isError: true };
          }
        },
      };
      return [tool];
    },

    async submit(id, req) {
      const r = row(id);
      if (!r) throw new HttpError(404, `unknown artifact ${id}`);
      if (!req || typeof req !== "object" || Array.isArray(req)) throw new HttpError(400, "expected a JSON object");
      const version = positiveInt(req.version);
      if (version === null || typeof req.version !== "number") throw new HttpError(400, "version must be a positive integer");
      if (!versionExists(id, version)) throw new HttpError(404, `artifact ${id} has no version ${version}`);
      if (!("data" in req)) throw new HttpError(400, "data is required");
      const json = JSON.stringify(req.data);
      if (json === undefined) throw new HttpError(400, "data must be JSON");
      if (Buffer.byteLength(json, "utf8") > SUBMIT_MAX_BYTES) throw new HttpError(413, `data is over ${SUBMIT_MAX_BYTES} bytes of JSON`);
      const session: Session | null = services.sessions.get(r.session_id);
      if (!session) throw new HttpError(404, `unknown session ${r.session_id}`);
      if (session.state === "waiting") throw new HttpError(409, "the session is waiting for an answer to a prompt");
      return services.sessions.send(r.session_id, { text: submitMessage(r.title, version, req.data) });
    },
  };
  return service;
}
