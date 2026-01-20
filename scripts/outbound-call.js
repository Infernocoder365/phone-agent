/*
  You can use this script to place an outbound call
  to your own mobile phone.
*/

require('dotenv').config();

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

async function makeOutBoundCall() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const server = getArgValue('server') || process.env.SERVER;
  const to = getArgValue('to');
  const from = getArgValue('from');

  if (!server) {
    throw new Error('Missing SERVER env var or --server');
  }
  if (!to) {
    throw new Error('Missing --to');
  }
  if (!from) {
    throw new Error('Missing --from');
  }
  
  const client = require('twilio')(accountSid, authToken);

  await client.calls
    .create({
      url: `https://${server}/incoming`,
      to,
      from
    })
    .then(call => console.log(call.sid));
}

makeOutBoundCall();
