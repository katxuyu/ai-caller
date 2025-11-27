# AI Caller GHL Integration (old)

A Node.js application that integrates AI-powered calling capabilities with Go High Level (GHL) CRM system.

## Main Features

*   **Automated Outgoing Calls:** Uses Twilio for telephony and ElevenLabs for AI-generated voice to make automated calls to leads.
*   **GoHighLevel (GHL) CRM Integration:** Deeply integrates with GHL for contact management, calendar bookings, and workflow automation.
*   **Intelligent Agent Assignment:**
    *   **Service-Based:** Assigns leads/appointments to agents based on the specific service requested (e.g., Infissi, Vetrate, Pergole).
    *   **Location-Based:** Routes calls and assigns sales representatives based on the lead's geographic province in Italy.
*   **Robust Address Parsing:** Accurately extracts Italian province codes from various address formats (including fuzzy matching and postal codes) to determine location.
*   **Sales Representative Management:** Matches contacts with suitable sales reps based on service specialty and geographic coverage.
*   **Calendar & Booking Management:** Fetches available slots from GHL calendars, books appointments, and includes a locking system to prevent double bookings.
*   **Automated Follow-up Scheduling:** System can schedule and initiate follow-up calls.
*   **Slack Notifications:** Provides real-time alerts for important system events (e.g., failed calls, no available sales reps).
*   **Retry Logic:** Implements retry mechanisms for failed call attempts with configurable delays.

## How the AI Caller Works

This AI Caller system is designed to automate and optimize the process of contacting and booking appointments with leads, that are coming through GHL. We have an automation that starts the process.

1.  **Call Initiation:**
    *   Calls can be triggered via an API endpoint (typically a POST request to `/outbound-call` or a custom route). This can be done through GHL workflow automation or by the system's automated follow-up manager.
    *   The request includes lead details (phone, name, email, contact ID) and the service they are interested in.

2.  **Contact Analysis & Agent Matching:**
    *   The system fetches the lead's details from GoHighLevel.
    *   It uses its **Robust Address Parsing** engine to determine the lead's province from their address.
    *   Based on the required **service** and the **province**, it queries its database to find suitable, active **sales representatives**.

3.  **Calendar Slot Availability & AI Interaction:**
    *   **If no sales reps are found:** A Slack notification is sent, and the call is rejected.
    *   **If one or more reps are found:** The system fetches their available calendar slots from GoHighLevel.
    *   The AI (powered by **ElevenLabs**) is provided with the lead's information and the available slots.
    *   **Twilio** then places the call. During the call, the AI interacts with the lead, aiming to book an appointment in an available slot.

4.  **Booking & Confirmation:**
    *   If the lead agrees to an appointment, the system books it in the GHL calendar of the matched sales representative.
    *   A booking lock system helps prevent double bookings.

5.  **Notifications & Follow-ups:**
    *   **Slack** is used to send notifications for critical events.
    *   The system can schedule automated **follow-up calls** if initial attempts are unsuccessful or based on specific criteria.

## How to Initialize a Call

An outgoing call can be initiated by sending an HTTP POST request to the `/outbound-call` endpoint (the exact path might be customized by `CLIENT_ROUTE_PREFIX` and `OUTGOING_ROUTE_PREFIX` environment variables).

**Endpoint:** `POST {YOUR_APP_URL}{CLIENT_ROUTE_PREFIX}{OUTGOING_ROUTE_PREFIX}/outbound-call`

**Payload Example (JSON):**
```json
{
  "phone": "+12345678900",
  "contact_id": "ghl_contact_id_123",
  "first_name": "John",
  "full_name": "John Doe",
  "email": "john.doe@example.com",
  "customData": [
    { "key": "service", "value": "Infissi" },
    { "key": "address", "value": "Via Roma 1, Milano MI" }
  ]
}
```
*   `service` (within `customData`) is crucial for agent and service matching.
*   The system will then queue the call for processing.

## Environment Variables

Create a `.env` file in the root directory with the following variables. These are essential for the application to function correctly:

| Variable                            | Reason & What it Does                                                                 |
| :---------------------------------- | :------------------------------------------------------------------------------------ |
| `TWILIO_ACCOUNT_SID`                | Your Twilio Account SID. Identifies your Twilio account.                            |
| `TWILIO_AUTH_TOKEN`                 | Your Twilio Auth Token. Used to authenticate requests to the Twilio API.              |
| `OUTGOING_TWILIO_PHONE_NUMBER`      | The Twilio phone number used by the system to make outgoing calls.                    |
| `GOHIGHLEVEL_CLIENT_ID`             | Client ID for GoHighLevel OAuth. Used for GHL API access requiring OAuth.           |
| `GOHIGHLEVEL_CLIENT_SECRET`         | Client Secret for GoHighLevel OAuth. Used for GHL API access requiring OAuth.       |
| `GOHIGHLEVEL_REDIRECT_URI`          | Redirect URI registered with GoHighLevel for OAuth flow.                            |
| `GOHIGHLEVEL_API_KEY`               | API Key for GoHighLevel. Used for direct GHL API access not using OAuth.            |
| `GOHIGHLEVEL_FAILED_CALL_WORKFLOW_ID` | GoHighLevel Workflow ID to trigger if a call fails.                                   |
| `SLACK_CLIENT_ID`                   | Client ID for Slack OAuth. Used for Slack API integration if OAuth is used.         |
| `SLACK_CLIENT_SECRET`               | Client Secret for Slack OAuth. Used for Slack API integration if OAuth is used.       |
| `SLACK_REDIRECT_URI`                | Redirect URI for Slack OAuth.                                                       |
| `SLACK_CHANNEL_ID`                  | The Slack channel ID where the application will send notifications.                 |
| `ELEVENLABS_API_KEY`                | Your ElevenLabs API Key. Used to authenticate with ElevenLabs for text-to-speech services. |
| `INCOMING_ELEVENLABS_AGENT_ID`      | The specific ElevenLabs AI Agent ID to be used for handling incoming calls.         |
| `OUTGOING_ELEVENLABS_AGENT_ID`      | The specific ElevenLabs AI Agent ID to be used for making outgoing calls.           |
| `LOCATION_ID`                       | Your GoHighLevel Location ID. Specifies which GHL location to work with.           |
| `CALENDAR_ID`                       | Default GoHighLevel Calendar ID. Used for booking appointments.                   |
| `DEFAULT_APPOINTMENT_ADDRESS`       | Default actual address when client address is not available (e.g., "Client Address - To Be Confirmed"). Used with locationType: "Address" for in-person visits. |
| `PUBLIC_URL`                        | The publicly accessible base URL of this application (e.g., `https://yourapp.com`). Essential for webhooks (Twilio, GHL). |
| `INCOMING_ROUTE_PREFIX`             | URL prefix for all incoming call related routes (e.g., `/api/incoming`).           |
| `OUTGOING_ROUTE_PREFIX`             | URL prefix for all outgoing call related routes (e.g., `/api/outgoing`).           |

## External Tools Integration

This application relies on several external services:

*   **Twilio:** Provides the core telephony infrastructure. It's used to make phone calls and manage call flows through WebSocket connections.
*   **ElevenLabs:** Powers the AI voice. It converts text scripted by the AI logic into natural-sounding speech for the call.
*   **GoHighLevel (GHL):** Acts as the primary CRM. The application fetches contact data from GHL, books appointments into GHL calendars, and can trigger/be triggered by GHL workflows.
*   **Slack:** Used as a notification channel. The system sends alerts to a designated Slack channel for important events like errors, successful bookings (if configured), or when manual intervention might be needed.

## Service-Based Agent Configuration

The AI caller supports service-based appointment booking, ensuring leads are assigned to the correct agent based on both their province AND the specific service they need.

### Database-Driven Sales Rep Management

The system uses a `sales_reps` database table to manage agent assignments instead of environment variables. This provides more flexibility and easier management.

### How to Find Your GoHighLevel UserIds

1. Go to your GoHighLevel calendar settings
2. Check the team/user management section
3. Copy the userIds for your agents
4. Add them to the database using the helper scripts

### Validate Your Configuration

After setting up your sales representatives in the database, run the validation script to ensure everything is configured correctly:

```bash
node validate-config.js
```

This will check:
- ✅ Sales rep database configuration
- 📍 Service coverage (Infissi, Vetrate, Pergole)
- 🔍 Province configuration validity

### Province Coverage

Sales reps can be configured to work in specific provinces and handle specific services:
- Milano, Torino, Genova, Bologna, Venezia, Verona, Padova, Brescia, Parma, Modena, Bergamo, Vicenza
- Roma, Firenze, Pisa, Perugia, Ancona
- Napoli, Bari, Palermo, Catania, Cagliari

### How It Works

1. **Service Detection**: The system identifies which service the lead is interested in (Infissi, Vetrate, or Pergole)
2. **Province Detection**: The system fetches the contact's details and extracts their province
3. **Agent Selection**: Based on service + province, the correct agent is selected from the database
4. **Filtered Slots**: Only calendar slots from the appropriate agent are shown to the AI
5. **Smart Booking**: When booking an appointment, the system automatically assigns it to the correct agent

## Sales Representatives Management

The system includes a sales representative management feature that automatically assigns calls to appropriate sales reps based on:
- **Service type**: Infissi, Vetrate, or Pergole
- **Geographic location**: Italian province codes (e.g., RM, MI, BO)

### Database Schema

The `sales_reps` table contains:
- `ghl_user_id`: GoHighLevel user ID of the sales representative
- `name`: Full name of the sales rep
- `services`: JSON array of services they handle (e.g., `["Infissi", "Vetrate"]`)
- `provinces`: JSON array of province codes they cover (e.g., `["RM", "LT", "FR"]`)
- `active`: Boolean flag to enable/disable the rep

### How It Works

1. **Contact Analysis**: When a call is initiated, the system:
   - Fetches contact details from GoHighLevel
   - Extracts the province from the contact's address
   - Identifies the requested service

2. **Sales Rep Matching**: The system queries the database to find sales reps who:
   - Handle the requested service
   - Cover the contact's province
   - Are currently active

3. **Call Routing**:
   - **0 candidates**: Call is rejected, Slack notification sent
   - **1 candidate**: Uses `fetchGHLCalendarSlots()` with single userId
   - **2+ candidates**: Uses `fetchGHLCalendarSlotsForUsers()` with multiple userIds

4. **Slot Formatting**: Available slots are formatted with userId information for proper assignment

### Adding Sales Representatives

Use the helper script to add sales reps:

```bash
node add-sales-reps.js
```

Or add them programmatically:

```javascript
import { addSalesRep } from './db.js';

await addSalesRep(
    'ghl_user_id_123',
    'John Doe',
    ['Infissi', 'Vetrate'],
    ['RM', 'MI', 'BO']
);
```

### Province Code Mapping

The system recognizes major Italian cities and their province codes:
- Roma/Rome → RM
- Milano/Milan → MI  
- Napoli/Naples → NA
- Bologna → BO
- Torino/Turin → TO
- And many more...

### Error Handling

- **No sales reps found**: Sends Slack notification with contact details
- **Province extraction fails**: Logs warning and attempts fallback matching
- **Invalid contact data**: Graceful degradation with appropriate error messages

The system prioritizes speed by trying faster local methods first, only falling back to external services for addresses that can't be parsed locally.

## What Happens When No Sales Rep is Found

When the system determines that no sales representatives are available for a specific service and location combination, the following process occurs:

### 1. **Call is Rejected**
The system immediately prevents the call from being made. The call request is rejected with a `400 Bad Request` HTTP status code.

### 2. **Slack Notification is Sent**
A detailed notification is automatically sent to the configured Slack channel with:
- **Title:** "No Sales Rep Available"
- **Message:** Details about the failed assignment
- **Contact Information:** Including contact ID, phone number, service requested, and province
- **Address Information:** Whether an address was provided in the customData

### 3. **Error Response**
The API returns a structured error response:
```json
{
  "success": false,
  "error": "No sales representatives available for this service and location",
  "details": {
    "service": "Infissi",
    "province": "MI",
    "hasCustomDataAddress": true
  }
}
```

### 4. **Detailed Logging**
The system logs comprehensive information about why no sales rep was found, including:
- The extracted province from the contact's address
- The requested service
- How many sales reps were found (0 in this case)
- Whether address data was available for province extraction

### 5. **No Call Queue Entry**
Since no suitable sales rep is found, the call is **not** added to the call queue, preventing any actual phone call attempt.

### Example Scenario
If a contact from Rome (RM) requests "Infissi" service, but there are no active sales reps in the database who both:
- Handle "Infissi" service
- Cover the "RM" province

Then the system will:
1. Send a Slack message like: "No sales representatives found for service 'Infissi' in province 'RM' for contact ABC123 (John Doe)"
2. Return the error response to the caller
3. Log the failure for debugging purposes
4. **Not attempt any phone call**

This ensures that calls are only made when there's an appropriate sales representative available to handle the appointment booking, preventing wasted calls and ensuring proper service coverage.

## FILE COMMUNICATION SUMMARY

### Core Communication Patterns

**1. Webhook Flow:**
```
GHL → ghl/routes.js → outgoing-call.js → db.js → ghl/api.js → queue-processor.js → Twilio
```

**2. Call Execution Flow:**
```
queue-processor.js → outgoing-call.js → Twilio → WebSocket → ElevenLabs → AI Response
```

**3. Booking Flow:**
```
ElevenLabs (function call) → ghl/api.js → bookingLock.js → GHL API → Success/Failure
```

**4. Error Notification Flow:**
```
Any Component → slack/notifications.js → Slack API → Slack Channel
```

**5. Data Persistence Flow:**
```
All Components → db.js → SQLite Database → Persistent Storage
```

### Key Data Exchanges

- **Contact Data:** contact_id, phone, name, email, service, address
- **Calendar Data:** available slots, booking times, user assignments
- **Call Data:** call_sid, status, conversation_id, retry attempts
- **Authentication:** OAuth tokens, API keys, signed URLs
- **System Status:** error messages, success confirmations, notifications

This architecture ensures robust, scalable call management with proper error handling, retry logic, and comprehensive monitoring through Slack notifications. 