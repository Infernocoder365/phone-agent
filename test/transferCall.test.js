process.env.TWILIO_ACCOUNT_SID = 'ACxxxxx';
process.env.TWILIO_AUTH_TOKEN = 'authxxxxx';
process.env.TRANSFER_NUMBER = '+15551234567';

jest.mock('twilio', () => {
  const mockUpdate = jest.fn().mockResolvedValue({});
  const mockCalls = jest.fn(() => ({ update: mockUpdate }));
  const mockTwilio = jest.fn(() => ({ calls: mockCalls }));
  mockTwilio.__mock = { mockUpdate, mockCalls };
  return mockTwilio;
});

const transferCall = require('../functions/transferCall');
const twilio = require('twilio');

test('Expect transferCall to update Twilio call with transfer TwiML', async () => {
  const transferResult = await transferCall({ callSid: 'CAxxxxx' });

  expect(twilio).toHaveBeenCalledWith('ACxxxxx', 'authxxxxx');
  expect(twilio.__mock.mockCalls).toHaveBeenCalledWith('CAxxxxx');
  expect(twilio.__mock.mockUpdate).toHaveBeenCalledWith({ twiml: `<Response><Dial>${process.env.TRANSFER_NUMBER}</Dial></Response>` });
  expect(transferResult).toContain('transferred successfully');
});
