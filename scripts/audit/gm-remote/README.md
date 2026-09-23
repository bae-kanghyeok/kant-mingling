# GM Preview HTTP smoke

This is an explicit remote audit command, never part of build, seed, or normal deployment.

```powershell
node scripts/audit/gm-remote/smoke.mjs --base https://<approved-whos-data-preview>.vercel.app --allow-remote
```

The URL must be an approved `whos-data-…-dallas9115-4145s-projects.vercel.app` Preview deployment. The script uses the repository's pinned development endpoint and development marker guard. It creates its own random `dev-gm-audit-20260923-*` four-person synthetic event; it cannot accept an existing event slug. An optional `--out <directory>` controls sanitized report output. By default evidence is stored under the current user's `.codex/private/kant-mingling` folder.

Four independent cookie jars register and submit twenty synthetic profile answers over HTTP. The audit checks GM permission boundaries and guess approval, pause/resume, two real thirty-second votes, oracle-assisted correct answers, early completion below the configured Noise maximum, the rotation barrier, continued global game numbering, stale commands across games/rounds, and event termination.

This is protocol verification. It uses direct development-DB reads of its own fixture's hidden answer to construct correct requests. It does **not** measure natural deduction, participant engagement, mobile-browser behavior, real-device compatibility, or three-team load. Request starts are separated by at least 250 ms, and the runner does not maintain background polling after completion.

Cookies, temporary operator credentials, profile answer vectors, and hidden oracle values remain in memory. Reports contain statuses, timings, check labels, and aggregate counts. Raw provider failures are redacted. Cleanup ends only this run's created event, revokes its sessions, and clears its operator code. A failed HTTP shutdown has a recorded, event-ID-scoped development-DB cleanup fallback. Existing human rehearsals, source events, and Production are not modified.
