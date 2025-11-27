import 'dotenv/config';

export const PUBLIC_URL = process.env.PUBLIC_URL || '';
export const OUTGOING_ROUTE_PREFIX = process.env.OUTGOING_ROUTE_PREFIX || '';

// --- GHL ---
export const GOHIGHLEVEL_CLIENT_ID = process.env.GOHIGHLEVEL_CLIENT_ID || '';
export const GOHIGHLEVEL_CLIENT_SECRET = process.env.GOHIGHLEVEL_CLIENT_SECRET || '';
export const GOHIGHLEVEL_REDIRECT_URI = process.env.GOHIGHLEVEL_REDIRECT_URI || '';
export const GOHIGHLEVEL_LOCATION_ID = process.env.GOHIGHLEVEL_LOCATION_ID || '';

// --- WORKFLOWS ---
export const PURCHASE_WORKFLOW_ID = process.env.PURCHASE_WORKFLOW_ID || '';

// --- ELEVENLABS ---
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
export const OUTGOING_ELEVENLABS_AGENT_ID = process.env.OUTGOING_ELEVENLABS_AGENT_ID || '';
export const ELEVENLABS_WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET || '';

// --- TWILIO ---
export const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
export const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
export const OUTGOING_TWILIO_PHONE_NUMBER = process.env.OUTGOING_TWILIO_PHONE_NUMBER || '';

// --- SLACK ---
export const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';

export const GOHIGHLEVEL_AUTH_URL = "https://marketplace.gohighlevel.com/oauth/chooselocation";
export const GOHIGHLEVEL_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
export const GOHIGHLEVEL_API_SCOPES = "contacts.readonly contacts.write workflows.readonly";

export const ITALIAN_TIMEZONE = 'Europe/Rome';

// ElevenLabs connection constants
export const ELEVENLABS_PING_INTERVAL = 30000; // 30 seconds
export const ELEVENLABS_CONNECTION_TIMEOUT = 300000; // 5 minutes

export const LOCATION_ID = GOHIGHLEVEL_LOCATION_ID;