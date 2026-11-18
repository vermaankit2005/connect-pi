# connect-pi

> For the current product guide and easiest installation, see the [README](../README.md).
> Version 1.1 adds a Pi package manifest and `/phone` commands. This document retains
> the lower-level manual-deployment reference; the README is authoritative for
> package setup, command behavior and supported installation paths.

## Pi package controls

Install with `pi install git:github.com/vermaankit2005/connect-pi`, then `/reload`
and `/phone setup`. The package declares `extension/connect-pi.ts` in its `pi`
manifest. Pi supplies the extension host; runtime dependencies stay in this package.
The repo is private and is not published to npm.

`/phone` and `/connect-pi` accept `setup`, `start`, `stop`, `restart`, `status`,
`url`, `doctor`, `folders`, `passcode`, `desktop`, and `help`.
The wizard chooses an existing folder, so it does not require a D: drive.
Passcode entry happens through Pi UI dialogs rather than model-generated text.

Background control uses an authenticated localhost-only endpoint. It does not
kill arbitrary processes by port or PID. `/phone stop` also stops sessions the
bridge launched. Desktop-window and foreground-terminal modes retain their
existing lifecycle; background mode requires an explicit stop command.

For isolated tests, `CONNECT_PI_CONFIG` selects a separate settings file and
`CONNECT_PI_TAILSCALE=off` disables Tailscale Serve changes. These are intended for
tests, not the recommended phone setup. `npm run smoke:package` installs into an
isolated Pi profile and exercises commands through real RPC without a model call.
`CONNECT_PI_PACKAGE_SOURCE` can choose another install source; `manual` tests the
legacy terminal installer and forwarding extension.

Control the **pi** coding agent on your Windows PC from your phone.

You type on your phone. It lands in a pi session on your PC — exactly as if you
had typed it at the keyboard. The reply streams back: the text, the thinking,
every command it runs, every file it touches. You can start a brand-new session
in any project folder without touching the PC, and hand the work back to your
keyboard whenever you want.

The phone app is dressed to look and behave like the ChatGPT Android app in dark
mode, so it should feel like something you already know.

```
   your phone                 your desktop PC
  ┌───────────┐              ┌───────────────────────────────┐
  │    pi     │  WiFi or     │  connect-pi bridge (node)     │
  │ (web app) │  Tailscale   │         ▲                     │
  └───────────┘ ────────────►│         │ localhost           │
                             │  ┌──────┴──────────────────┐  │
                             │  │ a pi session, either    │  │
                             │  │ one you opened, or one  │  │
                             │  │ the phone started       │  │
                             │  └─────────────────────────┘  │
                             └───────────────────────────────┘
```

Nothing is ever exposed to the public internet. See
[Who can reach it](#who-can-reach-it).

---

## One-time setup

In this folder:

```bash
npm install
```

```bash
npm run setup
```

That asks for a 6-digit passcode, installs the pi extension, and makes the app
icons. Once only.

Then start the bridge:

```bash
npm start
```

It prints the addresses your phone can use.

### One icon on the desktop

Once, run:

```bash
npm run desktop
```

That puts a single **pi on my phone** shortcut on your desktop, with the same
violet pi mark as the phone app.

**The window is the switch.** Double-click and a window opens: the bridge
starts, Tailscale is pointed at it, and the window shows the address to open on
your phone. Close that window and the bridge stops, any pi sessions it started
stop, and the Tailscale door shuts behind it - the https address stops answering
entirely. There is no separate Stop, and nothing keeps running in the background.

It works the same however the window goes away: the X button, Ctrl+C, or a
shutdown. `server/index.js` handles `SIGINT`, `SIGTERM`, `SIGHUP` (which is what
Windows sends when a console window is closed) and `SIGBREAK`, and shuts the
Tailscale door from its own `exit` handler as a last resort.

**Tailscale only.** Home-WiFi access is forced *off* every time the window
starts. The only way it comes back is if you type `npm run wifi on` yourself.

`npm start` does exactly the same thing from a terminal.
`npm run desktop:remove` takes the shortcut away.

After updating this project, run `npm run install-extension`, then restart pi
(or `/reload` in an open session) to load the new bridge extension.
Run `npm test` for local history checks and `npm run smoke` to check that the
installed pi starts in RPC mode with this extension. The smoke check makes no
model request and does not test a phone or the Tailscale tunnel.

---

## Getting to it from your phone

There are two routes. Start with the first.

### Home WiFi — works today

Out of the box the bridge refuses everything except the PC itself. To let your
own home network in:

```bash
npm run wifi on
```

The running bridge picks that up within a couple of seconds — no restart. It
prints a `192.168.x.x` address; open that on your phone, on the same WiFi.

To close it again:

```bash
npm run wifi off
```

This only ever allows private address ranges. A public address is refused either
way, so this switch cannot expose the bridge to the internet.

### Tailscale — works from anywhere, and unlocks fingerprint login

Tailscale is a free private tunnel between your own devices.

1. On your PC: install from <https://tailscale.com/download> and sign in.
2. On your phone: install Tailscale and sign in **with the same account**.

Now the bridge is reachable on its `100.x.x.x` address from anywhere.

For the good version, turn on **HTTPS Certificates** once in the
[Tailscale admin console](https://login.tailscale.com/admin/dns), then:

```bash
tailscale serve --bg 4317
```

That gives you a real address like `https://your-pc.your-tailnet.ts.net`. Use
that one. It is worth doing, because two things only work on a real https
address:

- **Fingerprint login.** Android will not offer a fingerprint on a plain
  `http://` address, or on a bare IP address even over https. It needs a real
  name with a real certificate. On any other address the app quietly falls back
  to the passcode and does not show the fingerprint option at all.
- **"Install app"** on Android, giving you a proper full-screen app icon.

To turn it off again: `tailscale serve --bg off`.

### Add it to your home screen

- **Android (Chrome):** ⋮ → *Install app* (https), or *Add to Home screen*.
- **iPhone (Safari):** Share → *Add to Home Screen*.

---

## Logging in

**Passcode.** Six digits, on a lock-screen style keypad. Guesses are
rate-limited — five wrong tries and it starts making you wait.

**Fingerprint.** Once you are on the Tailscale https address, open Settings in
the app (drawer → Settings) and turn on fingerprint unlock. From then on the
lock screen leads with the fingerprint and only offers the passcode as a
fallback. The fingerprint never leaves your phone; the PC only stores a public
key.

**Auto-lock.** After 60 minutes with no activity the login dies and the app asks
again. Coming back to the app after that shows the lock screen.

---

## Using it

### Starting a session

Tap the compose icon (top right) or **New session** in the drawer. You get a
folder browser over the whole **D drive**, opened at the top so you can walk
into anything on it. Windows' own clutter — `$RECYCLE.BIN`, System Volume
Information — and the usual noise like `node_modules` are hidden.

Walk into any folder, or tap **New folder** to make a fresh one, then
**Start pi here**. pi launches on the PC with no window and no taskbar entry,
and appears in the app a few seconds later. A brand-new empty folder can take
half a minute the first time; an established project is quicker.

It uses the login you already have on the PC. No keys or accounts are involved.

### Talking to it

Type and send, exactly like ChatGPT. Slash commands work too — `/review app.js`
on the phone runs the same thing it would at your desk.

While pi is working, the send button becomes a **stop square**:

- **Type and send anyway** and it goes in as a steer — pi changes course
  mid-task rather than waiting.
- **Tap stop** to abort the current pi run. Pi also cancels queued follow-ups;
  a command that does not support cancellation may still take time to finish.
  On older pi builds the bridge falls back to blocking remaining tool calls.

### Reading what it did

Thinking, commands and file edits appear as one-line grey rows — *Thought for
4s*, *write joke.md*. Tap one to see the full reasoning, the arguments, or the
command output. Tap again to fold it away.

### Code and markdown

A fenced block comes back as its own card with a copy button, sized so a real
line of code fits the width of a phone. Markdown gets its own treatment: when pi
shows you a `.md` file you see the file — the hashes, the asterisks — tinted so
it reads, rather than run through a code highlighter that turns every "for" and
"in" purple.

### Light and dark

Settings -> **Appearance**: *Follow my phone*, *Light* or *Dark*. Your choice is
remembered on that phone and is applied before the first paint, so opening the
app never flashes the wrong colour at you. On *Follow my phone* it tracks the
phone's own light/dark switch, including when Android flips it at sunset. The
Android browser chrome is tinted to match.

Code and markdown cards stay dark in **both** themes. That is deliberate: a code
block on white would need the whole syntax palette re-tuned for contrast, and
every app worth copying leaves code dark in light mode.

Every colour is a variable in `:root` in `web/styles.css`, and the light palette
is one block further down. Nothing is hardcoded anywhere else.

### Bubble colour

Settings -> **Bubble colour**. Nine choices for your own messages — Purple,
Teal, Ocean, Forest, Rose, Ember, Highlighter, White and Slate. Only the
bubbles change; the send button, the links and everything else stay put, so a
loud pick doesn't repaint the app.

Each colour carries two hexes, a deep one for dark and a pale tint for light,
because no single colour is readable on both black and white. The picker shows
the version you'll actually get, and switching the theme swaps the pair
underneath you. The palette lives in `BUBBLES` in `web/app.js`.

### Text size

Settings -> **Text size**. Every size in the app is relative to one number, so
this scales the whole thing — bubbles, buttons, code cards — not just the words.
The 15.36px default is 4% smaller than the original 16px UI scale.

### Switching sessions

The drawer (top-left) opens in **Projects** by default. **Library** opens all
conversations, and search matches titles and folders.

**Projects** groups chats by their full working folder. Open a project to see
only its conversations or start a new chat in that folder. Folders with the same
name stay separate. **New project** opens the folder browser, where you can choose
an existing folder or create one. This uses pi's existing history files; there
is no separate copy of your conversations.

**Running now** filters to what is actually alive on the PC — sessions the phone
started and sessions you opened at the keyboard, both. A green dot means pi is
working this second; a grey one means it is open and waiting. These are the
only sessions that can be spending anything.

Saved conversations appear alongside running chats in Library and Projects.
Opening a saved chat offers the existing resume/start-fresh choices before pi
launches. An empty **Running now** means no connected session is working,
regardless of how much saved history appears elsewhere.

The composer stays on one row and grows as you type multiple lines. Its **+**
menu offers new chats, text/code file context, desktop handoff, and **Think harder**.
File text is added to the editable draft before sending. The microphone offers
dictation in browsers with speech recognition support.

For a local UI preview with sample conversations and no real pi/model calls,
run `npm run preview:ui` and open `http://127.0.0.1:4318`. This is a separate,
loopback-only preview, not the authenticated phone bridge.

### Picking up an old conversation

Tap anything under **Earlier** and you get two choices:

- **Continue this session** — pi reopens that conversation and remembers all of
  it. The thread comes back on your phone too: the messages, the thinking, the
  commands it ran.
- **Start fresh in this folder** — same folder, empty conversation.

Continuing costs more than starting fresh, because the whole history goes back
to the model with your first message. Long conversations are tagged *long* or
*very long* in the list, and the sheet tells you how many messages you are
reopening, so the expensive ones are never a surprise.

Sessions that ran outside your allowed folders (the D drive, by default) are
listed greyed out — you can see them, but the phone will not start pi there.

This works on pi's own session files, so a conversation you had at your desk
with no phone in sight still shows up here and can be picked up from the sofa.
Under the hood it is `pi --session <file>` using the exact validated session
file; nothing is copied or rewritten. For branched sessions, the phone shows
only the active branch rather than mixing in abandoned replies.

### Taking over at your desk

The session menu also lets you **name a session** and change pi's **thinking level**
(Off through Max). Pi may cap the requested level for the current model; higher
levels may take longer and cost more. The name and level are saved by pi and
restored when you reopen the conversation.

Session menu → **Open on my PC**. That opens a Warp tab in the right folder and
puts `pi --resume` on your clipboard — paste it and carry on where the phone
left off. (Warp can be pointed at a folder but cannot be told to run a command,
so the last step is yours.)

### Closing a session

Session menu → **Close this session**, for sessions the phone started. Anything
already written to disk stays.

---

## Start the bridge automatically

```bash
npm run autostart
```

It then starts silently whenever you log into Windows. To undo:

```bash
npm run autostart:remove
```

---

## Sleep

Windows sleeping kills the network connection, and your laptop sleeps after a
few minutes on battery. So the bridge holds sleep off **only while a pi session
is actually running**, and lets go the moment it stops. The screen still sleeps
normally, and your battery behaviour is untouched when nothing is happening.

---

## Change your passcode

```bash
npm run passcode
```

Six digits. Every phone that was logged in has to log in again afterwards. Use
it if you ever think someone got hold of the address.

---

## Who can reach it

The bridge binds to every interface, then refuses the connection before serving
a single byte unless it came from:

- this PC,
- Tailscale (`100.64.0.0/10`),
- your own private network — **only** while `npm run wifi on` is set.

Public addresses are refused in all cases. There is no cloud service in the
middle and nothing is port-forwarded.

---

## If something isn't working

**"No session running"**
Nothing has connected. Start one from the app, or open `pi` on the PC. Inside a
desktop pi session, `/phone` reports what it thinks the status is.

**Phone can't reach the address at all**
On WiFi: check `npm run wifi on` is set and both devices are on the same
network. On Tailscale: check it is connected on both. Either way, check
`npm start` is still running and the PC is awake.

**Started a session and it never appeared**
Look at the bridge window on the PC. It logs `session started` and then
`pi connected`. If the second line never comes, pi failed to launch — usually
the pi harness moved or is mid-upgrade.

**No fingerprint option anywhere**
You are not on an https address with a real name. See
[Tailscale](#tailscale--works-from-anywhere-and-unlocks-fingerprint-login).

**It was working, now it looks stuck**
Pull down to refresh. The app reconnects on its own and replays recent history,
so the conversation is not lost.

**pi asks for permission and the phone just sits there**
If you use a permission-gate extension, its prompt appears on the **desktop
only** — the phone cannot answer it. Approve it at your desk, or turn that
extension off for sessions you plan to drive from the phone.

**I changed the extension and nothing happened**
`npm run install-extension`, then restart pi or `/reload` inside it.

**A session I am in also shows under Earlier**
The running session reports its own id so the two lists cannot double up — but
only from a pi started *after* the extension was last installed. Run
`npm run install-extension` and restart that session.

---

## What's what

| File | What it is |
| --- | --- |
| `server/index.js` | The bridge. Serves the app, checks logins, relays messages. |
| `server/auth.js` | Passcode and passkey (fingerprint) login. |
| `server/config.js` | Passcode, tokens, roots, port. Stored in `~/.connect-pi.json`. |
| `server/files.js` | The folder browser, clamped to the configured roots. |
| `server/history.js` | Reads pi's own session files, so old conversations can be listed and reopened. |
| `server/sessions.js` | Launching pi, the sleep hold, the Warp hand-off. |
| `server/net-guard.js` | Who is allowed to open a socket. |
| `extension/connect-pi.ts` | Lives inside pi. Injects your messages, streams events out. |
| `web/` | The phone app. `app.js` screens, `api.js` transport, `markdown.js` rendering. |
| `scripts/` | Setup, passcode, wifi switch, extension install, icons, autostart, the desktop Start/Stop shortcuts. |

---

## Notes on safety

- Anything sent from the phone runs on your PC as you. Treat the passcode like
  your laptop password.
- **The folder list is not a sandbox.** It is a convenience, not a wall: it does
  nothing to stop pi reaching the rest of the disk once it is running. pi has no
  sandbox. Do not treat it as containment. This is why widening the roots to the
  whole D drive changes nothing about safety - the network filter and the login
  are what actually keep people out.
- Passkeys are the strong option: there is no shared secret to guess, phish, or
  read off the wire. The passcode is the fallback.
- Nothing leaves your machine except across your own network or Tailscale.
