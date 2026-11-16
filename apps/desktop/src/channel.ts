// Which install this is. The packaged app is the stable channel; running from source (`yarn dev`) is the dev
// channel, with its own data folder, port, app id and name so the two never share a database, lock or taskbar entry.

export interface Channel {
  name: "stable" | "dev";
  productName: string;
  appId: string;
  home: string;
  port: number;
}

export const STABLE: Channel = { name: "stable", productName: "Odin", appId: "dev.odin.app", home: "~/.odin", port: 8790 };
export const DEV: Channel = { name: "dev", productName: "Odin Dev", appId: "dev.odin.app.dev", home: "~/.odin-dev", port: 8791 };

/** The channel for this run. ODIN_HOME and ODIN_PORT still override its folder and port. */
export function channelFor(packaged: boolean, env: Record<string, string | undefined>): Channel {
  const base = packaged ? STABLE : DEV;
  return { ...base, home: env.ODIN_HOME || base.home, port: Number(env.ODIN_PORT) || base.port };
}
