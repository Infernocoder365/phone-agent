import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

import twilio from 'twilio';

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

// WebSocket Handler
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('Client connected to media-stream');

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
          instructions: 'You are a helpful AI phone agent. You answer questions concisely. If you don\'t know the answer, ask to schedule a meeting. call the schedule_meeting tool if needed.',
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
        
        if (event.type === 'response.text.delta') {
          // Streaming text from OpenAI -> Send to ElevenLabs
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
