// Coarse node locations. The address itself stays on the server: only a
// country, city and approximate coordinates are shown to viewers.

import geoip from "geoip-lite";
import type { Geo } from "../lib/protocol.ts";

export function lookupGeo(ip: string): Geo | null {
  const geo = geoip.lookup(ip);

  return geo === null ? null : { country: geo.country, city: geo.city, ll: geo.ll };
}
