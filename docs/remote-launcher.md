# Optional direct debug launcher

The normal TizenBrew startup opens the frontend, starts its background service, then exits and reopens the frontend in debug mode. A remote controller can skip the initial frontend launch when the background service is already running.

This fork provides an opt-in HTTP listener on port 8097. It is disabled unless the service configuration at `/home/owner/share/tizenbrewConfig.json` contains:

```json
{
  "remoteLauncher": {
    "enabled": true,
    "token": "<64 lowercase hexadecimal characters generated from 32 random bytes>"
  }
}
```

Merge this field into the existing configuration; preserve the module list and auto-launch setting. Restart the service after changing it. Keep the token private. The listener uses HTTP on the local network and should not be exposed to the internet.

Both routes require `Authorization: Bearer <token>`:

- `GET /status` reports readiness, whether a debugger is attached, and launch/resume counters. It does not launch anything.
- `POST /launch` accepts an empty body. It either starts this installation's frontend directly in debug mode or resumes its existing debug session at the configured auto-launch page. It accepts no arbitrary app IDs, URLs, or commands.

A successful POST returns `200` with `accepted: true` and `mode: "debug"` or `"resume"`. A concurrent request returns `202` while the current operation continues. An active page that differs from the configured auto-launch page returns `409`, preserving deliberate manual navigation. Authentication failures return `401`; failures to confirm a launch return `503`.

For Home Assistant, use built-in REST commands and a script:

1. Wake the TV if necessary.
2. Read launcher status.
3. If ready, send one direct-launch POST.
4. If the service cannot be reached, or reports that it is still initializing, use the normal Samsung app-launch API once to bootstrap it.
5. Report authentication errors, unexpected responses, or failed direct requests. Do not send a normal launch after a direct POST times out: the first request may already have succeeded.

Store the Authorization header in HA's `secrets.yaml`. No custom Home Assistant integration is required.

The direct path removes the ordinary frontend launch before debug startup. Resuming an existing session avoids document navigation. Neither behavior guarantees that Samsung firmware will hide every native loading overlay. After a full TV reboot, the background service may need the normal bootstrap path before direct launch is available again. Standby/Wake-on-LAN and a full OS reboot are different cases.
