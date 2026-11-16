// The global launcher shortcut: registers the accelerator from settings, swaps it when settings change, and keeps a
// status Settings can show. Failure is reported, never fatal.

export interface ShortcutStatus {
  accelerator: string | null;
  registered: boolean;
  error?: string;
}

export interface GlobalShortcutLike {
  register(accelerator: string, fn: () => void): boolean;
  unregister(accelerator: string): void;
}

export function launcherShortcut(gs: GlobalShortcutLike, onPress: () => void) {
  let current: string | null = null;
  let status: ShortcutStatus = { accelerator: null, registered: false };

  return {
    /** Apply the wanted accelerator (null = off). A no-op when it is already the registered one. */
    apply(wanted: string | null): ShortcutStatus {
      if (wanted === status.accelerator && (status.registered || wanted === null)) return status;
      if (current) {
        gs.unregister(current);
        current = null;
      }
      if (wanted === null) return (status = { accelerator: null, registered: false });
      try {
        if (gs.register(wanted, onPress)) {
          current = wanted;
          status = { accelerator: wanted, registered: true };
        } else {
          status = { accelerator: wanted, registered: false, error: "Another app already uses this shortcut." };
        }
      } catch (err) {
        status = {
          accelerator: wanted,
          registered: false,
          error: `Not a valid shortcut: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return status;
    },
    status: (): ShortcutStatus => ({ ...status }),
  };
}
