/**
 * Validation functions for incoming emails
 */

/**
 * Validate that the recipient address contains the correct inbox secret
 * @param {string} toAddress - The recipient email address (may include display name)
 * @param {string} inboxSecret - The expected secret
 * @returns {boolean} - True if valid
 */
function validateRecipient(toAddress, inboxSecret) {
  if (!toAddress || !inboxSecret) {
    return false;
  }

  // Extract email from "Display Name <email>" format if present
  const email = extractEmail(toAddress);
  if (!email) {
    return false;
  }

  // Extract the local part before @
  const localPart = email.split('@')[0]?.toLowerCase();

  // Expected format: notion-{secret}
  const expectedPrefix = `notion-${inboxSecret.toLowerCase()}`;

  return localPart === expectedPrefix;
}

/**
 * Validate that the sender is in the allowed senders list
 * @param {string} fromAddress - The sender email address
 * @param {string[]} allowedSenders - List of allowed email addresses
 * @returns {boolean} - True if valid
 */
function validateSender(fromAddress, allowedSenders) {
  if (!fromAddress || !allowedSenders || allowedSenders.length === 0) {
    return false;
  }

  // Extract email from "Name <email>" format if present
  const email = extractEmail(fromAddress);
  if (!email) {
    return false;
  }

  return allowedSenders.includes(email.toLowerCase());
}

/**
 * Extract email address from a string that may be in "Name <email>" format
 * @param {string} fromString - The from string
 * @returns {string|null} - The extracted email or null
 */
function extractEmail(fromString) {
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

module.exports = {
  validateRecipient,
  validateSender,
  extractEmail,
};
