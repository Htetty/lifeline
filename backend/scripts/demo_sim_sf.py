"""Demo simulation on the San Francisco Marina shore (Golden Gate side), same as demo_sim.py.

    python scripts/demo_sim_sf.py                    # ~1.5 min: 11 callers, water peaks after 60 s
    python scripts/demo_sim_sf.py --calls 46 --rise 150 --max-turns 5   # the long version
    python scripts/demo_sim_sf.py --calls 3 --rise 30   # a short smoke test

Replays the Jan 27, 1983 record storm tide at the Golden Gate (NOAA 9414290) plus 1 m of
sea-level rise, with callers from backend/scripts/sim/sf-waterfront.json. Takes every
demo_sim.py option; see `python scripts/demo_sim.py --help`.
"""

import sys

from demo_sim import main

if __name__ == "__main__":
    if "--region" not in sys.argv:
        sys.argv[1:1] = ["--region", "sf-waterfront"]
    main()
