/**
 * Basic unit tests for email-to-notion
 * Run with: node test.js
 */

const { parseSubject, parseForwardedHeaders, stripForwardingHeaders } = require('./parse');
const { validateRecipient, validateSender, extractEmail } = require('./validate');
const { filterAttachments } = require('./attachments');

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

// ============ Summary ============

console.log('\n--- Summary ---');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
