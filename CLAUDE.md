# Claude Code Context

This file provides context for Claude Code when working on this project.

## Project Overview

Notion Email Archiver is a self-hosted system that receives forwarded emails and stores them in a Notion database. Users forward completed email threads to a secret inbox address with a `#clientname` tag in the subject line.

## Key Documents

- `docs/DESIGN.md` - Complete technical specification
- `docs/PLAN.md` - Staged implementation plan with success criteria
- `QUICKSTART.md` - User setup and deployment guide

## Architecture

```
Email → SES → S3 → Lambda → Notion API
```

SES receives inbound email, stores raw MIME in S3, then triggers Lambda. Lambda parses the MIME content, processes the email, and creates entries in Notion with file uploads.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20.x |
| Infrastructure | Terraform |
| Cloud | AWS (Lambda, SES, S3, SSM, CloudWatch) |
| Email | AWS SES (inbound receiving) |
| Database | Notion |
| AI | Claude 3.5 Haiku (optional) |

## Project Structure

```
email-to-notion/
├── README.md           # Project overview
├── QUICKSTART.md       # User guide
├── CLAUDE.md           # This file
├── docs/
│   ├── DESIGN.md       # Technical specification
│   └── PLAN.md         # Implementation stages
├── terraform/
│   ├── main.tf         # Lambda, IAM, SES, S3 resources
│   ├── variables.tf    # Input variables
│   ├── outputs.tf      # MX record, verification token, etc.
│   └── terraform.tfvars.example
├── src/
│   ├── index.js        # Lambda handler
│   ├── validate.js     # Recipient & sender validation
│   ├── parse.js        # Subject & header parsing
│   ├── convert.js      # HTML → Markdown → Notion blocks
│   ├── notion.js       # Notion API client with file uploads
│   ├── attachments.js  # Attachment filtering & upload
│   ├── summarize.js    # Claude AI summarization
│   ├── ses.js          # SES event parsing & S3 MIME retrieval
│   ├── test.js         # Unit tests
│   └── package.json
└── .gitignore
```

## Common Commands

### Development

```bash
# Install dependencies
cd src && npm install

# Run tests
npm test
```

### Terraform

```bash
cd terraform

# Initialize
terraform init

# Plan changes
terraform plan -var-file=terraform.tfvars

# Apply changes
terraform apply -var-file=terraform.tfvars

# View outputs
terraform output
```

## SSM Parameters

All configuration is stored in SSM Parameter Store under `/email-to-notion/`:

| Parameter | Type | Required |
|-----------|------|----------|
| `inbox-secret` | SecureString | Yes |
| `allowed-senders` | StringList | Yes |
| `notion-database-id` | String | Yes |
| `notion-api-key` | SecureString | Yes |
| `anthropic-api-key` | SecureString | No |
| `summary-prompt` | String | No |

## Key Implementation Details

### SES Integration
- SES receipt rule filters by recipient address (only accepts emails to `notion-{secret}@domain`)
- Raw MIME email stored in S3 bucket with 7-day retention
- Lambda triggered asynchronously after S3 storage
- MIME parsed using `mailparser` library

### Subject Parsing
- Extract `#clientname:` prefix (required)
- Strip `Fwd:`, `Re:`, `Fw:`, `Reply:` prefixes (case-insensitive)
- Client name is lowercased and stored as-is

### Sender Extraction
- Parse forwarded headers for `From:` field
- Skip any `From:` matching `allowed-senders` (handles "I replied last" case)
- Fall back to SES sender if parsing fails

### Attachment Handling
- Include: `ContentID` empty (manual attachments)
- Skip: `ContentID` present (CID-embedded images)
- Skip: Executables (exe, dll, bat, sh)
- Skip: Files > 20MB
- Upload directly to Notion using file upload API

### Notion File Upload
The Notion API requires a two-step process for file uploads:
1. Call `POST /v1/files` to get a signed upload URL
2. Upload file content to the signed URL
3. Reference the uploaded file in a block

This is handled in `notion.js` with proper content-type handling.

### Error Handling
- Errors logged to Notion database with error details
- Lambda throws on error (allows for retry/DLQ if configured)
- Silent reject for unauthorized senders
- Log all errors to CloudWatch

## Notion Database Schema

Create manually with these properties:

| Property | Type |
|----------|------|
| Name | title |
| Date | date |
| From | rich_text |
| Client | rich_text |
| Has Attachments | checkbox |
| Summary | rich_text |

## Testing Checklist

When testing changes:

1. [ ] Simple forwarded email (no attachments)
2. [ ] Email with PDF and image attachments
3. [ ] Email with unsupported attachment (exe)
4. [ ] Thread where you replied last
5. [ ] Missing #hashtag in subject
6. [ ] Email from unauthorized sender
7. [ ] Gmail, Outlook, Apple Mail forwarding formats

## Debugging

### CloudWatch Logs
```bash
aws logs tail /aws/lambda/email-to-notion --follow
```

### Common Issues

| Symptom | Likely Cause |
|---------|--------------|
| No database entry | Check SSM parameters, Notion sharing |
| Wrong "From" field | Forwarding header parsing failed |
| Missing attachments | ContentID filtering too aggressive |
| Lambda timeout | Large attachment, increase timeout |
| SES not receiving | Check MX records, domain verification |

## Security Notes

- Never log email content (privacy)
- Inbox secret should be UUID or 32+ random chars
- Notion integration should only have access to email database
- SES receipt rule filters by exact recipient address
- Raw emails in S3 auto-delete after 7 days
