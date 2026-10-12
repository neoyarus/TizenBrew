The PC client requires Node 18 or newer. Keep its JSON configuration and RSA private key outside the repository. The companion widget contains the matching public key and a separate server TLS credential; the PC private key is never packaged.

Client configuration fields are `host`, `port` (8098), `certificateSha256` (SHA-256 of the TLS leaf certificate DER bytes, lowercase hex), and `privateKeyPath` (absolute local PEM path). Provision the certificate pin through a trusted local channel. The client verifies this pin before sending HTTP headers or widget bytes.

```powershell
node recovery-companion/client/cli.cjs --config C:/Users/neoya/share/recovery-client.json start
node recovery-companion/client/cli.cjs --config C:/Users/neoya/share/recovery-client.json status
node recovery-companion/client/cli.cjs --config C:/Users/neoya/share/recovery-client.json tunnel 26102
sdb connect 127.0.0.1:26102
node recovery-companion/client/cli.cjs --config C:/Users/neoya/share/recovery-client.json install C:/path/TizenBrew-signed.wgt
```

`start` explicitly requests the fixed companion application through the configured TV's native HTTP port 8001, with a three-second deadline. It then polls authenticated, pinned TLS status for up to twenty seconds. A native launch acknowledgment alone does not prove service readiness. No other command starts the app automatically, and a certificate pin or authentication failure never triggers fallback launching. Reboot recovery through this command requires the TV's native application REST endpoint and companion foreground bootstrap to work on that firmware; hardware verification is still required.

The tunnel binds only to PC loopback. Each authenticated connection forwards raw TCP only to the TV's `127.0.0.1:26101`, with a five-minute lifetime, thirty-second idle timeout, and two-connection limit. An authorized key holder receives full SDB capabilities through this tunnel; it is not a restricted shell or a package-policy firewall. Use SDB forwarding for a debug port when needed; there is no separate CDP endpoint.

The upload endpoint additionally verifies a signature over the complete widget bytes and permits only package `xvvl3S1bvH`, application `xvvl3S1bvH.TizenBrewStandalone`. It rejects the companion package. Uploads are staged with exclusive creation and mode 0600, then installed through a fixed localhost SDB command. Check authenticated status for completion. An inconclusive result blocks another installer attempt until the companion is restarted, because the OS installer might still be running.

Challenges expire after thirty seconds and are single-use. Signatures bind the nonce, exact method and path, declared byte count, and SHA-256 body digest. Status and installer logs require authentication. The independent companion must have been launched and must still be running; it cannot promise availability after the TV kills its service or reboots.
