/**
 * RD New (EPSG:28992) <-> WGS84 (EPSG:4326) by the Kadaster polynomial
 * approximation (Schreutelkamp and Strang van Hees). Within the Netherlands it
 * stays within a few decimetres of RDNAPTRANS: against PDOK Locatieserver
 * points it is a constant 0.3 m off (the ETRS89 datum offset), far below what
 * a representative map point needs. No dependency: two polynomials do not
 * justify proj4.
 */

const PHI0 = 52.1551744;
const LAMBDA0 = 5.38720621;
const X0 = 155000;
const Y0 = 463000;

type Term = readonly [p: number, q: number, coefficient: number];

/** Latitude (arcseconds) from dX, dY in units of 100 km. */
const LAT_TERMS: readonly Term[] = [
  [0, 1, 3235.65389], [2, 0, -32.58297], [0, 2, -0.2475], [2, 1, -0.84978],
  [0, 3, -0.0655], [2, 2, -0.01709], [1, 0, -0.00738], [4, 0, 0.0053],
  [2, 3, -0.00039], [4, 1, 0.00033], [1, 1, -0.00012],
];

/** Longitude (arcseconds) from dX, dY. */
const LON_TERMS: readonly Term[] = [
  [1, 0, 5260.52916], [1, 1, 105.94684], [1, 2, 2.45656], [3, 0, -0.81885],
  [1, 3, 0.05594], [3, 1, -0.05607], [0, 1, 0.01199], [3, 2, -0.00256],
  [1, 4, 0.00128], [0, 2, 0.00022], [2, 0, -0.00022], [5, 0, 0.00026],
];

/** X (metres) from dPhi, dLambda in units of 10,000 arcseconds. */
const X_TERMS: readonly Term[] = [
  [0, 1, 190094.945], [1, 1, -11832.228], [2, 1, -114.221], [0, 3, -32.391],
  [1, 0, -0.705], [3, 1, -2.34], [1, 3, -0.608], [0, 2, -0.008], [2, 3, 0.148],
];

/** Y (metres) from dPhi, dLambda. */
const Y_TERMS: readonly Term[] = [
  [1, 0, 309056.544], [0, 2, 3638.893], [2, 0, 73.077], [1, 2, -157.984],
  [3, 0, 59.788], [0, 1, 0.433], [2, 2, -6.439], [1, 1, -0.032],
  [0, 4, 0.092], [1, 4, -0.054],
];

function polynomial(terms: readonly Term[], a: number, b: number): number {
  let sum = 0;
  for (const [p, q, coefficient] of terms) sum += coefficient * a ** p * b ** q;
  return sum;
}

export function rdToWgs84(x: number, y: number): { lat: number; lon: number } {
  const dX = (x - X0) * 1e-5;
  const dY = (y - Y0) * 1e-5;
  return {
    lat: PHI0 + polynomial(LAT_TERMS, dX, dY) / 3600,
    lon: LAMBDA0 + polynomial(LON_TERMS, dX, dY) / 3600,
  };
}

export function wgs84ToRd(lon: number, lat: number): { x: number; y: number } {
  const dPhi = 0.36 * (lat - PHI0);
  const dLambda = 0.36 * (lon - LAMBDA0);
  return { x: X0 + polynomial(X_TERMS, dPhi, dLambda), y: Y0 + polynomial(Y_TERMS, dPhi, dLambda) };
}
