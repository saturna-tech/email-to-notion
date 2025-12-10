/**
 * Attachment handling for email-to-notion
 */

const { Client } = require('@notionhq/client');

// File types that should be displayed as images in Notion
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];

// File types that are blocked for security
const BLOCKED_EXTENSIONS = ['exe', 'dll', 'bat', 'sh', 'cmd', 'com', 'msi', 'vbs', 'js', 'ps1'];

// Maximum file size (20MB - Notion's limit)
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/**
 * Filter attachments to include only valid ones
 * @param {Array} attachments - Postmark attachments array
 * @returns {{ valid: Array, warnings: string[] }} - Valid attachments and warning messages
 */
function filterAttachments(attachments) {
  if (!attachments || attachments.length === 0) {
    return { valid: [], warnings: [] };
  }

  const valid = [];
  const warnings = [];

  for (const att of attachments) {
    // Skip CID-embedded images (used in HTML email templates)
    if (att.ContentID && att.ContentID !== '') {
      continue; // Silent skip - these are inline images
    }

    const filename = att.Name || 'unknown';
    const ext = getExtension(filename).toLowerCase();
    const size = att.ContentLength || 0;

    // Check for blocked extensions
    if (BLOCKED_EXTENSIONS.includes(ext)) {
      warnings.push(`Attachment skipped: ${filename} (blocked file type)`);
      continue;
    }

    // Check file size
    if (size > MAX_FILE_SIZE) {
      const sizeMB = (size / (1024 * 1024)).toFixed(1);
      warnings.push(`Attachment skipped: ${filename} (${sizeMB}MB exceeds 20MB limit)`);
      continue;
    }

    valid.push(att);
  }

  return { valid, warnings };
}

/**
 * Get file extension from filename
 * @param {string} filename - The filename
 * @returns {string} - Extension without dot, or empty string
 */
function getExtension(filename) {
  if (!filename) return '';
  const parts = filename.split('.');
  if (parts.length < 2) return '';
  return parts[parts.length - 1];
}

/**
 * Check if a file should be displayed as an image
 * @param {string} filename - The filename
 * @returns {boolean}
 */
function isImageFile(filename) {
  const ext = getExtension(filename).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Format file size for display
 * @param {number} bytes - Size in bytes
 * @returns {string} - Formatted size
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Upload attachments to a Notion page
 * Note: Notion's API doesn't support direct file uploads for external integrations.
 * Files must be hosted externally. For this implementation, we'll create file blocks
 * that reference the original email (which won't work since Postmark doesn't host files).
 *
 * Alternative approach: We'll note that attachments existed but can't be uploaded directly.
 * In practice, you would need to:
 * 1. Upload to S3 or another hosting service, OR
 * 2. Use Notion's internal upload (not available via public API), OR
 * 3. Accept that attachments are noted but not viewable
 *
 * For this implementation, we'll add a note about attachments.
 *
 * @param {Client} notionClient - Notion client
 * @param {string} pageId - Notion page ID
 * @param {Array} attachments - Valid attachments to upload
 * @returns {{ uploaded: number, warnings: string[] }}
 */
async function uploadAttachments(notionClient, pageId, attachments) {
  const warnings = [];
  let uploaded = 0;

  if (!attachments || attachments.length === 0) {
    return { uploaded, warnings };
  }

  // Create blocks to note the attachments
  // Since Notion API doesn't support direct file uploads from base64,
  // we'll create a section listing the attachments that were in the email

  const blocks = [];

  // Add divider before attachments
  blocks.push({
    type: 'divider',
    divider: {},
  });

  // Add attachments header
  blocks.push({
    type: 'paragraph',
    paragraph: {
      rich_text: [
        {
          type: 'text',
          text: { content: 'Attachments:' },
          annotations: { bold: true },
        },
      ],
    },
  });

  // List each attachment
  for (const att of attachments) {
    const filename = att.Name || 'unknown';
    const size = formatFileSize(att.ContentLength || 0);
    const isImage = isImageFile(filename);
    const icon = isImage ? '🖼️' : '📎';

    blocks.push({
      type: 'bulleted_list_item',
      bulleted_list_item: {
        rich_text: [
          {
            type: 'text',
            text: { content: `${icon} ${filename} (${size})` },
          },
        ],
      },
    });

    uploaded++;
  }

  // Add note about attachment limitation
  blocks.push({
    type: 'callout',
    callout: {
      icon: { type: 'emoji', emoji: 'ℹ️' },
      color: 'gray_background',
      rich_text: [
        {
          type: 'text',
          text: {
            content: 'Note: Attachments are listed but not uploaded. Retrieve originals from your email client.',
          },
        },
      ],
    },
  });

  // Append blocks to page
  await notionClient.blocks.children.append({
    block_id: pageId,
    children: blocks,
  });

  return { uploaded, warnings };
}

/**
 * Create warning callout block for attachment issues
 * @param {string[]} warnings - Warning messages
 * @returns {Object} - Notion callout block
 */
function createWarningBlock(warnings) {
  return {
    type: 'callout',
    callout: {
      icon: { type: 'emoji', emoji: '⚠️' },
      color: 'yellow_background',
      rich_text: [
        {
          type: 'text',
          text: { content: warnings.join('\n') },
        },
      ],
    },
  };
}

module.exports = {
  filterAttachments,
  uploadAttachments,
  isImageFile,
  formatFileSize,
  createWarningBlock,
  BLOCKED_EXTENSIONS,
  MAX_FILE_SIZE,
};
