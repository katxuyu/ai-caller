import dotenv from 'dotenv';
dotenv.config();

export const GOHIGHLEVEL_CLIENT_ID = process.env.GOHIGHLEVEL_CLIENT_ID || '';
export const GOHIGHLEVEL_CLIENT_SECRET = process.env.GOHIGHLEVEL_CLIENT_SECRET || '';
export const GOHIGHLEVEL_REDIRECT_URI = process.env.GOHIGHLEVEL_REDIRECT_URI || '';
export const GOHIGHLEVEL_LOCATION_ID = process.env.GOHIGHLEVEL_LOCATION_ID || '';
export const GOHIGHLEVEL_CALENDAR_ID = process.env.GOHIGHLEVEL_CALENDAR_ID || '';

export const GOHIGHLEVEL_AUTH_URL = "https://marketplace.gohighlevel.com/oauth/chooselocation";
export const GOHIGHLEVEL_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
export const GOHIGHLEVEL_API_SCOPES = "calendars.readonly calendars.write calendars/events.write contacts.readonly";

export const ITALIAN_TIMEZONE = 'Europe/Rome';

// Environment variables for OutgoingCall
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
export const ELEVENLABS_WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET || '';
export const OUTGOING_ELEVENLABS_AGENT_ID = process.env.OUTGOING_ELEVENLABS_AGENT_ID || '';
export const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
export const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
export const OUTGOING_TWILIO_PHONE_NUMBER = process.env.OUTGOING_TWILIO_PHONE_NUMBER || '';

// Clean the OUTGOING_ROUTE_PREFIX by removing any quotes and setting a default
let outgoingRoutePrefix = (process.env.OUTGOING_ROUTE_PREFIX || '/outgoing').replace(/['"]/g, '');
// Ensure it starts with a forward slash
if (!outgoingRoutePrefix.startsWith('/') && !outgoingRoutePrefix.startsWith('*')) {
  outgoingRoutePrefix = '/' + outgoingRoutePrefix;
}
// Remove any empty segments that might cause double slashes
outgoingRoutePrefix = outgoingRoutePrefix.replace(/\/+/g, '/');
export const OUTGOING_ROUTE_PREFIX = outgoingRoutePrefix;

// Use the existing GOHIGHLEVEL_ variables instead of separate ones
export const LOCATION_ID = GOHIGHLEVEL_LOCATION_ID;
export const CALENDAR_ID = GOHIGHLEVEL_CALENDAR_ID;
export const PUBLIC_URL = process.env.PUBLIC_URL || '';
export const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';

// Clean the CLIENT_ROUTE_PREFIX by removing any quotes and setting a default
let clientRoutePrefix = (process.env.CLIENT_ROUTE_PREFIX || '').replace(/['"]/g, '');
// Only add leading slash if prefix is not empty
if (clientRoutePrefix && !clientRoutePrefix.startsWith('/')) {
  clientRoutePrefix = '/' + clientRoutePrefix;
}
// Remove any empty segments that might cause double slashes
if (clientRoutePrefix) {
  clientRoutePrefix = clientRoutePrefix.replace(/\/+/g, '/');
}
export const CLIENT_ROUTE_PREFIX = clientRoutePrefix;

// Agent User IDs Configuration
export const INFISSI_VETRATE_AGENT_USER_ID = process.env.INFISSI_VETRATE_AGENT_USER_ID || '';
export const PERGOLE_AGENT_USER_ID = process.env.PERGOLE_AGENT_USER_ID || '';

// Service to UserID mapping
export const SERVICE_TO_USER_IDS = {
  "Infissi": [INFISSI_VETRATE_AGENT_USER_ID].filter(id => id),
  "Vetrate": [INFISSI_VETRATE_AGENT_USER_ID].filter(id => id),
  "Pergole": [PERGOLE_AGENT_USER_ID].filter(id => id)
};

// Province-specific service mapping (if different agents cover different provinces)
// This can be extended as your business grows to different regions
export const PROVINCE_SERVICE_TO_USER_IDS = {
  
};

// Meeting/Appointment Configuration
export const DEFAULT_APPOINTMENT_ADDRESS = process.env.DEFAULT_APPOINTMENT_ADDRESS || 'Client Address - To Be Confirmed'; // Default actual address when client address not available