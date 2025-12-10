# Notion Email Archiver: Design Document

## Overview

A self-hosted system that receives forwarded emails and stores them in a Notion database. You forward completed email threads to a single inbox address, tagging the client in the subject line. The system parses the forwarded content, extracts attachments, optionally generates an AI summary, and creates a database entry.

### Goals
- **Privacy**: No third-party services touch email content beyond transient processing
- **Simplicity**: Minimal AWS infrastructure (Lambda, SSM), easy to maintain
- **Zero Configuration**: No client mappings—just use a new #hashtag for new clients
- **Organization**: All emails in a single searchable Notion database with client filtering

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           EMAIL FLOW                                │
└─────────────────────────────────────────────────────────────────────┘

    Forward email to notion-{secret}@yourdomain.com
    Subject: "#clientname: Fwd: Re: Original Subject"
                │
                ▼
    ┌───────────────────┐
    │     Postmark      │  ← Inbound email processing
    │  Inbound Server   │    (parses email, POSTs JSON)
    └────────┬──────────┘
             │ HTTPS POST (webhook)
             ▼
    ┌───────────────────┐
    │   Lambda Function │  ← Parse #client from subject
    │      (Node.js)    │  ← Strip forwarding prefixes
    │                   │  ← Convert HTML to Notion blocks
    │                   │  ← Generate AI summary (optional)
    └────────┬──────────┘
             │
             ▼
    ┌───────────────────┐
    │    Notion API     │  ← Create database row
    │                   │  ← Upload attachments to page
    └───────────────────┘
```

---

## Components

### 1. Postmark Inbound Processing

**What it does**: Receives emails at your domain and forwards them as structured JSON to your webhook.

**Setup required**:
- Configure MX records for your domain (or subdomain like `mail.yourdomain.com`)
- Create an Inbound Server in Postmark
- Point the webhook URL to your Lambda function

**Postmark webhook payload** (relevant fields):
```json
{
  "From": "you@gmail.com",
  "FromName": "Your Name",
  "To": "notion-abc123secret@yourdomain.com",
  "Subject": "#acme: Fwd: Re: Q4 Invoice Discussion",
  "TextBody": "Plain text content...",
  "HtmlBody": "<html>...</html>",
  "Date": "2024-12-09T10:30:00Z",
  "Attachments": [...]
}
```

**Cost**: Free tier includes 100 inbound emails/month. $10/month for 10,000.


### 2. AWS Lambda Function

**Runtime**: Node.js 20.x
**Memory**: 512 MB (for HTML parsing and attachment processing)
**Timeout**: 60 seconds (attachments may require multiple API calls)

**Dependencies**:
- `@notionhq/client` - Official Notion SDK
- `@anthropic-ai/sdk` - Anthropic SDK for Claude API
- `postmark` - Postmark SDK for sending notification emails
- `turndown` - HTML to Markdown conversion
- `turndown-plugin-gfm` - GitHub Flavored Markdown support (tables, strikethrough)

**Responsibilities**:
1. Receive POST from Postmark
2. Validate recipient address contains the inbox secret
3. Validate sender is in the allowed senders list
4. Parse subject line to extract client tag and clean subject
5. Extract original sender and date from forwarded headers
6. Strip forwarding headers from email body
7. Convert HTML email body to Markdown, then to Notion blocks
8. Filter attachments (skip CID-embedded images, keep manual attachments)
9. Generate AI summary of email content (if enabled)
10. Create database row in Notion with properties (using extracted sender/date)
11. Upload attachments directly to the Notion page
12. Send error/warning notification email if anything fails
13. Return success/failure to Postmark

**Configuration** (via environment variables or SSM Parameter Store):
```json
{
  "inboxSecret": "your-random-secret-here",
  "notionDatabaseId": "abc123def456",
  "notionApiKey": "secret_xxx",
  "anthropicApiKey": "sk-ant-xxx",
  "summaryPrompt": "Summarize this email in 2-3 sentences, focusing on action items and key information.",
  "allowedSenders": ["you@gmail.com", "you@work.com"],
  "postmarkServerToken": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```


### 3. Subject Line Parsing

**Format**: `#clientname: Fwd: Re: Original Subject Here`

**Parsing Logic**:
```javascript
function parseSubject(subject) {
  // Extract client tag
  const clientMatch = subject.match(/^#(\w+):\s*/);
  if (!clientMatch) {
    throw new Error('Missing client tag in subject (expected #clientname:)');
  }
  const client = clientMatch[1].toLowerCase();
  let cleanSubject = subject.slice(clientMatch[0].length);

  // Strip common forwarding/reply prefixes (case-insensitive, can repeat)
  const prefixPattern = /^(fwd|fw|re|reply):\s*/i;
  while (prefixPattern.test(cleanSubject)) {
    cleanSubject = cleanSubject.replace(prefixPattern, '');
  }

  return { client, subject: cleanSubject.trim() };
}
```

**Examples**:
| Input Subject | Extracted Client | Cleaned Subject |
|---------------|------------------|-----------------|
| `#acme: Fwd: Re: Q4 Invoice` | `acme` | `Q4 Invoice` |
| `#betainc: FW: FW: Meeting Notes` | `betainc` | `Meeting Notes` |
| `#newclient: Project Kickoff` | `newclient` | `Project Kickoff` |
| `Missing hashtag` | Error | — |


### 4. Sender Validation

Only emails from whitelisted addresses are processed. All others are silently ignored (no error notification to avoid spam replies).

**Configuration**:
- `allowedSenders`: Array of email addresses permitted to forward emails

**Implementation**:
```javascript
function validateSender(fromAddress, allowedSenders) {
  const sender = fromAddress.toLowerCase().trim();
  const allowed = allowedSenders.map(s => s.toLowerCase().trim());

  if (!allowed.includes(sender)) {
    console.log(`Rejected email from unauthorized sender: ${sender}`);
    return false;
  }
  return true;
}
```

**Why whitelist instead of secret-only?**
The inbox secret prevents random spam, but anyone who discovers the address could submit entries. The sender whitelist ensures only you (from your known email addresses) can create database entries.


### 5. Lambda Function URL

**Why this over API Gateway**:
- Simpler (no additional resource to manage)
- Free (API Gateway has costs at scale)
- HTTPS endpoint built into Lambda
- Sufficient for webhook use case

**Trade-offs**:
- Less flexible than API Gateway (no request transformation, throttling controls)
- No custom domain without CloudFront (Postmark doesn't care)


### 6. Forwarded Email Parsing

When you forward an email, your email client adds headers containing the original sender information. The Lambda extracts this data before stripping the headers.

**Data to Extract**:
- **Original Sender**: The actual person who sent the email (not you, the forwarder)
- **Original Date**: When the email was originally sent (not when you forwarded it)

**Parsing Logic**:
```javascript
function parseForwardedHeaders(text, allowedSenders) {
  let originalFrom = null;
  let originalDate = null;

  // Find all "From:" occurrences in the text
  // This handles cases where your reply is at the top of the forwarded thread
  const fromPattern = /From:\s*(.+?)(?:\n|$)/gim;
  const datePattern = /(?:Date|Sent):\s*(.+?)(?:\n|$)/gim;

  let match;
  while ((match = fromPattern.exec(text)) !== null) {
    const fromValue = match[1].trim();
    const emailInFrom = extractEmail(fromValue);

    // Skip if this is one of the allowed senders (i.e., yourself)
    if (emailInFrom && isAllowedSender(emailInFrom, allowedSenders)) {
      continue;
    }

    // Found a non-self sender
    originalFrom = fromValue;
    break;
  }

  // Get the date associated with the original sender
  // (first Date/Sent after the From we matched, or first one if none found)
  const dateMatch = datePattern.exec(text);
  if (dateMatch) {
    originalDate = parseDate(dateMatch[1].trim());
  }

  return { originalFrom, originalDate };
}

function extractEmail(fromString) {
  // Extract email from "John Doe <john@example.com>" or plain "john@example.com"
  const match = fromString.match(/<([^>]+)>/) || fromString.match(/([^\s]+@[^\s]+)/);
  return match ? match[1].toLowerCase() : null;
}

function isAllowedSender(email, allowedSenders) {
  return allowedSenders.map(s => s.toLowerCase()).includes(email.toLowerCase());
}

function parseDate(dateString) {
  // Handle various date formats from email clients
  const parsed = new Date(dateString);
  if (!isNaN(parsed)) {
    return parsed.toISOString();
  }
  // Fallback: return null, use forward timestamp instead
  return null;
}
```

**Handling "Last Reply Was Me" Scenario**:

When you forward a thread where your reply is most recent, the parser skips your address and finds the first external sender:

```
---------- Forwarded message ---------
From: you@gmail.com              ← Skipped (matches allowedSenders)
Date: Mon, Dec 9, 2024 at 11:00 AM
Subject: Re: Q4 Invoice

Thanks John, I'll review this.

On Mon, Dec 9, 2024 at 10:30 AM John Doe <john@example.com> wrote:
                                  ↑ Found! This becomes originalFrom
> Please find the invoice attached.
```

Result: `From: John Doe <john@example.com>` (the client, not you)

**Database Fields Updated**:
| Field | Source | Fallback |
|-------|--------|----------|
| From | Extracted from forwarded headers | Postmark `From` (forwarder's address) |
| Date | Extracted from forwarded headers | Postmark `Date` (forward timestamp) |

**Example**:
```
You forward an email with these headers in the body:

---------- Forwarded message ---------
From: John Doe <john@example.com>
Date: Mon, Dec 9, 2024 at 10:30 AM
Subject: Q4 Invoice
To: you@gmail.com

Extracted:
- originalFrom: "John Doe <john@example.com>"
- originalDate: "2024-12-09T18:30:00.000Z"

Database entry shows:
- From: John Doe <john@example.com>  ← The actual sender
- Date: 2024-12-09                    ← When they sent it
```


### 7. Forwarding Header Stripping

After extracting sender information, the headers are stripped before storing in Notion.

**Common forwarding formats**:

Gmail:
```
---------- Forwarded message ---------
From: John Doe <john@example.com>
Date: Mon, Dec 9, 2024 at 10:30 AM
Subject: Q4 Invoice
To: Jane Smith <jane@example.com>
```

Outlook:
```
________________________________
From: John Doe <john@example.com>
Sent: Monday, December 9, 2024 10:30 AM
To: Jane Smith <jane@example.com>
Subject: Q4 Invoice
```

Apple Mail:
```
Begin forwarded message:

From: John Doe <john@example.com>
Subject: Q4 Invoice
Date: December 9, 2024 at 10:30:00 AM PST
To: Jane Smith <jane@example.com>
```

**Implementation**:
```javascript
function stripForwardingHeaders(text) {
  // Gmail
  text = text.replace(/^-{5,}\s*Forwarded message\s*-{5,}\s*\n(From:.*\n)?(Date:.*\n)?(Subject:.*\n)?(To:.*\n)?(Cc:.*\n)?/gim, '');

  // Outlook
  text = text.replace(/^_{5,}\s*\n(From:.*\n)?(Sent:.*\n)?(To:.*\n)?(Cc:.*\n)?(Subject:.*\n)?/gim, '');

  // Apple Mail
  text = text.replace(/^Begin forwarded message:\s*\n\n?(From:.*\n)?(Subject:.*\n)?(Date:.*\n)?(To:.*\n)?(Cc:.*\n)?/gim, '');

  // Generic "Original Message" header
  text = text.replace(/^-{3,}\s*Original Message\s*-{3,}\s*\n(From:.*\n)?(Sent:.*\n)?(To:.*\n)?(Subject:.*\n)?/gim, '');

  return text.trim();
}
```

**Applied to both**:
- `TextBody` (plain text version)
- `HtmlBody` (after conversion to markdown, before Notion blocks)


### 8. Email Body Processing

**HTML to Markdown Conversion**:
The Lambda function uses `turndown` with the GFM plugin to convert HTML emails to Markdown:

```javascript
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
turndown.use(gfm);

// Ignore inline images (external URLs and CID references)
turndown.addRule('ignoreImages', {
  filter: 'img',
  replacement: () => ''
});

const markdown = turndown.turndown(htmlBody);
```

**URL Handling**:
URLs are converted to clickable Notion links in two cases:

1. **HTML links** (`<a href="...">text</a>`) — Turndown converts these to Markdown `[text](url)`, which becomes a Notion link
2. **Plain text URLs** — Detected via regex and converted to links

```javascript
// Detect plain URLs in text and convert to Markdown links
function linkifyUrls(text) {
  const urlPattern = /(?<![\[\(])(https?:\/\/[^\s\]\)]+)/g;
  return text.replace(urlPattern, '[$1]($1)');
}

// Apply after turndown, before Notion block conversion
const markdownWithLinks = linkifyUrls(markdown);
```

When converting to Notion blocks, Markdown links become rich text with link annotations:

```json
{
  "type": "text",
  "text": {
    "content": "View the document",
    "link": { "url": "https://example.com/doc.pdf" }
  }
}
```

For plain URLs converted to self-referencing links, the URL itself is displayed as clickable text:

```json
{
  "type": "text",
  "text": {
    "content": "https://example.com/doc.pdf",
    "link": { "url": "https://example.com/doc.pdf" }
  }
}
```

**Markdown to Notion Blocks**:
The Markdown is then parsed and converted to Notion block types:

| Markdown Element | Notion Block Type |
|------------------|-------------------|
| `# Heading` | `heading_1`, `heading_2`, `heading_3` |
| Paragraph | `paragraph` |
| `- item` | `bulleted_list_item` |
| `1. item` | `numbered_list_item` |
| `> quote` | `quote` |
| `` `code` `` | `code` |
| `---` | `divider` |
| `**bold**`, `*italic*`, `~~strike~~` | Rich text annotations |
| `[link](url)` | Rich text with link |

**Text Chunking**:
Notion has a 2000-character limit per rich_text element. Long paragraphs are automatically chunked:

```javascript
function chunkText(text, maxLength = 2000) {
  const chunks = [];
  while (text.length > 0) {
    if (text.length <= maxLength) {
      chunks.push(text);
      break;
    }
    // Find a good break point (newline, space, or hard cut)
    let breakPoint = text.lastIndexOf('\n', maxLength);
    if (breakPoint === -1) breakPoint = text.lastIndexOf(' ', maxLength);
    if (breakPoint === -1) breakPoint = maxLength;
    chunks.push(text.slice(0, breakPoint));
    text = text.slice(breakPoint).trimStart();
  }
  return chunks;
}
```


### 9. AI Summarization (Optional)

When configured with an Anthropic API key and summary prompt, the Lambda generates an AI-powered summary of each email using Claude 3.5 Haiku for cost optimization.

**Configuration**:
- `anthropicApiKey`: Your Anthropic API key (stored in SSM as SecureString)
- `summaryPrompt`: Custom prompt for summarization (e.g., "Summarize in 2-3 sentences, focusing on action items")

If either value is missing or empty, summarization is skipped silently.

**Implementation**:
```javascript
const Anthropic = require('@anthropic-ai/sdk');

async function summarizeEmail(emailBody, summaryPrompt, apiKey) {
  if (!apiKey || !summaryPrompt) {
    return null; // Summarization disabled
  }

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: 'claude-3-5-haiku-latest',
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `${summaryPrompt}\n\n---\n\n${emailBody}`
      }
    ]
  });

  return response.content[0].text;
}
```

**Error Handling**:
If the Claude API call fails, the email is still processed without a summary. A warning is logged to CloudWatch but no error is surfaced to the user.

**Cost Estimate**:
Claude 3.5 Haiku pricing:
- Input: $0.80 per million tokens
- Output: $4.00 per million tokens

Typical email (~500 words ≈ 700 tokens input, ~100 tokens output):
- Per email: ~$0.0006 + ~$0.0004 = **~$0.001**
- 1,000 emails/month: **~$1.00**


### 10. Attachment Handling

**Postmark Attachment Format**:
```json
{
  "Attachments": [
    {
      "Name": "invoice.pdf",
      "Content": "base64-encoded-content",
      "ContentType": "application/pdf",
      "ContentLength": 45678,
      "ContentID": ""
    },
    {
      "Name": "logo.png",
      "Content": "base64-encoded-content",
      "ContentType": "image/png",
      "ContentLength": 12345,
      "ContentID": "ii_abc123"
    }
  ]
}
```

**Filtering Logic**:
- **Include**: Attachments with empty `ContentID` (manually attached files)
- **Skip**: Attachments with non-empty `ContentID` (CID-embedded images used in HTML templates)

```javascript
function filterAttachments(attachments) {
  return attachments.filter(att => !att.ContentID || att.ContentID === '');
}
```

**Notion File Upload**:
Attachments are uploaded directly to Notion using their file upload API. Each database row is also a Notion page, so files are added as blocks within that page.

```
┌─────────────────┐     ┌─────────────────┐
│ Postmark sends  │────▶│ Lambda uploads  │
│ base64 file     │     │ directly to     │
│                 │     │ Notion page     │
└─────────────────┘     └─────────────────┘
```

**Supported vs Unsupported Attachments**:

| Category | File Types | Handling |
|----------|------------|----------|
| **Documents** | PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX, TXT, CSV | Upload to Notion as file block |
| **Images** | PNG, JPG, JPEG, GIF, WEBP | Upload to Notion as image block |
| **Archives** | ZIP, RAR, 7Z, TAR, GZ | Upload to Notion as file block |
| **Unsupported** | EXE, DLL, BAT, SH, and files >20MB | Skip, add warning callout |

**Failure Handling**:
When an attachment fails to upload, the system records this in the Notion page content:

```json
{
  "type": "callout",
  "callout": {
    "icon": { "type": "emoji", "emoji": "⚠️" },
    "rich_text": [
      {
        "type": "text",
        "text": {
          "content": "Attachment skipped: report.exe (unsupported file type)"
        }
      }
    ]
  }
}
```


### 11. Notion Database Integration

**Database Schema**:
You create the database manually in Notion with these properties:

| Property | Type | Purpose |
|----------|------|---------|
| Name | title | Email subject (cleaned) |
| Date | date | When email was received |
| From | rich_text | Original sender address |
| Client | rich_text | Extracted from #hashtag |
| Has Attachments | checkbox | Quick filter for emails with files |
| Summary | rich_text | AI-generated summary (if enabled) |

**Page Content Structure**:
Each database row is also a page. The email body and attachments are added as page content:

```
┌─────────────────────────────────────────┐
│ Database Row Properties                 │
│ ─────────────────────────────────────── │
│ Name: Q4 Invoice Discussion             │
│ Date: 2024-12-09                        │
│ From: john@example.com                  │
│ Client: acme                            │
│ Has Attachments: ✓                      │
│ Summary: Client requesting invoice...   │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ Page Content                            │
│ ─────────────────────────────────────── │
│ ✨ Summary: Client is requesting Q4     │
│    invoice review. Action needed:       │
│    approve by Friday.                   │
│ ─────────────────────────────────────── │
│ Hi team,                                │
│                                         │
│ Please find the **Q4 invoice** attached.│
│                                         │
│ Best regards,                           │
│ John                                    │
│ ─────────────────────────────────────── │
│ 📎 invoice.pdf (45.6 KB)               │
│ 🖼️ chart.png                           │
└─────────────────────────────────────────┘
```

**API Endpoints Used**:
- `POST /v1/pages` - Create database row with properties
- `POST /v1/blocks/{page_id}/children` - Add content blocks to page
- File upload via Notion's internal file hosting

**Setup Required**:
1. Create a database in Notion with the properties listed above
2. Create a Notion Integration at https://www.notion.so/my-integrations
3. Share the database with the integration (click "..." → "Connections" → select your integration)
4. Copy the database ID from the URL: `notion.so/{workspace}/{database_id}?v=...`


### 12. Error Notifications

When processing fails, the Lambda sends an error notification email back to the sender using the Postmark API.

**Notification Scenarios**:

| Scenario | Database Entry Created? | Notification Sent? |
|----------|------------------------|-------------------|
| Unauthorized sender | No | No (silent reject) |
| Invalid recipient (wrong secret) | No | No (silent reject) |
| Missing #client tag in subject | No | Yes |
| Notion API failure | No | Yes |
| Attachment upload failure | Yes | Yes (warning) |
| Claude API failure | Yes | No (non-critical) |

**Implementation**:
```javascript
const postmark = require('postmark');

async function sendNotification(serverToken, to, subject, body) {
  const client = new postmark.ServerClient(serverToken);

  await client.sendEmail({
    From: `notion-inbox@yourdomain.com`,
    To: to,
    Subject: subject,
    TextBody: body
  });
}

// Error notification
async function notifyError(config, originalFrom, errorMessage) {
  await sendNotification(
    config.postmarkServerToken,
    originalFrom,
    'Failed to archive email to Notion',
    `Your forwarded email could not be archived.\n\nError: ${errorMessage}\n\nPlease check the subject line format (#clientname: Subject) and try again.`
  );
}

// Warning notification (attachment failed but entry created)
async function notifyWarning(config, originalFrom, notionUrl, warnings) {
  await sendNotification(
    config.postmarkServerToken,
    originalFrom,
    'Email archived with warnings',
    `Your email was archived to Notion, but some attachments could not be uploaded.\n\nNotion entry: ${notionUrl}\n\nWarnings:\n${warnings.join('\n')}`
  );
}
```

**Email Templates**:

Error (entry not created):
```
Subject: Failed to archive email to Notion

Your forwarded email could not be archived.

Error: Missing client tag in subject (expected #clientname:)

Please check the subject line format and try again.
Original subject: "Fwd: Re: Q4 Invoice Discussion"
```

Warning (entry created, attachment failed):
```
Subject: Email archived with warnings

Your email was archived to Notion, but some attachments could not be uploaded.

Notion entry: https://notion.so/abc123...

Warnings:
- Attachment skipped: report.exe (unsupported file type)
- Attachment skipped: bigfile.zip (exceeds 20MB limit)
```

**Postmark Outbound Setup**:
The same Postmark account used for inbound can send outbound emails. You need:
1. A verified sender signature or domain in Postmark
2. The Server API Token (different from the inbound webhook—this is for sending)


### 13. Configuration Storage

**Recommended: SSM Parameter Store**

| Parameter Path | Type | Purpose |
|----------------|------|---------|
| `/email-to-notion/inbox-secret` | SecureString | Secret portion of inbox email address |
| `/email-to-notion/allowed-senders` | StringList | Comma-separated list of allowed sender emails |
| `/email-to-notion/notion-database-id` | String | Target Notion database ID |
| `/email-to-notion/notion-api-key` | SecureString | Notion integration API key |
| `/email-to-notion/postmark-server-token` | SecureString | Postmark API token for sending notifications |
| `/email-to-notion/anthropic-api-key` | SecureString | Optional: Anthropic API key |
| `/email-to-notion/summary-prompt` | String | Optional: AI summarization prompt |

**Benefits**:
- Update configuration without redeploying Lambda
- Proper secret management for API keys
- Minimal cost (free for standard parameters)

---

## Terraform Infrastructure

### Resources to Create

| Resource | Purpose |
|----------|---------|
| `aws_lambda_function` | Main processing logic |
| `aws_lambda_function_url` | HTTPS endpoint for Postmark webhook |
| `aws_iam_role` | Lambda execution role |
| `aws_iam_role_policy` | Permissions for SSM, CloudWatch |
| `aws_ssm_parameter` × 7 | Configuration values (see above) |
| `aws_cloudwatch_log_group` | Lambda logs |

### Variables

```hcl
variable "inbox_secret" {
  description = "Secret string for inbox email address (notion-{secret}@domain.com)"
  type        = string
  sensitive   = true
}

variable "allowed_senders" {
  description = "List of email addresses allowed to forward emails"
  type        = list(string)
}

variable "notion_database_id" {
  description = "Notion database ID to store emails"
  type        = string
}

variable "notion_api_key" {
  description = "Notion Integration API key"
  type        = string
  sensitive   = true
}

variable "postmark_server_token" {
  description = "Postmark Server API token for sending notification emails"
  type        = string
  sensitive   = true
}

variable "anthropic_api_key" {
  description = "Anthropic API key for Claude summarization (optional, leave empty to disable)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "summary_prompt" {
  description = "Prompt for email summarization (optional, leave empty to disable)"
  type        = string
  default     = ""
}
```

### Outputs

```hcl
output "webhook_url" {
  description = "URL to configure in Postmark inbound settings"
  value       = aws_lambda_function_url.webhook.function_url
}

output "inbox_email" {
  description = "Email address to forward emails to"
  value       = "notion-${var.inbox_secret}@yourdomain.com"
  sensitive   = true
}
```

---

## Security Considerations

### Inbox Address Security
The inbox email address contains a secret: `notion-{secret}@yourdomain.com`. Anyone who knows this address can create entries in your Notion database. Choose a sufficiently random secret (e.g., UUID or 32+ character random string).

### Webhook Validation
Lambda validates that the recipient address matches the configured inbox secret. Emails sent to other addresses at your domain are rejected.

### Secrets Management
- All API keys stored in SSM Parameter Store as SecureString
- Lambda IAM role has minimal permissions (only SSM read, CloudWatch logs)
- No secrets in Terraform state if using `sensitive = true` and remote state encryption

### Notion Permissions
- Integration only has access to databases/pages explicitly shared with it
- Use a dedicated integration (not your personal token)
- Share only the email database, nothing else

---

## Limitations and Trade-offs

### What This Design Handles Well
- Forwarded email threads with rich formatting
- Any client via #hashtag (no configuration needed)
- HTML emails converted to well-formatted Notion blocks
- Manual file attachments uploaded to Notion
- Optional AI summarization
- Low to moderate volume (hundreds of emails/day)

### What This Design Doesn't Handle
| Limitation | Notes |
|------------|-------|
| **Large attachments** | Notion has a 20MB file limit. Larger files are skipped with a warning. |
| **Executable files** | EXE, DLL, BAT, SH files are blocked for security. |
| **CID-embedded images** | Template images (logos, signatures) are intentionally skipped. |
| **Real-time email** | This is for forwarding completed threads, not live email processing. |
| **High volume** | Lambda concurrency limits. Add SQS queue if needed. |
| **Delivery confirmation** | No retry if Notion API fails. Add DynamoDB + retry logic if critical. |

### Privacy Assessment
| Component | Data Exposure |
|-----------|---------------|
| Postmark | Sees email content transiently (processes and forwards). No storage unless you enable their archive feature. |
| AWS Lambda | Processes email in memory. Only logs are persisted (you control what's logged). |
| Anthropic API | Email content sent to Claude for summarization (if enabled). Anthropic does not train on API data. |
| Notion | Final destination for email content and attachments. Your data, your workspace. |

---

## Cost Estimate

| Service | Free Tier | Estimated Monthly Cost |
|---------|-----------|------------------------|
| Postmark Inbound | 100 emails/month | $0 (or $10 for 10K) |
| Lambda | 1M requests, 400K GB-seconds | $0 for typical usage |
| Lambda Function URL | Free | $0 |
| SSM Parameter Store | Free for standard parameters | $0 |
| CloudWatch Logs | 5GB ingestion | $0 for typical usage |
| Notion | Free tier or existing plan | $0 |
| Claude 3.5 Haiku (optional) | N/A | ~$0.001 per email (~$1/1K emails) |
| **Total** | | **$0–10/month** |

---

## Implementation Checklist

### One-Time Setup
- [ ] Register domain (or use existing)
- [ ] Create Postmark account and Inbound Server
- [ ] Configure DNS MX records for your domain
- [ ] Verify sender domain/signature in Postmark (for outbound notifications)
- [ ] Get Postmark Server API Token (for sending emails)
- [ ] Create Notion database with required properties (Name, Date, From, Client, Has Attachments, Summary)
- [ ] Create Notion Integration and share database with it
- [ ] Copy database ID from Notion URL
- [ ] Generate a random inbox secret (e.g., `uuidgen` or random string)
- [ ] List your allowed sender email addresses

### Terraform Deployment
- [ ] Configure AWS credentials
- [ ] Set Terraform variables (inbox secret, allowed senders, database ID, API keys, Postmark token)
- [ ] Run `terraform init` and `terraform apply`
- [ ] Copy webhook URL from Terraform output
- [ ] Configure webhook URL in Postmark Inbound settings

### Testing
- [ ] Forward a test email to `notion-{secret}@yourdomain.com`
- [ ] Use subject: `#testclient: Fwd: Test Email Subject`
- [ ] Verify database row is created with correct properties
- [ ] Verify "From" field shows original sender (not your forwarding address)
- [ ] Verify "Date" field shows original email date (not forward timestamp)
- [ ] Forward a thread where your reply is the last message, verify "From" shows the client (not you)
- [ ] Verify email body appears as formatted page content (forwarding headers stripped)
- [ ] Verify AI summary appears (if summarization enabled)
- [ ] Forward email with attachments, verify they appear in Notion
- [ ] Test with unsupported file type, verify warning notification email received
- [ ] Test from unauthorized email, verify silent rejection (no entry, no notification)
- [ ] Test with missing #hashtag, verify error notification email received
- [ ] Check CloudWatch logs for any errors

### Adding a New Client
Just forward an email with a new #hashtag. No configuration changes needed.

### Adding a New Sender Email
Update the `allowed_senders` SSM parameter or Terraform variable. Redeploy is not required if using SSM.

---

## Evaluation Summary

### Strengths
- **Zero client configuration**: New clients via #hashtag, no config updates
- **Privacy**: Email content transient in Postmark/Lambda, stored only in your Notion
- **Security**: Sender whitelist + secret inbox address prevents unauthorized submissions
- **Cost**: Effectively free for typical usage
- **Rich formatting**: HTML emails converted to well-formatted Notion blocks, forwarding headers stripped
- **AI summarization**: Optional Claude 3.5 Haiku integration (~$1/1K emails)
- **Direct Notion storage**: Attachments stored in Notion, no S3 bucket needed
- **Searchable database**: Filter by client, date, attachments in Notion views
- **Error visibility**: Email notifications for failures and attachment warnings
- **Reliability**: Postmark and Lambda are highly available services

### Weaknesses
- **Manual forwarding**: You must forward emails (not automatic inbox integration)
- **No retry logic**: If Notion API fails, email is lost (you get notified, but must re-forward)
- **Notion file limits**: 20MB max per attachment
- **Summarization privacy**: If enabled, email content is sent to Anthropic's API
- **Fixed sender list**: Adding new sender emails requires config update (though no redeploy)

### Verdict
This design is optimized for the "archive completed email threads" use case. The #hashtag approach eliminates client configuration entirely, making it trivial to organize emails by client. The trade-off is manual forwarding, which is intentional—you control exactly which threads get archived.

---

## Next Steps

1. Review this design and confirm requirements
2. Create Notion database with required schema
3. Generate Terraform configuration and Lambda code
4. Set up Postmark and DNS
5. Deploy and test
