# Startup regression tests

Run with Node.js 22 or newer; the tests use only Node built-ins and require no npm installation:

```powershell
node --test tizenbrew-app/TizenBrew/tests/autolaunch-service.test.cjs tizenbrew-app/TizenBrew/tests/autolaunch-ui.test.cjs tizenbrew-app/TizenBrew/tests/direct-launch-lifecycle.test.cjs tizenbrew-app/TizenBrew/tests/remote-launch-service.test.cjs
```

Alternatively run `npm test` inside `service-nextgen/service` or `tizenbrew-ui` to run that package's suite.

The VM harness executes the actual production CommonJS service modules and the UI Client. It replaces the unavailable TV, ADB, debugger, websocket, and network interfaces with deterministic mocks. Timers advance explicitly, so retries and connection replacement require no real-time sleep. Tests and test tooling stay outside the service build tree and do not change the TV's runtime requirements.

The startup UI coverage also checks that modules arriving before the launch decision do not reveal the menu, manual startup and UP reveal it, delayed debugger replies preserve that decision, and late document-start acknowledgments cannot navigate after UP or a timeout. Service startup reconnects without a document reload and stops with a visible error if its bounded retries fail.

The remote launcher coverage checks authentication, single-flight operations, bounded requests, paused-session resume without JavaScript evaluation, stale debugger ownership, split SDB port output, and recovery after launch failures. These tests exercise the fixed launcher action without contacting a TV.

To reproduce the failures on a prior Git revision without changing the working tree, set `TIZENBREW_TEST_REF`. For example, from the repository root:

```powershell
$env:TIZENBREW_TEST_REF = '14760a371fa5132e6f93200f3045c5bbc5a9d1ca'
node --test tizenbrew-app/TizenBrew/tests/autolaunch-service.test.cjs tizenbrew-app/TizenBrew/tests/autolaunch-ui.test.cjs
Remove-Item Env:TIZENBREW_TEST_REF
```

This reads production sources from `git show` while using the current regression tests. It is expected to fail for the unfixed revision. These tests verify protocol behavior; real TV cold-start, firmware compatibility, and navigation still require hardware validation.
