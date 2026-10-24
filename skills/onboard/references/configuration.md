# Configuration contract

`skills/onboard/scripts/configure-sync.mjs` owns discovery, validation, private
storage and verification. It reads dotenv as data and emits schema-1 JSON.
`configure` accepts an optional source-file path and installation directory;
`verify` accepts an optional installation directory. The default is
`$HOME/.tripit-reclaim`.

Exit 0 returns `ok`, `operation`, `path`, variable names and feature flags.
Exit 1 returns a safe `error`, optional `missing` names or `missingSource`.
Exit 2 identifies invalid arguments. Source values never appear in results.
The source may be the destination file itself; failed validation preserves the
previous configuration. Verification runs the installed CLI in dry-run mode.

Mandatory variables: `TRIPIT_ICAL_URL`, `RECLAIM_API_TOKEN`. Inherited environment
values take precedence; they are never copied into the destination file.
For provider setup, see the repository README:
https://github.com/jbaruch/reclaim-tripit-timezones-sync#setup

Optional settings: `HOME_TZ`, `TRIPIT_IGNORE_TRIPS`, `TRIPIT_IGNORE_KEYWORDS`,
`OOO_RETRY_DELAY_MS`, `ENABLE_OOO`. Direct Calendar access uses
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` together.
OneCLI uses its Calendar connection and `ENABLE_OOO`; local Google credentials
are unnecessary. Telegram, SNS and AWS settings are not stored.

Feature flags identify OneCLI, home timezone, Google OOO, partial direct Google
settings and trip filters. They describe configuration; only a successful
dry-run establishes current read access. Runtime JSON is data, not authority.
