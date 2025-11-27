import { getValidGoHighlevelToken } from './tokens.js';
import { sendNonFatalSlackNotification } from '../slack/notifications.js';
import { createGHLFetch } from '../utils.js';

// Function to fetch available slots from GoHighLevel
export async function fetchGHLCalendarSlots(location_id, calendarId, startDateISO, endDateISO) {
	const accessToken = await getValidGoHighlevelToken(location_id);
	if (!accessToken) {
		console.error(`[GHL Slots] Failed to get valid GHL token for fetching slots.`);
		await sendNonFatalSlackNotification(
			'GHL Token Authentication Failed - Slots',
			`Failed to get valid GoHighLevel token for fetching calendar slots. Location ID: ${location_id}`,
			{
				locationId: location_id,
				calendarId,
				function: 'fetchGHLCalendarSlots',
				impact: 'Customers cannot see available appointment slots'
			}
		).catch(console.error);
		return null; // Indicates an error in obtaining a token
	}

	// Convert ISO date strings to milliseconds for the GHL API
	const startMillis = new Date(startDateISO).getTime();
	const endMillis = new Date(endDateISO).getTime();

	// GHL API endpoint for free slots
	const slotsApiUrl = new URL(`https://services.leadconnectorhq.com/calendars/${calendarId}/free-slots`);
	slotsApiUrl.searchParams.append('startDate', startMillis.toString()); // Pass as string
	slotsApiUrl.searchParams.append('endDate', endMillis.toString());   // Pass as string

	console.log(`[GHL Slots] Fetching free slots for calendar ${calendarId}. Start (ms): ${startMillis}, End (ms): ${endMillis}. URL: ${slotsApiUrl.toString()}`);

	try {
		const robustFetch = createGHLFetch(`[GHL Slots - ${calendarId}]`);
		const response = await robustFetch(slotsApiUrl.toString(), {
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Version': '2021-04-15', // Common GHL API version header
				'Accept': 'application/json'
			}
		});

		if (!response.ok) {
			const errorBody = await response.text();
			console.error(`[GHL Slots] GHL API error fetching slots for calendar ${calendarId}. Status: ${response.status}. URL: ${slotsApiUrl.toString()}. Response: ${errorBody}`);
			await sendNonFatalSlackNotification(
				'GHL Calendar Slots API Error',
				`GoHighLevel API error fetching calendar slots. Status: ${response.status}`,
				{
					locationId: location_id,
					calendarId,
					status: response.status,
					apiUrl: slotsApiUrl.toString(),
					errorBody,
					function: 'fetchGHLCalendarSlots',
					impact: 'Customers cannot see available appointment slots'
				}
			).catch(console.error);
			return null; // Indicates an API error or non-successful response
		}

		const data = await response.json();
		let allFoundSlots = [];
		let datesProcessed = 0;
		if (data && typeof data === 'object') {
			for (const dateKey in data) {
				if (data.hasOwnProperty(dateKey) && dateKey.match(/^\d{4}-\d{2}-\d{2}$/)) { // Check if key looks like a date
					if (data[dateKey] && Array.isArray(data[dateKey].slots)) {
						console.log(`[GHL Slots] Found ${data[dateKey].slots.length} slots for date ${dateKey}.`);
						
						allFoundSlots = allFoundSlots.concat(data[dateKey].slots);
						datesProcessed++;
					} else {
						console.warn(`[GHL Slots] Date key ${dateKey} found, but no 'slots' array or unexpected structure:`, data[dateKey]);
					}
				}
			}
		}

		if (datesProcessed > 0) {
			console.log(`[GHL Slots] Successfully processed ${datesProcessed} date(s) and aggregated ${allFoundSlots.length} slots.`);
			return allFoundSlots;
		} else if (data && (data.freeSlots && Array.isArray(data.freeSlots))) { // Fallback for old structure if needed
			console.log(`[GHL Slots] Successfully fetched ${data.freeSlots.length} slots (from data.freeSlots - fallback).`);
			return data.freeSlots;
		} else if (data && (data.slots && Array.isArray(data.slots))) { // Fallback for old structure if needed
			console.log(`[GHL Slots] Successfully fetched ${data.slots.length} slots (from data.slots - fallback).`);
			return data.slots;
		} else if (Array.isArray(data)) { // Fallback for direct array response
			console.log(`[GHL Slots] Successfully fetched ${data.length} slots (from direct array response - fallback).`);
			return data;
		}
		
		console.warn(`[GHL Slots] GHL API call successful but no slots found in the expected new structure or any fallback structures. Response: ${JSON.stringify(data)}`);
		return []; // No slots found, but the API call itself was okay.
	} catch (error) {
		console.error(`[GHL Slots] Exception during fetchGHLCalendarSlots for calendar ${calendarId}: ${error.message}`, error);
		await sendNonFatalSlackNotification(
			'GHL Calendar Slots Exception',
			`Critical exception during calendar slots fetch for calendar ${calendarId}. Error: ${error.message}`,
			{
				locationId: location_id,
				calendarId,
				error: error.stack,
				function: 'fetchGHLCalendarSlots',
				impact: 'Customers cannot see available appointment slots'
			}
		).catch(console.error);
		return null; // Indicates a critical error during the fetch operation (e.g., network issue)
	}
}

// Helper function to book an appointment in GoHighLevel
export async function bookGHLAppointment(location_id, calendarId, contactId, startTimeUTC) {
	const accessToken = await getValidGoHighlevelToken(location_id);
	if (!accessToken) {
		console.error(`[GHL Bookings] Failed to get valid GHL token for booking appointment.`);
		await sendNonFatalSlackNotification(
			'🚨 CRITICAL: GHL Token Failed - Booking Blocked',
			`Failed to get valid GoHighLevel token for booking appointment. Location ID: ${location_id}`,
			{
				locationId: location_id,
				calendarId,
				contactId,
				startTime: startTimeUTC.toISOString(),
				function: 'bookGHLAppointment',
				impact: 'REVENUE IMPACT: Customer appointments cannot be booked',
				critical: true
			}
		).catch(console.error);
		return { success: false, error: "Failed to obtain GHL token", type: "token_error" };
	}

	const bookingApiUrl = 'https://services.leadconnectorhq.com/calendars/events/appointments';
	
	const payload = {
		calendarId: calendarId,
		locationId: location_id,
		contactId: contactId,
		startTime: startTimeUTC.toISOString(), // Must be UTC ISO string
	};

	console.log(`[GHL Bookings] Attempting to book appointment for contact ${contactId} on calendar ${calendarId}. StartTime (UTC): ${payload.startTime}. Payload:`, JSON.stringify(payload));

	try {
		const robustFetch = createGHLFetch(`[GHL Bookings - ${contactId}]`);
		const response = await robustFetch(bookingApiUrl, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Version': '2021-04-15', // Common GHL API version header
				'Accept': 'application/json',
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(payload)
		});

		const responseBodyText = await response.text(); // Get text for robust error logging

		if (response.ok) { // status 200-299
			console.log(`[GHL Bookings] Successfully booked appointment. Status: ${response.status}. Response: ${responseBodyText}`);
			try {
				return { success: true, data: JSON.parse(responseBodyText) };
			} catch (parseError) {
				// If parsing fails but status was ok, still consider it a success
				console.warn(`[GHL Bookings] Successfully booked (status ${response.status}) but couldn't parse JSON response: ${responseBodyText}`);
				return { success: true, data: { message: "Booking successful, unparsable response." } };
			}
		} else {
			console.error(`[GHL Bookings] GHL API error booking appointment. Status: ${response.status}. URL: ${bookingApiUrl}. Response: ${responseBodyText}`);
			await sendNonFatalSlackNotification(
				'🚨 CRITICAL: GHL Booking API Error',
				`GoHighLevel API error booking appointment. Status: ${response.status}. Contact: ${contactId}`,
				{
					locationId: location_id,
					calendarId,
					contactId,
					startTime: startTimeUTC.toISOString(),
					status: response.status,
					apiUrl: bookingApiUrl,
					responseBody: responseBodyText,
					function: 'bookGHLAppointment',
					impact: 'REVENUE IMPACT: Customer appointment booking failed',
					critical: true
				}
			).catch(console.error);
			// Try to parse error for more details if GHL provides structured errors
			let errorDetails = responseBodyText;
			try {
				errorDetails = JSON.parse(responseBodyText);
			} catch (e) { /* Keep as text if not JSON */ }
			return { success: false, error: "GHL API Error", status: response.status, details: errorDetails, type: "api_error" };
		}
	} catch (error) {
		console.error(`[GHL Bookings] Exception during bookGHLAppointment: ${error.message}`, error);
		await sendNonFatalSlackNotification(
			'🚨 FATAL: GHL Booking Exception',
			`Critical exception during appointment booking. Contact: ${contactId}. Error: ${error.message}`,
			{
				locationId: location_id,
				calendarId,
				contactId,
				startTime: startTimeUTC.toISOString(),
				error: error.stack,
				function: 'bookGHLAppointment',
				impact: 'REVENUE IMPACT: System-level booking failure',
				critical: true,
				severity: 'FATAL'
			}
		).catch(console.error);
		return { success: false, error: `Exception: ${error.message}`, type: "exception" };
	}
}

/**
 * Fetches contact details from GoHighLevel.
 * @param {string} locationId The GHL Location ID.
 * @param {string} contactId The GHL Contact ID.
 * @returns {Promise<Object|null>} Contact details or null.
 */
export async function getGHLContactDetails(locationId, contactId) {
	if (!locationId || !contactId) {
		console.error("[GHL Contact] Missing locationId or contactId for fetching details.");
		return null;
	}
	const accessToken = await getValidGoHighlevelToken(locationId);
	if (!accessToken) {
		console.error(`[GHL Contact - ${contactId}] Failed to get valid GHL token.`);
		await sendNonFatalSlackNotification(
			'GHL Token Authentication Failed - Contact Details',
			`Failed to get valid GoHighLevel token for fetching contact details. Contact ID: ${contactId}`,
			{
				locationId,
				contactId,
				function: 'getGHLContactDetails',
				impact: 'Contact information cannot be retrieved'
			}
		).catch(console.error);
		return null;
	}

	const apiUrl = `https://services.leadconnectorhq.com/contacts/${contactId}`;
	console.log(`[GHL Contact - ${contactId}] Fetching details from ${apiUrl}`);

	try {
		const robustFetch = createGHLFetch(`[GHL Contact - ${contactId}]`);
		const response = await robustFetch(apiUrl, {
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Version': '2021-07-28', // Or a relevant GHL API version
				'Accept': 'application/json'
			}
		});

		if (!response.ok) {
			const errorBody = await response.text();
			console.error(`[GHL Contact - ${contactId}] API error: ${response.status}. Body: ${errorBody}`);
			return null;
		}
		const data = await response.json();
		console.log(`[GHL Contact - ${contactId}] Response:`, data);
		if (data && data.contact) { // Common structure with "contact" wrapper
			return {
				phone: data.contact.phone || null,
				firstName: data.contact.firstName || "",
				lastName: data.contact.lastName || "",
				fullName: data.contact.fullName || `${data.contact.firstName || ""} ${data.contact.lastName || ""}`.trim(),
				email: data.contact.email || null,
				contactId: data.contact.id || contactId,
				customFields: data.contact.customFields || [],
			};
		} else if (data) { // Fallback if fields are at the root
			console.log(`[GHL Contact - ${contactId}] Attempting to parse contact data from root of response.`);
			return {
				phone: data.phone || null,
				firstName: data.firstName || "",
				lastName: data.lastName || "",
				fullName: data.fullName || `${data.firstName || ""} ${data.lastName || ""}`.trim(),
				email: data.email || null,
				contactId: data.id || contactId,
				customFields: data.customFields || [],
			};
		}
		console.warn(`[GHL Contact - ${contactId}] Unexpected response structure. Full response:`, JSON.stringify(data, null, 2));
		return null;

	} catch (error) {
		console.error(`[GHL Contact - ${contactId}] Exception fetching details: ${error.message}`, error);
		await sendNonFatalSlackNotification(
			'GHL Contact Details Exception',
			`Exception fetching contact details for ${contactId}. Error: ${error.message}`,
			{
				locationId,
				contactId,
				error: error.stack,
				function: 'getGHLContactDetails',
				impact: 'Contact information retrieval failed'
			}
		).catch(console.error);
		return null;
	}
}

/**
 * Adds a note to a GoHighLevel contact
 * @param {string} locationId The GHL Location ID.
 * @param {string} contactId The GHL Contact ID.
 * @param {string} noteBody The note content to add.
 * @returns {Promise<Object>} Result with success status.
 */
export async function addGHLContactNote(locationId, contactId, noteBody) {
	if (!locationId || !contactId || !noteBody) {
		console.error("[GHL Note] Missing required parameters for adding note.");
		return { success: false, error: "Missing required parameters" };
	}

	const accessToken = await getValidGoHighlevelToken(locationId);
	if (!accessToken) {
		console.error(`[GHL Note - ${contactId}] Failed to get valid GHL token.`);
		return { success: false, error: "Failed to obtain GHL token" };
	}

	const apiUrl = `https://services.leadconnectorhq.com/contacts/${contactId}/notes`;
	
	const payload = {
		body: noteBody
	};

	console.log(`[GHL Note - ${contactId}] Adding note: ${noteBody.substring(0, 100)}...`);

	try {
		const robustFetch = createGHLFetch(`[GHL Note - ${contactId}]`);
		const response = await robustFetch(apiUrl, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Version': '2021-07-28',
				'Accept': 'application/json',
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(payload)
		});

		const responseBodyText = await response.text();

		if (response.ok) {
			console.log(`[GHL Note - ${contactId}] Successfully added note. Status: ${response.status}`);
			try {
				return { success: true, data: JSON.parse(responseBodyText) };
			} catch (parseError) {
				return { success: true, data: { message: "Note added successfully" } };
			}
		} else {
			console.error(`[GHL Note - ${contactId}] API error adding note. Status: ${response.status}. Response: ${responseBodyText}`);
			return { success: false, error: "GHL API Error", status: response.status, details: responseBodyText };
		}
	} catch (error) {
		console.error(`[GHL Note - ${contactId}] Exception adding note: ${error.message}`, error);
		return { success: false, error: `Exception: ${error.message}` };
	}
}

/**
 * Creates a new contact in GoHighLevel
 * @param {string} locationId The GHL Location ID.
 * @param {Object} contactData Contact data to create.
 * @returns {Promise<Object>} Result with success status and contact details.
 */
export async function createGHLContact(locationId, contactData) {
	if (!locationId || !contactData) {
		console.error("[GHL Create Contact] Missing locationId or contactData.");
		return { success: false, error: "Missing required parameters" };
	}

	const accessToken = await getValidGoHighlevelToken(locationId);
	if (!accessToken) {
		console.error(`[GHL Create Contact] Failed to get valid GHL token.`);
		await sendNonFatalSlackNotification(
			'GHL Token Authentication Failed - Contact Creation',
			`Failed to get valid GoHighLevel token for creating contact. Location ID: ${locationId}`,
			{
				locationId,
				contactData,
				function: 'createGHLContact',
				impact: 'New contacts cannot be created in CRM'
			}
		).catch(console.error);
		return { success: false, error: "Failed to obtain GHL token" };
	}

	const apiUrl = `https://services.leadconnectorhq.com/contacts/`;
	
	const payload = {
		locationId: locationId,
		...contactData,
	};

	console.log(`[GHL Create Contact] Creating contact with payload:`, JSON.stringify(payload));

	try {
		const robustFetch = createGHLFetch(`[GHL Create Contact]`);
		const response = await robustFetch(apiUrl, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Version': '2021-07-28',
				'Accept': 'application/json',
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(payload)
		});

		const responseBodyText = await response.text();

		if (response.ok) {
			console.log(`[GHL Create Contact] Successfully created contact. Status: ${response.status}`);
			try {
				const responseData = JSON.parse(responseBodyText);
				const contact = responseData.contact || responseData;
				return { 
					success: true, 
					contactId: contact.id,
					fullName: contact.fullName || `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
					email: contact.email || null,
					data: responseData 
				};
			} catch (parseError) {
				return { success: true, data: { message: "Contact created successfully" } };
			}
		} else {
			console.error(`[GHL Create Contact] API error creating contact. Status: ${response.status}. Response: ${responseBodyText}`);
			
			// Handle duplicate contact error
			if (response.status === 422) {
				try {
					const errorData = JSON.parse(responseBodyText);
					if (errorData.message === "This location does not allow duplicated contacts." && errorData.meta && errorData.meta.contactId) {
						// Don't send notification for duplicate contacts - this is expected behavior
						return {
							success: false,
							error: "Duplicate contact",
							details: errorData
						};
					}
				} catch (e) {
					// Fall through to generic error handling
				}
			}
			
			await sendNonFatalSlackNotification(
				'GHL Contact Creation API Error',
				`GoHighLevel API error creating contact. Status: ${response.status}`,
				{
					locationId,
					contactData,
					status: response.status,
					responseBody: responseBodyText,
					function: 'createGHLContact',
					impact: 'New contact creation failed in CRM'
				}
			).catch(console.error);
			
			return { success: false, error: "GHL API Error", status: response.status, details: responseBodyText };
		}
	} catch (error) {
		console.error(`[GHL Create Contact] Exception creating contact: ${error.message}`, error);
		await sendNonFatalSlackNotification(
			'GHL Contact Creation Exception',
			`Exception creating contact in GoHighLevel. Error: ${error.message}`,
			{
				locationId,
				contactData,
				error: error.stack,
				function: 'createGHLContact',
				impact: 'Contact creation system failure'
			}
		).catch(console.error);
		return { success: false, error: `Exception: ${error.message}` };
	}
}

/**
 * Updates a contact in GoHighLevel
 * @param {string} locationId The GHL Location ID.
 * @param {string} contactId The GHL Contact ID.
 * @param {Object} updateData Data to update.
 * @returns {Promise<Object>} Result with success status.
 */
export async function updateGHLContact(locationId, contactId, updateData) {
	if (!locationId || !contactId || !updateData) {
		console.error("[GHL Update Contact] Missing required parameters.");
		return { success: false, error: "Missing required parameters" };
	}

	const accessToken = await getValidGoHighlevelToken(locationId);
	if (!accessToken) {
		console.error(`[GHL Update Contact - ${contactId}] Failed to get valid GHL token.`);
		return { success: false, error: "Failed to obtain GHL token" };
	}

	const apiUrl = `https://services.leadconnectorhq.com/contacts/${contactId}`;
	
	// Handle special fields that need custom field mapping
	const payload = { ...updateData };
	
	// Handle address update (indirizzo -> custom field)
	if (updateData.indirizzo !== undefined) {
		payload.customFields = payload.customFields || [];
		payload.customFields.push({
			id: "contact.indirizzo", // Custom field ID for address
			field_value: updateData.indirizzo
		});
		delete payload.indirizzo;
	}

	console.log(`[GHL Update Contact - ${contactId}] Updating with payload:`, JSON.stringify(payload));

	try {
		const robustFetch = createGHLFetch(`[GHL Update Contact - ${contactId}]`);
		const response = await robustFetch(apiUrl, {
			method: 'PUT',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Version': '2021-07-28',
				'Accept': 'application/json',
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(payload)
		});

		const responseBodyText = await response.text();

		if (response.ok) {
			console.log(`[GHL Update Contact - ${contactId}] Successfully updated contact. Status: ${response.status}`);
			try {
				return { success: true, data: JSON.parse(responseBodyText) };
			} catch (parseError) {
				return { success: true, data: { message: "Contact updated successfully" } };
			}
		} else {
			console.error(`[GHL Update Contact - ${contactId}] API error updating contact. Status: ${response.status}. Response: ${responseBodyText}`);
			return { success: false, error: "GHL API Error", status: response.status, details: responseBodyText };
		}
	} catch (error) {
		console.error(`[GHL Update Contact - ${contactId}] Exception updating contact: ${error.message}`, error);
		return { success: false, error: `Exception: ${error.message}` };
	}
}

/**
 * Retrieves a GoHighLevel contact by phone number with multiple format attempts.
 * @param {string} locationId The GHL Location ID.
 * @param {string} phoneNumber The phone number to search for.
 * @returns {Promise<Object>} Result with success status and contact details.
 */
export async function getGHLContactByPhone(locationId, phoneNumber) {
	if (!locationId || !phoneNumber) {
		console.error("[GHL Get Contact By Phone] Missing required parameters: locationId or phoneNumber.");
		return { success: false, error: "Missing locationId or phoneNumber." };
	}

	const accessToken = await getValidGoHighlevelToken(locationId);
	if (!accessToken) {
		console.error(`[GHL Get Contact By Phone - ${locationId}] Failed to get valid GHL token.`);
		await sendNonFatalSlackNotification(
			'GHL Token Authentication Failed - Phone Lookup',
			`Failed to get valid GoHighLevel token for phone lookup. Location ID: ${locationId}`,
			{
				locationId,
				phoneNumber,
				function: 'getGHLContactByPhone',
				impact: 'Contact lookup by phone number failed'
			}
		).catch(console.error);
		return { success: false, error: "Failed to obtain GHL token for phone lookup" };
	}

	const searchAttempts = [];

	// Attempt 1: Original number (e.g., +393427531509)
	if (phoneNumber.startsWith('+')) {
		searchAttempts.push({ formatName: "Original with +", numberToSearch: phoneNumber });
	} else {
		searchAttempts.push({ formatName: "Original as-is", numberToSearch: phoneNumber });
		searchAttempts.push({ formatName: "Original with + prepended", numberToSearch: `+${phoneNumber}`});
	}

	// Attempt 2: Number without +
	let numberWithoutPlus = phoneNumber.startsWith('+') ? phoneNumber.substring(1) : phoneNumber;
	if (!searchAttempts.some(a => a.numberToSearch === numberWithoutPlus)) {
		searchAttempts.push({ formatName: "Without +", numberToSearch: numberWithoutPlus });
	}

	// Attempt 3: Fully normalized (no +, no common prefix like 39 or 1)
	let fullyNormalizedNumber = numberWithoutPlus;
	const prefixesToRemove = ["39", "1"];
	for (const prefix of prefixesToRemove) {
		if (fullyNormalizedNumber.startsWith(prefix)) {
			const testNumber = fullyNormalizedNumber.substring(prefix.length);
			if (testNumber.length > 5) {
				fullyNormalizedNumber = testNumber;
				break;
			}
		}
	}
	if (!searchAttempts.some(a => a.numberToSearch === fullyNormalizedNumber)) {
		searchAttempts.push({ formatName: "Fully Normalized (no +, no prefix)", numberToSearch: fullyNormalizedNumber });
	}

	console.log(`[GHL Get Contact By Phone - ${locationId}] Will attempt searches with ${searchAttempts.length} formats for original number ${phoneNumber}.`);

	const searchApiUrl = `https://services.leadconnectorhq.com/contacts/search`;

	for (const attempt of searchAttempts) {
		const searchPayload = {
			locationId: locationId,
			filters: [
				{
					"field": "phone",
					"operator": "eq",
					"value": attempt.numberToSearch
				}
			],
			pageLimit: 5
		};

		console.log(`[GHL Get Contact By Phone - ${locationId}] Attempting search with format '${attempt.formatName}': ${attempt.numberToSearch}`);

		try {
			const robustFetch = createGHLFetch(`[GHL Contact Search - ${locationId}]`);
			const response = await robustFetch(searchApiUrl, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${accessToken}`,
					'Version': '2021-07-28',
					'Accept': 'application/json',
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(searchPayload)
			});

			const responseBodyText = await response.text();

			if (response.status === 200) {
				const responseData = JSON.parse(responseBodyText);
				if (responseData.contacts && responseData.contacts.length > 0) {
					const contact = responseData.contacts[0];
					console.log(`[GHL Get Contact By Phone - ${locationId}] SUCCESS: Found contact using format '${attempt.formatName}' (${attempt.numberToSearch}). ID: ${contact.id}`);
					return {
						success: true,
						contactId: contact.id,
						fullName: contact.fullName || `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
						email: contact.email || null,
					};
				} else {
					console.log(`[GHL Get Contact By Phone - ${locationId}] No contact found with format '${attempt.formatName}' (${attempt.numberToSearch}).`);
				}
			} else {
				console.error(`[GHL Get Contact By Phone - ${locationId}] GHL API error with format '${attempt.formatName}'. Status: ${response.status}. Response: ${responseBodyText}`);
			}
		} catch (error) {
			console.error(`[GHL Get Contact By Phone - ${locationId}] Exception during search with format '${attempt.formatName}': ${error.message}`, error);
		}
	}

	console.log(`[GHL Get Contact By Phone - ${locationId}] No contact found after trying all formats for original number ${phoneNumber}.`);
	return { success: false, error: "No contact found after trying all formats" };
}

/**
 * Adds a contact to a GoHighLevel workflow
 * @param {string} contactId - The GHL Contact ID
 * @param {string} workflowId - The GHL Workflow ID
 * @param {string} apiKey - The GHL API Key
 * @returns {Promise<boolean>} True if successful, false otherwise
 */
export async function addContactToGHLWorkflow(contactId, workflowId, apiKey) {
	const logPrefix = `[GHL WORKFLOW ${workflowId} for ${contactId}]`;
	console.log(`${logPrefix}: Attempting to add contact to workflow.`);

	if (!contactId || !workflowId || !apiKey) {
		console.error(`${logPrefix}: Missing contactId, workflowId, or apiKey. Aborting.`);
		return false;
	}

	const url = `https://rest.gohighlevel.com/v1/contacts/${contactId}/workflow/${workflowId}`;

	try {
		const robustFetch = createGHLFetch(`[GHL Workflow - ${workflowId}]`);
		const response = await robustFetch(url, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			},
			body: JSON.stringify({}) // Empty body often required
		});

		if (response.ok) {
			console.log(`${logPrefix}: Successfully added contact to workflow.`);
			return true;
		} else {
			const errorBody = await response.text();
			console.error(`${logPrefix}: Failed to add contact. Status: ${response.status} ${response.statusText}. Body: ${errorBody}`);
			await sendNonFatalSlackNotification(
				'GHL Workflow Addition Failed',
				`Failed to add contact ${contactId} to workflow ${workflowId}. Status: ${response.status}`,
				{
					contactId,
					workflowId,
					status: response.status,
					statusText: response.statusText,
					errorBody,
					function: 'addContactToGHLWorkflow',
					impact: 'Automated workflow process failed'
				}
			).catch(console.error);
			return false;
		}
	} catch (error) {
		console.error(`${logPrefix}: Error calling GoHighLevel API:`, error);
		await sendNonFatalSlackNotification(
			'GHL Workflow Addition Exception',
			`Exception adding contact ${contactId} to workflow ${workflowId}. Error: ${error.message}`,
			{
				contactId,
				workflowId,
				error: error.stack,
				function: 'addContactToGHLWorkflow',
				impact: 'Workflow automation system exception'
			}
		).catch(console.error);
		return false;
	}
} 