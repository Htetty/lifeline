import { Map, Marker, setWorkerUrl } from "/maplibre-gl.mjs";

setWorkerUrl("/maplibre-gl-worker.mjs");
const status = document.querySelector("#status");
const confirm = document.querySelector("#confirm");
const recenter = document.querySelector("#recenter");
let latest, submitted, watchId, marker, mapLoaded = false, following = true;
const map = new Map({
  container: "map", center: [0, 20], zoom: 1.5, attributionControl: { compact: true },
  style: { version: 8, sources: { osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    tileSize: 256, maxzoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' } },
    layers: [{ id: "map", type: "raster", source: "osm" }] },
});
map.on("dragstart", () => { following = false; });
map.on("load", () => { mapLoaded = true; if (latest) paintLocation(true); });
map.on("idle", () => {
  if (latest && map.getZoom() >= 12) document.body.dataset.mapReady = "true";
});

function accuracyCircle(lng, lat, meters) {
  const points = [];
  const radius = Math.min(meters, 50000);
  for (let i = 0; i <= 64; i++) {
    const angle = 2 * Math.PI * i / 64;
    points.push([lng + radius * Math.cos(angle) / (111320 * Math.max(.01, Math.cos(lat * Math.PI / 180))),
      Math.max(-85, Math.min(85, lat + radius * Math.sin(angle) / 111320))]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [points] } };
}
function paintLocation(initial = false) {
  if (!latest) return;
  const point = [latest.longitude, latest.latitude];
  if (!marker) {
    const dot = document.createElement("div"); dot.className = "user-dot"; dot.setAttribute("aria-label", "Your current position");
    marker = new Marker({ element: dot }).setLngLat(point).addTo(map);
  } else marker.setLngLat(point);
  if (mapLoaded) {
    const data = accuracyCircle(...point, latest.accuracy);
    if (map.getSource("accuracy")) map.getSource("accuracy").setData(data);
    else {
      map.addSource("accuracy", { type: "geojson", data });
      map.addLayer({ id: "accuracy-fill", type: "fill", source: "accuracy", paint: { "fill-color": "#1680ff", "fill-opacity": .1 } });
      map.addLayer({ id: "accuracy-line", type: "line", source: "accuracy", paint: { "line-color": "#1680ff", "line-opacity": .2, "line-width": 1 } });
    }
  }
  if (following || initial) map.easeTo({ center: point, zoom: latest.accuracy > 1000 ? 12 : 16,
    padding: { top: 0, bottom: 140, left: 0, right: 0 }, duration: initial ? 0 : 600 });
}
function locate() {
  if (submitted) return;
  if (!navigator.geolocation) { status.textContent = "Location access isn’t available in this browser."; return; }
  if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
  following = true;
  status.textContent = "Finding you…";
  confirm.disabled = true;
  latest = undefined;
  watchId = navigator.geolocation.watchPosition(position => {
    if (submitted) return;
    latest = { latitude: position.coords.latitude, longitude: position.coords.longitude,
      accuracy: position.coords.accuracy, capturedAt: position.timestamp };
    if (!Object.values(latest).every(Number.isFinite)) return;
    paintLocation();
    status.textContent = "";
    confirm.disabled = false;
  }, error => {
    if (submitted) return;
    status.textContent = error.code === 1 ? "Allow location access, then tap the arrow to try again."
      : "Couldn’t locate you. Tap the arrow to try again.";
    confirm.disabled = true;
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}
recenter.addEventListener("click", () => {
  if (latest && Date.now() - latest.capturedAt < 120000) { following = true; paintLocation(true); }
  else locate();
});
confirm.addEventListener("click", async () => {
  if (!latest || submitted) return;
  if (Date.now() - latest.capturedAt > 120000) { locate(); return; }
  // Freeze this fix for retries; HTTP failure must not claim success or silently
  // send a different location if the first response was lost.
  submitted = { ...latest };
  if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
  confirm.disabled = true;
  confirm.setAttribute("aria-busy", "true");
  try {
    const token = location.pathname.split("/").pop();
    const response = await fetch(`/api/location/${token}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(submitted) });
    const result = await response.json();
    if (!response.ok || !result.confirmed) throw new Error(result.error ?? "Could not confirm. Try again.");
    status.textContent = "";
    confirm.textContent = "Confirmed";
    confirm.setAttribute("aria-label", "Location confirmed");
    confirm.classList.add("done");
    recenter.hidden = true;
  } catch (error) {
    status.textContent = error.message === "Failed to fetch" ? "Connection lost. Tap again to retry." : error.message;
    latest = submitted; submitted = undefined;
    confirm.disabled = false;
  } finally {
    confirm.removeAttribute("aria-busy");
  }
});
window.addEventListener("pagehide", () => { if (watchId !== undefined) navigator.geolocation.clearWatch(watchId); });
locate();
