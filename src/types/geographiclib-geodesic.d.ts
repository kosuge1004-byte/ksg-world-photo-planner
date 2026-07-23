declare module "geographiclib-geodesic" {
  interface InverseResult {
    lat1: number;
    lon1: number;
    lat2: number;
    lon2: number;
    a12: number;
    s12: number;
    azi1: number;
    azi2: number;
  }

  interface DirectResult {
    lat1: number;
    lon1: number;
    azi1: number;
    lat2: number;
    lon2: number;
    azi2: number;
    a12: number;
    s12: number;
  }

  interface GeodesicInstance {
    Inverse(
      lat1: number,
      lon1: number,
      lat2: number,
      lon2: number,
      outmask?: number
    ): InverseResult;
    Direct(
      lat1: number,
      lon1: number,
      azi1: number,
      s12: number,
      outmask?: number
    ): DirectResult;
  }

  export const Geodesic: {
    STANDARD: number;
    WGS84: GeodesicInstance;
  };
}
