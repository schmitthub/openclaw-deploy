import { SSHD_PORT, FILEBROWSER_PORT } from "../config/defaults";

/**
 * Renders Tailscale Serve JSON config (serve-config.json).
 *
 * Uses ${TS_CERT_DOMAIN} which containerboot substitutes at runtime
 * with the node's actual Tailscale FQDN.
 */
export function renderServeConfig(
  gatewayPort: number,
  sshdPort: number = SSHD_PORT,
  filebrowserPort: number = FILEBROWSER_PORT,
): string {
  const config = {
    TCP: {
      "443": { HTTPS: true },
      "22": { TCPForward: `127.0.0.1:${sshdPort}` },
    },
    Web: {
      "${TS_CERT_DOMAIN}:443": {
        Handlers: {
          "/": { Proxy: `http://127.0.0.1:${gatewayPort}` },
          "/browse/": { Proxy: `http://127.0.0.1:${filebrowserPort}` },
        },
      },
    },
    AllowFunnel: {
      "${TS_CERT_DOMAIN}:443": false,
    },
  };
  return JSON.stringify(config, null, 2) + "\n";
}
