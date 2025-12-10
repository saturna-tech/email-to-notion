/**
 * Error notification via Postmark
 */

const postmark = require('postmark');

/**
 * Send a notification email
 * @param {string} serverToken - Postmark server API token
 * @param {string} to - Recipient email address
 * @param {string} from - Sender email address
 * @param {string} subject - Email subject
 * @param {string} body - Email body (plain text)
 */
async function sendNotification(serverToken, to, from, subject, body) {
  const client = new postmark.ServerClient(serverToken);

  await client.sendEmail({
    From: from,
    To: to,
    Subject: subject,
    TextBody: body,
  });
}

/**
 * Send error notification (entry not created)
 * @param {Object} config - Configuration object
 * @param {string} originalFrom - Original sender email
 * @param {string} originalSubject - Original email subject
 * @param {string} errorMessage - Error description
 * @param {string} notificationFrom - From address for notification
 */
async function notifyError(config, originalFrom, originalSubject, errorMessage, notificationFrom) {
  if (!config.postmarkServerToken) {
    console.warn('Cannot send error notification: Postmark token not configured');
    return;
  }

  const subject = 'Failed to archive email to Notion';
  const body = `Your forwarded email could not be archived.

Error: ${errorMessage}

Please check the subject line format and try again.
Expected format: #clientname: Subject Here

Original subject: "${originalSubject || 'N/A'}"

---
This is an automated message from Email-to-Notion.
`;

  try {
    await sendNotification(
      config.postmarkServerToken,
      originalFrom,
      notificationFrom,
      subject,
      body
    );
    console.log('Error notification sent', { to: originalFrom });
  } catch (err) {
    console.error('Failed to send error notification:', err.message);
  }
}

/**
 * Send warning notification (entry created but with issues)
 * @param {Object} config - Configuration object
 * @param {string} originalFrom - Original sender email
 * @param {string} pageUrl - URL to the created Notion page
 * @param {string[]} warnings - Warning messages
 * @param {string} notificationFrom - From address for notification
 */
async function notifyWarning(config, originalFrom, pageUrl, warnings, notificationFrom) {
  if (!config.postmarkServerToken) {
    console.warn('Cannot send warning notification: Postmark token not configured');
    return;
  }

  if (!warnings || warnings.length === 0) {
    return;
  }

  const subject = 'Email archived with warnings';
  const body = `Your email was archived to Notion, but some issues occurred.

Notion entry: ${pageUrl}

Warnings:
${warnings.map(w => `- ${w}`).join('\n')}

---
This is an automated message from Email-to-Notion.
`;

  try {
    await sendNotification(
      config.postmarkServerToken,
      originalFrom,
      notificationFrom,
      subject,
      body
    );
    console.log('Warning notification sent', { to: originalFrom, warningCount: warnings.length });
  } catch (err) {
    console.error('Failed to send warning notification:', err.message);
  }
}

module.exports = {
  sendNotification,
  notifyError,
  notifyWarning,
};
