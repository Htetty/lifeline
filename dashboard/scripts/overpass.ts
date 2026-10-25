// Runs an Overpass (OpenStreetMap) query, retrying across public mirrors: the main server is
// often busy or refusing connections.

const SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

export async function overpass<T>(query: string): Promise<T[]> {
  for (const wait of [0, 15, 30, 60]) {
    await new Promise((r) => setTimeout(r, wait * 1000));
    for (const server of SERVERS) {
      try {
        const res = await fetch(server, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "hurricaneai-flood-demo/0.1" },
          body: new URLSearchParams({ data: query }),
        });
        const text = await res.text();
        if (res.ok && text.startsWith("{")) return JSON.parse(text).elements;
        console.warn(`${new URL(server).host} busy (${res.status})`);
      } catch (e) {
        console.warn(`${new URL(server).host} unreachable (${(e as Error).message})`);
      }
    }
  }
  throw new Error("No Overpass server answered; try again later");
}
