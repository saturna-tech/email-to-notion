/**
 * Parsing functions for email subject and forwarded headers
 */

/**
 * Parse subject line to extract client tag and clean subject
 * @param {string} subject - The email subject line
 * @returns {{ client: string, subject: string }} - Parsed result
 * @throws {Error} - If client tag is missing
 */
function parseSubject(subject) {
  if (!subject) {
    subject = '';
  }

  // Extract client tag: #clientname or #clientname: (colon optional)
  const clientMatch = subject.match(/^#(\w+):?\s*/);

  let client;
  let cleanSubject;

  if (clientMatch) {
    // Sanitize client name: lowercase, alphanumeric only, max 50 chars
    client = clientMatch[1].toLowerCase();
    client = client.replace(/[^a-z0-9]/g, '');
    if (client.length > 50) {
      client = client.slice(0, 50);
    }
    if (!client) {
      client = 'missing';
    }
    cleanSubject = subject.slice(clientMatch[0].length);
  } else {
    // No hashtag found, use "missing" as client
    client = 'missing';
    cleanSubject = subject;
  }

  // Strip common forwarding/reply prefixes (case-insensitive, can repeat)
  const prefixPattern = /^(fwd|fw|re|reply):\s*/i;
  while (prefixPattern.test(cleanSubject)) {
    cleanSubject = cleanSubject.replace(prefixPattern, '');
  }

  return {
    client,
    subject: cleanSubject.trim(),
  };
}

/**
 * Parse forwarded email headers to extract original sender and date
 * @param {string} text - The email body text
 * @param {string[]} allowedSenders - List of allowed senders (to skip self-replies)
 * @returns {{ originalFrom: string|null, originalDate: string|null }}
 */
function parseForwardedHeaders(text, allowedSenders) {
  let originalFrom = null;
  let originalDate = null;

  if (!text) {
    return { originalFrom, originalDate };
  }

  // Normalize allowed senders to lowercase
  const selfEmails = (allowedSenders || []).map(s => s.toLowerCase());

  // Find all "From:" occurrences in the text
  // This handles cases where your reply is at the top of the forwarded thread
  const fromPattern = /From:\s*(.+?)(?:\n|$)/gim;

  let match;
  while ((match = fromPattern.exec(text)) !== null) {
    const fromValue = match[1].trim();
    const emailInFrom = extractEmailFromHeader(fromValue);

    // Skip if this is one of the allowed senders (i.e., yourself)
    if (emailInFrom && selfEmails.includes(emailInFrom.toLowerCase())) {
      continue;
    }

    // Found a non-self sender
    originalFrom = fromValue;
    break;
  }

  // Get the date - look for Date: or Sent: field
  const datePattern = /(?:Date|Sent):\s*(.+?)(?:\n|$)/im;
  const dateMatch = text.match(datePattern);
  if (dateMatch) {
    originalDate = parseDateString(dateMatch[1].trim());
  }

  return { originalFrom, originalDate };
}

/**
 * Extract email address from a header value like "John Doe <john@example.com>"
 * @param {string} fromString - The from header value
 * @returns {string|null} - The extracted email or null
 */
function extractEmailFromHeader(fromString) {
  if (!fromString) {
    return null;
  }

  // Try to match "<email>" format
  const bracketMatch = fromString.match(/<([^>]+)>/);
  if (bracketMatch) {
    return bracketMatch[1].toLowerCase();
  }

  // Try to match plain email
  const emailMatch = fromString.match(/([^\s]+@[^\s]+)/);
  if (emailMatch) {
    return emailMatch[1].toLowerCase();
  }

  return null;
}

/**
 * Parse a date string from various email client formats
 * @param {string} dateString - The date string to parse
 * @returns {string|null} - ISO date string or null
 */
function parseDateString(dateString) {
  if (!dateString) {
    return null;
  }

  // Try to parse with Date constructor
  const parsed = new Date(dateString);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return null;
}

/**
 * Strip forwarding headers from email body
 * @param {string} text - The email body text
 * @returns {string} - Cleaned text
 */
function stripForwardingHeaders(text) {
  if (!text) {
    return '';
  }

  let result = text;

  // Gmail: "---------- Forwarded message ---------"
  result = result.replace(
    /^-{5,}\s*Forwarded message\s*-{5,}\s*\n(From:.*\n)?(Date:.*\n)?(Subject:.*\n)?(To:.*\n)?(Cc:.*\n)?/gim,
    ''
  );

  // Outlook: "________________________________"
  result = result.replace(
    /^_{5,}\s*\n(From:.*\n)?(Sent:.*\n)?(To:.*\n)?(Cc:.*\n)?(Subject:.*\n)?/gim,
    ''
  );

  // Apple Mail: "Begin forwarded message:"
  result = result.replace(
    /^Begin forwarded message:\s*\n\n?(From:.*\n)?(Subject:.*\n)?(Date:.*\n)?(To:.*\n)?(Cc:.*\n)?/gim,
    ''
  );

  // Generic "Original Message" header
  result = result.replace(
    /^-{3,}\s*Original Message\s*-{3,}\s*\n(From:.*\n)?(Sent:.*\n)?(To:.*\n)?(Subject:.*\n)?/gim,
    ''
  );

  // Gmail inline quote headers: "On Mon, Dec 9, 2024 at 10:30 AM John Doe <email> wrote:"
  result = result.replace(
    /^On .+wrote:\s*$/gim,
    ''
  );

  return result.trim();
}

module.exports = {
  parseSubject,
  parseForwardedHeaders,
  stripForwardingHeaders,
  extractEmailFromHeader,
  parseDateString,
};
