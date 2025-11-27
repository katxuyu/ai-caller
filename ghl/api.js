import { getValidGoHighlevelToken } from './tokens.js';
import { sendNonFatalSlackNotification, sendPositiveSlackNotification } from '../slack/notifications.js';

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
		await sendNonFatalSlackNotification(
			'GHL Token Missing - Add Note',
			`Failed to get valid GHL token for adding contact note`,
			{
				locationId,
				contactId,
				noteBody: noteBody.substring(0, 100) + '...'
			}
		).catch(console.error);
		return { success: false, error: "Failed to obtain GHL token" };
	}

	const apiUrl = `https://services.leadconnectorhq.com/contacts/${contactId}/notes`;
	
	const payload = {
		body: noteBody
	};

	console.log(`[GHL Note - ${contactId}] Adding note: ${noteBody.substring(0, 100)}...`);

	try {
		const response = await fetch(apiUrl, {
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
			
			// Send positive notification for successful note addition
			await sendPositiveSlackNotification(
				'Contact Note Successfully Added',
				`Successfully added note to contact ${contactId}`,
				{
					locationId,
					contactId,
					noteBody: noteBody.substring(0, 100) + '...',
					status: response.status
				}
			).catch(console.error);
			
			try {
				return { success: true, data: JSON.parse(responseBodyText) };
			} catch (parseError) {
				return { success: true, data: { message: "Note added successfully" } };
			}
		} else {
			console.error(`[GHL Note - ${contactId}] API error adding note. Status: ${response.status}. Response: ${responseBodyText}`);
			
			// Send non-fatal notification for note addition failure
			await sendNonFatalSlackNotification(
				'GHL Add Note Failed',
				`Failed to add note to contact ${contactId}`,
				{
					locationId,
					contactId,
					noteBody: noteBody.substring(0, 100) + '...',
					status: response.status,
					url: apiUrl,
					response: responseBodyText
				}
			).catch(console.error);
			
			return { success: false, error: "GHL API Error", status: response.status, details: responseBodyText };
		}
	} catch (error) {
		console.error(`[GHL Note - ${contactId}] Exception adding note: ${error.message}`, error);
		await sendNonFatalSlackNotification(
			'GHL Add Note Exception',
			`Exception adding note to contact ${contactId}`,
			{
				locationId,
				contactId,
				noteBody: noteBody.substring(0, 100) + '...',
				error: error.message,
				stack: error.stack
			}
		).catch(console.error);
		return { success: false, error: `Exception: ${error.message}` };
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
			'GHL Token Missing - Contact Details',
			`Failed to get valid GHL token for fetching contact details`,
			{
				locationId,
				contactId
			}
		).catch(console.error);
		return null;
	}

	const apiUrl = `https://services.leadconnectorhq.com/contacts/${contactId}`;
	console.log(`[GHL Contact - ${contactId}] Fetching details from ${apiUrl}`);

	try {
		const response = await fetch(apiUrl, {
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
			await sendNonFatalSlackNotification(
				'GHL Contact Details API Error',
				`Failed to fetch contact details for contact ${contactId}`,
				{
					locationId,
					contactId,
					status: response.status,
					url: apiUrl,
					response: errorBody
				}
			).catch(console.error);
			return null;
		}
		const data = await response.json();
		console.log(`[GHL Contact - ${contactId}] Full response:`, JSON.stringify(data, null, 2));
		if (data && data.contact) { // Common structure with "contact" wrapper
			return {
				phone: data.contact.phone || null,
				firstName: data.contact.firstName || "",
				lastName: data.contact.lastName || "",
				fullName: data.contact.fullName || `${data.contact.firstName || ""} ${data.contact.lastName || ""}`.trim(),
				email: data.contact.email || null,
				contactId: data.contact.id || contactId,
				address: data.contact.address1 || data.contact.address || null, // Include address for appointment location
				customFields: data.contact.customFields || [],
				tags: data.contact.tags || []
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
				address: data.address1 || data.address || null, // Include address for appointment location
				customFields: data.customFields || [],
				tags: data.tags || []
			};
		}
		console.warn(`[GHL Contact - ${contactId}] Unexpected response structure. Full response:`, JSON.stringify(data, null, 2));
		return null;

	} catch (error) {
		console.error(`[GHL Contact - ${contactId}] Exception fetching details: ${error.message}`, error);
		await sendNonFatalSlackNotification(
			'GHL Contact Details Exception',
			`Exception fetching contact details for contact ${contactId}`,
			{
				locationId,
				contactId,
				error: error.message,
				stack: error.stack
			}
		).catch(console.error);
		return null;
	}
}

/**
 * Generic function to add a contact to any workflow in GoHighLevel
 * @param {string} locationId The GHL Location ID.
 * @param {string} workflowId The GHL Workflow ID to trigger.
 * @param {string} contactId The GHL Contact ID.
 * @param {Object} eventData Optional event data to pass to the workflow.
 * @returns {Promise<Object>} Result with success status.
 */
export async function addContactToWorkflow(locationId, workflowId, contactId, eventData = {}) {
	if (!locationId || !workflowId || !contactId) {
		console.error("[GHL Workflow] Missing required parameters for adding contact to workflow.");
		return { success: false, error: "Missing required parameters" };
	}

	const accessToken = await getValidGoHighlevelToken(locationId);
	if (!accessToken) {
		console.error(`[GHL Workflow - ${contactId}] Failed to get valid GHL token.`);
		await sendNonFatalSlackNotification(
			'GHL Token Missing - Add to Workflow',
			`Failed to get valid GHL token for adding contact to workflow`,
			{
				locationId,
				workflowId,
				contactId,
				eventData
			}
		).catch(console.error);
		return { success: false, error: "Failed to obtain GHL token" };
	}

	const apiUrl = `https://services.leadconnectorhq.com/workflows/${workflowId}/contacts/${contactId}`;
	
	const payload = {
		eventData: eventData
	};

	console.log(`[GHL Workflow - ${contactId}] Adding contact to workflow ${workflowId}`);

	try {
		const response = await fetch(apiUrl, {
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
			console.log(`[GHL Workflow - ${contactId}] Successfully added contact to workflow. Status: ${response.status}`);
			
			await sendPositiveSlackNotification(
				'Contact Added to Workflow',
				`Successfully added contact ${contactId} to workflow ${workflowId}`,
				{
					locationId,
					workflowId,
					contactId,
					eventData,
					status: response.status
				}
			).catch(console.error);
			
			try {
				return { success: true, data: JSON.parse(responseBodyText) };
			} catch (parseError) {
				return { success: true, data: { message: "Contact added to workflow successfully" } };
			}
		} else {
			console.error(`[GHL Workflow - ${contactId}] API error adding contact to workflow. Status: ${response.status}. Response: ${responseBodyText}`);
			
			await sendNonFatalSlackNotification(
				'GHL Add to Workflow Failed',
				`Failed to add contact ${contactId} to workflow ${workflowId}`,
				{
					locationId,
					workflowId,
					contactId,
					eventData,
					status: response.status,
					url: apiUrl,
					response: responseBodyText
				}
			).catch(console.error);
			
			return { success: false, error: "GHL API Error", status: response.status, details: responseBodyText };
		}
	} catch (error) {
		console.error(`[GHL Workflow - ${contactId}] Exception adding contact to workflow: ${error.message}`, error);
		await sendNonFatalSlackNotification(
			'GHL Add to Workflow Exception',
			`Exception adding contact ${contactId} to workflow ${workflowId}`,
			{
				locationId,
				workflowId,
				contactId,
				eventData,
				error: error.message,
				stack: error.stack
			}
		).catch(console.error);
		return { success: false, error: `Exception: ${error.message}` };
	}
}
