/** Only a saved artifact/version may be printed; callers cannot supply HTML or arbitrary URLs. */
export function artifactPdfUrl(origin: string, id: unknown, version: unknown): string {
  if (!Number.isSafeInteger(id) || Number(id) < 1 || !Number.isSafeInteger(version) || Number(version) < 1) throw new Error("Invalid artifact version");
  const url = new URL(origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Invalid core origin");
  return `${url.origin}/a/${id}/${version}`;
}
