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

const SNOOZE_KEY = "snooze-minutes";

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
	private _prefs: Gio.Settings | null = null;
	private _source: MessageTray.Source | null = null;
	private _sourceDestroyId = 0;
	private _seen = new Set<string>();
	private _dueScheduled = new Set<string>();
	private _notifications = new Map<string, MessageTray.Notification>();
	private _timeouts = new Set<number>();
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
		this._prefs = this.getSettings();
		this._seen = new Set();
		this._dueScheduled = new Set();
		this._notifications = new Map();
		this._timeouts = new Set();

		// Silence the Evolution Reminders window; restored on disable().
		this._hadDisplay = this._settings.get_boolean(DISPLAY_KEY);
		this._settings.set_boolean(DISPLAY_KEY, false);

		this._settings.connectObject(
			`changed::${PAST_KEY}`,
			() => this._onRemindersChanged(),
			this,
		);
		this._onRemindersChanged();
	}

	disable(): void {
		for (const id of this._timeouts) GLib.Source.remove(id);
		this._timeouts.clear();

		if (this._settings) {
			this._settings.disconnectObject(this);
			this._settings.set_boolean(DISPLAY_KEY, this._hadDisplay);
			this._settings = null;
		}

		this._prefs = null;
		if (this._sourceDestroyId) {
			this._source?.disconnect(this._sourceDestroyId);
			this._sourceDestroyId = 0;
		}
		this._source?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
		this._source = null;
		this._seen.clear();
		this._dueScheduled.clear();
		this._notifications.clear();
	}

	private _onRemindersChanged(): void {
		const settings = this._settings;
		if (!settings) return;

		const entries = settings.get_strv(PAST_KEY);
		if (entries.length === 0) return;

		const now = GLib.DateTime.new_now_local().to_unix();
		const keep: string[] = [];
		for (const entry of entries) {
			const reminder = parseReminder(entry);
			if (!reminder || now >= reminder.end) continue;
			keep.push(entry);
			if (this._seen.has(reminder.id)) continue;

			this._seen.add(reminder.id);
			this._notify(reminder);

			/* EDS only writes reminders-past at the alarm trigger, so nothing
			 * fires at the event itself. Schedule that one ourselves. */
			const dueKey = `${reminder.uuid}\n${reminder.start}`;
			if (reminder.start > now && !this._dueScheduled.has(dueKey)) {
				this._dueScheduled.add(dueKey);
				this._later(reminder.start - now, () => this._notify(reminder));
			}
		}

		// Keep entries until their event ends, prune the rest.
		if (keep.length !== entries.length) settings.set_strv(PAST_KEY, keep);
	}

	private _ensureSource(): MessageTray.Source {
		if (!this._source || !Main.messageTray.getSources().includes(this._source)) {
			this._source = new MessageTray.Source({
				title: _("Calendar"),
				iconName: "org.gnome.Calendar",
			});
			Main.messageTray.add(this._source);
		}
		return this._source;
	}

	private _notify(reminder: Reminder): void {
		const fmt = (t: number) => GLib.DateTime.new_from_unix_local(t).format("%H:%M");
		const notification = new MessageTray.Notification({
			source: this._ensureSource(),
			title: reminder.summary || _("Calendar event"),
			body: `${fmt(reminder.start)} – ${fmt(reminder.end)}`,
			iconName: "org.gnome.Calendar",
			urgency: MessageTray.Urgency.HIGH,
		});

		/* connectObject ties the handler to this extension object; the tracker
		 * drops it when either side is destroyed, and disable() sweeps the rest. */
		notification.connectObject(
			"activated",
			() => this._openCalendar(reminder),
			this,
		);
		notification.addAction(_("Open in Calendar"), () =>
			this._openCalendar(reminder),
		);
		if (reminder.join)
			notification.addAction(_("Join"), () => this._openUri(reminder.join));
		notification.addAction(_("Snooze"), () => this._snooze(reminder));

		const source = this._ensureSource();
		const previous = this._notifications.get(reminder.uuid);
		this._notifications.set(reminder.uuid, notification);

		source.addNotification(notification);
		if (previous && source.notifications.includes(previous))
			previous.destroy(MessageTray.NotificationDestroyedReason.REPLACED);
	}

	private _snooze(reminder: Reminder): void {
		// Read on each snooze so a preference change applies without a reload.
		const mins = this._prefs?.get_int(SNOOZE_KEY) ?? 10;
		this._later(mins * 60, () => this._notify(reminder));
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
