import Twilio from 'twilio';
import { openDb, closeDb, run, get as getDbRecord, all as getAllDbRecords } from './db.js';
import { setCallData, getCallData } from './callDataDb.js'; // Use exported functions
import { sendNonFatalSlackNotification } from './slack/notifications.js';

const { 
    TWILIO_ACCOUNT_SID, 
    TWILIO_AUTH_TOKEN, 
    MAX_ACTIVE_CALLS = 3
} = process.env;

const PROCESSING_INTERVAL_MS = 10 * 1000; // Check every 10 seconds
const MAX_ACTIVE = parseInt(MAX_ACTIVE_CALLS, 10);


async function countActiveTwilioCalls(twilioClient) {
    if (!twilioClient) {
        console.error("[Queue Processor] countActiveTwilioCalls called without a valid Twilio client.");
        return MAX_ACTIVE; // Assume max if client is missing
    }
    try {
        // Use the passed client instance
        const calls = await twilioClient.calls.list({
            status: ['queued', 'ringing', 'in-progress'],
            limit: MAX_ACTIVE + 5 
        });
        return calls.length;
    } catch (error) {
        console.error(`[Queue Processor] Error fetching active calls from Twilio:`, error);
        // Log if credentials seem missing in the client's context, if possible (might be internal)
        if (error.message.includes("username is required") || error.message.includes("authenticate")) {
             console.error(`[Queue Processor] Authentication error suggests SID/Token might be missing or invalid for the client instance.`);
        }
        return MAX_ACTIVE; // Assume max if Twilio check fails to prevent overload
    }
}

async function processCallQueue(twilioClient) {
    if (!twilioClient) {
        console.error("[Queue Processor] processCallQueue called without a valid Twilio client.");
        return; 
    }
    let db;
    // console.log("[Queue Processor] Checking for pending calls..."); // Too noisy for interval

    try {
        // Pass client to countActiveTwilioCalls
        const currentActiveCalls = await countActiveTwilioCalls(twilioClient); 
        // console.log(`[Queue Processor] Current active calls (Twilio): ${currentActiveCalls}`);
        const availableSlots = MAX_ACTIVE - currentActiveCalls;

        if (availableSlots <= 0) {
            // console.log("[Queue Processor] Max active calls reached. Waiting for next interval.");
            return;
        }

        db = await openDb();
        const now_iso = new Date().toISOString();

        // Get calls ready to be processed (oldest first)
        const pendingCalls = await getAllDbRecords(db,
            `SELECT * FROM call_queue 
             WHERE status = 'pending' AND scheduled_at <= ? 
             ORDER BY scheduled_at ASC 
             LIMIT ?`,
            [now_iso, availableSlots]
        );

        if (pendingCalls.length === 0) {
            // console.log("[Queue Processor] No pending calls ready to process.");
            await closeDb(db); // Close DB if no calls found
            return;
        }

        console.log(`[Queue Processor] Found ${pendingCalls.length} calls to process (Available slots: ${availableSlots}).`);

        // Process calls sequentially to avoid race conditions on DB updates within the loop
        for (const callJob of pendingCalls) {
            console.log(`[Queue Processor] Processing job ID: ${callJob.queue_id} for ${callJob.phone_number}`);
            let jobProcessedSuccessfully = false;
            

            
            // Mark as processing immediately 
            try {
                 await run(db, 
                    `UPDATE call_queue SET status = 'processing', last_attempt_at = ? WHERE queue_id = ? AND status = 'pending'`,
                    [new Date().toISOString(), callJob.queue_id]
                );
            } catch (updateError) {
                 console.error(`[Queue Processor] Error marking job ${callJob.queue_id} as processing:`, updateError);
                 await sendNonFatalSlackNotification(`Queue Processor: Failed to mark job ${callJob.queue_id} as processing - ${updateError.message}`);
                 continue; // Skip this job if update fails
            }

            try {
                // Make the actual call via Twilio
                let callRecord;
                console.log(`[QUEUE PROCESSOR] Making call to ${callJob.phone_number} with options:`, callJob.call_options_json);
                const callOptions = JSON.parse(callJob.call_options_json);
                callRecord = await twilioClient.calls.create(callOptions);
                console.log(`[QUEUE PROCESSOR] Twilio call initiated. SID: ${callRecord.sid} for Number: ${callJob.phone_number}, Contact ID: ${callJob.contact_id}`);

                // CRITICAL: Store initial call data IMMEDIATELY after Twilio call creation
                // This prevents race condition where status callbacks arrive before call data is stored
                try {
                    await setCallData(callRecord.sid, {
                      to: callJob.phone_number,
                      contactId: callJob.contact_id,
                      retry_count: callJob.retry_stage, // Store the current attempt number (0-indexed)
                      status: 'initiated', // Initial status from our end
                      created_at: new Date().toISOString(),
                      signedUrl: callJob.initial_signed_url, // From the queue job
                      fullName: callJob.full_name,
                      firstName: callJob.first_name,
                      email: callJob.email,
                      first_attempt_timestamp: callJob.first_attempt_timestamp,
                      full_address: callJob.full_address
                    });
                                         console.log(`[QUEUE PROCESSOR] Successfully stored initial call data for SID ${callRecord.sid} with retry_count: ${callJob.retry_stage}, first_attempt_timestamp: ${callJob.first_attempt_timestamp}`);
                     
                     // Verify the data was stored correctly by retrieving it
                     const verifyCallData = await getCallData(callRecord.sid);
                     if (!verifyCallData) {
                         throw new Error(`Call data verification failed - unable to retrieve stored data for SID ${callRecord.sid}`);
                     }
                     console.log(`[QUEUE PROCESSOR] Verified call data storage for SID ${callRecord.sid} - contactId: ${verifyCallData.contactId}`);
                 } catch (setCallDataError) {
                    console.error(`[QUEUE PROCESSOR] CRITICAL ERROR: Failed to store call data for SID ${callRecord.sid}:`, setCallDataError);
                    await sendNonFatalSlackNotification(
                        'Queue Processor: Critical - Failed to Store Call Data',
                        `Failed to store call data for SID ${callRecord.sid}. Status callbacks will fail to find this call.`,
                        {
                            CallSid: callRecord.sid,
                            contactId: callJob.contact_id,
                            phone: callJob.phone_number,
                            error: setCallDataError.message,
                            stack: setCallDataError.stack,
                            critical: true
                        }
                    ).catch(console.error);
                    // Don't continue processing this job if we can't store the data
                    throw setCallDataError;
                }

                // Remove from queue upon successful initiation
                await run(db, `DELETE FROM call_queue WHERE queue_id = ?`, [callJob.queue_id]);
                console.log(`[Queue Processor] Removed job ${callJob.queue_id} from queue.`);
                jobProcessedSuccessfully = true;

            } catch (callError) {
                console.error(`[Queue Processor] Error initiating Twilio call for job ${callJob.queue_id}:`, callError);
                const errorMessage = callError.message || 'Unknown call initiation error';
                // Mark as failed in the queue
                try {
                    await run(db,
                        `UPDATE call_queue SET status = 'failed', last_error = ? WHERE queue_id = ?`,
                        [errorMessage, callJob.queue_id]
                    );
                } catch (failUpdateError) {
                     console.error(`[Queue Processor] Error marking job ${callJob.queue_id} as failed:`, failUpdateError);
                }
            }
        }

    } catch (error) {
        console.error("[Queue Processor] Error during queue processing cycle:", error);
    } finally {
        // Ensure DB is closed if it was opened
        if (db && !db.open) { // Check if already closed or failed to open
             // No action needed
        } else if (db) {
            await closeDb(db);
        }
    }
}

// Function to start the periodic queue processor
export function startQueueProcessor(intervalMs = PROCESSING_INTERVAL_MS) {
    // Create the Twilio client HERE
    const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    console.log(`[Queue Processor] Starting queue processing. Interval: ${intervalMs / 1000} seconds. Max Active Calls: ${MAX_ACTIVE}`);
    
    // Ensure interval is reasonable
    const safeInterval = Math.max(intervalMs, 5000); // Minimum 5 seconds

    // Initial run, pass the client
    processCallQueue(twilioClient).catch(console.error); 
    
    // Set interval for subsequent runs, pass the client
    setInterval(() => { 
        processCallQueue(twilioClient).catch(console.error);
    }, safeInterval);
} 