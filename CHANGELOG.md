# Changelog

## Unreleased

- Restrict phone access to private Tailscale HTTPS and isolate desktop control.
- Preserve existing Tailscale rules and other applications on occupied ports.
- Revoke phone sessions on lock, device removal, and live passcode rotation.
- Show active project and run state, preserve per-chat drafts, and restore failed messages.
- Add read-only transcript search, Git diff previews, and screenshot attachments.
- Test the Windows and Linux package paths and browser flows in CI.

## 1.1.0

- Install directly with `pi install git:github.com/vermaankit2005/connect-pi`.
- Set up and control the phone connection with `/phone` or `/connect-pi`.
- Choose project folders and change passcodes inside pi.
- Start, stop and restart the bridge, show its address, and run diagnostics.
- Keep the existing ZIP/manual setup and desktop shortcut available.
