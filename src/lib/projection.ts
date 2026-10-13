import { geoProjection, type GeoProjection } from "d3-geo";

/**
 * geoMiller is Miller's cylindrical projection: Mercator's familiar shapes,
 * with the far north stretched far less, so Canada and Russia neither swell
 * as on Mercator nor flatten as on an equal-area map.
 */
export function geoMiller(): GeoProjection {
  return geoProjection((x, y) => [x, 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * y))]);
}
