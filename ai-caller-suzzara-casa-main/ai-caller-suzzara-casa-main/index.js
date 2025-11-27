import { config } from 'dotenv';
config();

import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody'; // For parsing x-www-form-urlencoded
import fastifyWs from '@fastify/websocket'; // For WebSocket support (if needed)
import fastifyCors from '@fastify/cors'; // Import CORS

// Core Modules
import { initializeDataDatabase } from './dataDb.js';
import { initializeTokenDatabase } from './tokenDb.js';
import { sendSlackNotification } from './slack/notifications.js'; // For global error handling
import { startFollowUpProcessor } from './followup/manager.js';
import { startBookingLockCleanup } from './bookingLock.js';
import { startQueueProcessor } from './queue-processor.js';

// Route Modules
import { registerGhlRoutes } from './ghl/routes.js';
import { registerFollowUpRoutes } from './followup/routes.js';
import { registerElevenLabsRoutes } from './elevenlabs/routes.js';

import { OutgoingCall } from './outgoing-call.js';


// --- Environment Variable Checks (Keep essential ones) ---
const requiredEnvVars = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'GOHIGHLEVEL_CLIENT_ID',
    'GOHIGHLEVEL_CLIENT_SECRET',
    'GOHIGHLEVEL_REDIRECT_URI',
    'GOHIGHLEVEL_LOCATION_ID',
    'GOHIGHLEVEL_CALENDAR_ID',
    'SLACK_WEBHOOK_URL',
    'ELEVENLABS_API_KEY',
    'INCOMING_ELEVENLABS_AGENT_ID',
    'OUTGOING_ELEVENLABS_AGENT_ID',
    'PUBLIC_URL',
    'INCOMING_ROUTE_PREFIX',
    'OUTGOING_ROUTE_PREFIX',
    'ELEVENLABS_WEBHOOK_SECRET'
];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
    console.error("FATAL ERROR: Missing required environment variables:", missingVars.join(', '));
    process.exit(1); // Exit if critical configurations are missing
}

// --- Fastify Setup ---
const fastify = Fastify({
});

// --- Middleware ---
fastify.register(fastifyFormBody); // For parsing x-www-form-urlencoded POST bodies
fastify.register(fastifyWs); // For WebSocket support

// Use fastify-cors
fastify.register(fastifyCors, {
    // Put your CORS options here
    // TODO: Restrict CORS origins in production
    // Example: allow all origins (use with caution in production)
    origin: true
});


// Initialize and register routes from call handlers
OutgoingCall(fastify); // Initialize outgoing call routes by calling the function

// Register routes from modules
registerGhlRoutes(fastify);
registerFollowUpRoutes(fastify);
registerElevenLabsRoutes(fastify);

// --- Health Check Route (Keep this simple) ---
fastify.get('/', async (request, reply) => {
    return { status: 'ok', message: 'Twilio App is running' };
});

// --- Global Error Handler (Keep this) ---
fastify.setErrorHandler(async (error, request, reply) => {
    fastify.log.error(error); // Log the full error

    // Send detailed error to Slack
    sendSlackNotification(error).catch(err => {
        fastify.log.error("Failed to send error notification to Slack:", err);
    });

    // Send a generic error response to the client
    reply.status(500).send({
        statusCode: 500,
        error: "Internal Server Error",
        message: "An unexpected error occurred. Please try again later."
    });
});


// --- Start the server (to be completed with module initializations) ---
const start = async () => {
    try {
        // 1. Initialize Databases first
        await Promise.all([
            initializeDataDatabase(),
            initializeTokenDatabase()
        ]);
        console.log("[Main] Databases initialized successfully.");

        // 2. Start background processors
        startFollowUpProcessor();
        startBookingLockCleanup();
        startQueueProcessor();
        console.log("[Main] Background processors started.");

        // 3. Start Fastify server
        const port = process.env.PORT || 3000;
        await fastify.listen({ port: port, host: '0.0.0.0' });
        fastify.log.info(`Server listening on port ${port} and accessible on all network interfaces.`);

    } catch (err) {
        console.error("--- DETAILED STARTUP ERROR ---"); // Add a marker
        console.error("Message:", err.message); // Log the error message directly
        console.error("Stack:", err.stack);     // Log the stack trace directly
        console.error("--- END DETAILED STARTUP ERROR ---");
        fastify.log.error("[Main] Error starting server or background tasks:", err);
        process.exit(1);
    }
};

// --- Run the server start function ---
start();