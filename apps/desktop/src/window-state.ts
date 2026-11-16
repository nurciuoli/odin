// Window size, position and maximised state in <home>/desktop.json. Other keys in the file are preserved.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export const DEFAULT_STATE: WindowState = { width: 1280, height: 860, maximized: false };
const MIN_W = 480;
const MIN_H = 360;

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Validates a saved state against the current displays' work areas. A position off every display is dropped. */
export function validateState(raw: unknown, displays: Rect[]): WindowState {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const width = num(s.width) && s.width >= MIN_W ? Math.round(s.width) : DEFAULT_STATE.width;
  const height = num(s.height) && s.height >= MIN_H ? Math.round(s.height) : DEFAULT_STATE.height;
  const state: WindowState = { width, height, maximized: s.maximized === true };
  if (num(s.x) && num(s.y)) {
    const rect = { x: Math.round(s.x), y: Math.round(s.y), width, height };
    // Require a reachable strip (the title bar area) on some display, not just a sliver.
    const titleBar = { x: rect.x + 40, y: rect.y, width: Math.max(1, width - 80), height: 30 };
    if (displays.some((d) => intersects(titleBar, d))) {
      state.x = rect.x;
      state.y = rect.y;
    }
  }
  return state;
}

export function readDesktopFile(file: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function loadWindowState(file: string, displays: Rect[]): WindowState {
  return validateState(readDesktopFile(file).window, displays);
}

export function saveWindowState(file: string, state: WindowState): void {
  const data = readDesktopFile(file);
  data.window = state;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
