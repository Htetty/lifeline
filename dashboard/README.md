# Lifeline dispatcher dashboard

The product's Next.js application contains the landing page, `/console`, MapLibre maps, flood-aware routing, and the Convex backend in `convex/`.

Start with [the project README](../README.md) for installation and the isolated local launcher. See [the Convex hackathon log](../hackathon.md) for implementation evidence and [the Cartesia guide](../CARTESIA.md) for voice setup.

## Existing development deployment

From this directory, install with `npm ci`. Configure `NEXT_PUBLIC_CONVEX_URL` privately to match the backend's `CONVEX_URL`. For a backend port other than the dashboard's default, configure `NEXT_PUBLIC_BACKEND_URL` before starting Next.js.

```sh
npm run dev -- --port 3100
```

Open `/console`. The queue, map, detail sheet, teams, and activity feed subscribe to Convex state. Voice enters through FastAPI.

## Checks

```sh
npm run test:voice
npm run test:priority
npm run build
```

`test:voice` runs dashboard Vitest fixtures; it does not place a live call. The `postinstall` script copies the MapLibre worker into `public/`. Git ignores that generated file and local Convex state.
