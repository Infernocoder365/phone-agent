import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

import twilio from 'twilio';
import OpenAI from 'openai';

dotenv.config();

const {
  PORT = 3000,
  OPENAI_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  EMAIL_TO
} = process.env;

if (!OPENAI_API_KEY || !ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
  console.error('Missing required API keys in .env');
  process.exit(1);
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const fastify = Fastify({ logger: true });

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Email transporter
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS
  }
});

// Tool definition for OpenAI
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

// Root route
fastify.get('/', async (request, reply) => {
  return { status: 'Twello AI Agent Running' };
});

// Twilio Incoming Call Webhook
fastify.all('/incoming', async (request, reply) => {
  // Start recording the call explicitly if CallSid is present
  const callSid = request.body?.CallSid || request.query?.CallSid;
  if (callSid && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
      try {
          await twilioClient.calls(callSid)
            .recordings
            .create({
               recordingChannels: 'dual' // Record both sides
            });
          console.log(`Recording started for ${callSid}`);
      } catch (err) {
          console.error(`Failed to start recording for ${callSid}:`, err);
      }
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Hello, I am your AI assistant. How can I help you today?</Say>
  <Connect>
    <Stream url="wss://${request.headers.host}/media-stream" />
  </Connect>
</Response>`;

  reply.type('text/xml').send(twiml);
});

// Twilio Incoming SMS Webhook
fastify.post('/incoming-sms', async (request, reply) => {
  const { Body, From } = request.body;
  console.log(`Received SMS from ${From}: ${Body}`);

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5-pro", 
      messages: [
          { role: "system", content: "You are a helpful assistant for Pearly Whites Dental. Keep responses concise and suitable for SMS." },
          { role: "user", content: Body }
      ],
    });

    const aiResponse = completion.choices[0].message.content;

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(aiResponse);

    reply.type('text/xml').send(twiml.toString());
  } catch (error) {
    request.log.error(error);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("I'm sorry, I'm having trouble processing your request right now.");
    reply.type('text/xml').send(twiml.toString());
  }
});

// WebSocket Handler
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('Client connected to media-stream');
    if (!connection.socket) {
      console.error('Error: connection.socket is undefined. connection keys:', Object.keys(connection));
      // Fallback if connection is the socket itself (unlikely in v11 but possible in misconfig)
      if (connection.on) {
          console.log('connection seems to be the socket itself');
          connection.socket = connection; 
      }
    }

    const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    // ElevenLabs WebSocket URL (v1) - input streaming
    // We want ulaw output to match Twilio
    const elevenLabsWsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream-input?model_id=eleven_turbo_v2_5&output_format=ulaw_8000`;
    const elevenLabsWs = new WebSocket(elevenLabsWsUrl, {
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY
      }
    });

    let streamSid = null;

    // Open Events
    openAiWs.on('open', () => {
      console.log('Connected to OpenAI Realtime');
      // Initialize Session
      const sessionUpdate = {
        type: 'session.update',
        session: {
          modalities: ['text'], // We only want text back, we will do TTS with ElevenLabs
          instructions: '## Role You are an AI agent responsible for handling back office operations at the dental office "Pearly Whites Dental". You must make a decision about the data you receive and make a call into the appropriate tool in order to process this request and return the appropriate data necessary. You should look at the provided `tool` value in the request body to help decided which tool to use. Pay close attention to the constraints for number of times a tool is able to be used. You have secure access to the following internal tools:   - `think` → you MUST use this to think carefully about how to handle the provided request data. This tool must be used on every turn and tool call interaction.   - `get_availability` → returns true/false availability on the Dental Office Calendar for the given start timestamp in CST (Central Time). **For availability requests, you MUST call this tool multiple times to find AT LEAST 2 available timeslots if they exist.** Matches the `get_availability` tool value included in the request.   - `create_appointment` → creates a 1-hour appointment event for the provided start time. This tool may only be called ONCE (1 time) in a given request. Do NOT use this tool multiple times. Matches the `create_appointment` tool value included in the request. If you use this tool more than once, your task will be considered a FAILURE.   - `log_patient_details` → logs the provided call details and patient details to a Google Sheet. This should ONLY be called and used once for a provided request since we are logging details ONCE per call/patient. In order to use this tool, you need to be given the patient name / insurance provider / optional questions and concerns - if you don\'t have this information, you should NOT use this tool. This will be used only at the very end of the call when all details are provided. Matches the `log_patient_details` tool value included in the request. If you use this tool more than once, your task will be considered a FAILURE. ## Special Instructions for get_availability Tool When handling availability requests: 1. **Always aim to return 2 available timeslots** when possible 2. **Call get_availability multiple times** to check different time slots on the requested date 3. **Search strategy:**    - Start with the requested time (if provided)    - If that\'s not available, check nearby times in 30-minute or 1-hour increments    - Check both earlier and later times on the same day    - Continue checking until you find 2 available slots OR exhaust reasonable options 4. **Response format:** Return an array of available timeslots in ISO format (Central Time Zone CST):    ```json    {      "availableSlots": [        "2024-01-15T14:00:00Z",        "2024-01-15T16:00:00Z"      ]    }    ``` 5. **If fewer than 2 slots are found:**    - Return whatever available slots you found (even if just 1)    - It\'s better to return 1 slot than none 6. **Time checking sequence example:**    - If user requests "2:00 PM on Tuesday"    - Check: 2:00 PM, 1:30 PM, 2:30 PM, 1:00 PM, 3:00 PM, 12:30 PM, 3:30 PM, etc.    - Stop when you have 2 available slots or have checked reasonable business hours 7. **Business hours assumption:**     - Check times between 8:00 AM and 5:00 PM unless specified otherwise    - Skip lunch hour (12:00-1:00 PM) if applicable Remember: The get_availability tool can be called multiple times for availability requests, but create_appointment and log_patient_details must only be called ONCE per request. Remember: All times are in CST (Central Time Zone)',
          voice: 'alloy', // Ignored since modality is text, but required param sometimes
          input_audio_format: 'g711_ulaw', // OpenAI supports g711_ulaw directly now! (Check docs, if not we need PCM conversion)
          output_audio_format: 'g711_ulaw',
          turn_detection: {
            type: 'server_vad',
          },
          tools: TOOLS,
          tool_choice: 'auto',
        }
      };
      openAiWs.send(JSON.stringify(sessionUpdate));
    });

    openAiWs.on('error', (error) => {
      console.error('OpenAI WebSocket error:', error);
    });

    openAiWs.on('close', (code, reason) => {
      console.log(`OpenAI WebSocket closed: ${code} - ${reason}`);
    });

    elevenLabsWs.on('open', () => {
      console.log('Connected to ElevenLabs');
      // Send initial config to ElevenLabs
      elevenLabsWs.send(JSON.stringify({
        text: " ", // Init
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.8
        },
        generation_config: {
          chunk_length_schedule: [50] // Lower latency
        }
      }));
    });

    elevenLabsWs.on('error', (error) => {
      console.error('ElevenLabs WebSocket error:', error);
    });

    elevenLabsWs.on('close', (code, reason) => {
      console.log(`ElevenLabs WebSocket closed: ${code} - ${reason}`);
    });

    // Handle Twilio Messages
    connection.socket.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        
        switch (data.event) {
          case 'start':
            streamSid = data.start.streamSid;
            console.log(`Stream started: ${streamSid}`);
            break;
          case 'media':
            // Send audio to OpenAI
            // OpenAI Realtime supports 'input_audio_buffer.append'
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: data.media.payload // Twilio sends base64 mulaw
              }));
            }
            break;
          case 'stop':
            console.log('Stream stopped');
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            if (elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
            break;
        }
      } catch (error) {
        console.error('Error processing Twilio message:', error);
      }
    });

    // Handle OpenAI Messages
    openAiWs.on('message', (data) => {
      try {
        const event = JSON.parse(data);
        // Log interesting events
        if (event.type === 'session.updated') {
            console.log('OpenAI Session Updated');
        } else if (event.type === 'input_audio_buffer.speech_started') {
            console.log('OpenAI VAD: Speech Started');
            // Clear ElevenLabs buffer if user interrupts?
            if (elevenLabsWs.readyState === WebSocket.OPEN) {
                 elevenLabsWs.send(JSON.stringify({ text: " " })); // Send space to flush/reset? Or maybe strict handling
            }
        } else if (event.type === 'input_audio_buffer.speech_stopped') {
            console.log('OpenAI VAD: Speech Stopped');
        } else if (event.type === 'response.created') {
            console.log('OpenAI Response Created');
        } else if (event.type === 'response.done') {
            console.log('OpenAI Response Done:', event.response?.status);
        } else if (event.type === 'error') {
            console.error('OpenAI Error Event:', event.error);
        }

        if (event.type === 'response.text.delta') {
          // Streaming text from OpenAI -> Send to ElevenLabs
          process.stdout.write(`[Text Delta]: ${event.delta}\n`); // Log text
          if (elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.send(JSON.stringify({
              text: event.delta,
              try_trigger_generation: true
            }));
          }
        } else if (event.type === 'response.function_call_arguments.done') {
           // Handle tool calls (full arguments received)
           // Wait, Realtime API structure is slightly different for tools.
           // It uses 'response.output_item.added' or 'response.done'?
           // Let's check common patterns. Usually we look for 'response.output_item.done' where item.type is 'function_call'
        } else if (event.type === 'response.output_item.done') {
            const item = event.item;
            if (item.type === 'function_call') {
                handleFunctionCall(item);
            }
        }
      } catch (error) {
        console.error('Error processing OpenAI message:', error);
      }
    });
    
    async function handleFunctionCall(item) {
        const { name, arguments: args } = item;
        const callId = item.call_id;
        
        if (name === 'schedule_meeting') {
            const params = JSON.parse(args);
            const result = await sendScheduleEmail(params.reason, params.contact_info);
            
            // Send output back to OpenAI
            openAiWs.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                    type: 'function_call_output',
                    call_id: callId,
                    output: JSON.stringify(result)
                }
            }));
            
            // Trigger another response
            openAiWs.send(JSON.stringify({
                type: 'response.create'
            }));
        }
    }

    // Handle ElevenLabs Messages (Audio back)
    elevenLabsWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);
        if (response.audio) {
            // response.audio is base64 encoded audio chunk (ulaw because we requested it)
            const mediaMessage = {
                event: 'media',
                streamSid: streamSid,
                media: {
                    payload: response.audio
                }
            };
            connection.socket.send(JSON.stringify(mediaMessage));
        }
      } catch (error) {
         console.error('Error processing ElevenLabs message:', error);
      }
    });

    // Cleanup
    connection.socket.on('close', () => {
        console.log('Client disconnected');
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
        if (elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
    });
  });
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`Server listening on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
