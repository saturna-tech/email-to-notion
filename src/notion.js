/**
 * Notion API integration
 */

const { Client } = require('@notionhq/client');
const crypto = require('crypto');

/**
 * Create a Notion client
 * @param {string} apiKey - Notion API key
 * @returns {Client} - Notion client instance
 */
function createClient(apiKey) {
  return new Client({ auth: apiKey });
}

/**
 * Create a database entry for an email
 * @param {Client} client - Notion client
 * @param {Object} options - Entry options
 * @param {string} options.databaseId - Target database ID
 * @param {string} options.subject - Email subject (cleaned)
 * @param {string} options.from - Sender address
 * @param {string} options.date - Email date (ISO string)
 * @param {string} options.client - Client name (from hashtag)
 * @param {boolean} options.hasAttachments - Whether email has attachments
 * @param {string} options.summary - AI summary (optional)
 * @param {Array} options.contentBlocks - Notion blocks for page content
 * @returns {Object} - Created page object
 */
async function createEmailEntry(client, options) {
  const {
    databaseId,
    subject,
    from,
    date,
    client: clientName,
    hasAttachments,
    summary,
    contentBlocks,
  } = options;

  // Parse date for Notion
  let dateValue = null;
  if (date) {
    try {
      const parsed = new Date(date);
      if (!isNaN(parsed.getTime())) {
        dateValue = parsed.toISOString().split('T')[0]; // YYYY-MM-DD format
      }
    } catch (e) {
      console.warn('Failed to parse date:', date);
    }
  }

  // Generate UUID for this entry
  const uuid = crypto.randomUUID();

  // Build properties
  const properties = {
    // Name is the title property
    Name: {
      title: [
        {
          text: {
            content: subject || 'Untitled',
          },
        },
      ],
    },
    // UUID - rich text
    UUID: {
      rich_text: [
        {
          text: {
            content: uuid,
          },
        },
      ],
    },
    // From - rich text
    From: {
      rich_text: [
        {
          text: {
            content: from || 'Unknown',
          },
        },
      ],
    },
    // Client - rich text
    Client: {
      rich_text: [
        {
          text: {
            content: clientName || 'Unknown',
          },
        },
      ],
    },
    // Has Attachments - checkbox
    'Has Attachments': {
      checkbox: !!hasAttachments,
    },
  };

  // Add date if we have it
  if (dateValue) {
    properties.Date = {
      date: {
        start: dateValue,
      },
    };
  }

  // Add summary if provided
  if (summary) {
    properties.Summary = {
      rich_text: [
        {
          text: {
            content: truncateText(summary, 2000),
          },
        },
      ],
    };
  }

  // Create the page
  const page = await client.pages.create({
    parent: {
      database_id: databaseId,
    },
    properties,
  });

  // Add content blocks to the page
  if (contentBlocks && contentBlocks.length > 0) {
    await appendBlocksToPage(client, page.id, contentBlocks);
  }

  return page;
}

/**
 * Append blocks to a page, handling Notion's 100 block limit per request
 * @param {Client} client - Notion client
 * @param {string} pageId - Page ID
 * @param {Array} blocks - Blocks to append
 */
async function appendBlocksToPage(client, pageId, blocks) {
  const BATCH_SIZE = 100;

  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE);

    await client.blocks.children.append({
      block_id: pageId,
      children: batch,
    });
  }
}

/**
 * Add a summary callout block at the top of a page
 * @param {Client} client - Notion client
 * @param {string} pageId - Page ID
 * @param {string} summary - Summary text
 */
async function addSummaryCallout(client, pageId, summary) {
  const callout = {
    type: 'callout',
    callout: {
      icon: { type: 'emoji', emoji: '✨' },
      color: 'blue_background',
      rich_text: [
        {
          type: 'text',
          text: {
            content: `Summary: ${truncateText(summary, 1900)}`,
          },
        },
      ],
    },
  };

  // We need to prepend, so we first get existing children, then replace
  // Actually, for simplicity, just append at the beginning of contentBlocks before creating
  // This function is here for if we need to add it separately
  await client.blocks.children.append({
    block_id: pageId,
    children: [callout],
  });
}

/**
 * Add a warning callout for failed attachments
 * @param {Client} client - Notion client
 * @param {string} pageId - Page ID
 * @param {string[]} warnings - Warning messages
 */
async function addWarningCallout(client, pageId, warnings) {
  if (!warnings || warnings.length === 0) {
    return;
  }

  const callout = {
    type: 'callout',
    callout: {
      icon: { type: 'emoji', emoji: '⚠️' },
      color: 'yellow_background',
      rich_text: [
        {
          type: 'text',
          text: {
            content: warnings.join('\n'),
          },
        },
      ],
    },
  };

  await client.blocks.children.append({
    block_id: pageId,
    children: [callout],
  });
}

/**
 * Truncate text to a maximum length
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} - Truncated text
 */
function truncateText(text, maxLength) {
  if (!text || text.length <= maxLength) {
    return text || '';
  }
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Get the URL for a Notion page
 * @param {Object} page - Notion page object
 * @returns {string} - Page URL
 */
function getPageUrl(page) {
  if (page.url) {
    return page.url;
  }
  // Construct URL from page ID
  const cleanId = page.id.replace(/-/g, '');
  return `https://notion.so/${cleanId}`;
}

module.exports = {
  createClient,
  createEmailEntry,
  appendBlocksToPage,
  addSummaryCallout,
  addWarningCallout,
  truncateText,
  getPageUrl,
};
