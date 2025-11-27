import { openDb, closeDb, run, all } from '../db.js';
import { getGHLContactDetails } from '../ghl/api.js';
import { sendNonFatalSlackNotification } from '../slack/notifications.js';
import { LOCATION_ID } from '../config.js';


const FOLLOW_UP_INTERVAL_MS = 60 * 60 * 1000; // Check every hour
const OUTBOUND_CALL_ENDPOINT = process.env.OUTBOUND_CALL_ENDPOINT || 'http://localhost:8000/outbound-call';

// Database helper for follow-ups
export async function saveFollowUp(contactId, followUpAtUTC) {
    let db;
    try {
        db = await openDb();
        await run(db, 
            'INSERT INTO follow_ups (contact_id, follow_up_at_utc, status) VALUES (?, ?, ?)',
            [contactId, followUpAtUTC, 'pending']
        );
        console.log(`[FollowUp] Saved follow-up for contact ${contactId} at ${followUpAtUTC}`);
    } catch (error) {
        console.error(`[FollowUp] Error saving follow-up for contact ${contactId}:`, error);
        sendNonFatalSlackNotification(
            'FollowUp DB Error',
            `Error saving follow-up for contact ${contactId}`,
            error.message
        ).catch(console.error);
    } finally {
        await closeDb(db);
    }
}

async function getDueFollowUps() {
    let db;
    try {
        db = await openDb();
        const nowUTC = new Date().toISOString();
        const rows = await all(db, 
            'SELECT follow_up_id, contact_id, follow_up_at_utc FROM follow_ups WHERE status = ? AND follow_up_at_utc <= ?',
            ['pending', nowUTC]
        );
        return rows;
    } catch (error) {
        console.error('[FollowUp] Error fetching due follow-ups:', error);
        sendNonFatalSlackNotification(
            'FollowUp DB Error',
            'Error fetching due follow-ups',
            error.message
        ).catch(console.error);
        return [];
    } finally {
        await closeDb(db);
    }
}

async function deleteFollowUp(followUpId) {
    let db;
    try {
        db = await openDb();
        await run(db, 'DELETE FROM follow_ups WHERE follow_up_id = ?', [followUpId]);
        console.log(`[FollowUp] Deleted processed follow-up ID ${followUpId}`);
    } catch (error) {
        console.error(`[FollowUp] Error deleting follow-up ID ${followUpId}:`, error);
        sendNonFatalSlackNotification(
            'FollowUp DB Error',
            `Error deleting follow-up ID ${followUpId}`,
            error.message
        ).catch(console.error);
    } finally {
        await closeDb(db);
    }
}

// Core logic for checking and processing follow-ups
async function checkAndProcessFollowUps() {
    console.log("[FollowUp] Checking for due follow-ups...");
    const dueFollowUps = await getDueFollowUps();

    if (dueFollowUps.length === 0) {
        console.log("[FollowUp] No follow-ups due at this time.");
        return;
    }

    console.log(`[FollowUp] Found ${dueFollowUps.length} follow-ups due. Processing...`);

    for (const followUp of dueFollowUps) {
        console.log(`[FollowUp] Processing follow-up ID ${followUp.follow_up_id} for contact ${followUp.contact_id}. Due: ${followUp.follow_up_at_utc}`);
        try {
            // Fetch contact details for phone number
            const contactDetails = await getGHLContactDetails(LOCATION_ID, followUp.contact_id);

            if (!contactDetails || !contactDetails.phone) {
                console.warn(`[FollowUp - ${followUp.contact_id}] Could not fetch contact details or phone number. Deleting follow-up.`);
                const notificationTitle = 'FollowUp Processing Warning';
                const notificationMessage = `Follow-up for contact ID ${followUp.contact_id} (Due: ${followUp.follow_up_at_utc}) failed: Could not fetch contact details or phone number. Follow-up deleted.`;
                
                // Capture additional error context
                let errorContext = { 
                    contactId: followUp.contact_id, 
                    followUpAtUtc: followUp.follow_up_at_utc,
                    locationId: LOCATION_ID
                };
                
                // Add more context about what exactly failed
                if (!contactDetails) {
                    errorContext.errorType = 'getGHLContactDetails returned null';
                    errorContext.possibleCauses = [
                        'Missing locationId or contactId parameters',
                        'Failed to get valid GHL token for location',
                        'GHL API HTTP error (4xx/5xx response)',
                        'Network exception during API call',
                        'Unexpected GHL API response structure'
                    ];
                    errorContext.debugInfo = {
                        locationId: LOCATION_ID,
                        contactId: followUp.contact_id,
                        note: 'Check server logs for detailed GHL API error messages'
                    };
                } else if (!contactDetails.phone) {
                    errorContext.errorType = 'Contact details found but no phone number';
                    errorContext.contactDetails = contactDetails;
                    errorContext.availableFields = Object.keys(contactDetails);
                }
                
                sendNonFatalSlackNotification(
                    notificationTitle,
                    notificationMessage,
                    errorContext
                ).catch(console.error);
                await deleteFollowUp(followUp.follow_up_id);
                continue; // Skip to next follow-up
            }

            // Create payload with the same format as the main outbound call system
            const payload = {
                phone: contactDetails.phone,
                contact_id: followUp.contact_id,
                first_name: contactDetails.firstName,
                full_name: contactDetails.fullName,
                email: contactDetails.email,
            };

            console.log(`[FollowUp - ${followUp.contact_id}] Triggering outbound call to ${OUTBOUND_CALL_ENDPOINT} with payload:`, payload);

            const response = await fetch(OUTBOUND_CALL_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                console.log(`[FollowUp - ${followUp.contact_id}] Successfully triggered outbound call (Status: ${response.status}).`);
                // Successfully triggered, delete the follow-up record
                await deleteFollowUp(followUp.follow_up_id);
            } else {
                const errorBody = await response.text();
                console.error(`[FollowUp - ${followUp.contact_id}] Failed to trigger outbound call. Status: ${response.status}, Response: ${errorBody}. Follow-up NOT deleted.`);
                sendNonFatalSlackNotification(
                    'FollowUp Outbound Call Failure',
                    `Failed to trigger follow-up call for contact ${followUp.contact_id} (${contactDetails.fullName || 'N/A'}). Endpoint ${OUTBOUND_CALL_ENDPOINT} returned ${response.status}.`,
                    { 
                        contactId: followUp.contact_id, 
                        fullName: contactDetails.fullName || 'N/A',
                        endpoint: OUTBOUND_CALL_ENDPOINT,
                        status: response.status,
                        errorBody: errorBody 
                    }
                ).catch(console.error);
            }

        } catch (error) {
            console.error(`[FollowUp] Error processing follow-up ID ${followUp.follow_up_id} for contact ${followUp.contact_id}:`, error);
            sendNonFatalSlackNotification(
                'FollowUp Processing Error',
                `Error processing follow-up ID ${followUp.follow_up_id} for contact ${followUp.contact_id}`,
                {
                    errorMessage: error.message,
                    contactId: followUp.contact_id,
                    followUpId: followUp.follow_up_id
                }
            ).catch(console.error);
            // Decide if you want to delete/mark as failed on error
        }
    }
}

// Function to start the periodic check
export function startFollowUpProcessor(intervalMs = FOLLOW_UP_INTERVAL_MS) {
    console.log(`[FollowUp] Starting follow-up processor. Interval: ${intervalMs / 1000} seconds.`);
    // Initial check
    checkAndProcessFollowUps().catch(err => {
        console.error("[FollowUp Processor] Error during initial check:", err);
        sendNonFatalSlackNotification(
            'FollowUp Processor Error',
            'Error during initial checkAndProcessFollowUps',
            err.message
        ).catch(console.error);
    });
    // Set interval for subsequent checks
    setInterval(() => {
        checkAndProcessFollowUps().catch(err => {
            console.error("[FollowUp Processor] Error during scheduled check:", err);
            sendNonFatalSlackNotification(
                'FollowUp Processor Error',
                'Error during scheduled checkAndProcessFollowUps',
                err.message
            ).catch(console.error);
        });
    }, intervalMs);
}
