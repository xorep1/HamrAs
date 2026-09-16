import { networkInterfaces } from "node:os";

// Next's dev server rejects cross-origin requests to dev-only resources (HMR, dev assets) unless the
// requesting hostname is listed. The app is opened from this machine's own LAN addresses, so they are
// derived here rather than pinned to an address DHCP can change. Only the Origin hostname is matched,
// without scheme or port. Extra hostnames can be added through LAN_HOSTS, the same variable the
// signaling server uses for its own Host allow-list. Production builds ignore this option.
const origins = new Set(["localhost", "127.0.0.1", "[::1]"]);
for (const item of Object.values(networkInterfaces()).flat()) {
  if (!item) continue;
  const address = item.address.split("%")[0];
  origins.add(address);
  origins.add(`[${address}]`);
}
for (const host of (process.env.LAN_HOSTS || "").split(",").filter(Boolean)) origins.add(host.trim().toLowerCase());

const nextConfig = { allowedDevOrigins: [...origins] };

export default nextConfig;
