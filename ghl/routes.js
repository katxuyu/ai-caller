import { saveGoHighlevelTokens } from './tokens.js';
import { addContactToWorkflow } from './api.js';
import { sendNonFatalSlackNotification, sendPositiveSlackNotification } from '../slack/notifications.js';
import { 
    GOHIGHLEVEL_CLIENT_ID, 
    GOHIGHLEVEL_CLIENT_SECRET, 
    GOHIGHLEVEL_REDIRECT_URI,
    GOHIGHLEVEL_AUTH_URL,
    GOHIGHLEVEL_TOKEN_URL,
    GOHIGHLEVEL_API_SCOPES,
    GOHIGHLEVEL_LOCATION_ID,
    PURCHASE_WORKFLOW_ID
} from '../config.js';

export function registerGhlRoutes(fastify) {
    // GoHighLevel OAuth route
    fastify.get(`/gohighlevel/auth`, async (request, reply) => {
        if (!GOHIGHLEVEL_CLIENT_ID || !GOHIGHLEVEL_REDIRECT_URI) {
            return reply.code(500).send({ status: "error", message: "OAuth configuration incomplete" });
        }

        const authUrl = new URL(GOHIGHLEVEL_AUTH_URL);
        authUrl.searchParams.append('response_type', 'code');
        authUrl.searchParams.append('redirect_uri', GOHIGHLEVEL_REDIRECT_URI);
        authUrl.searchParams.append('client_id', GOHIGHLEVEL_CLIENT_ID);
        authUrl.searchParams.append('scope', GOHIGHLEVEL_API_SCOPES);

        return reply.redirect(authUrl.toString());
    });

    // GoHighLevel Callback Route
    fastify.get(`/hl/callback`, async (request, reply) => {
        const authCode = request.query.code;
        const locationIdFromCallback = request.query.location_id;

        if (!authCode) {
            return reply.code(400).send({ status: "error", message: "OAuth failed: No code provided" });
        }

        if (!GOHIGHLEVEL_CLIENT_ID || !GOHIGHLEVEL_CLIENT_SECRET || !GOHIGHLEVEL_REDIRECT_URI) {
            return reply.code(500).send({ status: "error", message: "OAuth configuration incomplete" });
        }

        const tokenPayload = new URLSearchParams({
            client_id: GOHIGHLEVEL_CLIENT_ID,
            client_secret: GOHIGHLEVEL_CLIENT_SECRET,
            grant_type: "authorization_code",
            code: authCode,
            redirect_uri: GOHIGHLEVEL_REDIRECT_URI,
            user_type: "Location"
        });

        try {
            const response = await fetch(GOHIGHLEVEL_TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: tokenPayload
            });

            if (!response.ok) {
                const errorText = await response.text();
                return reply.code(response.status).send({ status: "error", message: `Failed to obtain tokens: ${errorText}` });
            }

            const responseText = await response.text();
            const tokenData = JSON.parse(responseText);

            if (tokenData.access_token && tokenData.refresh_token) {
                const locationId = locationIdFromCallback || tokenData.locationId || GOHIGHLEVEL_LOCATION_ID;
                
                await saveGoHighlevelTokens(
                    locationId,
                    tokenData.access_token,
                    tokenData.refresh_token,
                    tokenData.expires_in
                );

                return reply.send({ status: "success", message: "OAuth completed successfully", locationId });
            } else {
                return reply.code(400).send({ status: "error", message: "Invalid token response from GoHighLevel" });
            }
        } catch (e) {
            console.error("Error during GoHighLevel token exchange:", e.message);
            await sendNonFatalSlackNotification(
                'GHL OAuth: Token Exchange Failed',
                `Critical error during GoHighLevel OAuth token exchange. Integration may be broken.`,
                {
                    error: e.message,
                    stack: e.stack,
                    authCode: authCode ? 'present' : 'missing',
                    locationId: locationIdFromCallback
                }
            ).catch(console.error);
            return reply.code(500).send({ status: "error", message: `Internal server error: ${e.message}` });
        }
    });



    // AI Caller LLM endpoint to add contact to any workflow
    fastify.post(`/addContactToWorkflow`, async (request, reply) => {
        const { contactId, workflowId, eventData } = request.body;

        console.log(`[AddContactToWorkflow] Received request for contactId: ${contactId}, workflowId: ${workflowId}`);

        if (!contactId) {
            return reply.code(400).send({
                status: "error",
                message: "Missing required field: contactId"
            });
        }

        if (!workflowId) {
            return reply.code(400).send({
                status: "error",
                message: "Missing required field: workflowId"
            });
        }

        try {
            console.log(`[AddContactToWorkflow] Adding contact ${contactId} to workflow ${workflowId}`);
            
            const workflowResult = await addContactToWorkflow(
                GOHIGHLEVEL_LOCATION_ID, 
                workflowId, 
                contactId,
                eventData || {}
            );

            if (workflowResult.success) {
                console.log(`[AddContactToWorkflow] Successfully added contact ${contactId} to workflow ${workflowId}`);
                
                return reply.code(200).send({
                    status: "success",
                    message: "Contact added to workflow successfully",
                    data: { 
                        contactId, 
                        workflowId,
                        workflowTriggered: true 
                    }
                });
            } else {
                console.error(`[AddContactToWorkflow] Failed to add contact to workflow: ${workflowResult.error}`);
                
                await sendNonFatalSlackNotification(
                    "Add Contact to Workflow Failed",
                    `Failed to add contact ${contactId} to workflow ${workflowId}. Error: ${workflowResult.error}`,
                    { contactId, workflowId, error: workflowResult.error, eventData }
                ).catch(console.error);

                return reply.code(500).send({
                    status: "error",
                    message: "Failed to add contact to workflow",
                    details: workflowResult.error
                });
            }
        } catch (error) {
            console.error(`[AddContactToWorkflow] Exception during workflow trigger:`, error);
            await sendNonFatalSlackNotification(
                'GHL Routes: Add Contact to Workflow Exception',
                `Exception occurred while adding contact ${contactId} to workflow ${workflowId}.`,
                {
                    contactId,
                    workflowId,
                    eventData,
                    error: error.message,
                    stack: error.stack
                }
            ).catch(console.error);
            return reply.code(500).send({
                status: "error",
                message: "Internal server error during workflow processing"
            });
        }
    });
} 

