import { createIncomingConnector, createOutgoingConnector, createIdentity } from '../src/services/connectorService.js';
import { createRule } from '../src/services/rules.js';
import { createUser } from '../src/services/user.js';

async function main() {
  const user = await createUser({
    email: 'demo@example.com',
    name: 'Demo User',
  });

  const incoming = await createIncomingConnector(user.id, {
    name: 'Demo Gmail IN',
    emailAddress: 'user@gmail.com',
    provider: 'gmail',
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    authType: 'oauth2',
    authConfig: {},
    syncSettings: {},
  });

  const outgoing = await createOutgoingConnector(user.id, {
    name: 'Demo Gmail SMTP',
    provider: 'gmail',
    fromAddress: 'user@gmail.com',
    host: 'smtp.gmail.com',
    port: 587,
    tlsMode: 'starttls',
    authType: 'oauth2',
    authConfig: {},
    sentCopyBehavior: { mode: 'imap_append', mailbox: 'Sent' },
  });

  const identity = await createIdentity(
    user.id,
    'Primary',
    'user@gmail.com',
    outgoing.id,
    'Sent from simpleMail',
    incoming.id,
    'reply@example.com',
  );

  await createRule(user.id, {
    name: 'Star newsletter replies',
    matchingScope: 'incoming',
    matchConditions: { subjectContains: 'invoice', hasAttachment: false },
    actions: { star: true, markRead: false },
    executionOrder: 1,
  });

  console.log('Seeded', { incoming, outgoing, identity });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
