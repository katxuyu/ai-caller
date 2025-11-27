import { getValidGoHighlevelToken } from './tokens.js';
import { sendNonFatalSlackNotification, sendPositiveSlackNotification } from '../slack/notifications.js';

/**
 * Triggers a purchase workflow when customer wants to buy
 * @param {string} locationId The GHL Location ID.
 * @param {string} workflowId The GHL Workflow ID to trigger.
 * @param {string} contactId The GHL Contact ID.
 * @returns {Promise<Object>} Workflow trigger result with success status.
 */
export async function triggerPurchaseWorkflow(locationId, workflowId, contactId, mattressId) {
	if (!locationId || !workflowId || !contactId || !mattressId) {
		console.error("[GHL Workflow] Missing required parameters for purchase workflow trigger.");
		await sendNonFatalSlackNotification(
			'GHL Workflow: Missing Parameters',
			'Purchase workflow trigger called with missing required parameters',
			{ locationId, workflowId, contactId, mattressId }
		).catch(console.error);
		return { success: false, error: "Missing required parameters" };
	}

	const accessToken = await getValidGoHighlevelToken(locationId);
	if (!accessToken) {
		console.error(`[GHL Workflow - ${contactId}] Failed to get valid GHL token.`);
		await sendNonFatalSlackNotification(
			'GHL Workflow: Token Failure',
			`Failed to obtain valid GHL token for purchase workflow. This will prevent customer purchases.`,
			{ locationId, contactId, workflowId }
		).catch(console.error);
		return { success: false, error: "Failed to obtain GHL token" };
	}

	const updateContactApiUrl = `https://services.leadconnectorhq.com/contacts/${contactId}`;
	const updateContactPayload = {
		customFields: [
			{
				key: "matress_selection",
				field_value: mattressId
			}
		]
	};
	await fetch(updateContactApiUrl, {
		method: 'PUT',
		headers: {
			'Authorization': `Bearer ${accessToken}`,
			'Version': '2021-07-28',
			'Accept': 'application/json',
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(updateContactPayload)
	});

	const apiUrl = `https://services.leadconnectorhq.com/contacts/${contactId}/workflow/${workflowId}`;

	console.log(`[GHL Workflow - ${contactId}] Triggering purchase workflow ${workflowId}`);

	try {
		const response = await fetch(apiUrl, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Version': '2021-07-28',
				'Accept': 'application/json',
				'Content-Type': 'application/json'
			}
		});

		const responseBodyText = await response.text();

		if (response.ok) {
			console.log(`[GHL Workflow - ${contactId}] Successfully triggered purchase workflow. Status: ${response.status}`);
			try {
				return { success: true, data: JSON.parse(responseBodyText) };
			} catch (parseError) {
				return { success: true, data: { message: "Purchase workflow triggered successfully" } };
			}
		} else {
			console.error(`[GHL Workflow - ${contactId}] API error triggering workflow. Status: ${response.status}. Response: ${responseBodyText}`);
			await sendNonFatalSlackNotification(
				'GHL Workflow: API Error',
				`Failed to trigger purchase workflow. Customer purchase may be lost.`,
				{ 
					contactId, 
					workflowId, 
					status: response.status, 
					response: responseBodyText,
					locationId
				}
			).catch(console.error);
			return { success: false, error: "GHL API Error", status: response.status, details: responseBodyText };
		}
	} catch (error) {
		console.error(`[GHL Workflow - ${contactId}] Exception triggering workflow: ${error.message}`, error);
		await sendNonFatalSlackNotification(
			'GHL Workflow: Exception',
			`Exception occurred while triggering purchase workflow. Customer purchase may be lost.`,
			{
				contactId,
				workflowId,
				error: error.message,
				stack: error.stack,
				locationId
			}
		).catch(console.error);
		return { success: false, error: `Exception: ${error.message}` };
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