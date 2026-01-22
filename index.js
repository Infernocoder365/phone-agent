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
  TWILIO_RECORD_CALLS,
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
    function: {
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
  console.log(`[Endpoint] /incoming hit via ${request.method}`);
  // Start recording the call explicitly if CallSid is present
  const callSid = request.body?.CallSid || request.query?.CallSid;
  if (TWILIO_RECORD_CALLS === 'true' && callSid && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
      try {
          await twilioClient.calls(callSid)
            .recordings
            .create({
               recordingChannels: 'dual' // Record both sides
            });
          console.log(`Recording started for ${callSid}`);
      } catch (err) {
          console.log(`Recording not started for ${callSid}:`, err?.code || err?.message || err);
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
  console.log(`[Endpoint] /incoming-sms hit`);
  const { Body, From } = request.body;
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
    console.log('[Endpoint] /media-stream WebSocket connected');
    // Workaround for Fastify/ws issue where connection might be the socket itself
    if (!connection.socket && connection.on) {
        console.log('[Debug] connection seems to be the socket itself, using it.');
        connection.socket = connection; 
    }
    
    if (!connection.socket) {
      console.error('[Error] connection.socket is undefined in /media-stream');
    }

    // Initialize Conversation State
    let messages = [
        { 
            role: 'system', 
            content: process.env.AGENT_SYSTEM_PROMPT || 'You are a helpful AI assistant. Keep your responses concise and conversational.' 
        }
    ];

    // ElevenLabs STT WebSocket (Scribe v2)
    const elevenLabsSttWs = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text?model_id=scribe_v2&audio_format=ulaw_8000`, {
      headers: { "xi-api-key": ELEVENLABS_API_KEY }
    });

    // ElevenLabs TTS WebSocket
    const elevenLabsTtsWs = new WebSocket(`wss://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream-input?model_id=eleven_flash_v2_5&output_format=ulaw_8000`, {
      headers: { "xi-api-key": ELEVENLABS_API_KEY }
    });

    let streamSid = null;
    let isThinking = false;

    // --- ElevenLabs STT Events ---
    elevenLabsSttWs.on('open', () => {
      console.log('[ElevenLabs STT] Connected');
      // Send initial config if needed (Assuming standard handshake or direct audio)
    });

    elevenLabsSttWs.on('error', (error) => {
      console.error('[ElevenLabs STT Error]', error);
    });

    elevenLabsSttWs.on('close', (code, reason) => {
      console.log(`[ElevenLabs STT Closed] Code: ${code}, Reason: ${reason}`);
    });

    elevenLabsSttWs.on('message', async (data) => {
        try {
            const event = JSON.parse(data);
            // Log all events for debug as requested
            console.log('[ElevenLabs STT Event]', JSON.stringify(event, null, 2));

            // Check for committed transcript (Finalized text)
            // Note: Event type might be 'committed_transcript' based on research
            if (event.type === 'committed_transcript' || (event.is_final && event.text)) {
                const userText = event.text;
                if (!userText || !userText.trim()) return;

                console.log(`[User Said]: ${userText}`);
                messages.push({ role: 'user', content: userText });
                
                // Trigger AI Response
                await generateResponse();
            }
        } catch (err) {
            console.error('[ElevenLabs STT] Msg Error:', err);
        }
    });

    // --- ElevenLabs TTS Events ---
    elevenLabsTtsWs.on('open', () => {
      console.log('[ElevenLabs TTS] Connected');
      // Init TTS
      elevenLabsTtsWs.send(JSON.stringify({
        text: " ", 
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
        generation_config: { chunk_length_schedule: [50] }
      }));
    });

    elevenLabsTtsWs.on('error', (error) => {
      console.error('[ElevenLabs TTS Error]', error);
    });

    elevenLabsTtsWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);
        if (response.audio) {
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
         console.error('Error processing ElevenLabs TTS message:', error);
      }
    });

    // --- OpenAI Generation Logic ---
    async function generateResponse() {
        if (isThinking) return;
        isThinking = true;
        console.log('[OpenAI] Generating response...');

        try {
            const completion = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: messages,
                stream: true,
                tools: TOOLS,
                tool_choice: 'auto'
            });

            let fullResponse = "";
            let toolCalls = [];
            let currentToolCall = null;

            for await (const chunk of completion) {
                const delta = chunk.choices[0]?.delta;
                
                // Handle Text Content
                if (delta?.content) {
                    const textChunk = delta.content;
                    fullResponse += textChunk;
                    process.stdout.write(`[Text Delta]: ${textChunk}\n`);
                    
                    if (elevenLabsTtsWs.readyState === WebSocket.OPEN) {
                        elevenLabsTtsWs.send(JSON.stringify({
                            text: textChunk,
                            try_trigger_generation: true
                        }));
                    }
                }

                // Handle Tool Calls (Accumulate)
                if (delta?.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        if (tc.index !== undefined) {
                            if (!toolCalls[tc.index]) toolCalls[tc.index] = { id: tc.id, function: { name: "", arguments: "" } };
                            if (tc.id) toolCalls[tc.index].id = tc.id;
                            if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
                            if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                        }
                    }
                }
            }

            // Flush TTS
            if (elevenLabsTtsWs.readyState === WebSocket.OPEN) {
                elevenLabsTtsWs.send(JSON.stringify({ text: "" }));
            }

            // Handle Tool Execution if any
            if (toolCalls.length > 0) {
                console.log('[OpenAI] Tool calls detected:', toolCalls);
                messages.push({ role: 'assistant', content: fullResponse, tool_calls: toolCalls });

                for (const toolCall of toolCalls) {
                    const functionName = toolCall.function.name;
                    const args = JSON.parse(toolCall.function.arguments);
                    let result = { error: "Unknown tool" };

                    if (functionName === 'schedule_meeting') {
                        console.log(`[Tool] Executing schedule_meeting with`, args);
                        result = await sendScheduleEmail(args.reason, args.contact_info);
                    }
                    
                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: JSON.stringify(result)
                    });
                }

                // Recursively call generateResponse to process tool output
                isThinking = false; // Reset flag to allow next turn
                await generateResponse(); 
                return;
            } else {
                if (fullResponse) {
                     messages.push({ role: 'assistant', content: fullResponse });
                }
            }

        } catch (error) {
            console.error('[OpenAI] Error generating response:', error);
        } finally {
            isThinking = false;
        }
    }

    // --- Twilio Events ---
    connection.socket.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        
        switch (data.event) {
          case 'start':
            streamSid = data.start.streamSid;
            console.log(`[Twilio] Stream started: ${streamSid}`);
            break;
          case 'media':
            if (elevenLabsSttWs.readyState === WebSocket.OPEN) {
              // Send audio to ElevenLabs STT
              // Format: { "message_type": "input_audio_chunk", "audio_base_64": "..." }
              elevenLabsSttWs.send(JSON.stringify({
                message_type: 'input_audio_chunk',
                audio_base_64: data.media.payload
              }));
            }
            break;
          case 'stop':
            console.log('[Twilio] Stream stopped');
            if (elevenLabsSttWs.readyState === WebSocket.OPEN) elevenLabsSttWs.close();
            if (elevenLabsTtsWs.readyState === WebSocket.OPEN) elevenLabsTtsWs.close();
            break;
        }
      } catch (error) {
        console.error('[Twilio] Error processing message:', error);
      }
    });

    // Cleanup
    connection.socket.on('close', () => {
        console.log('Client disconnected');
        if (elevenLabsSttWs.readyState === WebSocket.OPEN) elevenLabsSttWs.close();
        if (elevenLabsTtsWs.readyState === WebSocket.OPEN) elevenLabsTtsWs.close();
    });
  });
});

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
