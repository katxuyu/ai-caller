# AI Caller - Simple Purchase Workflow

A **super simple** Node.js application that makes AI calls and triggers GoHighLevel workflows when customers want to buy.

## What It Does

**That's it!** Just:

1. **AI calls customer** 📞
2. **Customer says "I want to buy"** 💰  
3. **AI triggers GHL workflow** ⚡
4. **Done!** ✅

## How It Works

```
Lead → AI Agent Calls → Customer Interested → Trigger Workflow → GHL Handles Rest
```

### **Simple Process:**
- AI agent calls leads automatically
- During conversation, when customer shows purchase intent
- AI calls `trigger_purchase` function with `contactId`
- System triggers your GoHighLevel workflow
- Workflow handles everything else (payment links, follow-ups, etc.)

## Environment Variables

Only the **essentials** needed:

| Variable | What It Does |
|----------|-------------|
| `TWILIO_ACCOUNT_SID` | Your Twilio account ID |
| `TWILIO_AUTH_TOKEN` | Your Twilio password |
| `OUTGOING_TWILIO_PHONE_NUMBER` | Phone number for outbound calls |
| `GOHIGHLEVEL_CLIENT_ID` | GHL OAuth client ID |
| `GOHIGHLEVEL_CLIENT_SECRET` | GHL OAuth secret |
| `GOHIGHLEVEL_REDIRECT_URI` | GHL OAuth redirect |
| `GOHIGHLEVEL_LOCATION_ID` | Your GHL location |
| `PURCHASE_WORKFLOW_ID` | **The ONE workflow to trigger when customer wants to buy** |
| `ELEVENLABS_API_KEY` | ElevenLabs API key |
| `OUTGOING_ELEVENLABS_AGENT_ID` | ElevenLabs agent for calls |
| `PUBLIC_URL` | Your app's public URL |

## API Endpoints

### **Trigger Call**
```bash
POST /outgoing/outbound-call
{
  "phone": "+1234567890",
  "contact_id": "ghl_contact_123",
  "first_name": "John"
}
```

### **Manual Purchase Trigger** 
```bash
POST /triggerPurchase
{
  "contactId": "ghl_contact_123"
}
```

## ElevenLabs Agent Setup

Your ElevenLabs agent needs **ONE function**:

```json
{
  "name": "trigger_purchase",
  "description": "Call this when customer wants to buy/purchase",
  "parameters": {
    "contactId": {
      "type": "string", 
      "description": "The contact ID"
    }
  }
}
```

## GoHighLevel Workflow

Create **ONE workflow** in GHL that:
- Sends payment links
- Follows up with customers  
- Handles the entire purchase process

Set its ID as `PURCHASE_WORKFLOW_ID`.

## Installation

```bash
npm install
node index.js
```

## That's It!

No complex service matching, no calendar logic, no payment calculations. Just:
**AI calls → Customer wants to buy → Trigger workflow → Done!** 🎉 