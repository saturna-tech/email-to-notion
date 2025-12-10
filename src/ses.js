/**
 * SES email parsing module
 * Handles fetching raw MIME emails from S3 and parsing to Postmark-compatible format
 */

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { simpleParser } = require('mailparser');

const s3Client = new S3Client({});

/**
 * Check if event is from SES
 * @param {Object} event - Lambda event
 * @returns {boolean}
 */
function isSesEvent(event) {
  return event?.Records?.[0]?.eventSource === 'aws:ses';
}

/**
 * Parse SES event to extract message info
 * @param {Object} event - SES Lambda event
 * @returns {Object} - Parsed SES info
 */
function parseSesEvent(event) {
  const record = event.Records?.[0];
  if (!record || record.eventSource !== 'aws:ses') {
    throw new Error('Invalid SES event structure');
  }

  const ses = record.ses;
  const mail = ses.mail;

  return {
    messageId: mail.messageId,
    source: mail.source,
    destination: mail.destination,
    timestamp: mail.timestamp,
    commonHeaders: mail.commonHeaders,
  };
}

/**
 * Fetch raw email from S3
 * @param {string} bucket - S3 bucket name
 * @param {string} key - S3 object key
 * @returns {Promise<string>} - Raw MIME email content
 */
async function fetchEmailFromS3(bucket, key) {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  const response = await s3Client.send(command);
  const bodyStream = response.Body;

  // Convert stream to string
  const chunks = [];
  for await (const chunk of bodyStream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Parse MIME email to Postmark-compatible format
 * @param {string} rawEmail - Raw MIME email content
 * @returns {Promise<Object>} - Postmark-compatible payload
 */
async function parseMimeEmail(rawEmail) {
  const parsed = await simpleParser(rawEmail);

  // Extract From address (handle array or single value)
  const fromAddress = parsed.from?.value?.[0];
  const from = fromAddress
    ? (fromAddress.name ? `${fromAddress.name} <${fromAddress.address}>` : fromAddress.address)
    : '';

  // Extract To addresses
  const toAddresses = parsed.to?.value || [];
  const to = toAddresses
    .map(addr => addr.name ? `${addr.name} <${addr.address}>` : addr.address)
    .join(', ');

  // Convert attachments to Postmark format
  const attachments = (parsed.attachments || []).map(att => ({
    Name: att.filename || 'attachment',
    Content: att.content.toString('base64'),
    ContentType: att.contentType,
    ContentLength: att.size,
    ContentID: att.cid || '',
  }));

  return {
    From: from,
    FromName: fromAddress?.name || '',
    To: to,
    Subject: parsed.subject || '',
    TextBody: parsed.text || '',
    HtmlBody: parsed.html || '',
    Date: parsed.date?.toISOString() || new Date().toISOString(),
    Attachments: attachments,
    MessageID: parsed.messageId,
  };
}

/**
 * Process SES event and return Postmark-compatible payload
 * @param {Object} event - SES Lambda event
 * @param {string} bucket - S3 bucket name (from environment)
 * @returns {Promise<Object>} - Postmark-compatible payload
 */
async function processSesEvent(event, bucket) {
  const sesInfo = parseSesEvent(event);

  // Construct S3 key (SES stores with messageId as key under our prefix)
  const key = `inbound/${sesInfo.messageId}`;

  console.log('Fetching email from S3', { bucket, key, messageId: sesInfo.messageId });

  // Fetch raw email
  const rawEmail = await fetchEmailFromS3(bucket, key);

  // Parse MIME to Postmark format
  const payload = await parseMimeEmail(rawEmail);

  return {
    ...payload,
    _sesMessageId: sesInfo.messageId,
    _sesSource: sesInfo.source,
    _sesTimestamp: sesInfo.timestamp,
  };
}

module.exports = {
  isSesEvent,
  parseSesEvent,
  fetchEmailFromS3,
  parseMimeEmail,
  processSesEvent,
};
