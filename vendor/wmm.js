// World Magnetic Model 2025 (NOAA/NCEI + BGS), degree/order 12, epoch 2025.0, valid to 2030.0.
// Compact spherical-harmonic implementation; coefficients are the official WMM2025 WMM.COF values.
// Public domain data (US/UK governments). Classic script and CommonJS.
(function (root) {
'use strict';
const EPOCH = 2025.0, VALID_TO = 2030.0;
// n,m,g,h,gdot,hdot (nT, nT/yr)
const COF = '1,0,-29351.8,0,12,0;1,1,-1410.8,4545.4,9.7,-21.5;2,0,-2556.6,0,-11.6,0;2,1,2951.1,-3133.6,-5.2,-27.7;2,2,1649.3,-815.1,-8,-12.1;3,0,1361,0,-1.3,0;3,1,-2404.1,-56.6,-4.2,4;3,2,1243.8,237.5,0.4,-0.3;3,3,453.6,-549.5,-15.6,-4.1;4,0,895,0,-1.6,0;4,1,799.5,278.6,-2.4,-1.1;4,2,55.7,-133.9,-6,4.1;4,3,-281.1,212,5.6,1.6;4,4,12.1,-375.6,-7,-4.4;5,0,-233.2,0,0.6,0;5,1,368.9,45.4,1.4,-0.5;5,2,187.2,220.2,0,2.2;5,3,-138.7,-122.9,0.6,0.4;5,4,-142,43,2.2,1.7;5,5,20.9,106.1,0.9,1.9;6,0,64.4,0,-0.2,0;6,1,63.8,-18.4,-0.4,0.3;6,2,76.9,16.8,0.9,-1.6;6,3,-115.7,48.8,1.2,-0.4;6,4,-40.9,-59.8,-0.9,0.9;6,5,14.9,10.9,0.3,0.7;6,6,-60.7,72.7,0.9,0.9;7,0,79.5,0,0,0;7,1,-77,-48.9,-0.1,0.6;7,2,-8.8,-14.4,-0.1,0.5;7,3,59.3,-1,0.5,-0.8;7,4,15.8,23.4,-0.1,0;7,5,2.5,-7.4,-0.8,-1;7,6,-11.1,-25.1,-0.8,0.6;7,7,14.2,-2.3,0.8,-0.2;8,0,23.2,0,-0.1,0;8,1,10.8,7.1,0.2,-0.2;8,2,-17.5,-12.6,0,0.5;8,3,2,11.4,0.5,-0.4;8,4,-21.7,-9.7,-0.1,0.4;8,5,16.9,12.7,0.3,-0.5;8,6,15,0.7,0.2,-0.6;8,7,-16.8,-5.2,0,0.3;8,8,0.9,3.9,0.2,0.2;9,0,4.6,0,0,0;9,1,7.8,-24.8,-0.1,-0.3;9,2,3,12.2,0.1,0.3;9,3,-0.2,8.3,0.3,-0.3;9,4,-2.5,-3.3,-0.3,0.3;9,5,-13.1,-5.2,0,0.2;9,6,2.4,7.2,0.3,-0.1;9,7,8.6,-0.6,-0.1,-0.2;9,8,-8.7,0.8,0.1,0.4;9,9,-12.9,10,-0.1,0.1;10,0,-1.3,0,0.1,0;10,1,-6.4,3.3,0,0;10,2,0.2,0,0.1,0;10,3,2,2.4,0.1,-0.2;10,4,-1,5.3,0,0.1;10,5,-0.6,-9.1,-0.3,-0.1;10,6,-0.9,0.4,0,0.1;10,7,1.5,-4.2,-0.1,0;10,8,0.9,-3.8,-0.1,-0.1;10,9,-2.7,0.9,0,0.2;10,10,-3.9,-9.1,0,0;11,0,2.9,0,0,0;11,1,-1.5,0,0,0;11,2,-2.5,2.9,0,0.1;11,3,2.4,-0.6,0,0;11,4,-0.6,0.2,0,0.1;11,5,-0.1,0.5,-0.1,0;11,6,-0.6,-0.3,0,0;11,7,-0.1,-1.2,0,0.1;11,8,1.1,-1.7,-0.1,0;11,9,-1,-2.9,-0.1,0;11,10,-0.2,-1.8,-0.1,0;11,11,2.6,-2.3,-0.1,0;12,0,-2,0,0,0;12,1,-0.2,-1.3,0,0;12,2,0.3,0.7,0,0;12,3,1.2,1,0,-0.1;12,4,-1.3,-1.4,0,0.1;12,5,0.6,0,0,0;12,6,0.6,0.6,0.1,0;12,7,0.5,-0.1,0,0;12,8,-0.1,0.8,0,0;12,9,-0.4,0.1,0,0;12,10,-0.2,-1,-0.1,0;12,11,-1.3,0.1,0,0;12,12,-0.7,0.2,-0.1,-0.1';
const A_REF = 6371.2;                     // geomagnetic reference radius, km
const WGS_A = 6378.137, WGS_F = 1 / 298.257223563, WGS_E2 = WGS_F * (2 - WGS_F);
const N = 12;
const G = [], H = [], GD = [], HD = [];
for (let n = 0; n <= N; n++) { G.push(new Array(N + 2).fill(0)); H.push(new Array(N + 2).fill(0)); GD.push(new Array(N + 2).fill(0)); HD.push(new Array(N + 2).fill(0)); }
COF.split(';').forEach((r) => { const a = r.split(',').map(Number); G[a[0]][a[1]] = a[2]; H[a[0]][a[1]] = a[3]; GD[a[0]][a[1]] = a[4]; HD[a[0]][a[1]] = a[5]; });

// Field components at geodetic lat/lon (deg), height above ellipsoid (km), decimal year.
// Returns { x (north), y (east), z (down), h, f, decl, incl } in nT / degrees. Declination is east positive.
function field(lat, lon, altKm, year) {
  const rad = Math.PI / 180;
  lat = Math.max(-89.9999, Math.min(89.9999, lat));
  const dt = year - EPOCH;
  const phi = lat * rad, lam = lon * rad;
  const sp = Math.sin(phi), cp = Math.cos(phi);
  const rc = WGS_A / Math.sqrt(1 - WGS_E2 * sp * sp);
  const p = (rc + altKm) * cp, z = (rc * (1 - WGS_E2) + altKm) * sp;
  const r = Math.sqrt(p * p + z * z);
  const phiG = Math.asin(z / r);            // geocentric latitude
  const th = Math.PI / 2 - phiG;            // colatitude
  const ct = Math.cos(th), st = Math.sin(th);
  // Schmidt semi-normalised associated Legendre functions and their theta-derivatives
  const P = [], dP = [];
  for (let n = 0; n <= N; n++) { P.push(new Array(N + 2).fill(0)); dP.push(new Array(N + 2).fill(0)); }
  P[0][0] = 1;
  for (let n = 1; n <= N; n++) {
    const k = n === 1 ? 1 : Math.sqrt(1 - 1 / (2 * n));
    P[n][n] = k * st * P[n - 1][n - 1];
    dP[n][n] = k * (st * dP[n - 1][n - 1] + ct * P[n - 1][n - 1]);
    for (let m = 0; m < n; m++) {
      const d = Math.sqrt(n * n - m * m);
      const e = n - 1 > m ? Math.sqrt((n - 1) * (n - 1) - m * m) : 0;
      const p2 = n - 2 >= m ? P[n - 2][m] : 0, d2 = n - 2 >= m ? dP[n - 2][m] : 0;
      P[n][m] = ((2 * n - 1) * ct * P[n - 1][m] - e * p2) / d;
      dP[n][m] = ((2 * n - 1) * (ct * dP[n - 1][m] - st * P[n - 1][m]) - e * d2) / d;
    }
  }
  let br = 0, bt = 0, bp = 0;
  const ar = A_REF / r;
  for (let n = 1; n <= N; n++) {
    const f = Math.pow(ar, n + 2);
    for (let m = 0; m <= n; m++) {
      const g = G[n][m] + GD[n][m] * dt, h = H[n][m] + HD[n][m] * dt;
      const cm = Math.cos(m * lam), sm = Math.sin(m * lam);
      const gh = g * cm + h * sm;
      br += (n + 1) * f * gh * P[n][m];
      bt -= f * gh * dP[n][m];
      bp -= f * m * (-g * sm + h * cm) * P[n][m] / st;   // Bphi = -(1/sin th) * sum ...
    }
  }
  const xg = -bt, yg = bp, zg = -br;        // north, east, down (geocentric frame)
  const psi = phiG - phi;                   // rotate to geodetic frame
  const x = xg * Math.cos(psi) - zg * Math.sin(psi);
  const zz = xg * Math.sin(psi) + zg * Math.cos(psi);
  const hh = Math.sqrt(x * x + yg * yg);
  return { x, y: yg, z: zz, h: hh, f: Math.sqrt(hh * hh + zz * zz), decl: Math.atan2(yg, x) / rad, incl: Math.atan2(zz, hh) / rad };
}

function declination(lat, lon, altKm, year) { return field(lat, lon, altKm || 0, year).decl; }

// Decimal year for a Date (UTC).
function decimalYear(d) {
  const y = d.getUTCFullYear(), a = Date.UTC(y, 0, 1), b = Date.UTC(y + 1, 0, 1);
  return y + (d.getTime() - a) / (b - a);
}

const WMM = { EPOCH, VALID_TO, field, declination, decimalYear };
if (typeof module !== 'undefined' && module.exports) module.exports = WMM; else root.WMM = WMM;
})(this);
