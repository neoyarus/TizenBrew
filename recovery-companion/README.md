# Independent recovery companion

This separate Samsung TV widget starts an authenticated recovery service through an ordinary app launch. It does not depend on TizenBrew's frontend, CDP, or a running TizenBrew service. Replacing the TizenBrew package leaves this package installed separately.

| Resource | Identifier |
| --- | --- |
| Package | `TbRecov001` |
| Visible app | `TbRecov001.RecoveryCompanion` |
| Background service | `TbRecov001.RecoveryService` |
| Target package that recovery may replace | `xvvl3S1bvH` |

The package ID is ten alphanumeric characters, following the [Tizen package-ID requirement](https://github.com/Samsung/tizen-docs/blob/master/docs/application/web/reference/config-xml.md). The service belongs to the companion package; the bootstrap requests only that service through `tizen.application.launchAppControl`. [Samsung's NodeJS background-service example](https://developer.samsung.com/smarttv/develop/guides/smart-hub-preview/implementing-personal-preview.html) uses this launch mechanism. A web application and its service are installed as one package, so the separate identity is necessary for surviving a TizenBrew replacement. [Tizen service packaging](https://github.com/Samsung/tizen-docs/blob/master/docs/application/web/guides/applications/service-app.md) documents that relationship.

## Build and package

Build tooling requires Node.js 22 or newer. The shipped service targets the existing Samsung TV NodeJS service runtime, including Node 4.4.3: the complete dependency bundle is transformed with Babel for that runtime. This is a runtime compatibility target, not a claim that every TV firmware accepts the companion manifest and privileges.

Create a private JSON input **outside the repository** with these fields:

```json
{
  "publicKey": "PEM RSA deployment verification PUBLIC key, at least 2048 bits",
  "tlsKey": "PEM HTTPS server PRIVATE key",
  "tlsCert": "PEM HTTPS server certificate matching tlsKey",
  "port": 8098
}
```

The PC's command/deployment signing private key is not included. The HTTPS server key is included in the personal widget so its service can start without a separate filesystem provisioning step. Keep the generated directory and signed widget private. The build validates key types, the TLS key/certificate pair, and the fixed port; it does not print configuration contents.

Remote-key support can use optional private fields `tvRemoteToken` and `tvRemoteName`. The token must already be authorized by the TV and contain 1–1024 characters; the plain client name must be nonempty and at most 64 UTF-8 bytes. When a token is supplied without a name, the remote module defaults to `HomeAssistant`. Missing token disables remote keys, so existing private configurations remain valid and never trigger a pairing request. The token is packaged only in the ignored personal staging directory; do not publish that directory or signed widget. See the [PC client instructions](client/README.md) for the supported key commands and limits.

An optional private `tvRemoteHost` can select the TV's own IPv4 address when its native remote-control service does not accept loopback connections. The default remains `127.0.0.1`. The build accepts only a canonical IPv4 literal with octets from 0 to 255; the service additionally requires loopback or a noninternal IPv4 address reported by the TV's own network interfaces. Hostnames, URLs, remote machines, and per-request host overrides are rejected. There is no automatic host fallback.

From `recovery-companion`:

```powershell
npm ci
npm test
npm run build -- --config "C:/private/tizen-recovery/build-config.json"
```

The build creates ignored `dist/package/` containing only `config.xml`, `index.html`, `bootstrap.js`, `icon.png`, `service/index.js`, and `service/recovery-config.json`. The generated icon is original code-generated artwork. Configuration is loaded by the service from a separate file next to its bundled entry point. Source files, tests, private PC signing keys, and Node dependencies are not copied to the widget.

Use the Samsung/Tizen SDK and an existing signing profile authorized for the TV to package that prepared directory:

```powershell
tizen package -t wgt -s YOUR_SIGNING_PROFILE -o "C:/private/tizen-recovery/release" -- dist/package
```

This command signs a personal widget; the project does not embed certificate profiles or perform installation. See [Samsung's CLI packaging guide](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/command-line-interface.html) for the installed SDK command's options.

## Starting after a service stop or TV reboot

Open **TizenBrew Recovery** from the TV's app list. Home Assistant can instead request the ordinary app through the TV's existing native REST application launch endpoint using `TbRecov001.RecoveryCompanion`. That launch API must already be reachable and permitted by the TV.

The bootstrap requests its same-package service when the page starts and whenever an existing hidden companion returns to the foreground. It displays whether the platform acknowledged the launch request. The PC client must confirm readiness through authenticated service status; a launch acknowledgment does not prove that TLS configuration loaded or the listener opened. Return/Back hides the visible app without calling `exit()` or stopping its service. There is no public readiness endpoint, embedded client authentication secret, CDP connection, or automatic TizenBrew launch in the bootstrap. See the [PC client instructions](client/README.md) for authenticated status, installation, and the bounded SDB tunnel.

This ordinary developer-signed companion does not register a boot-start service. A full TV OS reboot or a firmware decision to stop the service requires launching the companion again. `background-support="enable"` is not a guarantee of indefinite runtime survival; Tizen documents additional background restrictions. [Background configuration](https://github.com/Samsung/tizen-docs/blob/master/docs/application/web/reference/config-xml.md) describes those limitations. Standby/resume and full OS reboot are separate cases.

## Hardware validation still required

- The new package/app IDs, service declaration, and requested network/application-launch privileges must be accepted by the TV's developer certificate and firmware. Tizen's documentation explicitly notes partner certification requirements for TV web services on Tizen 3.0; existing TizenBrew installation success does not establish support on every older model.
- An ordinary TV icon or native REST launch must execute the bootstrap and start the NodeJS service without CDP.
- The packaged entry's `__dirname` must resolve to its `service/` directory, and the service must be able to read the neighboring private configuration.
- The HTTPS/TLS, RSA authentication, fixed SDB tunnel, and installer path must work on the actual service runtime. Syntax transformation cannot supply missing platform APIs or filesystem privileges.
- Authenticated status must remain reachable after hiding the companion, foregrounding another app, and replacing only `xvvl3S1bvH`. Service survival under standby and memory pressure must be measured. Full reboot recovery must use the ordinary companion launch fallback.

The local tests cover bootstrap deadlines and failure reporting, same-package service identity, lifecycle idempotence, and private configuration log handling. They do not establish any of these firmware behaviors.

On the development S90C running Tizen 9.0, the signed companion installed successfully and an ordinary native REST launch started authenticated, pinned HTTPS status on its Node 18.18.2 service runtime. After an owner-confirmed full reboot with developer host 127.0.0.1, remote companion launch and authenticated SDB access worked and the boot identity changed. Version 1.1.2 completed signed main-package replacements and remained reachable afterward; the companion itself was also replaced through its repair tunnel without another developer-IP change. This TV accepts only one SDB TCP client, so the companion limits tunnels to one and rejects uploads while its tunnel is reserved or open. It cannot detect every SDK or TizenBrew-owned connection: disconnect SDK transports before updates or fresh TizenBrew debug launches.

The shared build patch declares adbhost 0.0.2's dependency-local packet variable before Babel enables strict mode. The build fails unless the exact known dependency shape is found once. Without this patch, the compiled client throws on its first daemon handshake even though unbundled dependency tests pass. A local compiled-service test with real mock SDB packets and the physical TV's successful signed updates confirmed the repair.

Native remote keys from the companion process did not work on this TV; the PC client instead uses its explicitly configured, separately paired native remote connection. The owner confirmed an ordinary Power click turned the TV off. A virtual Power hold did not establish a full reboot: the kernel boot identity remained unchanged. Full-TV capture is unavailable with the tested service permissions. The separate PC screenshot tool captured the running TizenTube app document using explicitly configured launcher-status attestation through the pinned tunnel; native TV overlays and video planes are outside that scope.
