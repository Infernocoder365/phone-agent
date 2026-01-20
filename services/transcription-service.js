require('colors');
const EventEmitter = require('events');
const WebSocket = require('ws');


class TranscriptionService extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.isOpen = false;
    this.pendingMessages = [];

    this.connect();
  }

  connect() {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      console.error('STT -> Missing ELEVENLABS_API_KEY');
      return;
    }

    const modelId = process.env.ELEVENLABS_STT_MODEL_ID || 'scribe_v2_realtime';
    const audioFormat = process.env.ELEVENLABS_STT_AUDIO_FORMAT || 'ulaw_8000';
    const sampleRate = process.env.ELEVENLABS_STT_SAMPLE_RATE || '8000';
    const vadCommitStrategy = process.env.ELEVENLABS_STT_VAD_COMMIT_STRATEGY || 'true';
    const vadSilenceThresholdSecs = process.env.ELEVENLABS_STT_VAD_SILENCE_THRESHOLD_SECS || '1.5';
    const vadThreshold = process.env.ELEVENLABS_STT_VAD_THRESHOLD || '0.4';
    const minSpeechDurationMs = process.env.ELEVENLABS_STT_MIN_SPEECH_DURATION_MS || '100';
    const minSilenceDurationMs = process.env.ELEVENLABS_STT_MIN_SILENCE_DURATION_MS || '100';
    const languageCode = process.env.ELEVENLABS_STT_LANGUAGE_CODE;

    const url = new URL('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
    url.searchParams.set('model_id', modelId);
    url.searchParams.set('audio_format', audioFormat);
    url.searchParams.set('sample_rate', sampleRate);
    url.searchParams.set('vad_commit_strategy', vadCommitStrategy);
    url.searchParams.set('vad_silence_threshold_secs', vadSilenceThresholdSecs);
    url.searchParams.set('vad_threshold', vadThreshold);
    url.searchParams.set('min_speech_duration_ms', minSpeechDurationMs);
    url.searchParams.set('min_silence_duration_ms', minSilenceDurationMs);
    if (languageCode) {
      url.searchParams.set('language_code', languageCode);
    }

    this.ws = new WebSocket(url.toString(), {
      headers: {
        'xi-api-key': apiKey,
      },
    });

    this.ws.on('open', () => {
      this.isOpen = true;
      while (this.pendingMessages.length > 0) {
        this.ws.send(this.pendingMessages.shift());
      }
    });

    this.ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (_err) {
        return;
      }

      const type = msg.message_type || msg.type;
      if (!type) { return; }

      if (type === 'session_started') {
        return;
      }

      if (type === 'error') {
        console.error('STT -> ElevenLabs error');
        console.error(msg);
        return;
      }

      const text = this.extractText(msg);
      if (!text || text.trim().length === 0) { return; }

      if (type.includes('partial')) {
        this.emit('utterance', text);
        return;
      }

      if (type.includes('committed')) {
        this.emit('transcription', text);
        return;
      }
    });

    this.ws.on('close', () => {
      this.isOpen = false;
      console.log('STT -> ElevenLabs connection closed'.yellow);
    });

    this.ws.on('error', (error) => {
      console.error('STT -> ElevenLabs websocket error');
      console.error(error);
    });
  }

  extractText(msg) {
    if (typeof msg.text === 'string') { return msg.text; }
    if (typeof msg.transcript === 'string') { return msg.transcript; }
    if (typeof msg.partial_transcript === 'string') { return msg.partial_transcript; }
    if (typeof msg.committed_transcript === 'string') { return msg.committed_transcript; }
    if (msg.partial_transcript && typeof msg.partial_transcript.text === 'string') { return msg.partial_transcript.text; }
    if (msg.committed_transcript && typeof msg.committed_transcript.text === 'string') { return msg.committed_transcript.text; }
    return '';
  }

  /**
   * Send the payload to ElevenLabs Scribe
   * @param {String} payload A base64 MULAW/8000 audio stream
   */
  send(payload) {
    const sampleRate = Number(process.env.ELEVENLABS_STT_SAMPLE_RATE || 8000);
    const message = JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: payload,
      sample_rate: sampleRate,
    });

    if (this.ws && this.isOpen && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(message);
      return;
    }

    this.pendingMessages.push(message);
  }
}

module.exports = { TranscriptionService };
