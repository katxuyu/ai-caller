import fetch from 'node-fetch';

// Cache for ZIP code to province mapping to avoid repeated API calls
let zipCodeProvinceCache = new Map();
let cacheLastUpdated = null;
const CACHE_DURATION_MS = 24 * 60 * 1000; // 24 hours

/**
 * Checks if the current server time is within operating hours (8 AM to 8 PM) in Italian timezone.
 * @returns {boolean} True if within operating hours, false otherwise.
 */
export function isOperatingHours() {
	const now = new Date();
	const formatter = new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Europe/Rome',
		hour: '2-digit',
		hour12: false
	});
	const currentHourItaly = parseInt(formatter.format(now));

	const is_operating = currentHourItaly >= 8 && currentHourItaly < 20;
	if (!is_operating) {
		console.log(`[Operating Hours] Current hour in Italy ${currentHourItaly} is outside operating hours (8-20).`);
	}
	return is_operating;
}

// Helper function to check if a proposed UTC time falls within Italian operating hours (9-20 Rome time)
// This function was moved from outgoing-call.js
export const isWithinItalianOperatingHours = (utcDate) => {
	const formatter = new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Europe/Rome',
		hour: '2-digit',
		hour12: false // 24-hour format
	});
	const hourInItaly = parseInt(formatter.format(utcDate));
	return hourInItaly >= 9 && hourInItaly < 20;
};

// Helper function to convert an Italian local date and time string to a UTC Date object
export function italianLocalToUTC(dateStr, timeStr, timeZone = 'Europe/Rome') {
	const [day, month, year] = dateStr.split('-').map(Number);
	const [hours, minutes] = timeStr.split(':').map(Number);

	const tempUTCDate = new Date(Date.UTC(year, month - 1, day, hours, minutes));

	const formatter = new Intl.DateTimeFormat('en-GB', {
		timeZone: timeZone,
		hour: '2-digit',
		hour12: false
	});
	const italianHourForTempUTCDate = parseInt(formatter.format(tempUTCDate));

	const offsetInHours = italianHourForTempUTCDate - hours;

	const targetUTCHours = hours - offsetInHours;

	return new Date(Date.UTC(year, month - 1, day, targetUTCHours, minutes));
}

// Helper function to get the next workday (Mon-Fri), operating on UTC dates
export function getNextValidWorkday(date) {
	const nextDay = new Date(date.getTime());
	nextDay.setUTCDate(nextDay.getUTCDate() + 1);
	while (nextDay.getUTCDay() === 0 || nextDay.getUTCDay() === 6) {
		nextDay.setUTCDate(nextDay.getUTCDate() + 1);
	}
	return nextDay;
}

/**
 * Checks if the targetDate is within one week from the startDate.
 * @param {Date} targetDate The date to check.
 * @param {Date} startDate The start of the one-week period.
 * @returns {boolean} True if targetDate is within one week from startDate, false otherwise.
 */
export function isWithinOneWeek(targetDate, startDate) {
	if (!(targetDate instanceof Date) || !(startDate instanceof Date) || isNaN(targetDate.getTime()) || isNaN(startDate.getTime())) {
		console.error("[isWithinOneWeek] Invalid date objects provided.", { targetDate, startDate });
		return false; // Or throw an error, depending on desired behavior
	}
	const oneWeekInMillis = 7 * 24 * 60 * 60 * 1000;
	const endDate = new Date(startDate.getTime() + oneWeekInMillis);
	return targetDate < endDate;
}

/**
 * Parses an Italian datetime string ("DD-MM-YYYY HH:mm") to a UTC Date object.
 * @param {string} dateTimeStr Italian datetime string.
 * @returns {Date|null} UTC Date object or null if parsing fails.
 */
export function parseItalianDateTimeToUTC(dateTimeStr) {
	if (!dateTimeStr || typeof dateTimeStr !== 'string') {
		console.error("[DateTimeParse] Invalid input for parseItalianDateTimeToUTC:", dateTimeStr);
		return null;
	}
	const parts = dateTimeStr.split(' ');
	if (parts.length !== 2) {
		console.error(`[DateTimeParse] Invalid format: "${dateTimeStr}". Expected "DD-MM-YYYY HH:mm".`);
		return null;
	}
	const dateStr = parts[0];
	const timeStr = parts[1];

	if (!/^\d{2}-\d{2}-\d{4}$/.test(dateStr) || !/^\d{2}:\d{2}$/.test(timeStr)) {
		console.error(`[DateTimeParse] Invalid date or time format in "${dateTimeStr}". Date: ${dateStr}, Time: ${timeStr}`);
		return null;
	}
	try {
		return italianLocalToUTC(dateStr, timeStr);
	} catch (e) {
		console.error(`[DateTimeParse] Error converting "${dateTimeStr}" to UTC: ${e.message}`);
		return null;
	}
} 