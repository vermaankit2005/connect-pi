# connect-pi — handoff

Project folder: `D:\Ankit\Projects\connect-pi`

Goal: a phone app that controls the pi coding agent on Ankit's Windows PC.
Type a question on the phone, it goes into a pi session on the PC, the answer
streams back to the phone.

## What is already built and tested

**The bridge** (`server/`) — a small Node server on the PC, port 4317.
Serves the phone app, checks the login, relays messages, and can start pi
sessions. Run with `npm start`.

**The pi extension** (`extension/connect-pi.ts`) — loads inside pi. Injects the
phone's message via `pi.sendUserMessage()` so it appears exactly as if typed at
the keyboard, and streams pi's output back. Already installed to
`~/.pi-harness/agent/extensions/` and `~/.pi/agent/extensions/`.
Reinstall with `npm run install-extension` after any edit.

**Starting sessions on demand.** The bridge spawns `pi --mode rpc` in a chosen
folder, invisible, no window. The extension inside registers itself, so the
bridge never speaks pi's protocol. Uses Ankit's existing OpenAI login because it
launches with `PI_CODING_AGENT_DIR` pointed at the pi-harness agent dir.

**Home WiFi switch.** `npm run wifi on|off` (default off, and off out of the
box). On, it additionally allows private ranges only — 192.168.x, 10.x,
172.16-31.x, IPv6 link-local. Public addresses are refused either way, so this
can never expose the bridge to the internet. The running bridge picks the change
up in ~2 s via `watchFile`, no restart. Tested live.

**Security, all tested:**
- Only this PC and Tailscale (100.64.0.0/10) can open a socket, plus the LAN
  when the WiFi switch is on. Anything else is dropped before a byte is served.
- Folder access limited to the roots in the config, now the whole `D:\` drive.
  Escapes out of a root are still blocked. **This is not a sandbox** — see the
  traps below.
- Login by passcode (tested) or passkey / fingerprint (written, NOT yet tested
  — needs a real phone on https).
- Auto-lock after 60 minutes idle. Tested at 59 min (in) and 61 min (out).

**Sleep handling.** The bridge holds Windows sleep off only while a session is
running, then releases it. Re-verified in the UI run: hold taken on start,
`released sleep hold` logged when the last session closed.

**Stop button.** pi has no programmatic abort, so Stop steers the model to
stand down and hard-blocks all remaining tool calls with `terminate: true`.

Backend test suite: 26/26 passing.

## The phone UI — BUILT, and driven end to end

`web/` was rewritten from scratch. The old first-draft UI is gone.

| File | What it is |
| --- | --- |
| `web/index.html` | Shell, all four screens, one inline SVG icon sprite. |
| `web/styles.css` | The ChatGPT Android dark skin. Every colour is a var in `:root`; every size is `rem` off the one `html` font-size. |
| `web/app.js` | Screens, event rendering, drawer, picker, sheets. |
| `web/api.js` | Token storage, REST calls, WebAuthn, the reconnecting socket. |
| `web/markdown.js` | Hand-rolled markdown + syntax highlighting, code and markdown cards separately. Escapes first, always. |

**Look.** Modelled on the screenshots of Ankit's ChatGPT Android app: pure black
background, purple user bubbles (`#4f3d80`), bare assistant text with a
copy/speak/share/kebab action row under it, `#1e1e1e` rounded composer with the
purple round button, circular hamburger and the two-icon pill top-right, grey
code cards with a copy button. Tune any of it in `:root` — nothing is hardcoded
elsewhere.

**Decisions Ankit made for this build:**
- While pi is working, the send button becomes a stop square (ChatGPT
  behaviour). Typing and sending anyway steers.
- Thinking / tools / commands are collapsed one-line rows you tap open.
- Passcode fallback is a 6-digit PIN pad. `npm run passcode` and `npm run setup`
  now require exactly 6 digits.
- Fingerprint is designed as the hero and simply is not shown until the address
  supports it.

**What was actually exercised against a live pi**, driven through the real DOM
handlers at a 375×812 viewport:

- passcode login, wrong passcode (shake + "Wrong passcode"), lock now, re-login
- folder picker: drill in, back up, 37 folders listed
- create folder, including the server rejecting `bad/name`
- start a session in the new folder → "Starting pi" → auto-attach when it
  connected
- send a prompt → reply rendered; the optimistic local echo was correctly
  replaced by the PC's echo (one bubble, not two)
- a tool run: live spinner → green check, args and result inside the expanded row
- a code block with syntax highlighting and a copy button
- Stop mid-task: pi wrote a, b, c and was blocked before d and e — verified on
  disk. Blocked call shows as a red row.
- "Open on my PC": Warp tab opened, `pi --resume` copied
- second session, drawer listing both, search, switching (history replays)
- close session, sleep hold released
- reload with a live token: reconnects and replays without asking to log in
- no horizontal overflow; code scrolls inside its own box

## Second pass — 2026-08-29

Four things Ankit asked for after seeing the app on his phone.

**1. Everything was ~20% too big.** Fixed properly, not by hand-tuning: every
size in `styles.css` is now `rem`, and `html { font-size: 14.5px }` is the one
knob that zooms the whole app. Verified by putting his ChatGPT screenshot and
the app side by side at the same 360px width — body text now measures within a
few pixels of the real app, and so do the top-bar circles, the pill and the
action row. Settings → **Text size** moves that one number (5 steps, saved in
`localStorage`), so he can dial it in on the phone without another round trip.

**2. Markdown blocks looked wrong.** A ```` ```md ```` fence was going through
the *code* highlighter, so `#` opened a comment that swallowed the whole heading
and plain English words like "for", "in" and "is" came out purple. `markdown.js`
now dispatches on the fence language: markdown source gets its own tints
(hashes dim, heading amber, `**bold**` bold with the asterisks visible),
plain/text/log get none, everything else gets the code highlighter. Code cards
also got smaller type so a real line fits the width of a phone — measured
against the screenshot, not guessed.

**3. Desktop Start/Stop.** `npm run desktop` puts a green **Start pi on phone**
and a red **Stop pi on phone** on the desktop (`scripts/install-desktop-
shortcuts.ps1`). Both go through `scripts/phone-link.ps1`, which flips the WiFi
switch and starts or kills the bridge together, then shows a note that closes
itself. Icons are generated by `scripts/make-desktop-icons.mjs` into
`scripts/icons/`. Both paths were run end to end, including through the actual
shortcut shim.

**4. Roots widened to the whole `D:\` drive.** One root instead of two, so the
picker now opens straight into `D:\` rather than showing a list of one. Windows
clutter (`$RECYCLE.BIN`, System Volume Information, Recovery) is hidden, and the
"up one level" row is suppressed at the top of a drive since `resolve("D:\\", "..")`
returns `D:\` itself.

## Third pass - 2026-08-30 (first real-phone feedback)

Ankit finally opened it on his S24 Ultra. Three things came back.

**1. "Can't reach your PC" is now its own screen.** With Tailscale off, the app
used to fall through to the lock screen and announce *"No passcode is set on the
PC"* - a flat lie caused by `showLock()` drawing the PIN pad before it knew
whether the PC had answered at all. `api.js` already tagged an unreachable
fetch as status 0; nothing was reading it. Now `isUnreachable()` splits the two
cases, `showLock()` asks before it draws, and a dedicated `#offline` screen
gives the three things to check, a Try again button, and a self-backing-off
retry loop. Verified end to end with a stand-in server that serves the shell but
kills every /api/ socket: the offline screen appeared, and when the bridge came
back the app walked itself to the lock screen with no tap.

**2. The giant purple slab.** `.btn-primary` carried `flex: 1` for the picker's
side-by-side action bar. The empty state is a *column* flex box, so flex-grow
ran down the page and turned "Choose a folder" into a tall purple rectangle.
`flex: 1` now lives on `.pick-actions .btn-primary` only. All three empty states
were rebuilt with a medallion, tighter type and a real pill button.

**3. Odds and ends found while looking.**
- The picker header rendered `D:\` as `\:D`. It was leaning on CSS
  `direction: rtl` to keep the tail of long paths visible. Replaced with
  `shortPath()` in app.js.
- A "Reconnecting to your PC" banner now covers a dropped socket mid-chat
  instead of blowing the thread away - debounced 1.8s so it never flashes on a
  normal page load.
- Service worker bumped to v4, since the shell changed.

TAILSCALE ONLY, as of this pass. `scripts/phone-link.ps1` forces home-WiFi
access **off** on every action including start, and Start now reports the
`https://....ts.net` address and checks `tailscale serve` is proxying. Do not
put the WiFi switch back into that script.

**4. Light theme.** Every colour left hardcoded outside `:root` - 33 of them -
became a variable first, so the theme is a palette swap and not a rewrite. Light
is reached two ways: `data-theme="light"` on `<html>`, or *Follow my phone* plus
the `prefers-color-scheme` media query. An inline script in `index.html` sets the
attribute **before the first paint**; doing it from app.js would flash black on
every launch. `paintThemeColor()` keeps the Android chrome tint in step.

Code and markdown cards keep a dark surface in both themes on purpose - see the
comment on `--code-bg`. Do not "fix" that without re-tuning every `tok-*` and
`md-*` colour for contrast on white.

Checked in both themes: chat with code + markdown cards, expanded tool rows,
lists, quotes, links, the empty state, the offline screen, the settings sheets.
Choice survives a reload and lands before paint.

## Fourth pass - 2026-08-30 (the window is the switch)

Ankit rejected the invisible background bridge outright. He wants one visible
window whose lifetime *is* the service: window open = bridge up and Tailscale
pointing at it; window closed = nothing listening, nothing reachable.

**How it is built.** `scripts/pi-window.cmd` runs `node server/index.js` in the
FOREGROUND of a normal console window, so the window's life is the process's
life. `server/tailscale.js` owns `tailscale serve`: on at listen, off on the way
out. `server/index.js` handles SIGINT, SIGTERM, **SIGHUP** (Windows sends it when
a console window is closed) and SIGBREAK, with a synchronous `serveOff()` in the
`exit` handler as the last line of defence.

**Verified by actually closing the window**, not by reasoning about it: a
`WM_CLOSE` posted to the console host - the same message the X button sends -
left the port free, the node process gone, `tailscale serve status` reporting
"No serve config", and the https address refusing connections. Run twice.

**One trap found while testing.** A second bridge that fails to bind the port
still ran its exit handler on the way out and turned off the serve belonging to
the one that was actually running. `server/tailscale.js` now tracks whether
*this* process opened the door and refuses to close a door it did not open.

**Desktop is now ONE icon**, "pi on my phone", carrying the app's own violet pi
mark rather than a green play button - the desktop shortcut and the phone icon
should look like the same thing. `scripts/phone-link.ps1`, the hidden VBScript
shim, the green/red icon pair and the `link:*` npm scripts are all deleted; the
installer removes the old shortcuts from the desktop too.

**Anything printed to the console must be ASCII.** The banner had an em dash and
the Windows console rendered it as mojibake, the same cp1252 trap that broke the
PowerShell scripts earlier. Comments can be what they like; `console.log` cannot.

## What is NOT done

**Fingerprint has still never run.** The code is written and the UI path is
wired, but WebAuthn needs a real phone on a real https name. It cannot be tested
from a desktop browser here and it cannot be tested over http at all.

**Nothing has ever been driven from a real phone.** Every test above was a
desktop browser at phone size, talking to `localhost`. The phone path is
unproven end to end.

**Next, with Ankit present:**
1. Double-click **Start pi on phone** on the desktop, open the address it shows,
   and confirm the look against the real ChatGPT app side by side. If anything
   reads too big or too small, Settings → Text size — do not go editing CSS.
2. Install Tailscale on PC and phone, `tailscale serve --bg 4317`, open the
   `https://...ts.net` address, then Settings → turn on fingerprint unlock, and
   test it.

## Decisions already made — do not re-ask

| Question | Answer |
| --- | --- |
| Reach | **Tailscale only.** Home WiFi was deliberately shut off 2026-08-30 |
| Where prompts go | Into a live pi session on the PC |
| Detail shown | Everything, as collapsed rows you tap open |
| New sessions | Invisible, no window on the PC |
| Take over at desk | "Open on my PC" → Warp tab → `pi --resume` |
| Login | Fingerprint when https allows it, 6-digit passcode otherwise |
| Auto-lock | 60 minutes |
| Folders | The whole `D:\` drive (was two roots; widened 2026-08-29) |
| Sleep | Hold sleep off only while pi is working |
| Look | ChatGPT Android app. Dark by default; light theme added 2026-08-30, switchable in Settings |
| Send while busy | Button becomes Stop; sending anyway steers |

## Traps that cost time — do not rediscover these

- **The real pi is `@earendil-works/pi-coding-agent` v0.84**, at
  `C:\Users\verma\.pi-harness\`. Launched by `pi-harness.cmd`, which sets
  `PI_CODING_AGENT_DIR` and blanks the OpenAI env vars. Read docs from
  `~/.pi-harness/node_modules/@earendil-works/pi-coding-agent/docs/`.
  A stale `@mariozechner/pi-coding-agent` used to sit in npm globals; it has
  been removed. Removing it deleted the `pi`, `pi.cmd`, `pi.ps1` shims because
  npm thought it owned the name — they were restored from backup. Do not
  `npm uninstall -g` anything pi-related without backing those up first.
- **`pi` from Git Bash is broken** (no `PI_CODING_AGENT_DIR`, so no
  credentials). Works from PowerShell and cmd. Set the env var explicitly when
  scripting.
- **WebAuthn will not work on an IP address**, even over https with a
  certificate. The relying-party ID has to be a real registrable name. That is
  why fingerprint login waits for `tailscale serve`. Do not try to solve it with
  a self-signed cert.
- **`tool_execution_end` carries no `args`**, despite what the docs say. The
  extension caches args from `tool_execution_start`. Do not "simplify" that.
- **Warp cannot be told to run a command.** `warp://action/new_tab?path=` opens
  a folder and works; every command parameter tried does nothing on Windows.
- **pi has no sandbox.** Restricting the start folder does not stop pi reaching
  the rest of the disk. Never present the folder list as protection. Real
  containment would be Gondolin (needs QEMU); Ankit decided to skip it for now.
- **Never put a non-ASCII character in a `.ps1` file.** Windows PowerShell 5.1
  reads a BOM-less file as ANSI, and the third byte of a UTF-8 em dash lands on
  cp1252 0x94 — a smart quote, which its tokenizer treats as a real quote. One
  em dash inside a string on line 38 broke the parse of everything after it in
  `install-desktop-shortcuts.ps1`. Keep those files plain ASCII.
- **Every colour in `styles.css` is a `var()` on purpose**, the same way every
  size is a `rem`. Putting a literal hex back in means it will look wrong in one
  of the two themes. The only deliberate exceptions are the syntax colours on
  the code card and the black scrims, both of which are theme-independent.
- **`styles.css` is all `rem` on purpose.** Do not "helpfully" put a px value
  back in — it would stop scaling with the Text size setting. Values of 2.5px and
  under (hairlines, borders) are deliberately still px.
- **Bash heredocs mangle these files.** The Bash tool's own quoting broke a
  quoted heredoc mid-file. Use the Write tool for anything long.
- **Do not put raw control bytes in source.** An early markdown.js used a literal
  NUL as a placeholder token. It works, but it is invisible in every editor. It
  is `\u0001` as an escape sequence now — keep it that way.
- **Startup is not always ~4.5 s.** An established project is quick; a brand-new
  empty folder took **28 s** to connect. The app waits 60 s before complaining.
  Do not shorten that.
- Service worker registration fails inside embedded/preview browsers ("unknown
  error occurred when fetching the script") even though `/sw.js` serves fine over
  HTTP. It is caught and harmless. Verify it on the real phone, not in a
  preview pane.

## Current state on disk

- `~/.connect-pi.json` — config. A passcode **is** set and at least one passkey
  is registered (Ankit did that himself between sessions — do not clear either).
  `allowLan` is **off**. `roots` is now `["D:\\"]`. 60-min lock is set.
- Nothing is running: port 4317 is free, `tailscale serve` is off, `allowLan`
  is off. Double-clicking the desktop icon is what turns it all on.
- Ankit also has an older Warp window with pi running in `arxiv-rag`.
- `D:\Ankit\Projects\phone-ui-test` — the leftover test folder is now gone.
- Desktop shortcut **is installed**: one icon, "pi on my phone".
- `npm run setup` sets a passcode, installs the extension and makes icons.

## Style notes

Ankit is not a beginner but does not want jargon. Explain in plain language,
keep it short, give recommendations rather than menus of options. He pushes
back well and is often right — he correctly spotted that folder restriction is
not real security. Never oversell a safety feature.
