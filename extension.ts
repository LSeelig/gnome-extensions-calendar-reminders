/* extension.ts
 *
 * Calendar Reminders — GNOME notifications for Evolution Data Server reminders.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from "gi://Gio";
import GLib from "gi://GLib";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as MessageTray from "resource:///org/gnome/shell/ui/messageTray.js";
import {
	Extension,
	gettext as _,
} from "resource:///org/gnome/shell/extensions/extension.js";

import { parseReminder, type Reminder } from "./parser.js";

const EDS_SCHEMA = "org.gnome.evolution-data-server.calendar";
const PAST_KEY = "reminders-past";
const DISPLAY_KEY = "notify-enable-display";

/* Reminders older than this are cleared without notifying. reminders-past keeps
 * up to reminders-past-days (7) of missed reminders, and replaying a week of
 * them at login is a notification storm. */
const STALE_SECS = 3600;
const SNOOZE_SECS = 600;

/* @girs resolves two copies of Gio — one under @girs/gnome-shell, one under
 * @girs/meta — so the context this returns does not typecheck against
 * Gio.AppInfo.launch(). It is the same object at runtime. */
function launchContext(): Gio.AppLaunchContext {
	return global.create_app_launch_context(
		0,
		-1,
	) as unknown as Gio.AppLaunchContext;
}

export default class CalendarRemindersExtension extends Extension {
	private _settings: Gio.Settings | null = null;
	private _source: MessageTray.Source | null = null;
	private _seen = new Set<string>();
	private _timeouts = new Set<number>();
	private _signals: [Gio.Settings | MessageTray.Source | MessageTray.Notification, number][] = [];
	private _changedId = 0;
	private _hadDisplay = true;

	enable(): void {
		const schemas = Gio.SettingsSchemaSource.get_default();
		if (!schemas?.lookup(EDS_SCHEMA, true)) {
			console.warn(
				`${this.metadata.name}: ${EDS_SCHEMA} not found; ` +
					"is evolution-data-server installed?",
			);
			return;
		}

		this._settings = new Gio.Settings({ schema_id: EDS_SCHEMA });
		this._seen = new Set();
		this._timeouts = new Set();
		this._signals = [];

		// Silence the Evolution Reminders window; restored on disable().
		this._hadDisplay = this._settings.get_boolean(DISPLAY_KEY);
		this._settings.set_boolean(DISPLAY_KEY, false);

		this._changedId = this._settings.connect(`changed::${PAST_KEY}`, () =>
			this._onRemindersChanged(),
		);
		this._onRemindersChanged();
	}

	disable(): void {
		for (const id of this._timeouts) GLib.Source.remove(id);
		this._timeouts.clear();

		for (const [obj, id] of this._signals) obj.disconnect(id);
		this._signals = [];

		if (this._changedId) {
			this._settings?.disconnect(this._changedId);
			this._changedId = 0;
		}
		if (this._settings) {
			this._settings.set_boolean(DISPLAY_KEY, this._hadDisplay);
			this._settings = null;
		}

		this._source?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
		this._source = null;
		this._seen.clear();
	}

	private _onRemindersChanged(): void {
		const settings = this._settings;
		if (!settings) return;

		const entries = settings.get_strv(PAST_KEY);
		if (entries.length === 0) return;

		const now = GLib.DateTime.new_now_local().to_unix();
		for (const entry of entries) {
			const reminder = parseReminder(entry);
			if (!reminder || this._seen.has(reminder.id)) continue;

			this._seen.add(reminder.id);
			if (now - reminder.trigger > STALE_SECS) continue;
			this._notify(reminder);

			/* EDS only writes reminders-past at the alarm trigger, so nothing
			 * fires at the event itself. Schedule that one ourselves. */
			if (reminder.start > now)
				this._later(reminder.start - now, () => this._notify(reminder, true));
		}

		/* Clearing the key is what stops reminders piling up in the Evolution
		 * Reminders window. `_seen` guards against re-notifying if the daemon
		 * ever writes the same entries back. */
		settings.set_strv(PAST_KEY, []);
	}

	private _ensureSource(): MessageTray.Source {
		if (!this._source) {
			this._source = new MessageTray.Source({
				title: _("Calendar"),
				iconName: "org.gnome.Calendar",
			});
			this._track(this._source, this._source.connect("destroy", () => (this._source = null)));
			Main.messageTray.add(this._source);
		}
		return this._source;
	}

	private _notify(reminder: Reminder, due = false): void {
		const start = GLib.DateTime.new_from_unix_local(reminder.start);
		const notification = new MessageTray.Notification({
			source: this._ensureSource(),
			title: due ? _("Starting now") : _("Reminder"),
			body: `${reminder.summary || _("Calendar event")} — ${start.format("%H:%M")}`,
			iconName: "org.gnome.Calendar",
			urgency: MessageTray.Urgency.HIGH,
		});

		this._track(
			notification,
			notification.connect("activated", () => this._openCalendar(reminder)),
		);
		notification.addAction(_("Open in Calendar"), () =>
			this._openCalendar(reminder),
		);
		if (reminder.join)
			notification.addAction(_("Join"), () => this._openUri(reminder.join));
		notification.addAction(_("Snooze"), () => this._snooze(reminder));

		this._ensureSource().addNotification(notification);
	}

	private _snooze(reminder: Reminder): void {
		this._later(SNOOZE_SECS, () => this._notify(reminder));
	}

	private _track(obj: (typeof this._signals)[0][0], id: number): void {
		this._signals.push([obj, id]);
	}

	private _later(secs: number, fn: () => void): void {
		const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
			this._timeouts.delete(id);
			fn();
			return GLib.SOURCE_REMOVE;
		});
		this._timeouts.add(id);
	}

	/* Closing the tray first is the whole point of being an extension: while the
	 * message tray holds its grab nothing else can take focus, so a window
	 * launched underneath it opens behind. An external notification client
	 * cannot reach closeCalendar() at all. */
	private _dismissShellUi(): void {
		Main.overview.hide();
		Main.panel.closeCalendar();
	}

	private _openUri(uri: string): void {
		this._dismissShellUi();
		try {
			Gio.AppInfo.launch_default_for_uri(uri, launchContext());
		} catch (e) {
			console.warn(`${this.metadata.name}: cannot open ${uri}: ${e}`);
		}
	}

	private _openCalendar(reminder: Reminder): void {
		this._dismissShellUi();

		const start = GLib.DateTime.new_from_unix_local(reminder.start);
		/* gnome-calendar --date parses in the locale's format, so %x, not ISO.
		 * --uuid only selects the event once the view has loaded it, so it is a
		 * bonus on top of --date, not the mechanism. */
		if (!GLib.find_program_in_path("gnome-calendar")) {
			console.warn(`${this.metadata.name}: gnome-calendar is not installed`);
			return;
		}

		const argv =
			`gnome-calendar --date ${GLib.shell_quote(start.format("%x %H:%M")!)} ` +
			`--uuid ${GLib.shell_quote(reminder.uuid)}`;

		try {
			const app = Gio.AppInfo.create_from_commandline(
				argv,
				"Calendar",
				Gio.AppInfoCreateFlags.NONE,
			);
			app.launch([], launchContext());
		} catch (e) {
			console.warn(`${this.metadata.name}: cannot open Calendar: ${e}`);
		}
	}
}
