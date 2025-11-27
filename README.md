# Simple AI Caller

A lightweight, streamlined Node.js application for making automated, AI-powered phone calls. This server is designed for one core purpose: to initiate a call with an AI agent and provide a simple hook to transfer the call to a human if needed.

## Main Features

*   **Automated Outgoing Calls:** Uses Twilio for telephony and ElevenLabs for a conversational AI voice.
*   **Simple Call Trigger:** Initiate calls via a single, clean API endpoint.
*   **Human Handoff:** The AI can trigger a function to transfer the call to a pre-defined human agent.
*   **Automated Follow-up System:** Can schedule and execute follow-up calls for numbers that didn't connect.
*   **Retry Logic:** Automatically retries calls that fail or don't get an answer.
*   **Slack Notifications:** Provides real-time alerts for important system events.

## How the AI Caller Works

1.  **Call Initiation:** A call is triggered by sending a `POST` request to the `/outbound-call` endpoint with the contact's details.
2.  **Queueing:** The system adds the call to a processing queue.
3.  **AI Interaction:** The queue processor initiates the call via Twilio. Once connected, a WebSocket connection is established with an ElevenLabs AI agent, which handles the conversation.
4.  **Human Handoff:** If the AI determines a human is needed, it triggers the `transfer_to_human_agent` function. **Note:** You must implement the final transfer logic inside `outgoing-call.js`.
5.  **Call Completion:** The call ends, and its status is logged. Failed or unanswered calls can be automatically retried.

## How to Initiate a Call

Send an HTTP POST request to the `/outbound-call` endpoint. The exact path can be configured via the `OUTGOING_ROUTE_PREFIX` environment variable.

**Endpoint:** `POST {YOUR_APP_URL}{OUTGOING_ROUTE_PREFIX}/outbound-call`

**Payload Example (JSON):**

```json
{
  "phone": "+12345678900",
  "first_name": "Jane",
  "full_name": "Jane Doe",
  "email": "jane.doe@example.com",
  "contact_id": "internal_contact_123"
}
```

## Environment Variables

Create a `.env` file in the root directory.

| Variable                       | Description                                                                 |
| :----------------------------- | :-------------------------------------------------------------------------- |
| `TWILIO_ACCOUNT_SID`           | Your Twilio Account SID.                                                    |
| `TWILIO_AUTH_TOKEN`            | Your Twilio Auth Token.                                                     |
| `OUTGOING_TWILIO_PHONE_NUMBER` | The Twilio phone number used for outgoing calls.                            |
| `ELEVENLABS_API_KEY`           | Your ElevenLabs API Key for text-to-speech.                                 |
| `OUTGOING_ELEVENLABS_AGENT_ID` | The ElevenLabs AI Agent ID for outgoing calls.                              |
| `PUBLIC_URL`                   | The publicly accessible base URL of this application (e.g., `https://yourapp.com`). |
| `OUTGOING_ROUTE_PREFIX`        | URL prefix for outgoing call routes (e.g., `/api/calls`). Default: `/outgoing` |
| `SLACK_WEBHOOK_URL`            | The Slack Webhook URL for sending notifications.                            |

## External Tools Integration

*   **Twilio:** Provides the core telephony infrastructure for making and managing phone calls.
*   **ElevenLabs:** Powers the conversational AI voice agent.
*   **Slack:** Used as a notification channel for system alerts. 