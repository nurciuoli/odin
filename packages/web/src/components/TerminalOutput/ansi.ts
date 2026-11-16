// CSI sequences (colours, cursor moves), OSC sequences (titles, hyperlinks) and lone two-byte escapes.
/* eslint-disable no-control-regex */
const ANSI =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g
/* eslint-enable no-control-regex */

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/\r\n/g, '\n')
}
