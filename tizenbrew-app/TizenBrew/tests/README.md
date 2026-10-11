# Startup regression tests

Run with Node.js 22 or newer; the tests use only Node built-ins and require no npm installation:

```powershell
node --test tizenbrew-app/TizenBrew/tests/autolaunch-service.test.cjs tizenbrew-app/TizenBrew/tests/autolaunch-ui.test.cjs
```

Alternatively run `npm test` inside `service-nextgen/service` or `tizenbrew-ui` to run that package's suite.

The VM harness executes the actual production CommonJS service modules and the UI Client. It replaces the unavailable TV, ADB, debugger, websocket, and network interfaces with deterministic mocks. Timers advance explicitly, so retries and connection replacement require no real-time sleep. Tests and test tooling stay outside the service build tree and do not change the TV's runtime requirements.

To reproduce the failures on a prior Git revision without changing the working tree, set `TIZENBREW_TEST_REF`. For example, from the repository root:

```powershell
$env:TIZENBREW_TEST_REF = '14760a371fa5132e6f93200f3045c5bbc5a9d1ca'
node --test tizenbrew-app/TizenBrew/tests/autolaunch-service.test.cjs tizenbrew-app/TizenBrew/tests/autolaunch-ui.test.cjs
Remove-Item Env:TIZENBREW_TEST_REF
```

This reads production sources from `git show` while using the current regression tests. It is expected to fail for the unfixed revision. These tests verify protocol behavior; real TV cold-start, firmware compatibility, and navigation still require hardware validation.
