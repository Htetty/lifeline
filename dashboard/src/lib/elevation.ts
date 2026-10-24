// Ground elevation from the AWS Terrain Tiles (Terrarium encoding). In San Diego
// these are derived from USGS NED 1/9 arc-second (~3 m) bare-earth data.

const TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
export const DEM_ZOOM = 15;
const TILE_SIZE = 256;

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

function lonToX(lon: number, z: number) {
  return ((lon + 180) / 360) * 2 ** z;
}
function latToY(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z;
}

export class ElevationGrid {
  constructor(
    private readonly data: Float32Array,
    private readonly x0: number,
    private readonly y0: number,
    private readonly cols: number,
    private readonly rows: number,
  ) {}

  /** Ground elevation in metres, or null outside the loaded area. */
  sample(lon: number, lat: number): number | null {
    const px = (lonToX(lon, DEM_ZOOM) - this.x0) * TILE_SIZE - 0.5;
    const py = (latToY(lat, DEM_ZOOM) - this.y0) * TILE_SIZE - 0.5;
    const w = this.cols * TILE_SIZE;
    const h = this.rows * TILE_SIZE;
    if (px < 0 || py < 0 || px >= w - 1 || py >= h - 1) return null;
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const fx = px - ix;
    const fy = py - iy;
    const at = (x: number, y: number) => this.data[y * w + x];
    const top = at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx;
    const bottom = at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  }
}

async function loadTile(z: number, x: number, y: number): Promise<ImageData> {
  const url = TILE_URL.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Elevation tile ${z}/${x}/${y} failed: ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
}

export async function loadElevation(bounds: Bounds): Promise<ElevationGrid> {
  const x0 = Math.floor(lonToX(bounds.west, DEM_ZOOM));
  const x1 = Math.floor(lonToX(bounds.east, DEM_ZOOM));
  const y0 = Math.floor(latToY(bounds.north, DEM_ZOOM));
  const y1 = Math.floor(latToY(bounds.south, DEM_ZOOM));
  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  const w = cols * TILE_SIZE;
  const data = new Float32Array(w * rows * TILE_SIZE);

  const jobs: Promise<void>[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      jobs.push(
        loadTile(DEM_ZOOM, tx, ty).then((img) => {
          const ox = (tx - x0) * TILE_SIZE;
          const oy = (ty - y0) * TILE_SIZE;
          for (let py = 0; py < TILE_SIZE; py++) {
            for (let px = 0; px < TILE_SIZE; px++) {
              const i = (py * TILE_SIZE + px) * 4;
              const v = img.data[i] * 256 + img.data[i + 1] + img.data[i + 2] / 256 - 32768;
              data[(oy + py) * w + ox + px] = v;
            }
          }
        }),
      );
    }
  }
  await Promise.all(jobs);
  return new ElevationGrid(data, x0, y0, cols, rows);
}
