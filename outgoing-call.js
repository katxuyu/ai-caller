import WebSocket from "ws";
import Twilio from "twilio";
import xmlEscape from "xml-escape";
import fetch from "node-fetch";
import { getCallData, updateCallData } from './callDataDb.js';
import { openDb, closeDb, run } from './db.js';
import { sendNonFatalSlackNotification, sendPositiveSlackNotification } from './slack/notifications.js';
import {
  ELEVENLABS_API_KEY,
  OUTGOING_ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  OUTGOING_TWILIO_PHONE_NUMBER,
  OUTGOING_ROUTE_PREFIX,
  PUBLIC_URL
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
    
  console.log("OUTGOING_ROUTE_PREFIX raw:", JSON.stringify(OUTGOING_ROUTE_PREFIX));
  console.log("routePrefix cleaned:", JSON.stringify(routePrefix));
  
  const MAX_TOTAL_ATTEMPTS = 10;

  // ---------------------------------------------------------------------------
  // 1) GET SIGNED URL (ELEVENLABS)
  // ---------------------------------------------------------------------------
  async function getSignedUrl() {
    console.log('[ELEVENLABS] Requesting signed URL from ElevenLabs API...');
    const elevenlabsUrl = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${OUTGOING_ELEVENLABS_AGENT_ID}`;
    const response = await fetch(elevenlabsUrl, {
      method: "GET",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json"
      }
    });
    if (!response.ok) {
      const errorMessage = `Failed to get signed URL from ElevenLabs API: ${response.status} ${response.statusText}`;
      console.error('[ELEVENLABS] ' + errorMessage);
      await sendNonFatalSlackNotification('ElevenLabs Signed URL Failure', errorMessage, { status: response.status, statusText: response.statusText });
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
      await sendNonFatalSlackNotification(
        'Outgoing Call: Max Attempts Reached',
        `Maximum retry attempts (${MAX_TOTAL_ATTEMPTS}) reached for contact ${callDataForRetryLogic.contactId}. No further attempts will be made.`,
        {
          contactId: callDataForRetryLogic.contactId,
          phone: callDataForRetryLogic.to,
          totalAttempts: currentAttemptNumber + 1,
          firstName: callDataForRetryLogic.firstName,
          fullName: callDataForRetryLogic.fullName,
          critical: true
        }
      ).catch(console.error);
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
    const safeTo = callDataForRetryLogic.phone || callDataForRetryLogic.to || null;
    const safeContactId = callDataForRetryLogic.contactId || callDataForRetryLogic.contact_id || null;
    const safeFirstName = callDataForRetryLogic.firstName || callDataForRetryLogic.first_name || '';
    const safeFullName = callDataForRetryLogic.fullName || callDataForRetryLogic.full_name || '';
    const safeEmail = callDataForRetryLogic.email || '';
    const safeAddress = callDataForRetryLogic.full_address || callDataForRetryLogic.address || '';

    if (!safeTo || !safeContactId) {
      console.error(`${logPrefix} Missing required contact data for retry. contactId: ${safeContactId}, to: ${safeTo}`);
      await sendNonFatalSlackNotification(
        'Outgoing Call: Retry Scheduling Skipped - Missing Data',
        `Retry skipped due to missing phone or contactId for CallSid ${failedCallSid}.`,
        {
          contactId: safeContactId,
          phone: safeTo,
          firstName: safeFirstName,
          fullName: safeFullName,
          attemptNumber: nextAttemptNumberForDB,
          reason: options.reason || 'unknown'
        }
      ).catch(console.error);
      return;
    }

    const baseDataForRetry = {
        contactId: safeContactId,
        to: safeTo,
        firstName: safeFirstName,
        fullName: safeFullName,
        email: safeEmail,
        initialSignedUrl: callDataForRetryLogic.signedUrl,
        full_address: safeAddress
    };
    const twimlUrl = `${PUBLIC_URL}${routePrefix}/outbound-call-twiml?firstName=${encodeURIComponent(baseDataForRetry.firstName || '')}&fullName=${encodeURIComponent(baseDataForRetry.fullName || '')}&email=${encodeURIComponent(baseDataForRetry.email || '')}&phone=${encodeURIComponent(safeTo)}&contactId=${encodeURIComponent(safeContactId)}&full_address=${encodeURIComponent(baseDataForRetry.full_address || '')}`;
    const newCallOptions = {
        from: OUTGOING_TWILIO_PHONE_NUMBER,
        to: safeTo,
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
        dbRetry = await openDb();
        const result = await run(dbRetry,
            `INSERT INTO call_queue (contact_id, phone_number, first_name, full_name, email, full_address, retry_stage, status, scheduled_at, call_options_json, initial_signed_url, first_attempt_timestamp)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            [safeContactId, safeTo, safeFirstName, safeFullName, safeEmail, baseDataForRetry.full_address, nextAttemptNumberForDB, 'pending', scheduled_at_iso, newCallOptionsJson, baseDataForRetry.initialSignedUrl, firstAttemptTimestamp.toISOString()]
        );
        console.log(`${logPrefix} Added attempt ${nextAttemptNumberForDB} to DB queue. New Queue ID: ${result.lastID}. Scheduled for: ${scheduled_at_iso}`);
    } catch (dbError) {
         console.error(`${logPrefix} Error adding attempt ${nextAttemptNumberForDB} to DB queue:`, dbError);
         await sendNonFatalSlackNotification(
           'Outgoing Call: Retry Scheduling Failed', 
           `Failed to schedule retry for contact ${callDataForRetryLogic.contactId}. Customer follow-up may be lost.`,
           { 
             logPrefix, 
             contactId: callDataForRetryLogic.contactId,
             phone: callDataForRetryLogic.to,
             attemptNumber: nextAttemptNumberForDB,
             error: dbError.message,
             stack: dbError.stack
           }
         ).catch(console.error);
    } finally {
        if (dbRetry) await closeDb(dbRetry);
    }
  }

  // ---------------------------------------------------------------------------
  // 3) OUTBOUND CALL ENDPOINT (Initial Call Request)
  // ---------------------------------------------------------------------------
  fastify.post(`${routePrefix}/outbound-call`, async (request, reply) => {
    console.log("[OUTBOUND CALL] Received request with body:", JSON.stringify(request.body, null, 2));
    console.log("[OUTBOUND CALL] Request headers:", JSON.stringify(request.headers, null, 2));
    console.log("[OUTBOUND CALL] Available fields in body:", Object.keys(request.body || {}));
    
    const { phone, contact_id, first_name, full_name, email, full_address } = request.body;
    
    // Handle different possible field names from GoHighLevel
    const toPhoneValue = phone || request.body.phoneNumber || request.body.phone_number || request.body.Phone;
    const contactId = contact_id || request.body.contactId || request.body.contact_id || request.body.id || request.body.Id;
    const firstName = first_name || request.body.firstName || request.body.first_name || request.body.FirstName;
    const lastName = request.body.last_name || request.body.lastName || request.body.LastName;
    const fullName = full_name || request.body.fullName || request.body.full_name || request.body.name || request.body.Name;
    const emailValue = email || request.body.Email;
    const address = full_address || request.body.full_address || request.body.fullAddress || request.body.address || "";
    // Derive lastName from fullName if missing
    const derivedLastName = lastName || (fullName && firstName && fullName.startsWith(firstName)
      ? fullName.slice(firstName.length).trim()
      : (fullName ? fullName.split(" ").slice(1).join(" ").trim() : ""));
    console.log("[OUTBOUND CALL] Extracted parameters:", { phone, contact_id, first_name, last_name: derivedLastName, full_name, email, full_address: address });

    if (!toPhoneValue || !contactId) {
      console.error("[OUTBOUND CALL] Missing required parameters phone or contactId");
      await sendNonFatalSlackNotification(
        'Outbound Call: Missing Parameters',
        'Outbound call request received with missing phone or contactId. Call cannot be processed.',
        { phone: toPhoneValue, contactId, requestBody: request.body }
      ).catch(console.error);
      return reply.code(400).send({ error: "phone and contactId are required" });
    }
    
    let db;
    try {
      console.log("[ELEVENLABS] Requesting signed URL before call creation");
      let signedUrl = await getSignedUrl();
      console.log("[ELEVENLABS] Successfully obtained signed URL before call creation");

      const callOptions = {
        from: OUTGOING_TWILIO_PHONE_NUMBER,
        to: toPhoneValue,
        url: `${PUBLIC_URL}${routePrefix}/outbound-call-twiml?firstName=${encodeURIComponent(firstName || '')}&lastName=${encodeURIComponent(derivedLastName || '')}&fullName=${encodeURIComponent(fullName || '')}&email=${encodeURIComponent(emailValue || '')}&phone=${encodeURIComponent(toPhoneValue)}&contactId=${encodeURIComponent(contactId)}&full_address=${encodeURIComponent(address)}`,
        timeout: 25,
        timeLimit: 900,
        statusCallback: `${PUBLIC_URL}${routePrefix}/call-status`,
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        machineDetection: "Enable",
        asyncAmd: true,
        asyncAmdStatusCallback: `${PUBLIC_URL}${routePrefix}/call-status`,
      };

      db = await openDb();
      const scheduled_at_iso = new Date().toISOString(); // Initial call is scheduled for immediate processing by the queue
      const callOptionsJson = JSON.stringify(callOptions);
      const firstAttemptTimestamp = new Date(); // This is the very first attempt for this contactId in this sequence

      const result = await run(db,
         `INSERT INTO call_queue (contact_id, phone_number, first_name, full_name, email, full_address, retry_stage, status, scheduled_at, call_options_json, initial_signed_url, first_attempt_timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
         [contactId, toPhoneValue, firstName, fullName, emailValue, address,
          0, // Initial attempt is retry_stage 0
          'pending', scheduled_at_iso, callOptionsJson, signedUrl, firstAttemptTimestamp.toISOString()]
      );
      
      console.log(`[OUTBOUND CALL] Initial call for ${toPhoneValue} (Attempt 0 / DB Stage 0) added to DB queue with ID: ${result.lastID}. First attempt timestamp: ${firstAttemptTimestamp.toISOString()}.`);

      await sendPositiveSlackNotification(
        'Outgoing Call Successfully Queued',
        `Initial outbound call successfully queued for contact ${contactId}.`,
        {
          contactId,
          phone: toPhoneValue,
          firstName,
          fullName,
          queueId: result.lastID,
          scheduledAt: firstAttemptTimestamp.toISOString()
        }
      ).catch(console.error);

      return reply.code(202).send({ // 202 Accepted: Request accepted, processing will occur later by queue-processor
         success: true,
         message: "Call successfully queued for processing.",
         queueId: result.lastID
      });

    } catch (error) {
      console.error('Error in initial outbound call queuing:', error);
      await sendNonFatalSlackNotification(
        'Outbound Call: Initial Queuing Failed',
        `Failed to queue initial outbound call for contact ${contactId}. Customer will not be contacted.`,
        {
          contactId,
          phone: toPhoneValue,
          error: error.message,
          stack: error.stack,
          critical: true
        }
      ).catch(console.error);
      return reply.code(500).send({ success: false, error: error.message });
    } finally {
       if (db) await closeDb(db);
    }
  });

  // ---------------------------------------------------------------------------
  // X) CALL STATUS HANDLER (NEW - for Twilio callbacks)
  // ---------------------------------------------------------------------------
  fastify.post(`${routePrefix}/call-status`, async (request, reply) => {
    const { CallSid, CallStatus, AnsweredBy, To } = request.body;
    console.log(`[CALL STATUS ${CallSid}] Received status callback: ${CallStatus}, AnsweredBy: ${AnsweredBy}, To: ${To}`);
    
    // Try to get call data, with retry logic for race conditions
    let call = await getCallData(CallSid);
    if (!call) {
        console.warn(`[CALL STATUS ${CallSid}] Call data not found on first attempt. Retrying in 2 seconds...`);
        // Wait 2 seconds and try again - this handles race conditions where status arrives before queue processor stores data
        await new Promise(resolve => setTimeout(resolve, 2000));
        call = await getCallData(CallSid);
        
        if (!call) {
            console.warn(`[CALL STATUS ${CallSid}] Call data still not found after retry. This might be an unsolicited status or an issue with getCallData. Body:`, request.body);
            await sendNonFatalSlackNotification(
              'Outgoing Call: Status Data Missing',
              `Call status received for unknown CallSid ${CallSid}. This may indicate data consistency issues or race condition.`,
              { CallSid, CallStatus, requestBody: request.body }
            ).catch(console.error);
            return reply.code(200).send('OK. No call data found in calls table after retry.'); 
        } else {
            console.log(`[CALL STATUS ${CallSid}] Call data found on retry - race condition resolved.`);
        }
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
        toFromDB: call.phone,
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
              'Outgoing Call: Failed to Update AnsweredBy',
              `Failed to update AnsweredBy field in database for call ${CallSid}.`,
              {
                CallSid,
                AnsweredBy,
                error: error.message,
                stack: error.stack
              }
            ).catch(console.error);
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
              `Failed to end call ${CallSid} after machine detection. Call may continue running.`,
              {
                CallSid,
                error: error.message,
                stack: error.stack,
                contactId: call.contactId,
                phone: call.phone
              }
            ).catch(console.error);
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
    if (isRetryableFailure) {
        await updateCallData(CallSid, { retry_scheduled: 1 }); // Set flag
        await scheduleRetry(call, CallSid, { reason: 'retryable_failure' });
        console.log(`[CALL STATUS ${CallSid}] Scheduled retry for retryable failure.`);
        return reply.code(200).send('OK. Retryable failure, retry scheduled.');
    }
    if (CallStatus === "completed" && !isMachineDetected) {
        console.log(`[CALL STATUS ${CallSid}] Call completed by human. No retry needed.`);
        await sendPositiveSlackNotification(
          'Outgoing Call: Successful Human Connection',
          `Call ${CallSid} successfully completed with human interaction.`,
          {
            CallSid,
            contactId: call.contactId,
            phone: call.phone,
            firstName: call.firstName,
            fullName: call.fullName
          }
        ).catch(console.error);
        return reply.code(200).send('OK. Human answered, no retry.');
    }
    if (["completed", "canceled"].includes(CallStatus) && !isMachineDetected) {
        console.log(`[CALL STATUS ${CallSid}] Call ended (Status: ${CallStatus}). No retry/human action.`);
        return reply.code(200).send('OK. Call ended, no retry.');
    }
    return reply.code(200).send('OK');
  });

  // ---------------------------------------------------------------------------
  // 4) OUTBOUND-CALL-TWIML ENDPOINT
  // ---------------------------------------------------------------------------
  fastify.all(`${routePrefix}/outbound-call-twiml`, async (request, reply) => {
    console.log("[TWIML] Received request with query parameters:", request.query);
    const firstName = xmlEscape(request.query.firstName || "");
    const lastName = xmlEscape(request.query.lastName || "");
    const fullName = xmlEscape(request.query.fullName || "");
    const email = xmlEscape(request.query.email || "");
    const phone = xmlEscape(request.query.phone || "");
    const contactId = xmlEscape(request.query.contactId || "");
    const address = xmlEscape(request.query.full_address || "");
    
    console.log("[TWIML] Processed parameters after XML escape:", { firstName, lastName, fullName, email, phone, contactId, address });

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${PUBLIC_URL.replace(/^https?:\/\//, '')}${routePrefix}/outbound-media-stream">
            <Parameter name="firstName" value="${firstName}" />
            <Parameter name="lastName" value="${lastName}" />
            <Parameter name="fullName" value="${fullName}" />
            <Parameter name="email" value="${email}" />
            <Parameter name="phone" value="${phone}" />
            <Parameter name="contactId" value="${contactId}" />
            <Parameter name="address" value="${address}" />
            <Parameter name="callSid" value="${xmlEscape(request.query.CallSid || request.body.CallSid || '')}" />
          </Stream>
        </Connect>
      </Response>`;
    
    console.log("[TWIML] TwiML response being sent.");
    reply.type("text/xml").send(twimlResponse.trim());
  });

  // ---------------------------------------------------------------------------
  // 5) OUTBOUND-MEDIA-STREAM (WebSocket) ENDPOINT
  // ---------------------------------------------------------------------------
  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get(`${routePrefix}/outbound-media-stream`, { websocket: true }, (ws, request) => {
      console.info("[Server] Twilio connected to outbound media stream");
      const connectionState = { streamSid: null, callSid: null, customParameters: {}, elevenLabsWs: null };

      const setupElevenLabs = async () => {
        try {
          const callData = await getCallData(connectionState.callSid);
          let signedUrl = callData?.signedUrl || await getSignedUrl();
          
          connectionState.elevenLabsWs = new WebSocket(signedUrl);
          connectionState.elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");
            
            sendPositiveSlackNotification(
              'ElevenLabs: WebSocket Connection Established',
              `Successfully connected to ElevenLabs Conversational AI for call ${connectionState.callSid}.`,
              {
                callSid: connectionState.callSid,
                contactId: connectionState.customParameters.contactId,
                phone: connectionState.customParameters.phone
              }
            ).catch(console.error);

            const initialConfig = {
              type: "conversation_initiation_client_data",
              dynamic_variables: {
                firstName: connectionState.customParameters.firstName || "",
                lastName: connectionState.customParameters.lastName || "",
                fullName: connectionState.customParameters.fullName || "",
                email: connectionState.customParameters.email || "",
                phone: connectionState.customParameters.phone || "",
                contactId: connectionState.customParameters.contactId || "",
                address: connectionState.customParameters.address || "",
                nowDate: new Date().toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(/[/]/g, '-')
              }
            };
            console.log("[DEBUG] Initial ElevenLabs config:", initialConfig);
            
            // Add connection quality check
            if (connectionState.elevenLabsWs.readyState === WebSocket.OPEN) {
              connectionState.elevenLabsWs.send(JSON.stringify(initialConfig));
              console.log("[ElevenLabs] Sent initial config");
            } else {
              console.warn("[ElevenLabs] WebSocket not ready when trying to send initial config");
              sendNonFatalSlackNotification(
                'ElevenLabs: WebSocket Not Ready for Initial Config',
                'ElevenLabs WebSocket was not ready when trying to send initial configuration.',
                {
                  callSid: connectionState.callSid,
                  readyState: connectionState.elevenLabsWs.readyState,
                  contactId: connectionState.customParameters.contactId,
                  phone: connectionState.customParameters.phone
                }
              ).catch(console.error);
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
                      console.log(`[ElevenLabs] Saved conversationId to SQLite for callSid: ${connectionState.callSid}`);
                    } catch (sqliteError) {
                      console.error(`[ElevenLabs] Failed to save conversationId to SQLite:`, sqliteError);
                      await sendNonFatalSlackNotification('ElevenLabs: Save conversationId to SQLite Failed', sqliteError.message, { callSid: connectionState.callSid, sqliteError });
                    }
                  } else {
                    console.warn(`[ElevenLabs] No callSid available to save conversationId`);
                    await sendNonFatalSlackNotification(
                      'ElevenLabs: Missing CallSid for ConversationId',
                      'Received conversation metadata but no CallSid available to save conversationId.',
                      { conversationId }
                    ).catch(console.error);
                  }
                  break;
                case "audio":
                  let payload;
                  if (message.audio?.chunk) {
                    payload = message.audio.chunk;
                  } else if (message.audio_event?.audio_base_64) {
                    payload = message.audio_event.audio_base_64;
                  } else {
                    console.warn("[ElevenLabs] No audio payload found in the message.");
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
                      console.error(`[ElevenLabs] Failed to send audio data to Twilio:`, sendError);
                      await sendNonFatalSlackNotification('ElevenLabs: Send Audio to Twilio Failed', sendError.message, { streamSid: connectionState.streamSid, sendError });
                    }
                  } else {
                    console.warn(`[ElevenLabs] streamSid or payload is missing. streamSid: ${connectionState.streamSid}, payload available: ${!!payload}`);
                  }
                  break;
                case "interruption":
                  console.log(`[ElevenLabs] Received interruption event`);
                  if (connectionState.streamSid) {
                    try {
                      ws.send(JSON.stringify({ event: "clear", streamSid: connectionState.streamSid }));
                      console.log(`[ElevenLabs] Sent clear event to Twilio`);
                    } catch (sendError) {
                      console.error(`[ElevenLabs] Failed to send clear event to Twilio:`, sendError);
                      await sendNonFatalSlackNotification('ElevenLabs: Send Clear Event to Twilio Failed', sendError.message, { streamSid: connectionState.streamSid, sendError });
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
                        console.error(`[ElevenLabs] Failed to send pong response:`, sendError);
                        await sendNonFatalSlackNotification('ElevenLabs: Send Pong Response Failed', sendError.message, { sendError });
                      }
                    } else {
                      console.warn(`[ElevenLabs] WebSocket not open (readyState: ${connectionState.elevenLabsWs.readyState}), cannot send pong response.`);
                    }
                  }
                  break;
              }
            } catch (error) {
              console.error(`[${new Date().toISOString()}] [ElevenLabs] Error processing message:`, error);
              await sendNonFatalSlackNotification('ElevenLabs: Error Processing Message', error.message, { data, error });
              console.log(`[ElevenLabs] Raw message data:`, data);
            }
          });

          connectionState.elevenLabsWs.on("error", (error) => {
            console.error("[ElevenLabs] WebSocket error:", error);
            sendNonFatalSlackNotification('ElevenLabs: WebSocket Error', error.message, { error });
            console.log("[ElevenLabs] WebSocket state at error:", connectionState.elevenLabsWs.readyState);
            console.log("[ElevenLabs] Error details:", {
              message: error.message,
              type: error.type,
              code: error.code,
              target: error.target?.url
            });
            
            // Try to reconnect if connection lost
            if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND') {
              console.log("[ElevenLabs] Connection lost, will attempt reconnection on next audio event");
            }
          });

          connectionState.elevenLabsWs.on("close", (code, reason) => {
            console.log(`[ElevenLabs] WebSocket closed with code ${code}: ${reason.toString()}`);
            if (code !== 1000) { // 1000 is normal closure
              sendNonFatalSlackNotification(
                'ElevenLabs: WebSocket Unexpected Close',
                `ElevenLabs WebSocket closed unexpectedly with code ${code}.`,
                {
                  callSid: connectionState.callSid,
                  code,
                  reason: reason.toString(),
                  contactId: connectionState.customParameters.contactId,
                  phone: connectionState.customParameters.phone
                }
              ).catch(console.error);
            }
          });
        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
          sendNonFatalSlackNotification('ElevenLabs: Setup Error', error.message, { error });
        }
      };

      ws.on("message", async (message) => {
        try {
          const msg = JSON.parse(message);
          switch (msg.event) {
            case "start":
              console.log("[Twilio] Received start event with full payload:", JSON.stringify(msg, null, 2));
              ({ streamSid: connectionState.streamSid, callSid: connectionState.callSid, customParameters: connectionState.customParameters } = msg.start);
              console.log(`[Twilio] Stream started - StreamSid: ${connectionState.streamSid}, CallSid: ${connectionState.callSid}`);
              
              sendPositiveSlackNotification(
                'Twilio: Media Stream Started',
                `Twilio media stream successfully started for call ${connectionState.callSid}.`,
                {
                  streamSid: connectionState.streamSid,
                  callSid: connectionState.callSid,
                  contactId: connectionState.customParameters.contactId,
                  phone: connectionState.customParameters.phone
                }
              ).catch(console.error);
              
              await setupElevenLabs();
              break;
            case "media":
              if (connectionState.elevenLabsWs?.readyState === WebSocket.OPEN) {
                connectionState.elevenLabsWs.send(JSON.stringify({
                  type: "user_audio",
                  user_audio_chunk: msg.media.payload
                }));
              }
              break;
            case "stop":
              console.log(`[Twilio] Stream ${connectionState.streamSid} ended`);
              connectionState.elevenLabsWs?.readyState === WebSocket.OPEN && connectionState.elevenLabsWs.close();
              break;
            default:
              console.log(`[Twilio] Unhandled event: ${msg.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
          sendNonFatalSlackNotification('Twilio: Error Processing WebSocket Message', error.message, { message, error });
        }
      });

      ws.on("close", () => {
        console.log("[Twilio] Client disconnected");
        if (connectionState.elevenLabsWs?.readyState === WebSocket.OPEN) {
          connectionState.elevenLabsWs.close();
        }
      });

      ws.on("error", (error) => {
        console.error("[WebSocket] Error:", error);
        sendNonFatalSlackNotification('WebSocket: Error', error.message, { error });
      });
    });
  });
}
