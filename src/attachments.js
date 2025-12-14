/**
 * Attachment handling for email-to-notion
 */

// File types that should be displayed as images in Notion
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];

// File types that should be displayed as PDFs in Notion
const PDF_EXTENSIONS = ['pdf'];

// File types that are blocked for security
const BLOCKED_EXTENSIONS = ['exe', 'dll', 'bat', 'sh', 'cmd', 'com', 'msi', 'vbs', 'js', 'ps1'];

// Maximum file size (20MB - Notion's limit)
const MAX_FILE_SIZE = 20 * 1024 * 1024;

// MIME type mapping
const MIME_TYPES = {
  'pdf': 'application/pdf',
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'bmp': 'image/bmp',
  'doc': 'application/msword',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xls': 'application/vnd.ms-excel',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'ppt': 'application/vnd.ms-powerpoint',
  'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'txt': 'text/plain',
  'csv': 'text/csv',
  'zip': 'application/zip',
};

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
 * Get MIME type for a file extension
 * @param {string} filename - The filename
 * @returns {string} - MIME type
 */
function getMimeType(filename) {
  const ext = getExtension(filename).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Sanitize filename for use in HTTP headers (prevents header injection)
 * @param {string} filename - The filename
 * @returns {string} - Sanitized filename
 */
function sanitizeFilename(filename) {
  if (!filename) return 'attachment';
  return filename
    .replace(/[\r\n]/g, '')    // Remove CRLF (header injection)
    .replace(/"/g, '\\"');      // Escape quotes
}

/**
 * Check if a file should be displayed as a PDF in Notion
 * @param {string} filename - The filename
 * @returns {boolean}
 */
function isPdfFile(filename) {
  const ext = getExtension(filename).toLowerCase();
  return PDF_EXTENSIONS.includes(ext);
}

/**
 * Get the Notion block type for a file
 * @param {string} filename - The filename
 * @returns {string} - Block type (image, pdf, or file)
 */
function getBlockType(filename) {
  if (isImageFile(filename)) return 'image';
  if (isPdfFile(filename)) return 'pdf';
  return 'file';
}

/**
 * Upload a single file to Notion using the file upload API
 * @param {string} notionApiKey - Notion API key
 * @param {string} filename - The filename
 * @param {string} base64Content - Base64 encoded file content
 * @returns {Promise<string|null>} - File upload ID or null on failure
 */
async function uploadFileToNotion(notionApiKey, filename, base64Content) {
  const mimeType = getMimeType(filename);

  try {
    // Step 1: Create file upload object
    const createResponse = await fetch('https://api.notion.com/v1/file_uploads', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${notionApiKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filename: filename,
        content_type: mimeType,
      }),
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      console.warn(`File upload create failed (${createResponse.status}): ${errorText.slice(0, 200)}`);
      return null;
    }

    const createData = await createResponse.json();
    const fileUploadId = createData.id;

    if (!fileUploadId) {
      console.warn(`No file upload ID returned for ${filename}`);
      return null;
    }

    // Step 2: Send file content using multipart/form-data
    // Decode base64 to binary
    const binaryContent = Buffer.from(base64Content, 'base64');

    // Create multipart form data manually
    const boundary = '----NotionFileUpload' + Date.now();
    const formDataParts = [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="file"; filename="${sanitizeFilename(filename)}"\r\n`,
      `Content-Type: ${mimeType}\r\n\r\n`,
    ];

    const header = Buffer.from(formDataParts.join(''));
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, binaryContent, footer]);

    const sendResponse = await fetch(`https://api.notion.com/v1/file_uploads/${fileUploadId}/send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${notionApiKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: body,
    });

    if (!sendResponse.ok) {
      const errorText = await sendResponse.text();
      console.warn(`File upload send failed (${sendResponse.status}): ${errorText.slice(0, 200)}`);
      return null;
    }

    console.log(`Uploaded file: ${filename}`);
    return fileUploadId;

  } catch (error) {
    console.error(`Failed to upload ${filename}: ${error.message}`);
    return null;
  }
}

/**
 * Upload attachments to a Notion page using the file upload API
 * @param {Object} notionClient - Notion client
 * @param {string} pageId - Notion page ID
 * @param {Array} attachments - Valid attachments to upload
 * @param {string} notionApiKey - Notion API key for file uploads
 * @returns {{ uploaded: number, warnings: string[] }}
 */
async function uploadAttachments(notionClient, pageId, attachments, notionApiKey) {
  const warnings = [];
  let uploaded = 0;

  if (!attachments || attachments.length === 0) {
    return { uploaded, warnings };
  }

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

  // Upload and add each attachment
  for (const att of attachments) {
    const filename = att.Name || 'unknown';
    const base64Content = att.Content || att.ContentData;

    if (!base64Content) {
      warnings.push(`No content for attachment: ${filename}`);
      continue;
    }

    // Upload file to Notion
    const fileUploadId = await uploadFileToNotion(notionApiKey, filename, base64Content);

    if (fileUploadId) {
      // Create appropriate block type based on file extension
      const blockType = getBlockType(filename);
      const fileObj = { type: 'file_upload', file_upload: { id: fileUploadId } };

      if (blockType === 'image') {
        blocks.push({
          type: 'image',
          image: fileObj,
        });
      } else if (blockType === 'pdf') {
        blocks.push({
          type: 'pdf',
          pdf: fileObj,
        });
      } else {
        blocks.push({
          type: 'file',
          file: fileObj,
        });
      }
      uploaded++;
    } else {
      // Fallback: list the attachment with a warning
      const size = formatFileSize(att.ContentLength || 0);
      blocks.push({
        type: 'callout',
        callout: {
          icon: { type: 'emoji', emoji: '⚠️' },
          color: 'yellow_background',
          rich_text: [
            {
              type: 'text',
              text: { content: `Failed to upload: ${filename} (${size})` },
            },
          ],
        },
      });
      warnings.push(`Failed to upload: ${filename}`);
    }
  }

  // Append blocks to page
  if (blocks.length > 0) {
    await notionClient.blocks.children.append({
      block_id: pageId,
      children: blocks,
    });
  }

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
