# Calendar Reminders

GNOME notifications for calendar reminders, that open GNOME Calendar.

Evolution Data Server already runs the reminder engine behind GNOME Calendar,
but the only reminder UI it ships is the Evolution Reminders window: a separate
dialog, styled unlike anything else on the desktop, that accumulates every
reminder you never explicitly dismissed. This extension leaves the engine alone
and replaces only that UI.

Each triggered reminder becomes an ordinary GNOME notification with:

- **Open in Calendar** — opens GNOME Calendar on the event's date
- **Join** — only when the event has a meeting link
- **Snooze** — 10 minutes

## Why an extension

An external notification client (a script calling `notify-send`) can raise the
notification, but it cannot finish the job:

- Only GNOME Shell can call `Main.panel.closeCalendar()`. No notification action
  reaches it, so the message tray stays open over whatever you just launched.
- While the tray is open it holds a grab, so the launched window cannot take
  focus and opens *behind* it. The XDG activation token Shell hands out with
  every `ActionInvoked` does not help, and `notify-send` discards it anyway —
  which also leaves Shell's startup sequence dangling as a spinning cursor.

Running inside Shell, the extension closes the tray first and then launches with
Shell's own launch context, so the window lands in front.

## How it works

`evolution-alarm-notify` keeps doing the timing. On every trigger it appends the
reminder to the `reminders-past` GSettings key, independently of whether its own
window is enabled. The extension watches that key, notifies, and clears it —
which is also what stops reminders piling up.

While enabled it sets `notify-enable-display` to `false` to silence the Evolution
Reminders window, and restores the previous value when disabled.

## Requirements

- `evolution-data-server` (the reminder daemon must be running:
  `systemctl --user enable --now evolution-alarm-notify.service`)
- `gnome-calendar` for the Open in Calendar action

## Notes

- Missed reminders are still shown at login, unless the event has already ended.
- Snooze is in-memory: it does not survive a logout or disabling the extension.
- Meeting links are read from `LOCATION` (any URL) and from `DESCRIPTION` (known
  conferencing hosts only, so that unsubscribe links are not mistaken for
  meetings). ICS line folding is undone first, since it splits long URLs.

## Tested on

GNOME Shell 50, and typechecked against the GNOME 48 and 50 `@girs` typings.
Widen `shell-version` in `metadata.json` once another release has been tested.

## Licence

GPL-2.0-or-later

## Building

Requires [bun](https://bun.sh).

```sh
make          # compile extension.ts -> dist/
make pack     # build calendar-reminders.zip for extensions.gnome.org
make install  # install into ~/.local/share/gnome-shell/extensions
```

On Wayland a full logout is needed for GNOME Shell to pick up changed code.

Parsing has a standalone check that runs outside Shell:

```sh
gjs -m test-parse.js
```
