require('dotenv').config();
const { Buffer } = require('node:buffer');
const EventEmitter = require('events');
const fetch = require('node-fetch');

class TextToSpeechService extends EventEmitter {
  constructor() {
    super();
    this.nextExpectedIndex = 0;
    this.speechBuffer = {};
  }

  async generate(gptReply, interactionCount) {
    const { partialResponseIndex, partialResponse } = gptReply;

    if (!partialResponse) { return; }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    const modelId = process.env.ELEVENLABS_TTS_MODEL_ID || 'eleven_flash_v2_5';
    const outputFormat = process.env.ELEVENLABS_TTS_OUTPUT_FORMAT || 'ulaw_8000';

    if (!apiKey) {
      console.error('TTS -> Missing ELEVENLABS_API_KEY');
      return;
    }

    if (!voiceId) {
      console.error('TTS -> Missing ELEVENLABS_VOICE_ID');
      return;
    }

    try {
      const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`);
      url.searchParams.set('output_format', outputFormat);
      if (process.env.ELEVENLABS_TTS_OPTIMIZE_STREAMING_LATENCY) {
        url.searchParams.set('optimize_streaming_latency', process.env.ELEVENLABS_TTS_OPTIMIZE_STREAMING_LATENCY);
      }

      const response = await fetch(
        url.toString(),
        {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: partialResponse,
            model_id: modelId,
          }),
        }
      );

      if (response.status === 200) {
        try {
          const audioArrayBuffer = await response.arrayBuffer();
          const base64String = Buffer.from(audioArrayBuffer).toString('base64');
          this.emit('speech', partialResponseIndex, base64String, partialResponse, interactionCount);
        } catch (err) {
          console.log(err);
        }
      } else {
        console.log('ElevenLabs TTS error:');
        console.log(await response.text());
      }
    } catch (err) {
      console.error('Error occurred in TextToSpeech service');
      console.error(err);
    }
  }
}

module.exports = { TextToSpeechService };
