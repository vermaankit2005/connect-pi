# Connect Pi technical guide

See the [README](../README.md) for setup and phone usage.

## Processes and ports

- The UI and phone API listen only on `127.0.0.1`, port `4317` by default.
  Tailscale Serve exposes a private HTTPS URL to permitted devices in the tailnet.
  Direct Wi-Fi HTTP access has been removed.
- Desktop commands and the Pi extension use a second loopback listener with a
  separate secret. It defaults to the next port. If that port is occupied, set
  `controlPort` in the settings file while the bridge is stopped.
- The bridge only configures the HTTPS root at port 443. It preserves existing
  rules and reports conflicts. Cleanup removes the matching root only if this
  process created it.
- The Windows shortcut runs in the foreground. Closing it shuts down the
  bridge it started. The shortcut leaves an already-running background bridge
  in place. Autostart uses the same background command as `/phone start`.
- Phone-started sessions run Pi in RPC mode with the current owner's Pi profile.
  Connected desktop sessions and saved history are visible only within the
  shared folders. Pi tools inherit the desktop account's permissions.

## Access and persistence

The HTTPS site uses a host-only, secure, HttpOnly session cookie and checks
the origin for state-changing requests and WebSocket upgrades. Passcodes are
hashed with scrypt. Local desktop preview with passkeys uses
`http://localhost:4317`. Phone passkeys use the Tailscale HTTPS origin.

Settings, passkey public keys, and session hashes are stored in
`~/.connect-pi.json`. Use Settings → Devices and passkeys to remove a device's
access. To rotate the passcode, use `/phone passcode` or `npm run passcode`.
Existing phone logins are revoked and running Pi sessions continue.

Saved transcripts stay in Pi's session directory. A history worker indexes
metadata and sends transcripts in pages. The WebSocket carries recent activity
and prompt receipts. Pending drafts live in the active browser tab and are
cleared when it locks. A message whose delivery is unknown can be checked in
the conversation before sending it again.

## Development and verification

The CI matrix uses Node.js 22.19.0 and Pi 1.5.2 on Windows and Linux.

- `npm test` checks the control service, passcode rotation, history, Markdown,
  project grouping, and mocked Tailscale rule ownership.
- `npm run smoke` starts Pi's RPC interface with the extension and checks startup.
- `npm run smoke:package` installs the package into an isolated Pi profile and
  exercises setup, start, restart, status and stop without model calls.
  Use `CONNECT_PI_PACKAGE_SOURCE=manual` to check the manual forwarding extension.
- `npm run preview:ui` serves fixture data at `http://127.0.0.1:4318`.
  Use `npx playwright install chromium` and `npm run test:ui` to exercise the
  fixture in Chromium.
- `CONNECT_PI_CONFIG` points tests to isolated settings.
  `CONNECT_PI_TAILSCALE=off` skips Tailscale changes during a test run.

Use `/phone doctor` for bridge status, settings and log paths. Background logs
rotate locally. Check the Windows shortcut and a physical phone on a real
tailnet before changing network or deployment behavior.
