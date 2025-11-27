import { saveGoHighlevelTokens } from './tokens.js';
import { fetchGHLCalendarSlots, bookGHLAppointment, getGHLContactDetails } from './api.js';
import { italianLocalToUTC, getNextValidWorkday, isOperatingHours, createGHLFetch } from '../utils.js';
import { openDataDb, closeDataDb, runData, getData as getDbRecord } from '../dataDb.js'; // Renamed import
import { sendSlackNotification, sendNonFatalSlackNotification } from '../slack/notifications.js';
import { 
    GOHIGHLEVEL_CLIENT_ID, 
    GOHIGHLEVEL_CLIENT_SECRET, 
    GOHIGHLEVEL_REDIRECT_URI,
    GOHIGHLEVEL_AUTH_URL,
    GOHIGHLEVEL_TOKEN_URL,
    GOHIGHLEVEL_API_SCOPES,
    GOHIGHLEVEL_CALENDAR_ID,
    GOHIGHLEVEL_LOCATION_ID,
    ITALIAN_TIMEZONE,
} from '../config.js';

export function registerGhlRoutes(fastify) {
    // GoHighLevel Auth Route
    fastify.get(`/gohighlevel/auth`, async (request, reply) => {
        // Redirects the user to GoHighLevel for authorization
        // Check for Client ID and Redirect URI from env
        if (!GOHIGHLEVEL_CLIENT_ID || !GOHIGHLEVEL_REDIRECT_URI) {
            console.error(new Date().toISOString(), "[GOHIGHLEVEL] Auth endpoint configuration incomplete (CLIENT_ID, REDIRECT_URI).");
            return reply.code(500).send({ status: "error", message: "OAuth not configured" });
        }
    
        // Create params *without* scope first, URLSearchParams will handle their encoding.
        const params = new URLSearchParams({
            response_type: "code",
            redirect_uri: GOHIGHLEVEL_REDIRECT_URI, // From config
            client_id: GOHIGHLEVEL_CLIENT_ID // From config
            // Scope will be added manually to ensure %20 for spaces
        });
    
        // Manually encode scope with %20 for spaces, ensuring each part is URI encoded.
        // This is to ensure GoHighLevel receives %20 instead of + for spaces in the scope list.
        const scopeEncodedFinal = GOHIGHLEVEL_API_SCOPES.split(' ').map(s => encodeURIComponent(s)).join('%20');
    
        // Use URL object for robust construction
        const authUrl = new URL(GOHIGHLEVEL_AUTH_URL);
        // Append other params and the correctly %20 encoded scope
        authUrl.search = `${params.toString()}&scope=${scopeEncodedFinal}`;
    
        console.log(new Date().toISOString(), `[GOHIGHLEVEL] Redirecting user to GoHighLevel authorization URL: ${authUrl.toString()}`);
    
        // Return the URL for manual use or redirect
        // return reply.redirect(authUrl.toString()); // Use this for actual redirection
        return reply.send({ authorization_url: authUrl.toString() });
    });

    // GoHighLevel Callback Route
    fastify.get(`/hl/callback`, async (request, reply) => {
        // Handles the callback from GoHighLevel after authorization, stores tokens
        const authCode = request.query.code;
        const locationIdFromCallback = request.query.location_id;

        if (!authCode) {
            console.warn(new Date().toISOString(), "[GOHIGHLEVEL] Callback received without authorization code.");
            return reply.code(400).send({ status: "error", message: "OAuth failed: No code provided" });
        }
        if (!locationIdFromCallback) {
            console.warn(new Date().toISOString(), "[GOHIGHLEVEL] Callback received without location_id query parameter. Will rely on token exchange response.");
        } else {
            console.log(new Date().toISOString(), `[GOHIGHLEVEL] Callback received for location_id: ${locationIdFromCallback}`);
        }


        // Check for required environment variables (Client ID, Secret, Redirect URI still from env)
        if (!GOHIGHLEVEL_CLIENT_ID || !GOHIGHLEVEL_CLIENT_SECRET ||
            !GOHIGHLEVEL_REDIRECT_URI) {
            console.error(new Date().toISOString(), "[GOHIGHLEVEL] Callback handler configuration incomplete (CLIENT_ID, CLIENT_SECRET, REDIRECT_URI).");
            sendSlackNotification(":alert: GHL Callback Error: Missing GOHIGHLEVEL_CLIENT_ID, GOHIGHLEVEL_CLIENT_SECRET, or GOHIGHLEVEL_REDIRECT_URI environment variables.").catch(console.error);
            return reply.code(500).send({ status: "error", message: "OAuth configuration incomplete" });
        }

        const tokenPayload = new URLSearchParams({
            client_id: GOHIGHLEVEL_CLIENT_ID, // From config
            client_secret: GOHIGHLEVEL_CLIENT_SECRET, // From config
            grant_type: "authorization_code",
            code: authCode,
            redirect_uri: GOHIGHLEVEL_REDIRECT_URI, // From config
            user_type: "Location" // Or "Company"
        });

        console.log(new Date().toISOString(), "[GOHIGHLEVEL] Exchanging authorization code for GoHighLevel tokens...");
        try {
            const robustFetch = createGHLFetch('[GHL OAuth Callback]');
            const response = await robustFetch(GOHIGHLEVEL_TOKEN_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: tokenPayload
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(new Date().toISOString(), `Failed to obtain GoHighLevel tokens. Status: ${response.status}, Details: ${errorText}`);
                sendSlackNotification(`:alert: GHL Callback Error: Failed to exchange code for tokens. Status: ${response.status}. Check logs for details.`).catch(console.error);
                return reply.code(response.status).send({ status: "error", message: `Failed to obtain tokens: ${errorText}` });
            }

            const responseText = await response.text();
            console.log(new Date().toISOString(), `Token Exchange Response Status: ${response.status}`);
            // Avoid logging sensitive tokens in production if possible

            // Now parse the successful response
            try {
                const tokenData = JSON.parse(responseText);
                const accessToken = tokenData.access_token;
                const refreshToken = tokenData.refresh_token; 
                const expiresIn = tokenData.expires_in; // Seconds
                const locationIdFromResponse = tokenData.locationId; // Get locationId from the response

                // Ensure we have a location ID from either the callback or the response
                const locationId = locationIdFromResponse || locationIdFromCallback;
                if (!locationId) {
                    console.error(new Date().toISOString(), `Failed to obtain locationId from either callback query or token response. Cannot save tokens. Body: ${responseText}`);
                    sendSlackNotification(`:alert: GHL Callback Error: Failed to obtain locationId from OAuth callback or token response. Cannot save tokens.`).catch(console.error);
                    return reply.code(500).send({ status: "error", message: "Token exchange failed: Missing locationId" });
                }

                if (!accessToken || !refreshToken) {
                    console.error(new Date().toISOString(), `[${locationId}] Failed to obtain tokens: access_token or refresh_token missing in response. Body: ${responseText}`);
                    sendSlackNotification(`:alert: GHL Callback Error [Location: ${locationId}]: Missing access_token or refresh_token in response from GHL.`).catch(console.error);
                    return reply.code(500).send({ status: "error", message: "Token exchange failed: Missing tokens in response" });
                }

                console.log(new Date().toISOString(), `[${locationId}] Token exchange successful.`);

                // Calculate expiry time (UTC)
                let expiresAt = null;
                if (expiresIn) {
                    expiresAt = new Date(Date.now() + (parseInt(expiresIn) - 60) * 1000); // 60s buffer
                }

                // Save tokens to database USING THE LOCATION ID
                const saveSuccess = await saveGoHighlevelTokens(locationId, accessToken, refreshToken, expiresAt);
                if (saveSuccess) {
                    console.log(new Date().toISOString(), `[${locationId}] Successfully obtained and saved GoHighLevel tokens. Access token expires around: ${expiresAt ? expiresAt.toISOString() : 'N/A'}`);
                    // Maybe redirect to a success page or provide clearer feedback
                    return reply.send({ status: "success", message: `GoHighLevel OAuth successful for location ${locationId} and tokens stored.` });
                } else {
                    console.error(new Date().toISOString(), `[${locationId}] Failed to save GoHighLevel tokens to database after successful exchange.`);
                    sendSlackNotification(`:alert: GHL Callback Error [Location: ${locationId}]: Failed to save GHL tokens to database after successful exchange.`).catch(console.error);
                    return reply.code(500).send({ status: "error", message: `Token exchange successful for location ${locationId} but failed to save tokens` });
                }
            } catch (parseError) {
                console.error(new Date().toISOString(), `Error parsing GHL token response JSON: ${parseError.message}. Response Text: ${responseText}`);
                sendSlackNotification(`:alert: GHL Callback Error: Error parsing token response from GHL. Check logs.`).catch(console.error);
                return reply.code(500).send({ status: "error", message: "Failed to parse token response from GoHighLevel." });
            }
        } catch (e) {
            console.error(new Date().toISOString(), `Unexpected error during GoHighLevel token exchange: ${e.message}`, e);
            sendSlackNotification(`:alert: GHL Callback Exception: Unexpected error during token exchange. Error: ${e.message}. Check logs.`).catch(console.error);
            return reply.code(500).send({ status: "error", message: `Internal server error during token exchange: ${e.message}` });
        }
    });

    // New endpoint to get available GHL calendar slots for outbound calls
    fastify.get(`/availableSlotsOutbound`, async (request, reply) => {
        const { Timeframe, AppointmentDate } = request.query;
        const calendarId = GOHIGHLEVEL_CALENDAR_ID;
        const location_id = GOHIGHLEVEL_LOCATION_ID;

        console.log(`[AvailableSlotsOutbound - ${location_id}] Received request. Query params: Timeframe='${Timeframe}', AppointmentDate='${AppointmentDate}'`);

        if (!Timeframe || !AppointmentDate) {
            console.warn(`[AvailableSlotsOutbound - ${location_id}] Missing required query parameters.`);
            return reply.code(400).send({
                status: "error",
                message: "Missing required query parameters. Please provide: Timeframe, AppointmentDate."
            });
        }

        const timeFormatValid = /^\d{2}:\d{2}$/.test(Timeframe);
        if (!timeFormatValid) {
            console.warn(`[AvailableSlotsOutbound - ${location_id}] Invalid Timeframe format: '${Timeframe}'`);
            return reply.code(400).send({ status: "error", message: "Invalid Timeframe format. Expected HH:mm." });
        }

        let formattedAppointmentDate;
        if (/^\d{4}-\d{2}-\d{2}$/.test(AppointmentDate)) {
            const parts = AppointmentDate.split('-');
            formattedAppointmentDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
        } else if (/^\d{2}-\d{2}-\d{4}$/.test(AppointmentDate)) {
            formattedAppointmentDate = AppointmentDate;
        } else {
            console.warn(`[AvailableSlotsOutbound - ${location_id}] Invalid AppointmentDate format: '${AppointmentDate}'. Expected DD-MM-YYYY or YYYY-MM-DD.`);
            return reply.code(400).send({ status: "error", message: "Invalid AppointmentDate format. Expected DD-MM-YYYY or YYYY-MM-DD." });
        }

        let initialStartDate;
        try {
            initialStartDate = italianLocalToUTC(formattedAppointmentDate, Timeframe);
            if (isNaN(initialStartDate.getTime())) {
                throw new Error("Parsed date is invalid.");
            }
        } catch (e) {
            console.error(`[AvailableSlotsOutbound - ${location_id}] Error parsing AppointmentDate '${AppointmentDate}' and Timeframe '${Timeframe}': ${e.message}`, e);
            return reply.code(400).send({ status: "error", message: `Invalid AppointmentDate or Timeframe. Details: ${e.message}` });
        }

        const tryFetchSlotsForDate = async (currentStartDateUTC) => {
            const startDateForFetch = new Date(currentStartDateUTC.getTime());
            const endDateForFetch = new Date(startDateForFetch.getTime() + 3 * 60 * 60 * 1000);
            const startDateISO = startDateForFetch.toISOString();
            const endDateISO = endDateForFetch.toISOString();

            console.log(`[AvailableSlotsOutbound - ${location_id}] Calling fetchGHLCalendarSlots for calendar '${calendarId}'. Window: ${startDateISO} to ${endDateISO}.`);
            const slots = await fetchGHLCalendarSlots(location_id, calendarId, startDateISO, endDateISO);
            
            if (slots === null) {
                 console.error(`[AvailableSlotsOutbound - ${location_id}] fetchGHLCalendarSlots returned null, indicating an API or token error.`);
                 sendNonFatalSlackNotification(
                    'GHL API Error - AvailableSlotsOutbound',
                    `Failed to fetch slots for calendar ${calendarId}.`,
                    { calendarId, location_id, startDateISO, endDateISO }
                 ).catch(console.error);
            }
            
            console.log(`[AvailableSlotsOutbound - ${location_id}] fetchGHLCalendarSlots returned:`, slots ? `${slots.length} slots` : 'null');
            return slots;
        };

        console.log(`[AvailableSlotsOutbound - ${location_id}] Attempt 1: Fetching for initial parsed UTC date ${initialStartDate.toISOString()}`);
        let availableSlots = await tryFetchSlotsForDate(initialStartDate);

        if (availableSlots && availableSlots.length > 0) {
            const filterStartUTC = initialStartDate;
            const filterEndUTC = new Date(initialStartDate.getTime() + 3 * 60 * 60 * 1000);
            const originalCount = availableSlots.length;
            availableSlots = availableSlots.filter(slot => {
                try {
                    const slotDateUTC = new Date(slot.datetime);
                    if (isNaN(slotDateUTC.getTime())) return false;
                    return slotDateUTC.getTime() >= filterStartUTC.getTime() && slotDateUTC.getTime() <= filterEndUTC.getTime();
                } catch (e) {
                    return false;
                }
            });
            console.log(`[AvailableSlotsOutbound - ${location_id}] Attempt 1: Filtered slots. Before: ${originalCount}, After: ${availableSlots.length}.`);
        }

        if (availableSlots && availableSlots.length > 0) {
            console.log(`[AvailableSlotsOutbound - ${location_id}] Attempt 1 SUCCESS: Found ${availableSlots.length} slots.`);
            return reply.code(200).send({ status: "success", slots: availableSlots });
        } else if (availableSlots === null) {
             console.error(`[AvailableSlotsOutbound - ${location_id}] Attempt 1 FAILED (API/token error).`);
        } else {
            console.log(`[AvailableSlotsOutbound - ${location_id}] Attempt 1: No slots found.`);
        }

        console.log(`[AvailableSlotsOutbound - ${location_id}] Attempt 2: No slots found on first attempt, calculating next working day.`);
        const nextWorkdayBaseUTCDate = getNextValidWorkday(initialStartDate);
        const year = nextWorkdayBaseUTCDate.getUTCFullYear();
        const month = nextWorkdayBaseUTCDate.getUTCMonth() + 1;
        const day = nextWorkdayBaseUTCDate.getUTCDate();
        const nextWorkdayDateStr = `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}`;
        
        let nextAttemptStartDateUTC;
        try {
            nextAttemptStartDateUTC = italianLocalToUTC(nextWorkdayDateStr, Timeframe);
            if (isNaN(nextAttemptStartDateUTC.getTime())) {
                throw new Error("Parsed next attempt date is invalid.");
            }
        } catch (e) {
            console.error(`[AvailableSlotsOutbound - ${location_id}] Error parsing next workday date: ${e.message}`);
            return reply.code(400).send({ status: "error", message: `No available slots were found (error calculating next attempt date).` });
        }
        
        console.log(`[AvailableSlotsOutbound - ${location_id}] Attempt 2: Fetching for next working day, parsed UTC date ${nextAttemptStartDateUTC.toISOString()}`);
        availableSlots = await tryFetchSlotsForDate(nextAttemptStartDateUTC);

        if (availableSlots && availableSlots.length > 0) {
            const filterStartUTC = nextAttemptStartDateUTC;
            const filterEndUTC = new Date(nextAttemptStartDateUTC.getTime() + 3 * 60 * 60 * 1000);
            const originalCount = availableSlots.length;
            availableSlots = availableSlots.filter(slot => {
                try {
                    const slotDateUTC = new Date(slot.datetime);
                    if (isNaN(slotDateUTC.getTime())) return false;
                    return slotDateUTC.getTime() >= filterStartUTC.getTime() && slotDateUTC.getTime() <= filterEndUTC.getTime();
                } catch (e) {
                    return false;
                }
            });
            console.log(`[AvailableSlotsOutbound - ${location_id}] Attempt 2: Filtered slots. Before: ${originalCount}, After: ${availableSlots.length}.`);
        }

        if (availableSlots && availableSlots.length > 0) {
            console.log(`[AvailableSlotsOutbound - ${location_id}] Attempt 2 SUCCESS: Found ${availableSlots.length} slots on the next working day.`);
            return reply.code(200).send({ status: "success", slots: availableSlots });
        } else if (availableSlots === null) {
            console.error(`[AvailableSlotsOutbound - ${location_id}] Attempt 2 FAILED (API/token error).`);
        } else {
            console.log(`[AvailableSlotsOutbound - ${location_id}] Attempt 2: No slots found.`);
        }

        console.log(`[AvailableSlotsOutbound - ${location_id}] FINAL: No available slots found after all checks.`);
        return reply.code(404).send({ status: "error", message: "No available slots were found for the requested time." });
    });

    // New endpoint for providing available slots for INBOUND calls.
    // This is simplified to just get the next available slots from today.
    fastify.get(`/availableSlotsInbound`, async (request, reply) => {
        const calendarId = GOHIGHLEVEL_CALENDAR_ID;
        const location_id = GOHIGHLEVEL_LOCATION_ID;

        console.log(`[AvailableSlotsInbound - ${location_id}] Received request for calendar '${calendarId}'.`);

        // Helper function to fetch slots for a given day
        const fetchSlotsForDay = async (date) => {
            const startDate = new Date(date);
            startDate.setUTCHours(0, 0, 0, 0);
            const endDate = new Date(startDate);
            endDate.setDate(startDate.getDate() + 1);

            const startDateISO = startDate.toISOString();
            const endDateISO = endDate.toISOString();

            console.log(`[AvailableSlotsInbound - ${location_id}] Fetching slots for window: ${startDateISO} to ${endDateISO}`);
            const slots = await fetchGHLCalendarSlots(location_id, calendarId, startDateISO, endDateISO);
            return slots;
        };

        let availableSlots = [];
        let searchDate = new Date(); // Start from today in UTC
        const now = new Date();

        // Search for the first day with available slots within the next 7 days
        for (let i = 0; i < 7; i++) {
            const slotsForDay = await fetchSlotsForDay(searchDate);

            if (slotsForDay && slotsForDay.length > 0) {
                // Filter out slots that are in the past
                const futureSlots = slotsForDay.filter(slot => new Date(slot.datetime) > now);
                if (futureSlots.length > 0) {
                    availableSlots = futureSlots;
                    console.log(`[AvailableSlotsInbound - ${location_id}] Found ${availableSlots.length} future slots for ${searchDate.toISOString().split('T')[0]}. Stopping search.`);
                    break; // Found the first day with slots, so we stop.
                }
            }
            // If no slots found, advance to the next day
            searchDate.setDate(searchDate.getDate() + 1);
        }

        if (availableSlots.length === 0) {
            console.warn(`[AvailableSlotsInbound - ${location_id}] No available slots found in the next 7 days.`);
            return reply.send({
                status: "success",
                count: 0,
                formattedString: "Nessuno slot disponibile nell'intervallo richiesto.",
                slots: []
            });
        }

        // Group slots by day and format them
        const groupedByDay = availableSlots.reduce((acc, slot) => {
            try {
                const date = new Date(slot.datetime);
                const day = new Intl.DateTimeFormat('it-IT', {
                    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: ITALIAN_TIMEZONE
                }).format(date);
                if (!acc[day]) {
                    acc[day] = [];
                }
                acc[day].push(date);
                return acc;
            } catch (e) {
                console.error(`[AvailableSlotsInbound - ${location_id}] Error parsing slot datetime: ${slot.datetime}`, e);
                return acc;
            }
        }, {});

        // Sort times within each day
        for (const day in groupedByDay) {
            groupedByDay[day].sort((a, b) => a - b);
        }

        let formattedString = "Ecco gli slot disponibili:\n";
        for (const [day, times] of Object.entries(groupedByDay)) {
            const timeStrings = times.map(time =>
                new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: ITALIAN_TIMEZONE }).format(time)
            );
            formattedString += `- ${day}: ${timeStrings.join(', ')}\n`;
        }

        console.log(`[AvailableSlotsInbound - ${location_id}] Successfully formatted ${availableSlots.length} slots.`);
        
        reply.send({
            status: "success",
            count: availableSlots.length,
            formattedString,
            slots: availableSlots.map(slot => slot.datetime)
        });
    });

    // Endpoint to book an appointment (handles both inbound and outbound)
    fastify.post(`/bookAppointment`, async (request, reply) => {
        const { appointmentDate, contactId, callType, full_name, address } = request.body;
        
        // Use contactId or contact_id for backward compatibility
        const effectiveContactId = contactId || request.body.contact_id;
        
        const calendarId = GOHIGHLEVEL_CALENDAR_ID;
        const location_id = GOHIGHLEVEL_LOCATION_ID;

        console.log(`[BookAppointment - ${location_id}] Received request. DateTimeString: '${appointmentDate}', ContactID: '${effectiveContactId}', CallType: '${callType || 'unknown'}', Full Name: '${full_name || 'not provided'}', Address: '${address || 'not provided'}'`);

        // First, check if this contact already has a future booking in our local lock table
        let localDbCheck;
        try {
                            localDbCheck = await openDataDb();
            const nowUTCForCheck = new Date().toISOString();
            const existingFutureBooking = await getDbRecord(localDbCheck,
                `SELECT slot_utc_iso 
                 FROM active_bookings_lock 
                 WHERE contact_id = ? AND status = 'booked' AND slot_utc_iso > ? 
                 ORDER BY slot_utc_iso ASC LIMIT 1`,
                [effectiveContactId, nowUTCForCheck]
            );
            if (existingFutureBooking && existingFutureBooking.slot_utc_iso) {
                console.warn(`[BookAppointment - ${location_id}] Contact ${effectiveContactId} already has a future booked appointment in local lock table at ${existingFutureBooking.slot_utc_iso}.`);
                // Convert UTC ISO to a more human-readable Italian format for the AI/user
                let italianDateTimeStr = "data/ora sconosciuta";
                try {
                    const dateObj = new Date(existingFutureBooking.slot_utc_iso);
                    italianDateTimeStr = dateObj.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Rome' }) + " alle " +
                                       dateObj.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
                } catch (formatError) {
                    console.error("[BookAppointment] Error formatting existing booking time for response: " + formatError.message);
                }
                return reply.code(409).send({
                    status: "error",
                    message: `Il contatto ha già un appuntamento futuro registrato nel sistema per il giorno ${italianDateTimeStr}. Impossibile prenotare un altro appuntamento.`,
                    code: "EXISTING_APPOINTMENT_LOCAL",
                    existingAppointmentTimeUTC: existingFutureBooking.slot_utc_iso,
                    existingAppointmentTimeItalian: italianDateTimeStr
                });
            }
        } catch (dbError) {
            console.error(`[BookAppointment - ${location_id}] Database error during pre-check for existing bookings: ${dbError.message}`, dbError);
            // Proceed with booking attempt if pre-check fails, GHL will be the ultimate decider
        } finally {
            if (localDbCheck) await closeDataDb(localDbCheck);
        }

        // Validate required parameters based on call type
        if (!appointmentDate || !effectiveContactId) {
            console.warn(`[BookAppointment - ${location_id}] Missing required body parameters.`);
            return reply.code(400).send({
                status: "error",
                message: "Missing required body parameters. Please provide: appointmentDate and contactId (or contact_id)."
            });
        }

        // For inbound calls, validate additional required fields
        if (callType === "inbound" && typeof address === 'undefined') {
            console.warn(`[BookAppointment - ${location_id}] Missing required parameters for inbound booking. Address is required.`);
            return reply.code(400).send({
                status: "error",
                message: "Missing required parameters for inbound booking. Please provide: address. Full_name is also recommended for updates."
            });
        }

        // Handle contact updates for inbound calls
        let contactFullNameForNotification = full_name; // Use provided full_name for notification
        
        if (callType === "inbound") {
            // Prepare data for updating the contact
            const contactUpdatePayload = {};
            if (full_name) contactUpdatePayload.fullName = full_name;
            if (typeof address !== 'undefined') contactUpdatePayload.indirizzo = address;

            // Update the contact with new details if any are provided
            if (Object.keys(contactUpdatePayload).length > 0) {
                console.log(`[BookAppointment - ${location_id}] Attempting to update contact ${effectiveContactId} with payload:`, contactUpdatePayload);
                const updateResult = await updateGHLContact(location_id, effectiveContactId, contactUpdatePayload);
                if (!updateResult.success) {
                    // Log warning but proceed with booking, as contact update failure might not be critical for booking itself
                    console.warn(`[BookAppointment - ${location_id}] Failed to update contact ${effectiveContactId} details. Error: ${updateResult.error}. Details: ${JSON.stringify(updateResult.details)}. Proceeding with booking.`);
                } else {
                    console.log(`[BookAppointment - ${location_id}] Successfully updated details for contact ${effectiveContactId} or no update was needed.`);
                }
            } else {
                console.log(`[BookAppointment - ${location_id}] No new details provided to update for contact ${effectiveContactId}.`);
            }

            // Fetch full name for notification if it wasn't in the request but contactId was
            if (!contactFullNameForNotification && effectiveContactId) {
                console.log(`[BookAppointment - ${location_id}] Fetching details for contact ${effectiveContactId} to get full name for notification.`);
                const contactDetails = await getGHLContactDetails(location_id, effectiveContactId);
                if (contactDetails && contactDetails.fullName) {
                    contactFullNameForNotification = contactDetails.fullName;
                } else {
                    console.warn(`[BookAppointment - ${location_id}] Could not fetch full name for contact ${effectiveContactId}. Notification might use a generic name or the ID.`);
                    contactFullNameForNotification = `Contact ${effectiveContactId}`; // Fallback
                }
            }
        }

        const dateTimeParts = appointmentDate.split(' ');
        if (dateTimeParts.length !== 2) {
            console.warn(`[BookAppointment - ${location_id}] Invalid appointmentDate format: '${appointmentDate}'. Expected 'DD-MM-YYYY HH:mm' or 'YYYY-MM-DD HH:mm'.`);
            return reply.code(400).send({ status: "error", message: "Invalid appointmentDate format. Expected 'DD-MM-YYYY HH:mm' or 'YYYY-MM-DD HH:mm'." });
        }
        
        let dateStrInput = dateTimeParts[0];
        const timeStr = dateTimeParts[1];
        let formattedDateStr; // This will hold DD-MM-YYYY

        // Validate time format first
        if (!/^\d{2}:\d{2}$/.test(timeStr)) {
            console.warn(`[BookAppointment - ${location_id}] Invalid time format in appointmentDate: Time='${timeStr}'. Expected 'HH:mm'.`);
            return reply.code(400).send({ status: "error", message: "Invalid time format within appointmentDate. Expected 'HH:mm'." });
        }

        // Check for YYYY-MM-DD format
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateStrInput)) {
            console.log(`[BookAppointment - ${location_id}] Detected YYYY-MM-DD format: '${dateStrInput}'. Converting to DD-MM-YYYY.`);
            const parts = dateStrInput.split('-');
            formattedDateStr = `${parts[2]}-${parts[1]}-${parts[0]}`; // Convert YYYY-MM-DD to DD-MM-YYYY
        // Check for DD-MM-YYYY format
        } else if (/^\d{2}-\d{2}-\d{4}$/.test(dateStrInput)) {
            formattedDateStr = dateStrInput;
        } else {
            console.warn(`[BookAppointment - ${location_id}] Invalid date format in appointmentDate: Date='${dateStrInput}'. Expected 'DD-MM-YYYY' or 'YYYY-MM-DD'.`);
            return reply.code(400).send({ status: "error", message: "Invalid date format. Expected 'DD-MM-YYYY' or 'YYYY-MM-DD'." });
        }

        console.log(`[BookAppointment - ${location_id}] Using date for UTC conversion (DD-MM-YYYY): '${formattedDateStr}', Time: '${timeStr}'.`);

        let targetSlotStartUTC;
        try {
            console.log(`[BookAppointment - ${location_id}] Attempting to parse Italian local time for booking: Date='${formattedDateStr}', Time='${timeStr}' to UTC.`);
            targetSlotStartUTC = italianLocalToUTC(formattedDateStr, timeStr); // Use the always DD-MM-YYYY formatted date
            if (isNaN(targetSlotStartUTC.getTime())) {
                throw new Error("Parsed targetSlotStartUTC is Invalid Date.");
            }
            console.log(`[BookAppointment - ${location_id}] Successfully parsed target booking time to UTC Date: ${targetSlotStartUTC.toISOString()}`);
        } catch (e) {
            console.error(`[BookAppointment - ${location_id}] Error parsing appointmentDate '${appointmentDate}' (formatted as '${formattedDateStr} ${timeStr}') into UTC Date: ${e.message}`, e);
            return reply.code(400).send({ status: "error", message: `Invalid appointmentDate. Could not parse to UTC. Details: ${e.message}` });
        }

        // --- Booking Lock Logic ---
        const slot_utc_iso = targetSlotStartUTC.toISOString();
        const lock_id = `${location_id}_${calendarId}_${effectiveContactId}_${slot_utc_iso}`;
        const lock_duration_ms = 5 * 60 * 1000; // 5 minutes lock
        const new_expires_at_iso = new Date(Date.now() + lock_duration_ms).toISOString();
        let db;
        let acquired_lock = false;

        try {
            db = await openDataDb();
            acquired_lock = false; // Reset/ensure it's false initially

            try {
                // Attempt to insert the lock directly
                await runData(db,
                    `INSERT INTO active_bookings_lock (lock_id, contact_id, calendar_id, location_id, slot_utc_iso, status, expires_at)
                     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
                    [lock_id, effectiveContactId, calendarId, location_id, slot_utc_iso, new_expires_at_iso]
                );
                acquired_lock = true;
                console.log(`[BookAppointment - ${location_id}] Lock acquired via INSERT: ${lock_id}`);
            } catch (insertError) {
                if (insertError.message && insertError.message.toLowerCase().includes("unique constraint failed")) {
                    console.warn(`[BookAppointment - ${location_id}] Lock ${lock_id} INSERT failed (UNIQUE). Checking existing lock.`);
                    const existing_lock = await getDbRecord(db,
                        `SELECT lock_id, contact_id as existing_contact_id, status, expires_at FROM active_bookings_lock WHERE lock_id = ?`,
                        [lock_id]
                    );

                    if (existing_lock) {
                        const now_iso_check = new Date().toISOString();
                        if (existing_lock.expires_at < now_iso_check) {
                            // Lock is expired. Attempt to take it over atomically.
                            console.log(`[BookAppointment - ${location_id}] Existing lock ${lock_id} expired (at ${existing_lock.expires_at}). Attempting to take over.`);
                            const takeoverResult = await runData(db,
                                `UPDATE active_bookings_lock
                                 SET contact_id = ?, status = 'pending', expires_at = ?
                                 WHERE lock_id = ? AND expires_at = ?`, // Match exact expires_at for optimistic lock
                                [effectiveContactId, new_expires_at_iso, lock_id, existing_lock.expires_at]
                            );
                            if (takeoverResult.changes > 0) {
                                acquired_lock = true;
                                console.log(`[BookAppointment - ${location_id}] Lock ${lock_id} re-acquired via UPDATE (took over expired).`);
                            } else {
                                console.warn(`[BookAppointment - ${location_id}] Failed to take over expired lock ${lock_id} (already updated/deleted by another process). Checking current state.`);
                                const current_state_after_failed_takeover = await getDbRecord(db, `SELECT status, expires_at FROM active_bookings_lock WHERE lock_id = ?`, [lock_id]);
                                if (current_state_after_failed_takeover && 
                                    current_state_after_failed_takeover.expires_at >= now_iso_check && 
                                    (current_state_after_failed_takeover.status === 'pending' || current_state_after_failed_takeover.status === 'booked')) {
                                     return reply.code(200).send({
                                        status: "success", 
                                        message: "Appointment slot is currently being processed or has just been booked by another request.",
                                    });
                                }
                                // If still no lock or state is not 'pending'/'booked' and valid, then it's a conflict.
                                return reply.code(409).send({ status: "error", message: "Booking slot conflict or lock contention after attempting to claim an expired lock. Please try a different slot or try again shortly." });
                            }
                        } else {
                            // Lock is not expired, held by someone else
                            console.warn(`[BookAppointment - ${location_id}] Lock ${lock_id} exists, is not expired (expires ${existing_lock.expires_at}), status ${existing_lock.status}. Current contact ${effectiveContactId}, lock owner ${existing_lock.existing_contact_id}.`);
                            if (existing_lock.status === 'pending') {
                                // CHANGED: Return 200 OK to prevent AI from thinking the slot is unavailable
                                return reply.code(200).send({
                                    status: "success",
                                    message: "Appointment booking is already in progress for this contact and slot, or has just been confirmed.",
                                });
                            } else if (existing_lock.status === 'booked') {
                                console.warn(`[BookAppointment - ${location_id}] Slot ${lock_id} was already successfully booked by this contact. Responding with 200 OK to duplicate request.`);
                                return reply.code(200).send({
                                    status: "success",
                                    message: "Appointment was already successfully booked for this contact and slot.",
                                });
                            } else { // e.g., 'failed_booking_attempt'
                                console.warn(`[BookAppointment - ${location_id}] Previous attempt for ${lock_id} had status: ${existing_lock.status}. Conflict detected.`);
                                return reply.code(409).send({ status: "error", message: "A previous booking attempt for this slot did not complete successfully or is conflicting. Please try again later or choose a different slot." });
                            }
                        }
                    } else {
                        // UNIQUE constraint failed, but SELECT found no lock. This is highly problematic.
                        console.error(`[BookAppointment - ${location_id}] Lock insert for ${lock_id} failed (UNIQUE constraint) but no existing lock found. Critical race condition or DB error: ${insertError.message}`);
                        // Fall through, acquired_lock is false.
                    }
                } else {
                    // Other, non-UNIQUE error during INSERT
                    console.error(`[BookAppointment - ${location_id}] Error inserting lock ${lock_id} (non-UNIQUE error): ${insertError.message}`);
                    // Fall through, acquired_lock is false.
                }
            } // Explicitly NO finally block here for the inner try. The main 'db' connection is handled by the outer try/finally.

            if (!acquired_lock) {
                console.error(`[BookAppointment - ${location_id}] Failed to acquire booking lock for contact ${effectiveContactId} and slot ${slot_utc_iso} after all attempts.`);
                sendNonFatalSlackNotification(
                    `Booking Lock Acquisition Failed (${callType || 'Unknown'})`,
                    `[BookAppointment - ${location_id}] Failed to acquire booking lock for contact ${effectiveContactId} and slot ${slot_utc_iso}.`,
                    {
                        location_id,
                        contactId: effectiveContactId,
                        slot_utc_iso,
                        lock_id, // lock_id was defined earlier in the function
                        callType: callType || 'unknown',
                        function: "/bookAppointment - Lock Acquisition"
                    }
                );
                return reply.code(500).send({ status: "error", message: "Failed to acquire booking lock. Please try again." });
            }

            // --- Proceed with GHL Booking if lock acquired ---
            console.log(`[BookAppointment - ${location_id}] Lock acquired for ${lock_id}. Attempting to book GHL appointment for ContactID: '${effectiveContactId}' at ${targetSlotStartUTC.toISOString()}`);
        
            const bookingResult = await bookGHLAppointment(location_id, calendarId, effectiveContactId, targetSlotStartUTC);

            if (bookingResult.success) {
                // DIAGNOSTIC LOG:
                console.log(`[BookAppointment - ${location_id}] DIAGNOSTIC: db.open before UPDATE active_bookings_lock: ${db.open}`);
                
                // Use the original 'db' connection
                await runData(db, "UPDATE active_bookings_lock SET status = 'booked' WHERE lock_id = ?", [lock_id]);
                console.log(`[BookAppointment - ${location_id}] Successfully booked GHL appointment for ${lock_id}. Lock status updated to 'booked'.`);
                
                // Removed tag logic here
                let callTypeForNotification;
                let contactDetailsForLater = null; // Store contact details for reuse
                // Determine call type with multiple detection methods
                if (callType === "inbound") {
                    callTypeForNotification = "inbound";
                } else if (callType === "outbound") {
                    callTypeForNotification = "outbound";
                } else {
                    // Try to detect call type from other indicators
                    try {
                        contactDetailsForLater = await getGHLContactDetails(location_id, effectiveContactId);
                        // Removed tag-based detection
                        callTypeForNotification = "outbound";
                    } catch (detectionError) {
                        console.error(`[BookAppointment - ${location_id}] Error detecting call type from contact details: ${detectionError.message}`, detectionError);
                        callTypeForNotification = "outbound";
                    }
                }

                // Send Slack notification for successful booking
                try {
                    // Get contact details for the notification (reuse if already fetched or use inbound contact name)
                    let fullNameForNotification;
                    if (callType === "inbound" && contactFullNameForNotification) {
                        fullNameForNotification = contactFullNameForNotification;
                    } else {
                        const contactDetailsForNotification = contactDetailsForLater || await getGHLContactDetails(location_id, effectiveContactId);
                        fullNameForNotification = contactDetailsForNotification?.fullName || `Contact ${effectiveContactId}`;
                    }
                    
                    await sendSlackBookingNotification(effectiveContactId, fullNameForNotification, callTypeForNotification);
                    console.log(`[BookAppointment - ${location_id}] Slack booking notification sent for contact ${effectiveContactId}.`);
                } catch (slackError) {
                    console.error(`[BookAppointment - ${location_id}] Failed to send Slack booking notification: ${slackError.message}`, slackError);
                    // Don't fail the booking if Slack notification fails
                }

                console.log(`[BookAppointment - ${location_id}] About to send 201 success for lock_id ${lock_id}, contactId ${effectiveContactId}.`); // Enhanced log
                return reply.code(201).send({ status: "success", message: "Appointment booked successfully.", data: bookingResult.data });
            } else {
                // GHL Booking failed
                // Use the original 'db' connection
                await runData(db, "DELETE FROM active_bookings_lock WHERE lock_id = ?", [lock_id]);
                console.log(`[BookAppointment - ${location_id}] GHL booking failed for ${lock_id}. Lock record deleted.`);
                // Original console.error for GHL booking failure - keep for context, but actual DB update is now separate
                console.error(`[BookAppointment - ${location_id}] GHL booking failed for ${lock_id}. Original Reason: ${bookingResult.error}`, bookingResult.details || '');
                
                sendNonFatalSlackNotification(
                    `GHL ${callType || 'Unknown'} Booking Failed`,
                    `[BookAppointment - ${location_id}] Failed to book GHL appointment for contact ${effectiveContactId} for slot ${targetSlotStartUTC.toISOString()}. Reason: ${bookingResult.error}`,
                    { 
                        location_id, 
                        contactId: effectiveContactId, 
                        slot_utc_iso: targetSlotStartUTC.toISOString(),
                        ghlError: bookingResult.error,
                        ghlDetails: bookingResult.details,
                        lock_id,
                        callType: callType || 'unknown',
                        function: "/bookAppointment - GHL Booking Failure"
                    }
                );

                // Booking failed, try to find alternative slots
                console.log(`[BookAppointment - ${location_id}] Booking failed. Finding alternatives. Original request was for ${targetSlotStartUTC.toISOString()}`);

                const findAndFormatAlternativesForTwoDays = async (originalFailedSlotUTC) => {
                    const searchStartBaseUTC = new Date(originalFailedSlotUTC);
                    searchStartBaseUTC.setUTCHours(0, 0, 0, 0); // Start of the day of the failed slot

                    const searchWindowEndUTC = new Date(searchStartBaseUTC);
                    searchWindowEndUTC.setUTCDate(searchStartBaseUTC.getUTCDate() + 7); // 7 days from the start of the failed slot's day

                    const searchStartDateISO = searchStartBaseUTC.toISOString();
                    const searchEndDateISO = searchWindowEndUTC.toISOString();

                    console.log(`[BookAppointment Alt - ${location_id}] Fetching GHL slots for 7-day window starting from failed slot's day: ${searchStartDateISO} to ${searchEndDateISO}`);
                    const rawSlots = await fetchGHLCalendarSlots(location_id, calendarId, searchStartDateISO, searchEndDateISO);

                    if (rawSlots === null) {
                        console.error(`[BookAppointment Alt - ${location_id}] Failed to fetch GHL slots (API/token error) for 7-day window.`);
                        return [];
                    }
                    if (!Array.isArray(rawSlots) || rawSlots.length === 0) {
                        console.log(`[BookAppointment Alt - ${location_id}] No raw slots found in the 7-day window.`);
                        return [];
                    }

                    console.log(`[BookAppointment Alt - ${location_id}] Received ${rawSlots.length} raw slots. Filtering for slots >= ${originalFailedSlotUTC.toISOString()} and grouping for first two available days.`);
                    
                    // Normalize slots to handle both string and object formats
                    const normalizedSlots = rawSlots.map(slot => {
                        if (typeof slot === 'string') {
                            return slot;
                        }
                        return slot.datetime || slot;
                    });

                    const allSlotDates = normalizedSlots
                        .map(iso => new Date(iso))
                        .filter(date => !isNaN(date.getTime()) && date.getTime() >= originalFailedSlotUTC.getTime()); // Filter out past slots relative to failed attempt

                    allSlotDates.sort((a, b) => a - b); // Sort chronologically

                    if (allSlotDates.length === 0) {
                        console.log(`[BookAppointment Alt - ${location_id}] No valid future slots found after initial filter.`);
                        return [];
                    }

                    const slotsByUTCDate = {};
                    allSlotDates.forEach(slotDate => {
                        const dateKey = slotDate.toISOString().split('T')[0]; // YYYY-MM-DD UTC
                        if (!slotsByUTCDate[dateKey]) {
                            slotsByUTCDate[dateKey] = [];
                        }
                        slotsByUTCDate[dateKey].push(slotDate);
                    });

                    const availableUTCDates = Object.keys(slotsByUTCDate).sort();
                    const resultSlots = [];

                    if (availableUTCDates.length > 0) {
                        const firstDaySlots = slotsByUTCDate[availableUTCDates[0]];
                        resultSlots.push(...firstDaySlots);
                        console.log(`[BookAppointment Alt - ${location_id}] Added ${firstDaySlots.length} slots from the first available day: ${availableUTCDates[0]}`);

                        if (availableUTCDates.length > 1) {
                            const secondDaySlots = slotsByUTCDate[availableUTCDates[1]];
                            resultSlots.push(...secondDaySlots);
                            console.log(`[BookAppointment Alt - ${location_id}] Added ${secondDaySlots.length} slots from the second available day: ${availableUTCDates[1]}`);
                        }
                    }
                    
                    console.log(`[BookAppointment Alt - ${location_id}] Total ${resultSlots.length} alternative slots collected from first two available days.`);
                    return resultSlots.map(date => ({ datetime: date.toISOString() }));
                };

                const alternatives = await findAndFormatAlternativesForTwoDays(targetSlotStartUTC);

                if (alternatives.length > 0) {
                    console.log(`[BookAppointment - ${location_id}] Found ${alternatives.length} alternative slots.`);
                    
                    // Format alternatives differently for inbound vs outbound
                    let formattedAlternatives;
                    if (callType === "inbound") {
                        // For inbound calls, format as Italian datetime strings (DD-MM-YYYY HH:mm)
                        formattedAlternatives = alternatives.map(slot => {
                            try {
                                const d = new Date(slot.datetime);
                                const datePart = d.toLocaleDateString('it-IT', { 
                                    day: '2-digit', 
                                    month: '2-digit', 
                                    year: 'numeric', 
                                    timeZone: ITALIAN_TIMEZONE 
                                }).replace(/\//g, '-');
                                const timePart = d.toLocaleTimeString('it-IT', { 
                                    hour: '2-digit', 
                                    minute: '2-digit', 
                                    timeZone: ITALIAN_TIMEZONE 
                                });
                                return `${datePart} ${timePart}`;
                            } catch (e) {
                                console.warn(`[BookAppointment - ${location_id}] Error formatting alternative slot ${slot.datetime}: ${e.message}`);
                                return null;
                            }
                        }).filter(Boolean);
                    } else {
                        // For outbound calls, keep the original format with datetime and userId
                        formattedAlternatives = alternatives;
                    }
                    
                    return reply.code(200).send({ 
                        status: "booking_failed_alternatives_available", 
                        message: "Booking failed. Alternative slots from the first two available days (starting from your original request day, within a 7-day window) are provided.", 
                        slots: formattedAlternatives, 
                        originalBookingError: bookingResult 
                    });
                }

                console.log(`[BookAppointment - ${location_id}] No alternative slots found after all attempts.`);
                return reply.code(409).send({ status: "booking_failed_no_alternatives", message: "Booking failed and no alternative slots were found within the first two available days of a 7-day search period starting from your original request day.", originalBookingError: bookingResult });
            }
        } catch (error) {
            console.error(`[BookAppointment - ${location_id}] Critical error during booking process for contact ${effectiveContactId}: ${error.message}`, error);
            sendNonFatalSlackNotification(
                "/bookAppointment Critical Error",
                `[BookAppointment - ${location_id}] Critical error during booking process for contact ${effectiveContactId}. Error: ${error.message}`,
                { 
                    location_id, 
                    contactId: effectiveContactId, 
                    appointmentDateRequest: request.body?.appointmentDate, 
                    requestBody: request.body, 
                    error: error.stack, 
                    callType: callType || 'unknown',
                    function: "/bookAppointment route" 
                }
            );
            // If a lock was potentially acquired but an error occurred before status update, it might remain 'pending' until expiry.
            // This is handled by the lock expiry logic on subsequent attempts.
            return reply.code(500).send({ status: "error", message: "An unexpected server error occurred during booking." });
        } finally {
            if (db) { // This is the main finally block for the route
                await closeDataDb(db);
                console.log(`[BookAppointment - ${location_id}] Main database connection closed for request concerning lock_id: ${lock_id}.`);
            }
        }
    });
} 