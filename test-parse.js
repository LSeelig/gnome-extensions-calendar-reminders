#!/usr/bin/env -S gjs -m
/* Standalone check for the reminder parsing. Run after `make`:
 *     gjs -m test-parse.js
 */
import { parseReminder } from "./dist/parser.js";

const assert = (cond, msg) => {
	if (!cond) throw new Error(`FAIL: ${msg}`);
};

function entry(body, trigger = 1787740000, start = 1787740000) {
	const ics =
		`BEGIN:VEVENT\r\nUID:abc123\r\nSUMMARY:Standup\r\n${body}END:VEVENT\r\n`;
	return ["src", "alarm", trigger, start, start + 600, ics].join("\n");
}

// ICS folds long lines at 75 octets with a leading space, splitting long URLs
assert(
	parseReminder(
		entry(
			"LOCATION:https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZmE0\r\n" +
				" ZTgtYjc4/0?context=%7b%22Tid%22%3a%22abc%22%7d\r\n",
		),
	).join ===
		"https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZmE0ZTgtYjc4/0?context=%7b%22Tid%22%3a%22abc%22%7d",
	"unfolds a folded meeting URL",
);

assert(parseReminder(entry("LOCATION:Room 3\\, Floor 2\r\n")).join === "",
	"a room name is not a link");
assert(parseReminder(entry("")).join === "", "no LOCATION at all");
assert(
	parseReminder(entry(
		"LOCATION:https://whereby.com/room\r\nDESCRIPTION:also https://zoom.us/j/9\r\n",
	)).join === "https://whereby.com/room",
	"LOCATION wins over DESCRIPTION",
);
assert(
	parseReminder(entry("DESCRIPTION:Join https://zoom.us/j/12345 now\r\n")).join ===
		"https://zoom.us/j/12345",
	"falls back to a known host in DESCRIPTION",
);
assert(
	parseReminder(entry("DESCRIPTION:Unsubscribe https://mailer.example.com/u/9\r\n"))
		.join === "",
	"ignores non-meeting links in DESCRIPTION",
);
assert(parseReminder(entry("")).summary === "Standup", "summary");
assert(parseReminder(entry("")).uuid === "src:abc123", "uuid");
assert(parseReminder("too\nshort") === null, "malformed entry");

// A real entry captured from reminders-past: recurring, TZID, tab-separated rid
const real =
	"2a5f4f5e0b5ab109e1a5e6e0c13dcebee305a5f7\nffdc6b1991a08bddff6e7fd512cad0e6723b5250\t20260826T103000Z\n1787739600\n1787740200\n1787742000\n" +
	"BEGIN:VEVENT\r\nDTSTART;TZID=Europe/London:20260826T113000\r\nRRULE:FREQ=WEEKLY;BYDAY=WE\r\n" +
	"UID:real-event-uid\r\nSUMMARY:Daily Stand-up\r\n" +
	"LOCATION:https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc\r\nEND:VEVENT\r\n";
const p = parseReminder(real);
assert(p.summary === "Daily Stand-up", "real entry summary");
assert(p.uuid === "2a5f4f5e0b5ab109e1a5e6e0c13dcebee305a5f7:real-event-uid",
	"real entry uuid");
assert(p.join === "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc",
	"real entry join link");
assert(p.trigger === 1787739600 && p.start === 1787740200 && p.end === 1787742000, "real entry times");

const allDay = parseReminder(entry("DTSTART;VALUE=DATE:20261008\r\n", 0, 1791417600));
assert(allDay.allDay, "all-day detected");
assert(allDay.start === new Date(2026, 9, 8).getTime() / 1000, "all-day start is local midnight");
assert(!parseReminder(entry("DTSTART:20261008T090000Z\r\n")).allDay, "timed is not all-day");

print("all parse assertions passed");
