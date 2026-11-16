// Placeholders for modules that aren't built yet: the app still boots, and calling a missing method fails loudly.
export function notImplemented<T extends object>(module: string): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      if (prop === "close") return () => {};
      if (prop === "then") return undefined;
      return () => {
        throw new Error(`${module}.${String(prop)} is not implemented yet`);
      };
    },
  });
}

/** A stub with some methods filled in (safe defaults other modules may call while booting). */
export function partialStub<T extends object>(module: string, impl: Partial<T>): T {
  const rest = notImplemented<T>(module);
  return new Proxy(impl as T, {
    get(target, prop, receiver) {
      return prop in target ? Reflect.get(target, prop, receiver) : Reflect.get(rest, prop);
    },
  });
}

/** A listener registry for stubs: `onX(listener)` that never fires. */
export const neverFires = () => () => {};
