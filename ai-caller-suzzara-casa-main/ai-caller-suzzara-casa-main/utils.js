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

/**
 * Sleep utility for implementing delays in retry logic
 * @param {number} ms Milliseconds to sleep
 * @returns {Promise<void>}
 */
export function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Checks if an error is retryable based on common network error patterns
 * @param {Error} error The error to check
 * @returns {boolean} True if the error is likely retryable
 */
export function isRetryableError(error) {
	if (!error) return false;
	
	const retryablePatterns = [
		'fetch failed',
		'ECONNRESET',
		'ECONNREFUSED',
		'ETIMEDOUT',
		'ENOTFOUND',
		'EAI_AGAIN',
		'EPROTO',
		'EHOSTUNREACH',
		'ENETUNREACH',
		'socket hang up',
		'network timeout',
		'request timeout'
	];
	
	const errorMessage = error.message?.toLowerCase() || '';
	const errorCode = error.code?.toLowerCase() || '';
	
	return retryablePatterns.some(pattern => 
		errorMessage.includes(pattern.toLowerCase()) || 
		errorCode.includes(pattern.toLowerCase())
	);
}

/**
 * Checks if an HTTP status code is retryable
 * @param {number} status HTTP status code
 * @returns {boolean} True if the status is retryable
 */
export function isRetryableStatus(status) {
	// Retry on server errors (5xx) and specific client errors
	const retryableStatuses = [
		408, // Request Timeout
		429, // Too Many Requests
		500, // Internal Server Error
		502, // Bad Gateway
		503, // Service Unavailable
		504, // Gateway Timeout
		507, // Insufficient Storage
		509, // Bandwidth Limit Exceeded
		510  // Not Extended
	];
	
	return retryableStatuses.includes(status);
}

/**
 * Robust HTTP request function with retry logic and proper error handling
 * @param {string} url The URL to fetch
 * @param {Object} options Fetch options
 * @param {Object} retryConfig Retry configuration
 * @returns {Promise<Response>} The fetch response
 */
export async function robustFetch(url, options = {}, retryConfig = {}) {
	const {
		maxRetries = 3,
		baseDelay = 1000,
		maxDelay = 30000,
		backoffFactor = 2,
		timeout = 30000,
		retryOnStatus = true,
		logPrefix = '[ROBUST_FETCH]'
	} = retryConfig;

	let lastError = null;
	
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		let timeoutId = null;
		try {
			// Create AbortController for timeout
			const controller = new AbortController();
			timeoutId = setTimeout(() => {
				controller.abort();
			}, timeout);

			// Merge abort signal with existing options
			const fetchOptions = {
				...options,
				signal: options.signal ? 
					// If user provided a signal, we need to handle both
					AbortSignal.any ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
					: controller.signal
			};

			console.log(`${logPrefix} Attempt ${attempt + 1}/${maxRetries + 1} for ${url}`);
			
			const response = await fetch(url, fetchOptions);
			clearTimeout(timeoutId);

			// Check if we should retry based on status
			if (retryOnStatus && !response.ok && isRetryableStatus(response.status)) {
				const errorMessage = `HTTP ${response.status} ${response.statusText}`;
				console.warn(`${logPrefix} Retryable HTTP error on attempt ${attempt + 1}: ${errorMessage}`);
				
				if (attempt < maxRetries) {
					const delay = Math.min(baseDelay * Math.pow(backoffFactor, attempt), maxDelay);
					console.log(`${logPrefix} Waiting ${delay}ms before retry...`);
					await sleep(delay);
					continue;
				} else {
					throw new Error(`HTTP request failed after ${maxRetries + 1} attempts: ${errorMessage}`);
				}
			}

			// Success case
			if (attempt > 0) {
				console.log(`${logPrefix} Request succeeded on attempt ${attempt + 1}`);
			}
			
			return response;

		} catch (error) {
			if (timeoutId) clearTimeout(timeoutId);
			lastError = error;
			
			// Handle AbortError specifically
			if (error.name === 'AbortError') {
				console.error(`${logPrefix} Request timed out after ${timeout}ms on attempt ${attempt + 1}`);
				if (attempt < maxRetries) {
					const delay = Math.min(baseDelay * Math.pow(backoffFactor, attempt), maxDelay);
					console.log(`${logPrefix} Waiting ${delay}ms before retry after timeout...`);
					await sleep(delay);
					continue;
				} else {
					throw new Error(`Request timed out after ${maxRetries + 1} attempts (${timeout}ms each)`);
				}
			}

			// Check if error is retryable
			if (isRetryableError(error)) {
				console.warn(`${logPrefix} Retryable error on attempt ${attempt + 1}: ${error.message}`);
				
				if (attempt < maxRetries) {
					const delay = Math.min(baseDelay * Math.pow(backoffFactor, attempt), maxDelay);
					console.log(`${logPrefix} Waiting ${delay}ms before retry...`);
					await sleep(delay);
					continue;
				} else {
					console.error(`${logPrefix} Max retries exceeded. Final error: ${error.message}`);
					throw new Error(`Network request failed after ${maxRetries + 1} attempts: ${error.message}`);
				}
			} else {
				// Non-retryable error, fail immediately
				console.error(`${logPrefix} Non-retryable error: ${error.message}`);
				throw error;
			}
		}
	}

	// This should never be reached, but just in case
	throw lastError || new Error('Unexpected error in robustFetch');
}

/**
 * Creates a configured robustFetch function for GoHighLevel API calls
 * @param {string} logPrefix Prefix for logging
 * @returns {Function} Configured fetch function
 */
export function createGHLFetch(logPrefix = '[GHL_API]') {
	return (url, options = {}) => robustFetch(url, options, {
		maxRetries: 3,
		baseDelay: 2000,
		maxDelay: 15000,
		backoffFactor: 2,
		timeout: 20000,
		retryOnStatus: true,
		logPrefix
	});
}

/**
 * Creates a configured robustFetch function for Slack notifications
 * @param {string} logPrefix Prefix for logging
 * @returns {Function} Configured fetch function
 */
export function createSlackFetch(logPrefix = '[SLACK_API]') {
	return (url, options = {}) => robustFetch(url, options, {
		maxRetries: 2,
		baseDelay: 1000,
		maxDelay: 8000,
		backoffFactor: 2,
		timeout: 10000,
		retryOnStatus: true,
		logPrefix
	});
}

/**
 * Creates a configured robustFetch function for general HTTP requests
 * @param {string} logPrefix Prefix for logging
 * @returns {Function} Configured fetch function
 */
export function createRobustFetch(logPrefix = '[HTTP_API]') {
	return (url, options = {}) => robustFetch(url, options, {
		maxRetries: 2,
		baseDelay: 1000,
		maxDelay: 10000,
		backoffFactor: 2,
		timeout: 15000,
		retryOnStatus: true,
		logPrefix
	});
}