# Notion Email Archiver: Design Document

## Overview

A self-hosted system that receives forwarded emails and stores them in a Notion database. You forward completed email threads to a single inbox address, tagging the client in the subject line. The system parses the forwarded content, extracts attachments, optionally generates an AI summary, and creates a database entry.

### Goals
- **Privacy**: No third-party services touch email content beyond transient processing
- **Simplicity**: Minimal AWS infrastructure (Lambda, SES, S3, SSM), easy to maintain
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
    │      AWS SES      │  ← Inbound email receiving
    │  Receipt Rules    │    (filters by recipient address)
    └────────┬──────────┘
             │ Store raw MIME
             ▼
    ┌───────────────────┐
    │      AWS S3       │  ← Temporary email storage
    │   Email Bucket    │    (7-day retention)
    └────────┬──────────┘
             │ Trigger (async)
             ▼
    ┌───────────────────┐
    │   Lambda Function │  ← Parse MIME from S3
    │      (Node.js)    │  ← Parse #client from subject
    │                   │  ← Strip forwarding prefixes
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

### 1. AWS SES Inbound Processing

**What it does**: Receives emails at your domain and triggers Lambda processing.

**Setup required**:
- Verify your domain with SES (TXT record)
- Configure MX records to point to SES (`inbound-smtp.{region}.amazonaws.com`)
- Create receipt rule set with recipient filter

**SES Flow**:
1. Email arrives at `notion-{secret}@yourdomain.com`
2. Receipt rule matches recipient address exactly
3. Raw MIME stored in S3 bucket
4. Lambda invoked asynchronously

**Why SES over other providers**:
- Native AWS integration (no external webhooks)
- Direct Lambda trigger
- Full MIME access (complete email with attachments)
- No per-email costs beyond standard SES pricing ($0.10/1000 emails)

**Inbound-only design**:
This system only uses SES for *receiving* email—it never sends email. This is an intentional design choice:
- **No sandbox restrictions**: SES sandbox mode restricts *outbound* email to verified addresses only. Since we don't send email, sandbox mode doesn't affect us.
- **Simpler setup**: No need to request production access or verify sender identities for outbound.
- **Errors logged to Notion**: Instead of sending error notification emails, failures are logged directly to the Notion database where you'll see them alongside successful entries.

### 2. AWS S3 Email Storage

**Purpose**: Temporary storage for raw MIME emails

**Configuration**:
- Bucket with SES write permissions
- Lifecycle policy: delete after 7 days
- Lambda read access

**Why store in S3**:
- SES Lambda trigger only provides metadata, not email content
- S3 provides reliable storage for MIME parsing
- Allows retry if Lambda fails

### 3. AWS Lambda Function

**Runtime**: Node.js 20.x
**Memory**: 512 MB (for MIME parsing and attachment processing)
**Timeout**: 60 seconds (attachments may require multiple API calls)

**Dependencies**:
- `@notionhq/client` - Official Notion SDK
- `@anthropic-ai/sdk` - Anthropic SDK for Claude API
- `@aws-sdk/client-s3` - S3 client for fetching emails
- `@aws-sdk/client-ssm` - SSM client for configuration
- `mailparser` - MIME email parsing
- `turndown` - HTML to Markdown conversion
- `turndown-plugin-gfm` - GitHub Flavored Markdown support (tables, strikethrough)

**Responsibilities**:
1. Receive SES event with S3 object reference
2. Fetch raw MIME from S3
3. Parse MIME to extract headers, body, attachments
4. Validate recipient address contains the inbox secret
5. Validate sender is in the allowed senders list
6. Parse subject line to extract client tag and clean subject
7. Extract original sender and date from forwarded headers
8. Strip forwarding headers from email body
9. Convert HTML email body to Markdown, then to Notion blocks
10. Filter attachments (skip CID-embedded images, keep manual attachments)
11. Generate AI summary of email content (if enabled)
12. Create database row in Notion with properties (using extracted sender/date)
13. Upload attachments directly to the Notion page
14. Log errors to Notion database if processing fails

**Configuration** (via SSM Parameter Store):
```json
{
  "inboxSecret": "your-random-secret-here",
  "notionDatabaseId": "abc123def456",
  "notionApiKey": "secret_xxx",
  "anthropicApiKey": "sk-ant-xxx",
  "summaryPrompt": "Summarize this email in 2-3 sentences, focusing on action items and key information.",
  "allowedSenders": ["you@gmail.com", "you@work.com"]
}
```


### 4. Subject Line Parsing

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


### 5. Sender Validation (Whitelist)

Only emails from whitelisted addresses are processed. All others are silently ignored—no error logging, no response.

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

**Defense in depth**: The system uses two layers of protection:
1. **Secret inbox address** - Obscurity prevents discovery (`notion-{uuid}@domain.com`)
2. **Sender whitelist** - Even if discovered, only authorized senders can create entries

This combination means an attacker would need both the secret address AND access to one of your email accounts to create entries.


### 6. Forwarded Email Parsing

When you forward an email, your email client adds headers containing the original sender information. The Lambda extracts this data before stripping the headers.

**Data to Extract**:
- **Original Sender**: The actual person who sent the email (not you, the forwarder)
- **Original Date**: When the email was originally sent (not when you forwarded it)

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
Notion has a 2000-character limit per rich_text element. Long paragraphs are automatically chunked.


### 9. AI Summarization (Optional)

When configured with an Anthropic API key and summary prompt, the Lambda generates an AI-powered summary of each email using Claude 3.5 Haiku for cost optimization.

**Configuration**:
- `anthropicApiKey`: Your Anthropic API key (stored in SSM as SecureString)
- `summaryPrompt`: Custom prompt for summarization (e.g., "Summarize in 2-3 sentences, focusing on action items")

If either value is missing or empty, summarization is skipped silently.

**Cost Estimate**:
Claude 3.5 Haiku pricing:
- Input: $0.80 per million tokens
- Output: $4.00 per million tokens

Typical email (~500 words ≈ 700 tokens input, ~100 tokens output):
- Per email: ~$0.0006 + ~$0.0004 = **~$0.001**
- 1,000 emails/month: **~$1.00**


### 10. Attachment Handling

**MIME Attachment Format**:
When parsing MIME with `mailparser`, attachments are provided as:
```javascript
{
  filename: "invoice.pdf",
  content: Buffer,  // Raw file content
  contentType: "application/pdf",
  size: 45678,
  cid: ""  // Content-ID for embedded images
}
```

**Filtering Logic**:
- **Include**: Attachments with empty `cid` (manually attached files)
- **Skip**: Attachments with non-empty `cid` (CID-embedded images used in HTML templates)

**Notion File Upload**:
Attachments are uploaded directly to Notion using their file upload API:

1. Call `POST /v1/files` with filename and content type
2. Receive signed upload URL
3. PUT file content to signed URL
4. Add file block to page referencing the uploaded file

**Supported vs Unsupported Attachments**:

| Category | File Types | Handling |
|----------|------------|----------|
| **Documents** | PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX, TXT, CSV | Upload to Notion as file block |
| **Images** | PNG, JPG, JPEG, GIF, WEBP | Upload to Notion as image block |
| **Archives** | ZIP, RAR, 7Z, TAR, GZ | Upload to Notion as file block |
| **Unsupported** | EXE, DLL, BAT, SH, and files >20MB | Skip, add warning callout |


### 11. Notion Database Integration

**Database Schema**:
You create the database manually in Notion with these properties:

| Property | Type | Purpose |
|----------|------|---------|
| Name | title | Email subject (cleaned) |
| UUID | rich_text | Unique identifier for deduplication |
| Date | date | When email was received |
| From | rich_text | Original sender address |
| Client | rich_text | Extracted from #hashtag |
| Has Attachments | checkbox | Quick filter for emails with files |
| Summary | rich_text | AI-generated summary (if enabled) |

**UUID Property**:
Each entry receives a unique UUID generated at processing time. This serves two purposes:
1. **Deduplication** - If an email is processed twice (e.g., Lambda retry), the UUID helps identify duplicates
2. **External reference** - Provides a stable identifier that doesn't change if the subject is edited

**Page Content Structure**:
Each database row is also a page. The email body and attachments are added as page content.

**Setup Required**:
1. Create a database in Notion with the properties listed above
2. Create a Notion Integration at https://www.notion.so/my-integrations
3. Share the database with the integration (click "..." → "Connections" → select your integration)
4. Copy the database ID from the URL: `notion.so/{workspace}/{database_id}?v=...`


### 12. Error Handling

When processing fails, the Lambda logs the error to the Notion database itself.

**Error Entry Fields**:
- Name: Original subject with "[ERROR]" prefix
- Date: When error occurred
- From: Original sender
- Client: "error"
- Content: Error message and stack trace

**Error Scenarios**:

| Scenario | Database Entry Created? | Logged to Notion? |
|----------|------------------------|-------------------|
| Unauthorized sender | No | No (silent reject) |
| Invalid recipient (wrong secret) | No | No (silent reject) |
| Missing #client tag in subject | No | Yes |
| Notion API failure | No | Attempted |
| Attachment upload failure | Yes | Yes (warning) |
| Claude API failure | Yes | No (non-critical) |


### 13. Configuration Storage

**SSM Parameter Store**

| Parameter Path | Type | Purpose |
|----------------|------|---------|
| `/email-to-notion/inbox-secret` | SecureString | Secret portion of inbox email address |
| `/email-to-notion/allowed-senders` | StringList | Comma-separated list of allowed sender emails |
| `/email-to-notion/notion-database-id` | String | Target Notion database ID |
| `/email-to-notion/notion-api-key` | SecureString | Notion integration API key |
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
| `aws_ses_domain_identity` | Domain verification for SES |
| `aws_ses_receipt_rule_set` | Rule set for inbound processing |
| `aws_ses_receipt_rule` | Store in S3 + invoke Lambda |
| `aws_s3_bucket` | Temporary email storage |
| `aws_lambda_function` | Main processing logic |
| `aws_lambda_permission` | Allow SES to invoke Lambda |
| `aws_iam_role` | Lambda execution role |
| `aws_iam_role_policy` | Permissions for S3, SSM, CloudWatch |
| `aws_ssm_parameter` × 6 | Configuration values (see above) |
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

variable "email_domain" {
  description = "Domain for receiving emails via SES"
  type        = string
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
output "ses_mx_record" {
  description = "MX record to add to your DNS"
  value       = "10 inbound-smtp.${data.aws_region.current.name}.amazonaws.com"
}

output "ses_verification_token" {
  description = "TXT record value for domain verification"
  value       = aws_ses_domain_identity.main.verification_token
}

output "ses_inbox_address" {
  description = "Email address to forward emails to"
  value       = "notion-${var.inbox_secret}@${var.email_domain}"
  sensitive   = true
}
```

---

## Security Considerations

### Multi-Layer Access Control

The system uses defense in depth with three security layers:

| Layer | Protection | What it prevents |
|-------|------------|------------------|
| **Secret inbox address** | `notion-{uuid}@domain.com` | Random spam, discovery by scanning |
| **Sender whitelist** | Only specified email addresses | Unauthorized submissions even if address is discovered |
| **SES receipt rule** | Exact recipient match | Processing of emails to other addresses at your domain |

An attacker would need: (1) your secret inbox address, (2) ability to send from one of your whitelisted email addresses, AND (3) knowledge of the #hashtag format to create entries.

### Inbox Address Security
The inbox email address contains a secret: `notion-{secret}@yourdomain.com`. Choose a sufficiently random secret (e.g., UUID or 32+ character random string). The secret should be treated like a password—don't share it or commit it to version control.

### Sender Whitelist
The `allowed-senders` parameter contains email addresses permitted to create entries. Emails from any other address are silently rejected—no error response, no logging to Notion. This prevents:
- Spam submissions if the inbox address is discovered
- Unauthorized users from creating entries
- Phishing attempts using your archival system

### Secrets Management
- All API keys stored in SSM Parameter Store as SecureString
- Lambda IAM role has minimal permissions (only S3 read, SSM read, CloudWatch logs)
- No secrets in Terraform state if using `sensitive = true` and remote state encryption

### Notion Permissions
- Integration only has access to databases/pages explicitly shared with it
- Use a dedicated integration (not your personal token)
- Share only the email database, nothing else

### Email Storage
- Raw emails stored in S3 with 7-day retention
- Auto-deleted after processing window
- No long-term email storage in AWS

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

### Privacy Assessment
| Component | Data Exposure |
|-----------|---------------|
| AWS SES | Receives email, stores briefly in S3. Your AWS account. |
| AWS S3 | Raw email stored 7 days. Your AWS account. |
| AWS Lambda | Processes email in memory. Only logs are persisted (you control what's logged). |
| Anthropic API | Email content sent to Claude for summarization (if enabled). Anthropic does not train on API data. |
| Notion | Final destination for email content and attachments. Your data, your workspace. |

---

## Cost Estimate

| Service | Free Tier | Estimated Monthly Cost |
|---------|-----------|------------------------|
| AWS SES | N/A | $0.10 per 1,000 emails received |
| AWS S3 | 5GB storage | ~$0 for email storage (auto-delete) |
| Lambda | 1M requests, 400K GB-seconds | $0 for typical usage |
| SSM Parameter Store | Free for standard parameters | $0 |
| CloudWatch Logs | 5GB ingestion | $0 for typical usage |
| Notion | Free tier or existing plan | $0 |
| Claude 3.5 Haiku (optional) | N/A | ~$0.001 per email (~$1/1K emails) |
| **Total** | | **$0–5/month** |

---

## Implementation Checklist

### One-Time Setup
- [ ] Register domain (or use existing)
- [ ] Verify domain with SES (TXT record)
- [ ] Configure MX records for SES inbound
- [ ] Create Notion database with required properties (Name, Date, From, Client, Has Attachments, Summary)
- [ ] Create Notion Integration and share database with it
- [ ] Copy database ID from Notion URL
- [ ] Generate a random inbox secret (e.g., `uuidgen` or random string)
- [ ] List your allowed sender email addresses

### Terraform Deployment
- [ ] Configure AWS credentials
- [ ] Set Terraform variables (inbox secret, allowed senders, database ID, API keys, email domain)
- [ ] Run `terraform init` and `terraform apply`
- [ ] Copy MX record and verification token from Terraform output
- [ ] Configure DNS with MX and TXT records

### Testing
- [ ] Forward a test email to `notion-{secret}@yourdomain.com`
- [ ] Use subject: `#testclient: Fwd: Test Email Subject`
- [ ] Verify database row is created with correct properties
- [ ] Verify "From" field shows original sender (not your forwarding address)
- [ ] Verify "Date" field shows original email date (not forward timestamp)
- [ ] Forward a thread where your reply is the last message, verify "From" shows the client (not you)
- [ ] Verify email body appears as formatted page content (forwarding headers stripped)
- [ ] Verify AI summary appears (if summarization enabled)
- [ ] Forward email with attachments, verify they upload to Notion
- [ ] Test from unauthorized email, verify silent rejection (no entry)
- [ ] Test with missing #hashtag, verify error logged to Notion
- [ ] Check CloudWatch logs for any errors

### Adding a New Client
Just forward an email with a new #hashtag. No configuration changes needed.

### Adding a New Sender Email
Update the `allowed_senders` SSM parameter or Terraform variable. Redeploy is not required if using SSM.
