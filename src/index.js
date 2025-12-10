/**
 * Email-to-Notion Lambda Handler
 *
 * Receives inbound emails from Postmark and creates entries in a Notion database.
 */

const { SSMClient, GetParametersCommand } = require('@aws-sdk/client-ssm');
const { validateRecipient, validateSender } = require('./validate');
const { parseSubject, parseForwardedHeaders, stripForwardingHeaders } = require('./parse');
const { processEmailBody } = require('./convert');
const { createClient, createEmailEntry, getPageUrl, addWarningCallout } = require('./notion');
const { filterAttachments, uploadAttachments } = require('./attachments');
const { summarizeEmail, createSummaryBlock } = require('./summarize');
const { notifyError, notifyWarning } = require('./notify');

const ssmClient = new SSMClient({});

// Cache config to avoid SSM calls on every invocation
let cachedConfig = null;
let configLoadedAt = null;
const CONFIG_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Load configuration from SSM Parameter Store
 */
async function loadConfig() {
  // Return cached config if still valid
  if (cachedConfig && configLoadedAt && (Date.now() - configLoadedAt) < CONFIG_TTL_MS) {
    return cachedConfig;
  }

  const parameterNames = [
    '/email-to-notion/inbox-secret',
    '/email-to-notion/allowed-senders',
    '/email-to-notion/notion-database-id',
    '/email-to-notion/notion-api-key',
    '/email-to-notion/postmark-server-token',
    '/email-to-notion/anthropic-api-key',
    '/email-to-notion/summary-prompt',
  ];

  const command = new GetParametersCommand({
    Names: parameterNames,
    WithDecryption: true,
  });

  const response = await ssmClient.send(command);

  const params = {};
  for (const param of response.Parameters) {
    const key = param.Name.split('/').pop();
    params[key] = param.Value;
  }

  cachedConfig = {
    inboxSecret: params['inbox-secret'],
    allowedSenders: params['allowed-senders']?.split(',').map(s => s.trim().toLowerCase()) || [],
    notionDatabaseId: params['notion-database-id'],
    notionApiKey: params['notion-api-key'],
    postmarkServerToken: params['postmark-server-token'],
    anthropicApiKey: params['anthropic-api-key'] !== 'disabled' ? params['anthropic-api-key'] : null,
    summaryPrompt: params['summary-prompt'] !== 'disabled' ? params['summary-prompt'] : null,
  };

  configLoadedAt = Date.now();
  return cachedConfig;
}

/**
 * Main Lambda handler
 */
exports.handler = async (event) => {
  const requestId = event.requestContext?.requestId || 'unknown';
  console.log('Received request', { requestId });

  try {
    // Parse the incoming request body
    let body;
    try {
      if (event.body) {
        body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      } else {
        body = event;
      }
    } catch (parseError) {
      console.error('Failed to parse request body', { requestId, error: parseError.message });
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'OK', error: 'Invalid request body' }),
      };
    }

    // Validate required fields exist
    if (!body || typeof body !== 'object') {
      console.error('Invalid request body structure', { requestId });
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'OK', error: 'Invalid request body' }),
      };
    }

    // Load configuration
    const config = await loadConfig();

    // Log receipt (avoid logging full email content for privacy)
    console.log('Email received', {
      requestId,
      from: body.From,
      to: body.To,
      subject: body.Subject?.slice(0, 100), // Truncate for logging
      hasAttachments: body.Attachments?.length > 0,
      attachmentCount: body.Attachments?.length || 0,
    });

    // Stage 2: Validate recipient address
    if (!validateRecipient(body.To, config.inboxSecret)) {
      console.log('Rejected: invalid recipient address', { requestId, to: body.To });
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'OK' }),
      };
    }

    // Stage 2: Validate sender is in allowed list
    if (!validateSender(body.From, config.allowedSenders)) {
      console.log('Rejected: unauthorized sender', { requestId, from: body.From });
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'OK' }),
      };
    }

    console.log('Validation passed', { requestId });

    // Derive notification sender address from the To address
    const notificationFrom = body.To || 'noreply@example.com';

    // Stage 3: Parse subject line
    const parsed = parseSubject(body.Subject);
    const client = parsed.client;
    const cleanSubject = parsed.subject;
    console.log('Subject parsed', { requestId, client, cleanSubject: cleanSubject?.slice(0, 100) });

    // Stage 4: Parse forwarded headers to get original sender
    const emailText = body.TextBody || '';
    const { originalFrom, originalDate } = parseForwardedHeaders(emailText, config.allowedSenders);

    // Use extracted data or fall back to Postmark data
    const fromAddress = originalFrom || body.From;
    const emailDate = originalDate || body.Date;

    console.log('Headers parsed', {
      requestId,
      originalFrom: originalFrom ? 'extracted' : 'fallback',
      originalDate: originalDate ? 'extracted' : 'fallback',
    });

    // Stage 4: Strip forwarding headers from body
    const cleanedTextBody = stripForwardingHeaders(emailText);

    // Stage 5: Process email body (convert to Notion blocks)
    const htmlBody = body.HtmlBody || '';
    const contentBlocks = processEmailBody(htmlBody, cleanedTextBody, config.allowedSenders);

    console.log('Content processed', { requestId, blockCount: contentBlocks.length });

    // Stage 7: Filter attachments
    const rawAttachments = body.Attachments || [];
    const { valid: validAttachments, warnings: attachmentWarnings } = filterAttachments(rawAttachments);
    const hasAttachments = validAttachments.length > 0;

    console.log('Attachments filtered', {
      requestId,
      total: rawAttachments.length,
      valid: validAttachments.length,
      warningCount: attachmentWarnings.length,
    });

    // Stage 8: AI summarization (if configured)
    let summary = null;
    if (config.anthropicApiKey && config.summaryPrompt) {
      summary = await summarizeEmail(cleanedTextBody, config.summaryPrompt, config.anthropicApiKey);
      if (summary) {
        console.log('Summary generated', { requestId, length: summary.length });
      }
    }

    // Prepend summary callout to content blocks (so it appears at top of page)
    const finalContentBlocks = [...contentBlocks];
    if (summary) {
      finalContentBlocks.unshift(createSummaryBlock(summary));
    }

    // Stage 6: Create Notion entry
    const notionClient = createClient(config.notionApiKey);

    const page = await createEmailEntry(notionClient, {
      databaseId: config.notionDatabaseId,
      subject: cleanSubject,
      from: fromAddress,
      date: emailDate,
      client,
      hasAttachments,
      summary,
      contentBlocks: finalContentBlocks,
    });

    const pageUrl = getPageUrl(page);
    console.log('Notion entry created', { requestId, pageId: page.id, client });

    // Stage 7: Upload attachments to page
    if (validAttachments.length > 0) {
      const { uploaded, warnings: uploadWarnings } = await uploadAttachments(
        notionClient,
        page.id,
        validAttachments,
        config.notionApiKey
      );
      attachmentWarnings.push(...uploadWarnings);
      console.log('Attachments processed', { requestId, uploaded });
    }

    // Add warning callout if there were attachment issues
    if (attachmentWarnings.length > 0) {
      await addWarningCallout(notionClient, page.id, attachmentWarnings);
      console.log('Added attachment warnings', { requestId, count: attachmentWarnings.length });
    }

    // Collect all warnings for potential notification
    const allWarnings = [...attachmentWarnings];

    // Stage 9: Send warning notification if there were issues
    if (allWarnings.length > 0) {
      await notifyWarning(config, body.From, pageUrl, allWarnings, notificationFrom);
    }

    console.log('Email processed successfully', {
      requestId,
      client,
      pageId: page.id,
      hasAttachments,
      hasSummary: !!summary,
      warningCount: allWarnings.length,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'OK', pageUrl }),
    };

  } catch (error) {
    // Always return 200 to Postmark to prevent retries
    // Log the error for debugging
    console.error('Error processing email', {
      requestId,
      error: error.message,
      stack: error.stack,
    });

    // Try to send error notification if we have enough context
    try {
      const config = cachedConfig || await loadConfig();
      if (config.postmarkServerToken && event.body) {
        const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        const notificationFrom = body.To || 'noreply@example.com';
        await notifyError(config, body.From, body.Subject, error.message, notificationFrom);
      }
    } catch (notifyErr) {
      console.error('Failed to send error notification', { requestId, error: notifyErr.message });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'OK', error: error.message }),
    };
  }
};
