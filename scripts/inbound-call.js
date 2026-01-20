require('dotenv').config();

// You can use this function to make a
// test call to your application by running
// npm inbound
function getArgValue(name) {
  const prefix = `--${name}=`;
  const eqArg = process.argv.find(a => a.startsWith(prefix));
  if (eqArg) {
    return eqArg.slice(prefix.length);
  }
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return null;
}

async function makeInboundCall() {
  const VoiceResponse = require('twilio').twiml.VoiceResponse;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const to = getArgValue('to');
  const from = getArgValue('from');

  if (!to) {
    throw new Error('Missing --to');
  }
  if (!from) {
    throw new Error('Missing --from');
  }
  
  const client = require('twilio')(accountSid, authToken);
  
  let twiml = new VoiceResponse();
  twiml.pause({ length: 10 });
  twiml.say('Which models of airpods do you have available right now?');
  twiml.pause({ length: 30 });
  twiml.hangup();

  console.log(twiml.toString());
  
  await client.calls
    .create({
      twiml: twiml.toString(),
      to,
      from
    })
    .then(call => console.log(call.sid));
}  

makeInboundCall();
