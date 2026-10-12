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
- An ordinary TV icon or native REST launch must execute the bootstrap and start the NodeJS service without CDP. The existing TizenBrew service convention is the implementation baseline, but the new package has not yet been installed.
- The packaged entry's `__dirname` must resolve to its `service/` directory, and the service must be able to read the neighboring private configuration.
- The HTTPS/TLS, RSA authentication, fixed SDB tunnel, and installer path must work on the actual service runtime. Syntax transformation cannot supply missing platform APIs or filesystem privileges.
- Authenticated status must remain reachable after hiding the companion, foregrounding another app, and replacing only `xvvl3S1bvH`. Service survival under standby and memory pressure must be measured. Full reboot recovery must use the ordinary companion launch fallback.

The local tests cover bootstrap deadlines and failure reporting, same-package service identity, lifecycle idempotence, and private configuration log handling. They do not establish any of these firmware behaviors.
