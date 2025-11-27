import { saveFollowUp } from './manager.js';
import { parseItalianDateTimeToUTC } from '../utils.js';
import { sendNonFatalSlackNotification } from '../slack/notifications.js';

export function registerFollowUpRoutes(fastify) {

    // Route to schedule a follow-up call
    fastify.post('/followup', async (request, reply) => {
        const { contactId, followUpDateTime } = request.body;
        console.log(`[FollowUp Route] Received request: contactId=${contactId}, followUpDateTime=${followUpDateTime}`);

        if (!contactId || !followUpDateTime) {
            return reply.code(400).send({ status: "error", message: "Missing required parameters: contactId and followUpDateTime" });
        }

        // Parse the Italian datetime string to UTC
        const followUpAtUTC = parseItalianDateTimeToUTC(followUpDateTime);
        if (!followUpAtUTC) {
            return reply.code(400).send({ status: "error", message: "Invalid followUpDateTime format. Expected 'DD-MM-YYYY HH:mm'" });
        }

        // Validate if the parsed date is in the future
        if (followUpAtUTC <= new Date()) {
             return reply.code(400).send({ status: "error", message: "Follow-up date must be in the future." });
        }
       
        try {
            await saveFollowUp(contactId, followUpAtUTC.toISOString());
            const successMessage = `Follow-up scheduled for contact ${contactId} at ${followUpDateTime} (UTC: ${followUpAtUTC.toISOString()})`;
            console.log(`[FollowUp Route] ${successMessage}`);
            return reply.code(201).send({ status: "success", message: successMessage });
        } catch (error) {
            console.error(`[FollowUp Route] Error in /followup endpoint:`, error);
            // Notify Slack about the error
            sendNonFatalSlackNotification(
                'FollowUp Route Error',
                `Error in /followup endpoint for contactId: ${contactId}`,
                error.message
            ).catch(console.error);
            return reply.code(500).send({ status: "error", message: "Failed to schedule follow-up." });
        }
    });
} 