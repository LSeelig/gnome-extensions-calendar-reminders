/* parser.ts — pure ICS/reminder parsing, no GNOME Shell imports, so it can be
 * exercised outside the compositor: gjs -m test-parse.js
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const MEETING_HOSTS =
	"teams\\.(?:microsoft|live)\\.com|meet\\.google\\.com|zoom\\.us|" +
	"webex\\.com|whereby\\.com|meet\\.jit\\.si";

export interface Reminder {
	id: string;
	uuid: string;
	summary: string;
	trigger: number;
	start: number;
	join: string;
}

/* LOCATION wins and accepts any URL — a link put there was meant as the venue.
 * DESCRIPTION is only searched for known conferencing hosts, because taking the
 * first URL out of a description body picks up unsubscribe and branding links. */
function meetingUri(location: string, description: string): string {
	const inLocation = location.match(/https?:\/\/[^\s<>"]+/);
	if (inLocation) return inLocation[0].replace(/[.,)]+$/, "");

	const inDescription = description.match(
		new RegExp(`https?://[^\\s<>"]*(?:${MEETING_HOSTS})[^\\s<>"]*`),
	);
	return inDescription ? inDescription[0].replace(/[.,)]+$/, "") : "";
}

/* An entry is: source_uid \n alarm_uid[\trid] \n trigger \n start \n end \n ICS */
export function parseReminder(entry: string): Reminder | null {
	const parts = entry.split("\n");
	if (parts.length < 6) return null;

	const [sourceUid, alarmUid, trigger, start] = parts;
	/* ICS folds long lines at 75 octets with a leading space or tab, which
	 * splits exactly the long meeting URLs we want to find. Unfold first. */
	const ics = parts.slice(5).join("\n").replace(/\r?\n[ \t]/g, "");

	const field = (name: string): string => {
		const m = ics.match(new RegExp(`^${name}:(.*)$`, "m"));
		return m ? m[1] : "";
	};
	// ICS escapes , ; \ and newlines inside text values
	const unescape = (text: string): string =>
		text.replace(/\\([,;\\])/g, "$1").replace(/\\n/g, " ");

	return {
		id: `${sourceUid}\n${alarmUid}`,
		uuid: `${sourceUid}:${field("UID").trim()}`,
		summary: unescape(field("SUMMARY")).trim(),
		trigger: Number.parseInt(trigger, 10),
		start: Number.parseInt(start, 10),
		join: meetingUri(unescape(field("LOCATION")), unescape(field("DESCRIPTION"))),
	};
}

