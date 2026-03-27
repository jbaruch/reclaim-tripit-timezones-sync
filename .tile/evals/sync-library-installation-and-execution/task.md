# Set Up Automated Travel Timezone Sync

## Problem/Feature Description

A developer on a distributed team travels frequently for conferences and client visits. Their team uses Reclaim.ai for scheduling, and colleagues keep booking meetings during travel when the developer is in a completely different timezone. The developer has heard about a TripIt-to-Reclaim sync tool that can automatically update timezone segments in Reclaim based on their TripIt travel itinerary, preventing these scheduling conflicts.

The developer wants a shell script they can run manually (or schedule via cron) that ensures the sync tool is available and runs it to update Reclaim. The script should be robust — it should install the tool if it isn't already present, run the sync, and capture its output so they can tell whether anything changed or if there were errors.

## Output Specification

Produce a shell script named `run-sync.sh` that can be executed directly. The script should:

1. Check whether the sync tool is already available and install it if needed
2. Run the sync operation and capture its structured output
3. Write the raw JSON output to a file named `sync-output.json` in the same directory as the script
4. Exit with a non-zero code if the sync encountered errors

Assume the following environment variables will be set at runtime:
- `TRIPIT_ICAL_URL`
- `RECLAIM_API_TOKEN`
