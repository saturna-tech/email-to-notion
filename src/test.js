/**
 * Basic unit tests for email-to-notion
 * Run with: node test.js
 */

const { parseSubject, parseForwardedHeaders, stripForwardingHeaders } = require('./parse');
const { validateRecipient, validateSender, extractEmail } = require('./validate');
const { filterAttachments } = require('./attachments');
const { isSesEvent, parseMimeEmail } = require('./ses');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Not equal'}: expected "${expected}", got "${actual}"`);
  }
}

// ============ parseSubject tests ============

console.log('\n--- parseSubject tests ---');

test('parses simple client tag', () => {
  const result = parseSubject('#acme: Q4 Invoice');
  assertEqual(result.client, 'acme');
  assertEqual(result.subject, 'Q4 Invoice');
});

test('parses client tag with Fwd prefix', () => {
  const result = parseSubject('#beta: Fwd: Meeting Notes');
  assertEqual(result.client, 'beta');
  assertEqual(result.subject, 'Meeting Notes');
});

test('strips multiple forwarding prefixes', () => {
  const result = parseSubject('#client: Fwd: Re: Fw: RE: FW: Hello');
  assertEqual(result.client, 'client');
  assertEqual(result.subject, 'Hello');
});

test('lowercases client name', () => {
  const result = parseSubject('#ACME: Test');
  assertEqual(result.client, 'acme');
});

test('sanitizes client name - removes non-alphanumeric', () => {
  const result = parseSubject('#test_client: Subject');
  assertEqual(result.client, 'testclient');
});

test('parses client tag without colon', () => {
  const result = parseSubject('#acme Fwd: Invoice');
  assertEqual(result.client, 'acme');
  assertEqual(result.subject, 'Invoice');
});

test('uses "missing" for null subject', () => {
  const result = parseSubject(null);
  assertEqual(result.client, 'missing');
  assertEqual(result.subject, '');
});

test('uses "missing" when no hashtag', () => {
  const result = parseSubject('Fwd: Just a regular subject');
  assertEqual(result.client, 'missing');
  assertEqual(result.subject, 'Just a regular subject');
});

// ============ validateRecipient tests ============

console.log('\n--- validateRecipient tests ---');

test('validates correct recipient', () => {
  assert(validateRecipient('notion-abc123@example.com', 'abc123'));
});

test('rejects wrong secret', () => {
  assert(!validateRecipient('notion-wrong@example.com', 'abc123'));
});

test('rejects missing secret', () => {
  assert(!validateRecipient('notion-abc123@example.com', null));
});

test('is case insensitive', () => {
  assert(validateRecipient('NOTION-ABC123@example.com', 'ABC123'));
});

test('validates recipient with display name', () => {
  assert(validateRecipient('"Notion Archive" <notion-abc123@example.com>', 'abc123'));
});

// ============ validateSender tests ============

console.log('\n--- validateSender tests ---');

test('validates allowed sender', () => {
  assert(validateSender('user@example.com', ['user@example.com']));
});

test('validates sender with display name', () => {
  assert(validateSender('John Doe <john@example.com>', ['john@example.com']));
});

test('is case insensitive', () => {
  assert(validateSender('USER@EXAMPLE.COM', ['user@example.com']));
});

test('rejects unauthorized sender', () => {
  assert(!validateSender('hacker@evil.com', ['user@example.com']));
});

test('rejects empty allowed list', () => {
  assert(!validateSender('user@example.com', []));
});

// ============ parseForwardedHeaders tests ============

console.log('\n--- parseForwardedHeaders tests ---');

test('extracts original sender from forwarded email', () => {
  const text = `
---------- Forwarded message ---------
From: Client Person <client@company.com>
Date: Mon, Dec 9, 2024 at 10:00 AM
Subject: Project Update
To: me@example.com

Hello, this is the email body.
`;
  const result = parseForwardedHeaders(text, ['me@example.com']);
  assert(result.originalFrom.includes('client@company.com'));
});

test('skips self as sender when forwarding own reply', () => {
  const text = `
On Mon, Dec 9, 2024 at 11:00 AM Me <me@example.com> wrote:
> Thanks for the update!

---------- Forwarded message ---------
From: Client Person <client@company.com>
Date: Mon, Dec 9, 2024 at 10:00 AM

Original message here.
`;
  const result = parseForwardedHeaders(text, ['me@example.com']);
  assert(result.originalFrom.includes('client@company.com'));
});

test('returns null for empty text', () => {
  const result = parseForwardedHeaders('', []);
  assertEqual(result.originalFrom, null);
  assertEqual(result.originalDate, null);
});

test('extracts date from same block as sender', () => {
  // When you forwarded your own reply, the date should come from the client's message, not yours
  const text = `
---------- Forwarded message ---------
From: Me <me@example.com>
Date: Tue, Dec 10, 2024 at 9:00 AM
Subject: Re: Project Update
To: client@company.com

Thanks for the update!

---------- Forwarded message ---------
From: Client Person <client@company.com>
Date: Mon, Dec 9, 2024 at 10:00 AM
Subject: Project Update
To: me@example.com

Here is the original message.
`;
  const result = parseForwardedHeaders(text, ['me@example.com']);
  assert(result.originalFrom.includes('client@company.com'), 'Should extract client as sender');
  assert(result.originalDate.includes('2024-12-09'), 'Should extract Dec 9 date from client message, not Dec 10');
});

// ============ stripForwardingHeaders tests ============

console.log('\n--- stripForwardingHeaders tests ---');

test('strips Gmail forwarding header', () => {
  const text = `---------- Forwarded message ---------
From: someone@example.com
Date: Mon, Dec 9, 2024
Subject: Test
To: me@example.com

The actual content.`;
  const result = stripForwardingHeaders(text);
  assert(!result.includes('Forwarded message'));
  assert(result.includes('actual content'));
});

test('strips Outlook forwarding header', () => {
  const text = `________________________________
From: someone@example.com
Sent: Monday, December 9, 2024
To: me@example.com

The actual content.`;
  const result = stripForwardingHeaders(text);
  assert(!result.includes('________________________________'));
  assert(result.includes('actual content'));
});

test('strips Apple Mail forwarding header', () => {
  const text = `Begin forwarded message:

From: someone@example.com
Subject: Test
Date: December 9, 2024

The actual content.`;
  const result = stripForwardingHeaders(text);
  assert(!result.includes('Begin forwarded message'));
  assert(result.includes('actual content'));
});

// ============ filterAttachments tests ============

console.log('\n--- filterAttachments tests ---');

test('allows PDF attachments', () => {
  const attachments = [
    { Name: 'document.pdf', ContentLength: 1000, ContentID: '' }
  ];
  const { valid, warnings } = filterAttachments(attachments);
  assertEqual(valid.length, 1);
  assertEqual(warnings.length, 0);
});

test('blocks executable files', () => {
  const attachments = [
    { Name: 'malware.exe', ContentLength: 1000, ContentID: '' }
  ];
  const { valid, warnings } = filterAttachments(attachments);
  assertEqual(valid.length, 0);
  assertEqual(warnings.length, 1);
  assert(warnings[0].includes('blocked file type'));
});

test('skips CID-embedded images', () => {
  const attachments = [
    { Name: 'logo.png', ContentLength: 1000, ContentID: 'cid:12345' }
  ];
  const { valid, warnings } = filterAttachments(attachments);
  assertEqual(valid.length, 0);
  assertEqual(warnings.length, 0); // Silent skip
});

test('rejects oversized files', () => {
  const attachments = [
    { Name: 'huge.zip', ContentLength: 25 * 1024 * 1024, ContentID: '' }
  ];
  const { valid, warnings } = filterAttachments(attachments);
  assertEqual(valid.length, 0);
  assertEqual(warnings.length, 1);
  assert(warnings[0].includes('exceeds'));
});

// ============ extractEmail tests ============

console.log('\n--- extractEmail tests ---');

test('extracts email from angle brackets', () => {
  assertEqual(extractEmail('John Doe <john@example.com>'), 'john@example.com');
});

test('extracts plain email', () => {
  assertEqual(extractEmail('john@example.com'), 'john@example.com');
});

test('returns null for invalid input', () => {
  assertEqual(extractEmail('not an email'), null);
});

// ============ SES parsing tests ============

console.log('\n--- SES parsing tests ---');

test('detects SES event', () => {
  const sesEvent = {
    Records: [{ eventSource: 'aws:ses', ses: { mail: {}, receipt: {} } }]
  };
  assert(isSesEvent(sesEvent));
});

test('rejects non-SES event', () => {
  const httpEvent = { body: '{}' };
  assert(!isSesEvent(httpEvent));
});

test('rejects empty event', () => {
  assert(!isSesEvent({}));
  assert(!isSesEvent(null));
  assert(!isSesEvent(undefined));
});

// ============ MIME parsing tests ============

// Helper for async tests
async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    failed++;
  }
}

// Run async tests
async function runAsyncTests() {
  console.log('\n--- MIME parsing tests ---');

  await testAsync('parses simple plain text MIME email', async () => {
    const mime = `From: sender@example.com
To: recipient@example.com
Subject: Test Subject
Content-Type: text/plain; charset="UTF-8"

This is the body.`;

    const result = await parseMimeEmail(mime);
    assertEqual(result.From, 'sender@example.com');
    assertEqual(result.To, 'recipient@example.com');
    assertEqual(result.Subject, 'Test Subject');
    assert(result.TextBody.includes('This is the body'));
  });

  await testAsync('parses email with display name', async () => {
    const mime = `From: John Doe <john@example.com>
To: Jane Smith <jane@example.com>
Subject: Hello

Hi there!`;

    const result = await parseMimeEmail(mime);
    assertEqual(result.From, 'John Doe <john@example.com>');
    assertEqual(result.FromName, 'John Doe');
    assert(result.To.includes('jane@example.com'));
  });

  await testAsync('parses multipart email with HTML and text', async () => {
    const mime = `From: sender@example.com
To: recipient@example.com
Subject: Multipart Test
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="boundary123"

--boundary123
Content-Type: text/plain; charset="UTF-8"

Plain text version.

--boundary123
Content-Type: text/html; charset="UTF-8"

<html><body><p>HTML version.</p></body></html>

--boundary123--`;

    const result = await parseMimeEmail(mime);
    assert(result.TextBody.includes('Plain text version'));
    assert(result.HtmlBody.includes('HTML version'));
  });

  await testAsync('parses email with attachment', async () => {
    const mime = `From: sender@example.com
To: recipient@example.com
Subject: With Attachment
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="boundary456"

--boundary456
Content-Type: text/plain; charset="UTF-8"

See attached.

--boundary456
Content-Type: application/pdf; name="test.pdf"
Content-Disposition: attachment; filename="test.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQKJeLjz9MK
--boundary456--`;

    const result = await parseMimeEmail(mime);
    assertEqual(result.Attachments.length, 1);
    assertEqual(result.Attachments[0].Name, 'test.pdf');
    assertEqual(result.Attachments[0].ContentType, 'application/pdf');
    assert(result.Attachments[0].Content.length > 0);
  });

  await testAsync('handles CID-embedded images', async () => {
    const mime = `From: sender@example.com
To: recipient@example.com
Subject: Inline Image
MIME-Version: 1.0
Content-Type: multipart/related; boundary="boundary789"

--boundary789
Content-Type: text/html; charset="UTF-8"

<html><body><img src="cid:logo123"></body></html>

--boundary789
Content-Type: image/png; name="logo.png"
Content-ID: <logo123>
Content-Transfer-Encoding: base64

iVBORw0KGgo=
--boundary789--`;

    const result = await parseMimeEmail(mime);
    // Should have the inline image with ContentID set
    assertEqual(result.Attachments.length, 1);
    assertEqual(result.Attachments[0].ContentID, 'logo123');
  });
}

// ============ Run async tests and summary ============

runAsyncTests().then(() => {
  console.log('\n--- Summary ---');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}).catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
