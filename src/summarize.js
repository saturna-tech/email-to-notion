/**
 * AI summarization using Claude
 */

const Anthropic = require('@anthropic-ai/sdk');

/**
 * Summarize email content using Claude 3.5 Haiku
 * @param {string} emailBody - The email body text
 * @param {string} summaryPrompt - The prompt for summarization
 * @param {string} apiKey - Anthropic API key
 * @returns {Promise<string|null>} - Summary text or null if disabled/failed
 */
async function summarizeEmail(emailBody, summaryPrompt, apiKey) {
  // Skip if not configured
  if (!apiKey || !summaryPrompt) {
    return null;
  }

  // Skip if email body is too short
  if (!emailBody || emailBody.trim().length < 50) {
    return null;
  }

  try {
    const client = new Anthropic({ apiKey });

    // Truncate very long emails to avoid excessive token usage
    const maxInputLength = 10000;
    const truncatedBody = emailBody.length > maxInputLength
      ? emailBody.slice(0, maxInputLength) + '\n\n[Truncated...]'
      : emailBody;

    const response = await client.messages.create({
      model: 'claude-3-5-haiku-latest',
      max_tokens: 300,
      system: 'You are a concise email summarizer. Output ONLY the summary itself—no preamble, no apologies, no meta-commentary about the email quality or completeness. If the email lacks detail, summarize what IS there. Never say "I cannot" or "I apologize".',
      messages: [
        {
          role: 'user',
          content: `${summaryPrompt}\n\n---\n\n${truncatedBody}`,
        },
      ],
    });

    // Extract text from response
    if (response.content && response.content.length > 0) {
      const textContent = response.content.find(c => c.type === 'text');
      if (textContent) {
        return textContent.text.trim();
      }
    }

    return null;
  } catch (error) {
    // Log error but don't throw - summarization is non-critical
    console.warn('AI summarization failed:', error.message);
    return null;
  }
}

/**
 * Create a summary callout block for Notion
 * @param {string} summary - The summary text
 * @returns {Object} - Notion callout block
 */
function createSummaryBlock(summary) {
  return {
    type: 'callout',
    callout: {
      icon: { type: 'emoji', emoji: '✨' },
      color: 'blue_background',
      rich_text: [
        {
          type: 'text',
          text: {
            content: `Summary: ${summary}`,
          },
        },
      ],
    },
  };
}

module.exports = {
  summarizeEmail,
  createSummaryBlock,
};
