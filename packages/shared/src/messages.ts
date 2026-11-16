/** Decoded attachment limits, shared by message validation and the browser composer. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Includes JSON/base64 overhead. Text with extensive JSON escaping can reach this before its decoded limit. */
export const MAX_MESSAGE_BODY_BYTES = 32 * 1024 * 1024;
