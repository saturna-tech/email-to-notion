/**
 * Convert email content to Notion blocks
 */

const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');

// Initialize turndown with GFM plugin
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
turndown.use(gfm);

// Ignore inline images
turndown.addRule('ignoreImages', {
  filter: 'img',
  replacement: () => '',
});

/**
 * Convert HTML to Markdown
 * @param {string} html - HTML content
 * @returns {string} - Markdown content
 */
function htmlToMarkdown(html) {
  if (!html) {
    return '';
  }
  return turndown.turndown(html);
}

/**
 * Detect plain URLs in text and convert to Markdown links
 * @param {string} text - The text to process
 * @returns {string} - Text with URLs converted to Markdown links
 */
function linkifyUrls(text) {
  if (!text) {
    return '';
  }
  // Match URLs that aren't already in Markdown link format
  const urlPattern = /(?<!\]\()(?<!\[)(https?:\/\/[^\s\]\)]+)/g;
  return text.replace(urlPattern, '[$1]($1)');
}

/**
 * Chunk text into segments that fit Notion's 2000 character limit
 * @param {string} text - Text to chunk
 * @param {number} maxLength - Maximum length per chunk
 * @returns {string[]} - Array of text chunks
 */
function chunkText(text, maxLength = 2000) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find a good break point
    let breakPoint = remaining.lastIndexOf('\n', maxLength);
    if (breakPoint === -1 || breakPoint < maxLength / 2) {
      breakPoint = remaining.lastIndexOf(' ', maxLength);
    }
    if (breakPoint === -1 || breakPoint < maxLength / 2) {
      breakPoint = maxLength;
    }

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}

/**
 * Parse inline formatting and create rich text array
 * @param {string} text - Text with potential Markdown formatting
 * @returns {Array} - Notion rich text array
 */
function parseRichText(text) {
  if (!text) {
    return [];
  }

  const richText = [];
  let remaining = text;

  // Simple regex-based parsing for bold, italic, strikethrough, and links
  // This is a simplified parser - a full implementation would use a proper Markdown parser

  const patterns = [
    // Links: [text](url)
    { regex: /\[([^\]]+)\]\(([^)]+)\)/g, type: 'link' },
    // Bold: **text** or __text__
    { regex: /\*\*([^*]+)\*\*/g, type: 'bold' },
    { regex: /__([^_]+)__/g, type: 'bold' },
    // Italic: *text* or _text_
    { regex: /\*([^*]+)\*/g, type: 'italic' },
    { regex: /_([^_]+)_/g, type: 'italic' },
    // Strikethrough: ~~text~~
    { regex: /~~([^~]+)~~/g, type: 'strikethrough' },
    // Inline code: `text`
    { regex: /`([^`]+)`/g, type: 'code' },
  ];

  // For now, use a simpler approach: just create plain text with link detection
  // Full Markdown parsing would be more complex

  // Split by Markdown link pattern and process
  const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match;

  while ((match = linkPattern.exec(remaining)) !== null) {
    // Add text before the link
    if (match.index > lastIndex) {
      const beforeText = remaining.slice(lastIndex, match.index);
      if (beforeText) {
        richText.push(...parseFormattedText(beforeText));
      }
    }

    // Add the link
    richText.push({
      type: 'text',
      text: {
        content: match[1],
        link: { url: match[2] },
      },
    });

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text after last link
  if (lastIndex < remaining.length) {
    const afterText = remaining.slice(lastIndex);
    if (afterText) {
      richText.push(...parseFormattedText(afterText));
    }
  }

  // If no links were found, process the whole text
  if (richText.length === 0 && remaining) {
    richText.push(...parseFormattedText(remaining));
  }

  return richText;
}

/**
 * Parse bold/italic/code formatting in text
 * @param {string} text - Text to parse
 * @returns {Array} - Notion rich text array
 */
function parseFormattedText(text) {
  if (!text) {
    return [];
  }

  // For simplicity, just handle the most common case: plain text
  // A full implementation would recursively parse formatting
  const result = [];

  // Remove formatting markers and just create annotated text
  // This is a simplified approach
  let content = text;
  const annotations = {};

  // Check for bold
  if (/\*\*(.+?)\*\*/.test(content)) {
    content = content.replace(/\*\*(.+?)\*\*/g, '$1');
    annotations.bold = true;
  }

  // Check for italic
  if (/\*(.+?)\*/.test(content) || /_(.+?)_/.test(content)) {
    content = content.replace(/\*(.+?)\*/g, '$1').replace(/_(.+?)_/g, '$1');
    annotations.italic = true;
  }

  // Check for strikethrough
  if (/~~(.+?)~~/.test(content)) {
    content = content.replace(/~~(.+?)~~/g, '$1');
    annotations.strikethrough = true;
  }

  // Check for code
  if (/`(.+?)`/.test(content)) {
    content = content.replace(/`(.+?)`/g, '$1');
    annotations.code = true;
  }

  if (content) {
    const textObj = {
      type: 'text',
      text: { content },
    };

    if (Object.keys(annotations).length > 0) {
      textObj.annotations = annotations;
    }

    result.push(textObj);
  }

  return result;
}

/**
 * Convert Markdown text to Notion blocks
 * @param {string} markdown - Markdown content
 * @returns {Array} - Array of Notion block objects
 */
function markdownToBlocks(markdown) {
  if (!markdown) {
    return [];
  }

  const blocks = [];
  const lines = markdown.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (!line.trim()) {
      i++;
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const type = `heading_${level}`;

      blocks.push({
        type,
        [type]: {
          rich_text: parseRichText(text),
        },
      });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(line.trim())) {
      blocks.push({
        type: 'divider',
        divider: {},
      });
      i++;
      continue;
    }

    // Bulleted list
    if (/^[-*+]\s+/.test(line)) {
      const text = line.replace(/^[-*+]\s+/, '');
      blocks.push({
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: parseRichText(text),
        },
      });
      i++;
      continue;
    }

    // Numbered list
    if (/^\d+\.\s+/.test(line)) {
      const text = line.replace(/^\d+\.\s+/, '');
      blocks.push({
        type: 'numbered_list_item',
        numbered_list_item: {
          rich_text: parseRichText(text),
        },
      });
      i++;
      continue;
    }

    // Block quote - skip if empty (just > or >> or "> > >" etc.)
    if (/^[\s>]+$/.test(line)) {
      i++;
      continue;
    }
    if (/^>\s*/.test(line)) {
      const text = line.replace(/^>\s*/, '');
      blocks.push({
        type: 'quote',
        quote: {
          rich_text: parseRichText(text),
        },
      });
      i++;
      continue;
    }

    // Code block
    if (line.startsWith('```')) {
      const codeLines = [];
      i++; // Skip opening ```
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // Skip closing ```

      const codeContent = codeLines.join('\n');
      // Chunk code if too long
      const chunks = chunkText(codeContent);
      for (const chunk of chunks) {
        blocks.push({
          type: 'code',
          code: {
            rich_text: [{ type: 'text', text: { content: chunk } }],
            language: 'plain text',
          },
        });
      }
      continue;
    }

    // Regular paragraph
    // Chunk if too long
    const chunks = chunkText(line);
    for (const chunk of chunks) {
      blocks.push({
        type: 'paragraph',
        paragraph: {
          rich_text: parseRichText(chunk),
        },
      });
    }
    i++;
  }

  return blocks;
}

/**
 * Strip forwarder's content (signature, etc.) and forwarding headers
 * Keeps only the actual forwarded email content
 * @param {string} text - The text to process
 * @returns {string} - Cleaned forwarded content
 */
function stripBeforeForwardedMessage(text) {
  if (!text) {
    return '';
  }

  // Look for common forwarded message markers and strip everything before
  const markers = [
    /-{5,}\s*Forwarded message\s*-{5,}/i,   // Gmail: ---------- Forwarded message ----------
    /Begin forwarded message:/i,             // Apple Mail
    /-{3,}\s*Original Message\s*-{3,}/i,     // Outlook
    /_{5,}/,                                  // Outlook underscores
  ];

  let result = text;

  for (const marker of markers) {
    const match = result.match(marker);
    if (match) {
      // Remove everything before and including the marker line
      result = result.slice(match.index + match[0].length);
      break;
    }
  }

  // Now strip the forwarding header block (From:, Date:, Subject:, To:, etc.)
  // These typically appear right after the marker
  result = result.replace(/^\s*\**From:\s*.+?\**\s*$/im, '');
  result = result.replace(/^\s*\**Date:\s*.+?\**\s*$/im, '');
  result = result.replace(/^\s*\**Sent:\s*.+?\**\s*$/im, '');
  result = result.replace(/^\s*\**Subject:\s*.+?\**\s*$/im, '');
  result = result.replace(/^\s*\**To:\s*.+?\**\s*$/im, '');
  result = result.replace(/^\s*\**Cc:\s*.+?\**\s*$/im, '');

  return result.trim();
}

/**
 * Process email body: HTML to Notion blocks
 * @param {string} htmlBody - HTML email body
 * @param {string} textBody - Plain text email body (fallback)
 * @param {string[]} allowedSenders - For stripping forwarding headers
 * @returns {Array} - Array of Notion block objects
 */
function processEmailBody(htmlBody, textBody, allowedSenders) {
  // Prefer HTML, fall back to plain text
  let markdown;
  if (htmlBody) {
    markdown = htmlToMarkdown(htmlBody);
  } else {
    markdown = textBody || '';
  }

  // Strip forwarder's signature/content before the forwarded message
  markdown = stripBeforeForwardedMessage(markdown);

  // Linkify plain URLs
  markdown = linkifyUrls(markdown);

  // Convert to Notion blocks
  return markdownToBlocks(markdown);
}

module.exports = {
  htmlToMarkdown,
  linkifyUrls,
  chunkText,
  parseRichText,
  markdownToBlocks,
  stripBeforeForwardedMessage,
  processEmailBody,
};
