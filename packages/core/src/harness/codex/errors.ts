/** Only classified messages cross the wire; raw runtime errors may contain secrets. */
export function codexFailure(error: unknown): string {
  if (error && typeof error === "object") {
    const info = (error as { codexErrorInfo?: unknown }).codexErrorInfo;
    const code = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : null;
    if (code === "usageLimitExceeded")
      return "Codex usage limit reached. Your session is preserved. Retry after your usage resets, or change the model before sending another message.";
    if (code === "httpConnectionFailed" || code === "responseStreamConnectionFailed")
      return "Codex connection failed. Your session is preserved; try sending another message.";
  }
  return "Codex turn failed";
}
