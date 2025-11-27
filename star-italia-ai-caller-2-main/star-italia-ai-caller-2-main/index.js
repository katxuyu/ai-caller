import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody'; // For parsing x-www-form-urlencoded
import fastifyWs from '@fastify/websocket'; // For WebSocket support (if needed)
import fastifyCors from '@fastify/cors'; // Import CORS

// Core Modules
import { initializeDatabase } from './db.js';
import { sendSlackNotification, sendNonFatalSlackNotification } from './slack/notifications.js';
import { startQueueProcessor } from './queue-processor.js';

// Route Modules
import { registerGhlRoutes } from './ghl/routes.js';

// Call Handlers (Import these before they are used)
import { IncomingCall } from './incoming-call.js';
import { OutgoingCall } from './outgoing-call.js';

// --- Simplified Environment Variable Checks ---
const requiredEnvVars = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN', 
    'OUTGOING_TWILIO_PHONE_NUMBER',
    'GOHIGHLEVEL_CLIENT_ID',
    'GOHIGHLEVEL_CLIENT_SECRET',
    'GOHIGHLEVEL_REDIRECT_URI',
    'GOHIGHLEVEL_LOCATION_ID',
    'PURCHASE_WORKFLOW_ID',
    'ELEVENLABS_API_KEY',
    'OUTGOING_ELEVENLABS_AGENT_ID',
    'PUBLIC_URL',
    'ELEVENLABS_WEBHOOK_SECRET'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
    console.error("❌ MISSING REQUIRED ENVIRONMENT VARIABLES:", missingVars.join(', '));
    console.error("📋 Please check your .env file and add the missing variables.");
    
    // Send critical notification about missing environment variables
    sendNonFatalSlackNotification(
        'Application Startup: Missing Environment Variables',
        `Application cannot start due to missing required environment variables: ${missingVars.join(', ')}`,
        { missingVars, critical: true }
    ).catch(console.error);
    
    process.exit(1);
}

console.log("✅ All required environment variables are present!");

// --- Fastify Setup ---
const fastify = Fastify({
    logger: true // Basic logging, adjust as needed
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
IncomingCall(fastify); // Initialize incoming call routes by calling the function

OutgoingCall(fastify); // Initialize outgoing call routes by calling the function

// Register routes from modules
registerGhlRoutes(fastify);


// --- Health Check Route (Keep this simple) ---
fastify.get('/', async (request, reply) => {
    return { 
        status: 'ok', 
        message: 'AI Caller - Simple Purchase Workflow is running! 🚀',
        endpoints: {
            trigger_call: 'POST /outgoing/outbound-call',
            trigger_purchase: 'POST /star-italia-2/triggerPurchase',
            ghl_auth: 'GET /star-italia-2/hl/auth'
        }
    };
});

// --- Global Error Handler (Keep this) ---
fastify.setErrorHandler(async (error, request, reply) => {
    fastify.log.error(error); // Log the full error

    // Send detailed error to Slack
    const errorMessage = `❌ Error in AI Caller: ${error.message}`;
    sendSlackNotification(errorMessage).catch(err => {
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
        // 1. Initialize Database first
        await initializeDatabase();
        console.log("📊 Database initialized successfully.");

        // 2. Start Fastify server
        const port = process.env.PORT || 3000;
        await fastify.listen({ port: port, host: '0.0.0.0' }); // Listen on all available network interfaces
        console.log(`🚀 AI Caller server running on port ${port}`);
        console.log(`🌐 Access at: http://localhost:${port}`);

        // 3. Start background processors AFTER server is listening
        startQueueProcessor();
        console.log("⚡ Background processors started.");
        
        console.log("\n🎉 READY FOR TESTING!");
        console.log("📞 To test: POST to /outgoing/outbound-call");
        console.log("💰 Purchase trigger: POST to /star-italia/triggerPurchase");

    } catch (err) {
        console.error("💥 STARTUP ERROR:");
        console.error("Message:", err.message);
        console.error("Stack:", err.stack);
        
        // Send critical startup failure notification
        sendNonFatalSlackNotification(
            'Application Startup: Critical Failure',
            `Application failed to start up. Immediate attention required.`,
            {
                error: err.message,
                stack: err.stack,
                critical: true,
                emergencyLevel: true
            }
        ).catch(console.error);
        
        process.exit(1);
    }
};

// --- Run the server start function ---
start();