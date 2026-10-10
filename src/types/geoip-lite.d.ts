declare module "geoip-lite" {
  interface Lookup {
    country: string;
    region: string;
    city: string;
    ll: [number, number];
  }

  const geoip: { lookup(ip: string): Lookup | null };

  export default geoip;
}
