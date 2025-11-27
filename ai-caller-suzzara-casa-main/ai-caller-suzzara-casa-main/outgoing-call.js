import WebSocket from "ws";
import Twilio from "twilio";
import xmlEscape from "xml-escape";

import { getCallData, updateCallData } from './callDataDb.js';
import { openDataDb, closeDataDb, runData, getData } from './dataDb.js';
import { getValidGoHighlevelToken } from './ghl/tokens.js';
import { fetchGHLCalendarSlots } from './ghl/api.js';
import { sendNonFatalSlackNotification } from './slack/notifications.js';
import { createRobustFetch } from './utils.js';
import {
  ITALIAN_TIMEZONE,
  ELEVENLABS_API_KEY,
  OUTGOING_ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  OUTGOING_ROUTE_PREFIX,
  GOHIGHLEVEL_LOCATION_ID,
  PUBLIC_URL,
  OUTGOING_TWILIO_PHONE_NUMBER,
  GOHIGHLEVEL_CALENDAR_ID,
} from './config.js';

// ---------------------------------------------------------------------------

export function OutgoingCall(fastify) {
  const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  
  // Clean the route prefix by removing any quotes and setting a default
  let routePrefix = (OUTGOING_ROUTE_PREFIX || '/outgoing').replace(/['"]/g, '');
  
  // Ensure it starts with a forward slash
  if (!routePrefix.startsWith('/') && !routePrefix.startsWith('*')) {
    routePrefix = '/' + routePrefix;
  }
  
  // Remove any empty segments that might cause double slashes
  routePrefix = routePrefix.replace(/\/+/g, '/');

  // ---------------------------------------------------------------------------
  // 1) GET SIGNED URL (ELEVENLABS)
  // ---------------------------------------------------------------------------
  async function getSignedUrl() {
    console.log('[ELEVENLABS] Requesting signed URL from ElevenLabs API...');
    const elevenlabsUrl = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${OUTGOING_ELEVENLABS_AGENT_ID}`;
    const robustFetch = createRobustFetch('[ELEVENLABS Outgoing]');
    const response = await robustFetch(elevenlabsUrl, {
      method: "GET",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json"
      }
    });
    if (!response.ok) {
      const errorBody = await response.text();
      const errorMessage = `Failed to get signed URL from ElevenLabs API: ${response.status} ${response.statusText}. Agent ID: ${OUTGOING_ELEVENLABS_AGENT_ID}. Response: ${errorBody}`;
      console.error('[ELEVENLABS] ' + errorMessage);
      sendNonFatalSlackNotification(
        "Outgoing Call: ElevenLabs Get Signed URL API Error",
        `ElevenLabs API (outgoing call flow) returned ${response.status} ${response.statusText} when requesting a signed URL for agent ${OUTGOING_ELEVENLABS_AGENT_ID}.`,
        { status: response.status, statusText: response.statusText, agentId: OUTGOING_ELEVENLABS_AGENT_ID, function: 'getSignedUrl (outgoing-call.js)', responseBody: errorBody }
      );
      throw new Error(errorMessage);
    }
    const data = await response.json();
    return data.signed_url;
  }

  // ---------------------------------------------------------------------------
  // 2) SCHEDULE RETRY (Helper Function)
  // ---------------------------------------------------------------------------
  async function scheduleRetry(callDataForRetryLogic, failedCallSid, options = {}) {
    // options: { reason: string, forceImmediate: boolean }
    const logPrefix = `[RETRY SCHEDULER for ${callDataForRetryLogic.to} (from ${failedCallSid})]`;
    const currentAttemptNumber = callDataForRetryLogic.retry_count !== undefined ? Number(callDataForRetryLogic.retry_count) : 0;
    const MAX_TOTAL_ATTEMPTS = 10;
    const firstAttemptTimestamp = callDataForRetryLogic.first_attempt_timestamp ? new Date(callDataForRetryLogic.first_attempt_timestamp) : new Date();
    if (currentAttemptNumber >= MAX_TOTAL_ATTEMPTS - 1) {
      console.log(`${logPrefix} Max total attempts (${MAX_TOTAL_ATTEMPTS}) reached for contact ${callDataForRetryLogic.contactId} after attempt ${currentAttemptNumber}. No more retries.`);
      
      // Notify about max attempts reached
      await sendNonFatalSlackNotification(
        'Outgoing Call: Max Retry Attempts Reached',
        `Contact ${callDataForRetryLogic.contactId} (${callDataForRetryLogic.fullName || callDataForRetryLogic.firstName || 'Unknown'}) has reached maximum retry attempts (${MAX_TOTAL_ATTEMPTS}).`,
        {
          contactId: callDataForRetryLogic.contactId,
          phone: callDataForRetryLogic.to,
          fullName: callDataForRetryLogic.fullName || callDataForRetryLogic.firstName || 'Unknown',
          currentAttempt: currentAttemptNumber,
          maxAttempts: MAX_TOTAL_ATTEMPTS,
          firstAttemptTimestamp: firstAttemptTimestamp.toISOString(),
          failedCallSid,
          reason: options.reason || 'unknown'
        }
      );
      
      return;
    }

    // Custom retry schedule
    const RETRY_SCHEDULE = [
      // Index 0: For first retry (2nd total call), logged as "Attempt 1"
      { type: 'immediate' },
      // Index 1: For second retry (3rd total call), logged as "Attempt 2"
      { type: 'delay', hours: 1 },
      // Index 2: For third retry (4th total call), logged as "Attempt 3"
      { type: 'immediate' },
      // Index 3: For fourth retry (5th total call), logged as "Attempt 4"
      { type: 'next_time', hour: 9 },
      // Index 4: For fifth retry (6th total call), logged as "Attempt 5"
      { type: 'immediate' },
      // Index 5: For sixth retry (7th total call), logged as "Attempt 6"
      { type: 'next_time', hour: 14 },
      // Index 6: For seventh retry (8th total call), logged as "Attempt 7"
      { type: 'immediate' },
      // Index 7: For eighth retry (9th total call), logged as "Attempt 8"
      { type: 'next_time', hour: 19 },
       // Index 8: For ninth retry (10th total call), logged as "Attempt 9"
      { type: 'immediate' },
    ];

    const nextAttemptNumberForDB = currentAttemptNumber + 1;
    const scheduleConfig = RETRY_SCHEDULE[nextAttemptNumberForDB - 1] || { type: 'immediate' };

    let delayMs = 0;
    let scheduled_at_base = new Date();

    if (options.forceImmediate || scheduleConfig.type === 'immediate') {
      delayMs = 0;
      scheduled_at_base = new Date();
      console.log(`${logPrefix} Immediate retry (Attempt ${nextAttemptNumberForDB}).`);
    } else if (scheduleConfig.type === 'delay') {
      delayMs = scheduleConfig.hours * 60 * 60 * 1000;
      scheduled_at_base = new Date(Date.now() + delayMs);
      console.log(`${logPrefix} Delayed retry by ${scheduleConfig.hours} hour(s) (Attempt ${nextAttemptNumberForDB}).`);
    } else if (scheduleConfig.type === 'next_time') {
      // Schedule for the next occurrence of the specified hour (e.g., 9, 14, 19)
      const now = new Date();
      let target = new Date(now);
      target.setHours(scheduleConfig.hour, 0, 0, 0);
      if (now >= target) {
        target.setDate(target.getDate() + 1);
      }
      delayMs = target.getTime() - now.getTime();
      scheduled_at_base = target;
      console.log(`${logPrefix} Scheduled retry for next ${scheduleConfig.hour}:00 (Attempt ${nextAttemptNumberForDB}).`);
    }

    const scheduled_at_iso = scheduled_at_base.toISOString();
    const baseDataForRetry = {
        contactId: callDataForRetryLogic.contactId,
        to: callDataForRetryLogic.to,
        firstName: callDataForRetryLogic.firstName,
        fullName: callDataForRetryLogic.fullName,
        email: callDataForRetryLogic.email,
        availableSlots: callDataForRetryLogic.availableSlots,
        initialSignedUrl: callDataForRetryLogic.signedUrl,
    };
    const twimlUrl = `${PUBLIC_URL}${routePrefix}/outbound-call-twiml?firstName=${encodeURIComponent(baseDataForRetry.firstName || '')}&fullName=${encodeURIComponent(baseDataForRetry.fullName || '')}&email=${encodeURIComponent(baseDataForRetry.email || '')}&phone=${encodeURIComponent(baseDataForRetry.to || '')}&contactId=${encodeURIComponent(baseDataForRetry.contactId || '')}`;
    
    const newCallOptions = {
        from: OUTGOING_TWILIO_PHONE_NUMBER,
        to: baseDataForRetry.to,
        url: twimlUrl,
        timeout: 25,
        timeLimit: 900,
        statusCallback: `${PUBLIC_URL}${routePrefix}/call-status`,
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        machineDetection: "Enable",
        asyncAmd: true,
        asyncAmdStatusCallback: `${PUBLIC_URL}${routePrefix}/call-status`,
    };
    const newCallOptionsJson = JSON.stringify(newCallOptions);
    let dbRetry;
    try {
        dbRetry = await openDataDb();
        const availableSlotsForRetry = callDataForRetryLogic.availableSlots || 'No availability information found.';
        const result = await runData(dbRetry,
            `INSERT INTO call_queue (contact_id, phone_number, first_name, full_name, email, retry_stage, status, scheduled_at, call_options_json, available_slots_text, initial_signed_url, first_attempt_timestamp)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            [baseDataForRetry.contactId, baseDataForRetry.to, baseDataForRetry.firstName, baseDataForRetry.fullName, baseDataForRetry.email, nextAttemptNumberForDB, 'pending', scheduled_at_iso, newCallOptionsJson, availableSlotsForRetry, baseDataForRetry.initialSignedUrl, firstAttemptTimestamp.toISOString()]
        );
        console.log(`${logPrefix} Added attempt ${nextAttemptNumberForDB} to DB queue. New Queue ID: ${result.lastID}. Scheduled for: ${scheduled_at_iso}. Available slots: ${availableSlotsForRetry ? availableSlotsForRetry.substring(0, 100) + '...' : 'None'}`);
    } catch (dbError) {
         console.error(`${logPrefix} Error adding attempt ${nextAttemptNumberForDB} to DB queue:`, dbError);
         await sendNonFatalSlackNotification(
           'Outgoing Call: Retry Scheduling DB Error', 
           `${logPrefix} Failed to schedule retry attempt ${nextAttemptNumberForDB} for contact ${callDataForRetryLogic.contactId}. DB Error: ${dbError.message}`,
           { 
             logPrefix, 
             contactId: callDataForRetryLogic.contactId,
             phone: callDataForRetryLogic.to,
             attemptNumber: nextAttemptNumberForDB,
             dbError: dbError.stack,
             function: 'scheduleRetry'
           }
         );
    } finally {
        if (dbRetry) await closeDataDb(dbRetry);
    }
  }

  // ---------------------------------------------------------------------------
  // 3) OUTBOUND CALL ENDPOINT (Initial Call Request)
  // ---------------------------------------------------------------------------
  fastify.post(`${routePrefix}/outbound-call`, async (request, reply) => {   
    // console.log("[OUTBOUND CALL] Received request with body:", JSON.stringify(request.body, null, 2));
    const {
      phone,
      contact_id,
      first_name,
      full_name,
      email
    } = request.body;    
    
    console.log("[OUTBOUND CALL] Extracted parameters:", {
      phone,
      contact_id,
      first_name,
      full_name,
      email
    });

    // Check if this is an abrupt ending retry
    const customData = request.body.customData || {};
    const isAbruptEndingRetry = customData?.isAbruptEndingRetry === true;
    const pastCallSummary = customData?.pastCallSummary || '';
    const originalConversationId = customData?.originalConversationId || '';
    const id_immobile = request.body.id_immobile || request.body.idImmobile || request.body.IdImmobile || '';
    
    if (isAbruptEndingRetry) {
      console.log(`[OUTBOUND CALL] Processing abrupt ending retry for contact ${contact_id}. Original conversation: ${originalConversationId}`);
    }
    
    // Handle different possible field names from GoHighLevel
    const toPhoneValue = phone || request.body.phoneNumber || request.body.phone_number || request.body.Phone;
    const contactId = contact_id || request.body.contactId || request.body.contact_id || request.body.id || request.body.Id;
    const firstName = first_name || request.body.firstName || request.body.first_name || request.body.FirstName;
    const fullName = full_name || request.body.fullName || request.body.full_name || request.body.name || request.body.Name;

    if (!toPhoneValue || !contactId) {
      console.error("[OUTBOUND CALL] Missing required parameters phone or contactId");
      return reply.code(400).send({ error: "phone and contactId are required" });
    }
    
    let db;
    try {
      console.log("[ELEVENLABS] Requesting signed URL before call creation");
      let signedUrl = await getSignedUrl();
      console.log("[ELEVENLABS] Successfully obtained signed URL before call creation");
      
      // Build TwiML URL with additional parameters for abrupt ending retry
      let twimlUrl = `${PUBLIC_URL}${routePrefix}/outbound-call-twiml?firstName=${encodeURIComponent(firstName || '')}&fullName=${encodeURIComponent(fullName || '')}&email=${encodeURIComponent(email || '')}&phone=${encodeURIComponent(toPhoneValue)}&contactId=${encodeURIComponent(contactId)}`;
      
      if (isAbruptEndingRetry) {
        twimlUrl += `&isAbruptEndingRetry=true&pastCallSummary=${encodeURIComponent(pastCallSummary)}&originalConversationId=${encodeURIComponent(originalConversationId)}`;
      }

      const callOptions = {
        from: OUTGOING_TWILIO_PHONE_NUMBER,
        to: toPhoneValue,
        url: twimlUrl,
        timeout: 25,
        timeLimit: 900,
        statusCallback: `${PUBLIC_URL}${routePrefix}/call-status`,
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        machineDetection: "Enable",
        asyncAmd: true,
        asyncAmdStatusCallback: `${PUBLIC_URL}${routePrefix}/call-status`,
      };

      let formattedSlotsString = "Slot availability not checked.";
      try {
         const goHighLevelToken = await getValidGoHighlevelToken(GOHIGHLEVEL_LOCATION_ID);
         if (!goHighLevelToken) {
           const errorMessage = `No GoHighLevel tokens found for location ${GOHIGHLEVEL_LOCATION_ID}. Cannot fetch calendar slots or process calls for contact ${contactId} (${fullName || firstName || 'Unknown'}).`;
           console.error(`[OUTBOUND CALL] ${errorMessage}`);
           
           try {
             await sendNonFatalSlackNotification(
               'GoHighLevel Token Missing - Call Blocked',
               errorMessage,
               {
                 contactId,
                 fullName: fullName || firstName || 'Unknown',
                 phone: toPhoneValue,
                 locationId: GOHIGHLEVEL_LOCATION_ID,
               }
             );
           } catch (slackError) {
             console.error('[OUTBOUND CALL] Failed to send GHL token missing notification to Slack:', slackError);
           }
           
           return reply.code(500).send({ error: "GoHighLevel integration not available. Cannot process calls at this time." });
         }
         
         if (goHighLevelToken) {
             const now = new Date();
             const startDate = new Date(now);
             startDate.setDate(startDate.getDate() + 1); // Start from tomorrow
             startDate.setHours(8, 30, 0, 0); // Set start time
             const endDate = new Date(startDate);
             endDate.setDate(startDate.getDate() + 14); // Look for 14 days ahead
             endDate.setHours(21, 30, 0, 0); // Set end time
             if (!GOHIGHLEVEL_CALENDAR_ID) {
                 console.error("[GHL] CALENDAR_ID not set, cannot fetch GHL slots.");
                 formattedSlotsString = "Calendar ID not configured for slot checking.";
             } else {
                 console.log(`[GHL] Fetching slots for calendar ${GOHIGHLEVEL_CALENDAR_ID} from ${startDate.toISOString()} to ${endDate.toISOString()} for id_immobile: ${id_immobile}`);
                 let allSlots = await fetchGHLCalendarSlots(GOHIGHLEVEL_LOCATION_ID, GOHIGHLEVEL_CALENDAR_ID, startDate.toISOString(), endDate.toISOString(), id_immobile);
                 if (allSlots && Array.isArray(allSlots) && allSlots.length > 0) {
                     const groupedSlots = {};
                     let totalSlotsCount = 0;
                     allSlots.forEach(slotObj => {
                         try {
                             const isoString = slotObj.datetime || slotObj;
                             const dateObj = new Date(isoString);
                             if (!isNaN(dateObj.getTime())) {
                                 totalSlotsCount++;
                                 const italianDateKey = dateObj.toLocaleDateString('en-CA', { timeZone: ITALIAN_TIMEZONE }); // YYYY-MM-DD for sorting
                                 const timePart = dateObj.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: ITALIAN_TIMEZONE });
                                 if (!groupedSlots[italianDateKey]) {
                                     const datePartStr = dateObj.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: ITALIAN_TIMEZONE }).replace(/\//g, '-');
                                     let weekdayStr = dateObj.toLocaleDateString('it-IT', { weekday: 'short', timeZone: ITALIAN_TIMEZONE });
                                     weekdayStr = weekdayStr.charAt(0).toUpperCase() + weekdayStr.slice(1).replace('.', '');
                                     groupedSlots[italianDateKey] = { header: `${weekdayStr} ${datePartStr}`, times: [] };
                                 }
                                 groupedSlots[italianDateKey].times.push(timePart);
                             } else { 
                                console.warn(`[GHL] Invalid date string encountered in GHL slots: ${isoString}`); 
                            }
                         } catch (parseError) { 
                            console.warn(`[GHL] Error parsing date string from GHL slots: ${slotObj}`, parseError); 
                        }
                     });
                     const formattedLines = [];
                     const sortedDateKeys = Object.keys(groupedSlots).sort();
                     for (const dateKey of sortedDateKeys) {
                         const group = groupedSlots[dateKey];
                         group.times.sort((a, b) => a.localeCompare(b));
                         formattedLines.push(`${group.header}: ${group.times.join(', ')}`);
                     }
                     if (totalSlotsCount > 0) { 
                        formattedSlotsString = formattedLines.join('\n'); 
                        console.log(`[GHL] Formatted GHL slots (${totalSlotsCount} total):\n${formattedSlotsString}`);
                    } else { 
                        formattedSlotsString = "Nessuno slot disponibile nell'intervallo richiesto (dopo elaborazione)."; 
                        console.log("[GHL] No valid slots found after processing the received array.");
                    }
                 } else if (allSlots === null) {
                    formattedSlotsString = "Errore nel recupero degli slot GHL."; 
                    console.error("[GHL] Slot fetching returned null, indicating a fetch error.");
                } else {
                    formattedSlotsString = "Nessuno slot disponibile nell'intervallo richiesto (vuoto o non valido)."; 
                    console.log("[GHL] No slots returned (array is empty) or data is not an array.");
                }
             }
         }
      } catch (slotsError) {
        console.error("[GHL] Error during slot fetching:", slotsError);
        formattedSlotsString = "Errore durante il controllo degli slot.";
      }

      db = await openDataDb();
      const scheduled_at_iso = new Date().toISOString(); // Initial call is scheduled for immediate processing by the queue
      const callOptionsJson = JSON.stringify(callOptions);
      const firstAttemptTimestamp = new Date(); // This is the very first attempt for this contactId in this sequence

      const result = await runData(db,
         `INSERT INTO call_queue (contact_id, phone_number, first_name, full_name, email, retry_stage, status, scheduled_at, call_options_json, available_slots_text, initial_signed_url, first_attempt_timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
         [contactId, toPhoneValue, firstName, fullName, email,
          0, // Initial attempt is retry_stage 0
          'pending', scheduled_at_iso, callOptionsJson, formattedSlotsString, signedUrl, firstAttemptTimestamp.toISOString()]
      );
      
      console.log(`[OUTBOUND CALL] Initial call for ${toPhoneValue} (Attempt 0 / DB Stage 0) added to DB queue with ID: ${result.lastID}. First attempt timestamp: ${firstAttemptTimestamp.toISOString()}`);

      return reply.code(202).send({ // 202 Accepted: Request accepted, processing will occur later by queue-processor
         success: true,
         message: "Call successfully queued for processing.",
         queueId: result.lastID
      });

    } catch (error) {
      console.error('Error in initial outbound call queuing:', error);
      
      // Send comprehensive error notification
      await sendNonFatalSlackNotification(
        'Outgoing Call: Initial Call Queuing Failed',
        `Failed to queue initial outbound call for contact ${contactId} (${fullName || firstName || 'Unknown'}) to ${toPhoneValue}. Error: ${error.message}`,
        {
          contactId,
          phone: toPhoneValue,
          fullName: fullName || firstName || 'Unknown',
          error: error.stack,
          isAbruptEndingRetry,
          function: 'outbound-call endpoint'
        }
      );
      
      return reply.code(500).send({ success: false, error: error.message });
    } finally {
       if (db) await closeDataDb(db);
    }
  });

  // ---------------------------------------------------------------------------
  // 4) CALL STATUS HANDLER (NEW - for Twilio callbacks)
  // ---------------------------------------------------------------------------
  fastify.post(`${routePrefix}/call-status`, async (request, reply) => {
    const { CallSid, CallStatus, AnsweredBy, To } = request.body;
    let call = await getCallData(CallSid);
    if (!call) {
        console.warn(`[CALL STATUS ${CallSid}] Original call data not found in 'calls' table. This might be an unsolicited status or an issue with getCallData. Body:`, request.body);
        await sendNonFatalSlackNotification('Call Status: Call Data Not Found', `CallSid: ${CallSid}`, request.body);
        return reply.code(200).send('OK. No call data found in calls table.'); 
    }

    if (call.retry_scheduled) {
        console.log(`[CALL STATUS ${CallSid}] A retry has already been scheduled for this call. Ignoring status: ${CallStatus}.`);
        return reply.code(200).send('OK. Retry already handled.');
    }

    const currentAnsweredBy = call.answeredBy;
    const machineDetectionStatuses = ['machine_start', 'fax', 'machine_beep', 'machine_end_silence', 'machine_end_other', 'machine_end_beep'];
    const isMachineDetected = (AnsweredBy && machineDetectionStatuses.includes(String(AnsweredBy).toLowerCase())) ||
                              (currentAnsweredBy && machineDetectionStatuses.includes(String(currentAnsweredBy).toLowerCase()));
    console.log(`[CALL STATUS ${CallSid}] Status Update: ${CallStatus}`, {
        answeredByRaw: AnsweredBy,
        answeredByStored: currentAnsweredBy,
        toFromTwilio: To,
        toFromDB: call.to,
        contactId: call.contactId
    });
    if (AnsweredBy && AnsweredBy !== currentAnsweredBy) {
        try {
            await updateCallData(CallSid, { answeredBy: AnsweredBy });
            call.answeredBy = AnsweredBy;
            console.log(`[CALL STATUS ${CallSid}] Updated AnsweredBy to '${AnsweredBy}' in DB`);
        } catch (error) {
            console.error(`[CALL STATUS ${CallSid}] Failed to update AnsweredBy in DB:`, error);
            await sendNonFatalSlackNotification(
              'Outgoing Call: DB Update Failed',
              `Failed to update AnsweredBy field for CallSid ${CallSid}. Error: ${error.message}`,
              {
                CallSid,
                answeredBy: AnsweredBy,
                contactId: call.contactId,
                phone: call.to,
                error: error.stack,
                function: 'call-status updateCallData'
              }
            );
        }
    }
    // If machine detected and not terminal, end call and schedule retry
    if (isMachineDetected && !["completed", "canceled", "failed"].includes(CallStatus)) {
        console.log(`[${CallSid}] Machine detected during ongoing call. Attempting to end call and schedule retry.`);
        try {
            await updateCallData(CallSid, { retry_scheduled: 1 }); // Set flag before any async operation
            const currentCallState = await twilioClient.calls(CallSid).fetch();
            if (!['completed', 'canceled', 'failed'].includes(currentCallState.status)) {
                await twilioClient.calls(CallSid).update({ status: "completed" });
                console.log(`[${CallSid}] Successfully sent command to end call.`);
            } else {
                console.log(`[${CallSid}] Call already terminal (${currentCallState.status}) before command sent.`);
            }
        } catch (error) {
            console.error(`[${CallSid}] Failed to end call after early machine detection:`, error);
            await sendNonFatalSlackNotification(
              'Outgoing Call: Failed to End Call After Machine Detection',
              `Failed to programmatically end call ${CallSid} after machine detection. Error: ${error.message}`,
              {
                CallSid,
                contactId: call.contactId,
                phone: call.to,
                error: error.stack,
                function: 'call-status machine detection handler'
              }
            );
        }
        await scheduleRetry(call, CallSid, { reason: 'machine_detected' });
        console.log(`[${CallSid}] Scheduled retry after machine detection.`);
        return reply.code(200).send('OK. Machine detected, call ended, retry scheduled.');
    }
    // Retryable failure (machine on completed/canceled, no-answer, busy, failed)
    const isRetryableFailure =
        ((["completed", "canceled"].includes(CallStatus) && isMachineDetected) ||
        CallStatus === "no-answer" ||
        CallStatus === "busy" ||
        CallStatus === "failed");

    if (CallStatus === "failed") {
        console.log(`[${CallSid}] Call failed non-retryable. Cleaning up call data.`);
        // Remove from active call queue if such a function exists (optional, not found in codebase)
        // callQueue.removeActiveCall(CallSid); // Uncomment if implemented
        if (!call.contactId) {
            console.warn(`[${CallSid}] Cannot add to GHL workflow: contactId missing from call data.`);
        }
    }
    if (isRetryableFailure) {
        await updateCallData(CallSid, { retry_scheduled: 1 }); // Set flag
        await scheduleRetry(call, CallSid, { reason: 'retryable_failure' });
        console.log(`[CALL STATUS ${CallSid}] Scheduled retry for retryable failure.`);
        return reply.code(200).send('OK. Retryable failure, retry scheduled.');
    }
    if (CallStatus === "completed" && !isMachineDetected) {
        console.log(`[CALL STATUS ${CallSid}] Call completed by human. No retry needed.`);
        return reply.code(200).send('OK. Human answered, no retry.');
    }
    if (["completed", "canceled"].includes(CallStatus) && !isMachineDetected) {
        console.log(`[CALL STATUS ${CallSid}] Call ended (Status: ${CallStatus}). No retry/human action.`);
        return reply.code(200).send('OK. Call ended, no retry.');
    }
    return reply.code(200).send('OK');
  });

  // ---------------------------------------------------------------------------
  // 5) OUTBOUND-CALL-TWIML ENDPOINT
  // ---------------------------------------------------------------------------
  fastify.all(`${routePrefix}/outbound-call-twiml`, async (request, reply) => {
    console.log("[TWIML] Received request with query parameters:", request.query);
    const firstName = xmlEscape(request.query.firstName || "");
    const fullName = xmlEscape(request.query.fullName || "");
    const email = xmlEscape(request.query.email || "");
    const phone = xmlEscape(request.query.phone || "");
    const contactId = xmlEscape(request.query.contactId || "");

    const isAbruptEndingRetry = xmlEscape(request.query.isAbruptEndingRetry || "");
    const pastCallSummary = xmlEscape(request.query.pastCallSummary || "");
    const originalConversationId = xmlEscape(request.query.originalConversationId || "");
    
    console.log("[TWIML] Processed parameters after XML escape:", { firstName, fullName, email, phone, contactId, isAbruptEndingRetry: !!isAbruptEndingRetry });

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${PUBLIC_URL.replace(/^https?:\/\//, '')}${routePrefix}/outbound-media-stream">
            <Parameter name="firstName" value="${firstName}" />
            <Parameter name="fullName" value="${fullName}" />
            <Parameter name="email" value="${email}" />
            <Parameter name="phone" value="${phone}" />
            <Parameter name="contactId" value="${contactId}" />
            <Parameter name="callSid" value="${xmlEscape(request.query.CallSid || request.body.CallSid || '')}" />
            <Parameter name="isAbruptEndingRetry" value="${isAbruptEndingRetry}" />
            <Parameter name="pastCallSummary" value="${pastCallSummary}" />
            <Parameter name="originalConversationId" value="${originalConversationId}" />
          </Stream>
        </Connect>
      </Response>`;
    
    console.log("[TWIML] TwiML response being sent.");
    reply.type("text/xml").send(twimlResponse.trim());
  });

  // ---------------------------------------------------------------------------
  // 6) OUTBOUND-MEDIA-STREAM (WebSocket) ENDPOINT
  // ---------------------------------------------------------------------------
  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get(`${routePrefix}/outbound-media-stream`, { websocket: true }, (ws, request) => {
      console.info("[Server] Twilio connected to outbound media stream");
      
      const connectionState = {
        streamSid: null,
        callSid: null, // Twilio CallSid
        customParameters: {}, // from start message
        elevenLabsWs: null
      };

      const setupElevenLabs = async (availableSlots) => {
        if (!connectionState.callSid) {
          console.error("[ElevenLabs] Cannot setup ElevenLabs: callSid missing in connectionState.");
          return;
        }
        try {
          const callData = await getCallData(connectionState.callSid);
          // Always get a fresh signed URL to avoid authorization errors
          let signedUrl = await getSignedUrl();
          
          connectionState.elevenLabsWs = new WebSocket(signedUrl);
          connectionState.elevenLabsWs.on("open", () => {
            console.log(`[ElevenLabs OUT - ${connectionState.callSid}] Connected to Conversational AI.`);
            

            // Extract first available date from availableSlots
            let availableDate = "";
            if (availableSlots && availableSlots !== "No availability information found." && availableSlots !== "Nessuno slot disponibile nell'intervallo richiesto (dopo elaborazione)." && availableSlots !== "Errore nel recupero degli slot GHL." && availableSlots !== "Errore durante il controllo degli slot.") {
              const lines = availableSlots.split('\\n');
              if (lines.length > 0) {
                const firstLine = lines[0];
                // Extract date from format like "Lun 23-12-2024: 09:00, 10:00"
                const dateMatch = firstLine.match(/([A-Za-z]{3}\s\d{2}-\d{2}-\d{4})/);
                if (dateMatch) {
                  availableDate = dateMatch[1];
                }
              }
            }

            const initialConfig = {
              type: "conversation_initiation_client_data",
              dynamic_variables: {
                firstName: connectionState.customParameters.firstName || "",
                fullName: connectionState.customParameters.fullName || "",
                email: connectionState.customParameters.email || "",
                phone: connectionState.customParameters.phone || "",
                contactId: connectionState.customParameters.contactId || "",
                availableSlots: availableSlots,
                availableDate: availableDate,
                offertaMinima: connectionState.customParameters.offertaMinima || "",
                tipologia: connectionState.customParameters.tipologia || "",
                indirizzo: connectionState.customParameters.indirizzo || "",
                civico: connectionState.customParameters.civico || "",
                citta: connectionState.customParameters.citta || "",
                cap: connectionState.customParameters.cap || ""
              }
            };
            
            // Handle abrupt ending retry - add pastCallSummary and override first message
            const isAbruptRetry = connectionState.customParameters.isAbruptEndingRetry === 'true';
            if (isAbruptRetry) {
              console.log(`[ElevenLabs OUT - ${connectionState.callSid}] Configuring abrupt ending retry for ${connectionState.customParameters.firstName}`);
              initialConfig.dynamic_variables.pastCallSummary = connectionState.customParameters.pastCallSummary || '';
              initialConfig.dynamic_variables.originalConversationId = connectionState.customParameters.originalConversationId || '';
              
              // Override the first message for abrupt ending retry
              initialConfig.first_message_override = `Pronto ${connectionState.customParameters.firstName || 'cliente'}? Era caduta la linea, mi senti?`;
              
              console.log(`[ElevenLabs OUT - ${connectionState.callSid}] Added pastCallSummary (${initialConfig.dynamic_variables.pastCallSummary.length} chars) and custom first message for abrupt retry`);
            }
            console.log(`[DEBUG - ${connectionState.callSid}] Initial ElevenLabs config:`, initialConfig);
            
            // Add connection quality check
            if (connectionState.elevenLabsWs.readyState === WebSocket.OPEN) {
              connectionState.elevenLabsWs.send(JSON.stringify(initialConfig));
              console.log(`[ElevenLabs OUT - ${connectionState.callSid}] Sent initial config`);
            } else {
              console.warn(`[ElevenLabs OUT - ${connectionState.callSid}] WebSocket not ready when trying to send initial config`);
            }
          });

          connectionState.elevenLabsWs.on("message", async (data) => {
            try {
              const message = JSON.parse(data);
              const timestamp = new Date().toISOString();
              switch (message.type) {
                case "conversation_initiation_metadata":
                  const conversationId = message.conversation_initiation_metadata_event?.conversation_id;
                  if (connectionState.callSid) {
                    try {
                      await updateCallData(connectionState.callSid, { conversationId }); 
                      console.log(`[ElevenLabs OUT - ${connectionState.callSid}] Saved conversationId to SQLite for callSid: ${connectionState.callSid}`);
                    } catch (sqliteError) {
                      console.error(`[ElevenLabs OUT - ${connectionState.callSid}] Failed to save conversationId to SQLite:`, sqliteError);
                      
                      // Send notification for conversation ID save failures
                      await sendNonFatalSlackNotification(
                        'Outgoing Call: Conversation ID Save Failed',
                        `Failed to save conversationId to database for call ${connectionState.callSid}. Error: ${sqliteError.message}`,
                        {
                          callSid: connectionState.callSid,
                          conversationId,
                          error: sqliteError.stack,
                          function: 'ElevenLabs conversation metadata handler'
                        }
                      );
                    }
                  } else {
                    console.warn(`[ElevenLabs OUT - ${connectionState.callSid}] No callSid available to save conversationId`);
                  }
                  break;
                case "audio":
                  let payload;
                  if (message.audio?.chunk) {
                    payload = message.audio.chunk;
                  } else if (message.audio_event?.audio_base_64) {
                    payload = message.audio_event.audio_base_64;
                  } else {
                    console.warn(`[ElevenLabs OUT - ${connectionState.callSid}] No audio payload found in the message.`);
                  }
                  if (connectionState.streamSid && payload) {
                    const audioData = {
                      event: "media",
                      streamSid: connectionState.streamSid,
                      media: { payload },
                    };
                    try {
                      // Add small delay to prevent audio rushing
                      if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify(audioData));
                      }
                    } catch (sendError) {
                      console.error(`[ElevenLabs OUT - ${connectionState.callSid}] Failed to send audio data to Twilio:`, sendError);
                      
                      // Send notification for audio transmission failures
                      await sendNonFatalSlackNotification(
                        'Outgoing Call: Audio Transmission Failed',
                        `Failed to send audio data to Twilio for call ${connectionState.callSid}. Error: ${sendError.message}`,
                        {
                          callSid: connectionState.callSid,
                          streamSid: connectionState.streamSid,
                          error: sendError.stack,
                          wsReadyState: ws.readyState,
                          function: 'ElevenLabs audio transmission'
                        }
                      );
                    }
                  } else {
                    console.warn(`[ElevenLabs OUT - ${connectionState.callSid}] streamSid or payload is missing. streamSid: ${connectionState.streamSid}, payload available: ${!!payload}`);
                  }
                  break;
                case "interruption":
                  console.log(`[ElevenLabs OUT - ${connectionState.callSid}] Received interruption event`);
                  if (connectionState.streamSid) {
                    try {
                      ws.send(JSON.stringify({ event: "clear", streamSid: connectionState.streamSid }));
                      console.log(`[ElevenLabs OUT - ${connectionState.callSid}] Sent clear event to Twilio`);
                    } catch (sendError) {
                      console.error(`[ElevenLabs OUT - ${connectionState.callSid}] Failed to send clear event to Twilio:`, sendError);
                      
                      // Send notification for clear event failures
                      await sendNonFatalSlackNotification(
                        'Outgoing Call: Clear Event Failed',
                        `Failed to send clear event to Twilio for call ${connectionState.callSid}. Error: ${sendError.message}`,
                        {
                          callSid: connectionState.callSid,
                          streamSid: connectionState.streamSid,
                          error: sendError.stack,
                          function: 'ElevenLabs interruption handler'
                        }
                      );
                    }
                  }
                  break;
                case "ping":
                  if (message.ping_event?.event_id) {
                    if (connectionState.elevenLabsWs.readyState === WebSocket.OPEN) {
                      try {
                        connectionState.elevenLabsWs.send(JSON.stringify({
                          type: "pong",
                          event_id: message.ping_event.event_id
                        }));
                      } catch (sendError) {
                        console.error(`[ElevenLabs OUT - ${connectionState.callSid}] Failed to send pong response:`, sendError);
                        
                        // Send notification for pong failures (less critical)
                        await sendNonFatalSlackNotification(
                          'Outgoing Call: Pong Response Failed',
                          `Failed to send pong response for call ${connectionState.callSid}. Error: ${sendError.message}`,
                          {
                            callSid: connectionState.callSid,
                            streamSid: connectionState.streamSid,
                            error: sendError.stack,
                            function: 'ElevenLabs ping-pong handler'
                          }
                        );
                      }
                    } else {
                      console.warn(`[ElevenLabs OUT - ${connectionState.callSid}] WebSocket not open (readyState: ${connectionState.elevenLabsWs.readyState}), cannot send pong response.`);
                    }
                  }
                  break;
                case "user_transcript":
                  // Handle user transcript silently - no action needed
                  break;
                case "agent_response":
                  // Handle agent response silently - no action needed
                  break;
              }
            } catch (error) {
              console.error(`[${new Date().toISOString()}] [ElevenLabs OUT - ${connectionState.callSid}] Error processing message:`, error);
              console.log(`[ElevenLabs OUT - ${connectionState.callSid}] Raw message data:`, data);
              
              // Send notification for critical message processing errors
              await sendNonFatalSlackNotification(
                'Outgoing Call: ElevenLabs Message Processing Error',
                `Error processing ElevenLabs message for call ${connectionState.callSid}. Error: ${error.message}`,
                {
                  callSid: connectionState.callSid,
                  streamSid: connectionState.streamSid,
                  error: error.stack,
                  rawMessageData: data?.toString?.() || 'Unable to stringify',
                  function: 'ElevenLabs message handler'
                }
              );
            }
          });

          connectionState.elevenLabsWs.on("error", (error) => {
            console.error(`[ElevenLabs OUT - ${connectionState.callSid}] WebSocket error:`, error);
            
            // Send notification for critical WebSocket errors
            if (error.code !== 'ECONNRESET' && error.code !== 'ENOTFOUND') {
              sendNonFatalSlackNotification(
                'Outgoing Call: ElevenLabs WebSocket Error',
                `ElevenLabs WebSocket error for call ${connectionState.callSid}. Error: ${error.message}`,
                {
                  callSid: connectionState.callSid,
                  streamSid: connectionState.streamSid,
                  errorCode: error.code,
                  error: error.stack,
                  function: 'ElevenLabs WebSocket error handler'
                }
              ).catch(console.error);
            }
            
            if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND') {
              console.log(`[ElevenLabs OUT - ${connectionState.callSid}] Connection lost, will attempt reconnection on next audio event`);
            }
          });

          connectionState.elevenLabsWs.on("close", async (code, reason) => {
            const reasonString = reason?.toString() || 'No reason given';
            console.log(`[ElevenLabs OUT - ${connectionState.callSid}] WebSocket closed with code ${code}: ${reasonString}`);

            if (code !== 1000 && code !== 1005) { // Unexpected close
              sendNonFatalSlackNotification(
                "Outgoing Call: ElevenLabs WebSocket Closed Unexpectedly",
                `[ElevenLabs OUT - ${connectionState.callSid}] WebSocket closed unexpectedly with code ${code}. Reason: ${reasonString}`,
                { twilioCallSid: connectionState.callSid, streamSid: connectionState.streamSid, closeCode: code, closeReason: reasonString, wsState: connectionState.elevenLabsWs?.readyState }
              );
            }
          });
        } catch (error) {
          console.error(`[ElevenLabs OUT - ${connectionState.callSid}] Setup error:`, error);
          await sendNonFatalSlackNotification(
            'Outgoing Call: ElevenLabs Setup Failed',
            `Failed to setup ElevenLabs connection for call ${connectionState.callSid}. Error: ${error.message}`,
            {
              callSid: connectionState.callSid,
              streamSid: connectionState.streamSid,
              error: error.stack,
              function: 'setupElevenLabs'
            }
          );
        }
      };

      ws.on("message", async (message) => {
        try {
          const msg = JSON.parse(message);
          switch (msg.event) {
            case "start":
              ({ streamSid: connectionState.streamSid, callSid: connectionState.callSid, customParameters: connectionState.customParameters } = msg.start);
              console.log(`[Twilio] Stream started - StreamSid: ${connectionState.streamSid}, CallSid: ${connectionState.callSid}`);
              
              let availableSlotsString = "No availability information found."; // Default message
              if (connectionState.callSid) {
                  try {
                      const callDataFromDb = await getCallData(connectionState.callSid);
                      if (callDataFromDb && callDataFromDb.availableSlots) {
                          availableSlotsString = callDataFromDb.availableSlots;
                          console.log(new Date().toISOString(), `[Twilio] Stream started - Available slots: ${availableSlotsString}`);
                      }
                  } catch (error) {
                      console.error(`[Twilio] Error fetching available slots for callSid: ${connectionState.callSid}:`, error);
                      await sendNonFatalSlackNotification(
                        'Outgoing Call: Available Slots Fetch Failed',
                        `Failed to fetch available slots for call ${connectionState.callSid}. Error: ${error.message}`,
                        {
                          callSid: connectionState.callSid,
                          error: error.stack,
                          function: 'WebSocket start event handler'
                        }
                      );
                  }
              }
              setupElevenLabs(availableSlotsString);
              break;
            case "media":
              if (connectionState.elevenLabsWs?.readyState === WebSocket.OPEN) {
                connectionState.elevenLabsWs.send(JSON.stringify({
                  type: "user_audio",
                  user_audio_chunk: msg.media.payload
                }));
              }
              break;
            case "end":
              console.log(`[Twilio] Stream ended - StreamSid: ${connectionState.streamSid}, CallSid: ${connectionState.callSid}`);
              
              // Close ElevenLabs WebSocket when Twilio stream ends
              if (connectionState.elevenLabsWs?.readyState === WebSocket.OPEN || connectionState.elevenLabsWs?.readyState === WebSocket.CONNECTING) {
                connectionState.elevenLabsWs.close();
                console.log(`[ElevenLabs OUT - ${connectionState.callSid}] Connection closed due to Twilio stream end.`);
              }
              break;
            case "error":
              console.error(`[Twilio] Stream error - StreamSid: ${connectionState.streamSid}, Error:`, msg.error);
              break;
          }
        } catch (error) {
          console.error(`[Twilio] Error processing message:`, error);
          await sendNonFatalSlackNotification(
            'Outgoing Call: Twilio Message Processing Error',
            `Error processing Twilio WebSocket message. Error: ${error.message}`,
            {
              callSid: connectionState.callSid,
              streamSid: connectionState.streamSid,
              error: error.stack,
              function: 'Twilio WebSocket message handler'
            }
          );
        }
      });

      // Add missing Twilio WebSocket cleanup handlers
      ws.on("close", async () => {
        console.log(`[TWILIO OUT - ${connectionState.callSid || 'NO_SID_ON_CLOSE'}] Twilio WebSocket connection closed.`);
        
        // Close ElevenLabs WebSocket when Twilio disconnects
        if (connectionState.elevenLabsWs?.readyState === WebSocket.OPEN || connectionState.elevenLabsWs?.readyState === WebSocket.CONNECTING) {
          connectionState.elevenLabsWs.close();
          console.log(`[ElevenLabs OUT - ${connectionState.callSid}] Connection closed due to Twilio client disconnect.`);
        }
      });

      ws.on("error", async (error) => {
        console.error(`[TWILIO OUT - ${connectionState.callSid || 'NO_SID_ON_ERROR'}] Twilio WebSocket error: ${error.message}`);
        
        // Send notification for Twilio WebSocket errors
        await sendNonFatalSlackNotification(
          'Outgoing Call: Twilio WebSocket Error',
          `Twilio WebSocket error for outgoing call ${connectionState.callSid || 'Unknown'}. Error: ${error.message}`,
          {
            callSid: connectionState.callSid,
            streamSid: connectionState.streamSid,
            error: error.stack,
            function: 'Twilio WebSocket error handler'
          }
        );
        
        // Close ElevenLabs WebSocket when Twilio has an error
        if (connectionState.elevenLabsWs?.readyState === WebSocket.OPEN || connectionState.elevenLabsWs?.readyState === WebSocket.CONNECTING) {
          connectionState.elevenLabsWs.close();
          console.log(`[ElevenLabs OUT - ${connectionState.callSid}] Connection closed due to Twilio WebSocket error.`);
        }
      });
    });
  });
}