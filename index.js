import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import twilio from 'twilio';

dotenv.config();

const {
  PORT = 3000,
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_RECORD_CALLS,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  EMAIL_TO
} = process.env;

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in .env');
  process.exit(1);
}

// Initialize Twilio Client
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_ACCOUNT_SID.startsWith('AC')) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
  console.warn('[Twilio] Missing or invalid credentials; Twilio features will be disabled until configured.');
}

// Initialize Express
const app = express();
app.use(express.urlencoded({ extended: true })); // For parsing application/x-www-form-urlencoded (Twilio webhooks)
app.use(express.json());

// Email transporter
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS
  }
});

// Helper to send email
async function sendScheduleEmail(reason, contactInfo) {
  try {
    const info = await transporter.sendMail({
      from: SMTP_USER,
      to: EMAIL_TO,
      subject: 'New Meeting Request from AI Agent',
      text: `Reason: ${reason}\nContact Info: ${contactInfo || 'Not provided'}`
    });
    console.log('Email sent:', info.messageId);
    return { success: true, message: 'Meeting request sent via email.' };
  } catch (error) {
    console.error('Error sending email:', error);
    return { success: false, message: 'Failed to send email.' };
  }
}

// Tool definition for OpenAI Realtime API
const TOOLS = [
  {
    type: 'function',
    name: 'schedule_meeting',
    description: 'Schedule a meeting with a real person when the AI cannot answer or the user asks for human help.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'The reason for scheduling the meeting or the user\'s question.'
        },
        contact_info: {
          type: 'string',
          description: 'The user\'s contact information (if provided).'
        }
      },
      required: ['reason']
    }
  }
];

// Root route
app.get('/', (req, res) => {
  res.send({ status: 'Twello AI Agent Running' });
});

// Twilio Incoming Call Webhook
app.all('/incoming', async (req, res) => {
  console.log(`[Endpoint] /incoming hit via ${req.method}`);
  
  // Start recording if enabled
  const callSid = req.body?.CallSid || req.query?.CallSid;
  if (TWILIO_RECORD_CALLS === 'true' && callSid && twilioClient) {
    try {
      await twilioClient.calls(callSid)
        .recordings
        .create({ recordingChannels: 'dual' });
      console.log(`Recording started for ${callSid}`);
    } catch (err) {
      console.log(`Recording not started for ${callSid}:`, err?.code || err?.message || err);
    }
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Hello, I am your AI assistant. How can I help you today?</Say>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream" />
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
});

// Twilio Incoming SMS Webhook
// NOTE: SMS still uses standard Chat Completions API as Realtime API is Audio-focused.
// We'll keep using the 'openai' package for this if needed, but for now let's import OpenAI class just for SMS.
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

app.post('/incoming-sms', async (req, res) => {
  console.log(`[Endpoint] /incoming-sms hit`);
  const { Body, From } = req.body;
  console.log(`[SMS] Received from ${From}: ${Body}`);

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o", 
      messages: [
          { role: "system", content: "You are a helpful assistant for Pearly Whites Dental. Keep responses concise and suitable for SMS." },
          { role: "user", content: Body }
      ],
    });

    const aiResponse = completion.choices[0].message.content;
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(aiResponse);

    res.type('text/xml').send(twiml.toString());
  } catch (error) {
    console.error(error);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("I'm sorry, I'm having trouble processing your request right now.");
    res.type('text/xml').send(twiml.toString());
  }
});

// Start Express Server
const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// WebSocket Server
const wss = new WebSocketServer({ server });

wss.on('connection', (connection, req) => {
  if (req.url !== '/media-stream') {
    connection.close();
    return;
  }

  console.log('[WebSocket] Client connected to /media-stream');

  let streamSid = null;
  let openAiWs = null;
  let responseActive = false;

  // Connect to OpenAI Realtime API
  try {
    const url = 'wss://api.openai.com/v1/realtime?model=gpt-realtime';
    openAiWs = new WebSocket(url, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });
  } catch (err) {
    console.error('[OpenAI] Connection Error:', err);
    connection.close();
    return;
  }

  openAiWs.on('open', () => {
    console.log('[OpenAI] Connected to Realtime API');
    
    // Send Session Update to configure tools and voice
    const sessionUpdate = {
      type: 'session.update',
      session: {
        voice: 'shimmer', // Options: alloy, echo, shimmer
        instructions: process.env.AGENT_SYSTEM_PROMPT || 'You are a helpful AI assistant. Keep your responses concise and conversational.',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        turn_detection: {
            type: 'server_vad',
            interrupt_response: true,
            create_response: true
        },
        tools: TOOLS
      }
    };
    openAiWs.send(JSON.stringify(sessionUpdate));
    openAiWs.send(JSON.stringify({ type: 'response.create' }));
  });

  openAiWs.on('message', async (data) => {
    try {
      const event = JSON.parse(data);
      console.log(event);
      switch (event.type) {
        case 'response.created':
          responseActive = true;
          break;
        case 'response.done':
          responseActive = false;
          console.log("done:", JSON.stringify(event.response.status_details.error));
          break;
        case 'response.output_audio.delta':
          // Relay audio back to Twilio
          if (event.delta && streamSid) {
            const audioPayload = event.delta;
            const mediaMessage = {
              event: 'media',
              streamSid: streamSid,
              media: {
                payload: audioPayload
              }
            };
            connection.send(JSON.stringify(mediaMessage));
          }
          break;

        case 'input_audio_buffer.speech_started':
           // User started speaking, we might want to interrupt playback if needed (Twilio handles this usually by stopping stream if we send clear)
           // For better experience, we can send a 'clear' message to Twilio to stop current audio
           if (streamSid) {
             const clearMessage = {
               event: 'clear',
               streamSid: streamSid
             };
             connection.send(JSON.stringify(clearMessage));
             
             // Also tell OpenAI to cancel current response only if active
             if (responseActive) {
               openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
             }
           }
           break;

        case 'response.function_call_arguments.done':
            // Handle tool calls
            const callId = event.call_id;
            const functionName = event.name;
            const args = JSON.parse(event.arguments);
            
            console.log(`[Tool] Calling ${functionName} with`, args);

            let result = { error: "Unknown tool" };
            if (functionName === 'schedule_meeting') {
                result = await sendScheduleEmail(args.reason, args.contact_info);
            }

            // Send tool output back to OpenAI
            const toolOutput = {
                type: 'conversation.item.create',
                item: {
                    type: 'function_call_output',
                    call_id: callId,
                    output: JSON.stringify(result)
                }
            };
            openAiWs.send(JSON.stringify(toolOutput));

            // Trigger another response from AI based on the tool output
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
            break;

        case 'error':
            console.error('[OpenAI] Error event:', event.error);
            break;
            
        default:
          // console.log('[OpenAI] Unhandled event:', event.type);
          break;
      }
    } catch (err) {
      console.error('[OpenAI] Error processing message:', err);
    }
  });

  openAiWs.on('close', (code, reason) => {
    console.log(`[OpenAI] Disconnected: ${code} ${reason}`);
    connection.close();
  });

  openAiWs.on('error', (error) => {
    console.error('[OpenAI] WebSocket Error:', error);
  });

  // Handle messages from Twilio
  connection.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.event) {
        case 'start':
          streamSid = data.start.streamSid;
          console.log(`[Twilio] Stream started: ${streamSid}`);
          break;

        case 'media':
          // Relay audio to OpenAI
          if (openAiWs.readyState === WebSocket.OPEN) {
            const audioAppend = {
              type: 'input_audio_buffer.append',
              audio: data.media.payload
            };
            openAiWs.send(JSON.stringify(audioAppend));
          }
          break;

        case 'stop':
          console.log('[Twilio] Stream stopped');
          if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
          break;
      }
    } catch (error) {
      console.error('[Twilio] Error processing message:', error);
    }
  });

  connection.on('close', () => {
    console.log('[Twilio] Client disconnected');
    if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
  });
});
