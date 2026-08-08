// Sends the GenBI daily-budget warning email via SES. Dynamically imports the SES SDK
// the same way genbi.mjs already dynamically imports the Bedrock SDK -- keeps this
// dependency out of the hot path for every other handler (standings/winners/seasons)
// that never sends email.
//
// Requires @aws-sdk/client-ses as a dependency (added to package.json). Needs the
// sender identity verified in SES -- if the account is still in SES sandbox mode, both
// the "from" and "to" addresses must be verified there first.
const DEFAULT_ALERT_EMAIL = 'chetanbk@gmail.com';

export async function sendBudgetWarningEmail({ costSoFar, limit }) {
  const { SESClient, SendEmailCommand } = await import('@aws-sdk/client-ses');
  const sesClient = new SESClient({ region: 'us-west-2' });

  const toAddress = process.env.GENBI_ALERT_EMAIL || DEFAULT_ALERT_EMAIL;
  const fromAddress = process.env.GENBI_ALERT_FROM_EMAIL || toAddress;

  const command = new SendEmailCommand({
    Source: fromAddress,
    Destination: { ToAddresses: [toAddress] },
    Message: {
      Subject: { Data: `GenBI Bedrock budget warning: $${costSoFar.toFixed(2)} of $${limit}/day used` },
      Body: {
        Text: {
          Data:
            `GenBI has used $${costSoFar.toFixed(2)} of today's $${limit.toFixed(2)} Bedrock budget.\n\n` +
            `Once the full $${limit.toFixed(2)} is reached, GenBI will stop answering questions until ` +
            `the budget resets at midnight UTC. No action needed unless usage looks unexpected.`
        }
      }
    }
  });

  await sesClient.send(command);
}
