import { saveGoHighlevelTokens } from './tokens.js';
import { triggerPurchaseWorkflow } from './api.js';
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

    // Simple purchase trigger endpoint
    fastify.post(`/triggerPurchase`, async (request, reply) => {
        const { contactId, mattressId } = request.body;

        console.log(`[TriggerPurchase] Received request for contactId: ${contactId}`);

        if (!contactId) {
            return reply.code(400).send({
                status: "error",
                message: "Missing required field: contactId"
            });
        }

        if (!PURCHASE_WORKFLOW_ID) {
            console.error(`[TriggerPurchase] PURCHASE_WORKFLOW_ID not configured.`);
            return reply.code(500).send({
                status: "error", 
                message: "Purchase workflow not configured"
            });
        }

        if (!mattressId) {
            console.error(`[TriggerPurchase] Mattress ID not provided.`);
            return reply.code(400).send({
                status: "error",
                message: "Mattress ID not provided"
            });
        }

        try {
            console.log(`[TriggerPurchase] Triggering purchase workflow for contact ${contactId}`);
            
            const workflowResult = await triggerPurchaseWorkflow(
                GOHIGHLEVEL_LOCATION_ID, 
                PURCHASE_WORKFLOW_ID, 
                contactId,
                mattressId
            );

            if (workflowResult.success) {
                console.log(`[TriggerPurchase] Successfully triggered purchase workflow for contact ${contactId}`);
                
                sendPositiveSlackNotification(
                    "Payment Link Sent - Customer Purchase!",
                    `🎉 Customer wants to buy! Purchase workflow triggered successfully for contact ${contactId}. Payment link should be sent automatically by GoHighLevel.`,
                    { 
                        contactId, 
                        workflowId: PURCHASE_WORKFLOW_ID,
                        mattressId,
                        timestamp: new Date().toISOString()
                    }
                ).catch(console.error);

                return reply.code(200).send({
                    status: "success",
                    message: "Purchase workflow triggered successfully",
                    data: { contactId, workflowTriggered: true }
                });
            } else {
                console.error(`[TriggerPurchase] Failed to trigger purchase workflow: ${workflowResult.error}`);
                
                sendNonFatalSlackNotification(
                    "Purchase Workflow Failed",
                    `Failed to trigger purchase workflow for contact ${contactId}. Error: ${workflowResult.error}`,
                    { contactId, error: workflowResult.error, workflowId: PURCHASE_WORKFLOW_ID }
                ).catch(console.error);

                return reply.code(500).send({
                    status: "error",
                    message: "Failed to trigger purchase workflow",
                    details: workflowResult.error
                });
            }
        } catch (error) {
            console.error(`[TriggerPurchase] Exception during workflow trigger:`, error);
            await sendNonFatalSlackNotification(
                'GHL Routes: Purchase Trigger Exception',
                `Exception occurred during purchase workflow trigger for contact ${contactId}. Customer purchase may be lost.`,
                {
                    contactId,
                    error: error.message,
                    stack: error.stack,
                    workflowId: PURCHASE_WORKFLOW_ID
                }
            ).catch(console.error);
            return reply.code(500).send({
                status: "error",
                message: "Internal server error during purchase processing"
            });
        }
    });
} 

