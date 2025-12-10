# Claude Code Context

This file provides context for Claude Code when working on this project.

## Project Overview

Email-to-Notion is a self-hosted system that receives forwarded emails and stores them in a Notion database. Users forward completed email threads to a secret inbox address with a `#clientname:` tag in the subject line.

## Key Documents

- `DESIGN.md` - Complete technical specification
- `PLAN.md` - Staged implementation plan with success criteria
- `QUICKSTART.md` - User setup and deployment guide

## Architecture

```
Email → Postmark (inbound) → Lambda → Notion API
                               ↓
                          Postmark (outbound notifications)
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20.x |
| Infrastructure | Terraform |
| Cloud | AWS (Lambda, SSM, CloudWatch) |
| Email | Postmark (inbound + outbound) |
| Database | Notion |
| AI | Claude 3.5 Haiku (optional) |

## Project Structure

```
email-to-notion/
├── DESIGN.md           # Technical specification
├── PLAN.md             # Implementation stages
├── QUICKSTART.md       # User guide
├── CLAUDE.md           # This file
├── terraform/
│   ├── main.tf         # Lambda, IAM, SSM resources
│   ├── variables.tf    # Input variables
│   ├── outputs.tf      # Webhook URL, etc.
│   └── terraform.tfvars.example
├── src/
│   ├── index.js        # Lambda handler
│   ├── parse.js        # Subject & header parsing
│   ├── convert.js      # HTML → Markdown → Notion blocks
│   ├── notion.js       # Notion API client
│   ├── attachments.js  # Attachment filtering & upload
│   ├── summarize.js    # Claude AI summarization
│   └── notify.js       # Postmark error notifications
├── package.json
└── .gitignore
```

## Common Commands

### Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Package Lambda for deployment
npm run build
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

### Testing Locally

```bash
# Invoke Lambda locally with test payload
# (requires SAM CLI or similar)
sam local invoke -e test/events/sample-email.json
```

## SSM Parameters

All configuration is stored in SSM Parameter Store under `/email-to-notion/`:

| Parameter | Type | Required |
|-----------|------|----------|
| `inbox-secret` | SecureString | Yes |
| `allowed-senders` | StringList | Yes |
| `notion-database-id` | String | Yes |
| `notion-api-key` | SecureString | Yes |
| `postmark-server-token` | SecureString | Yes |
| `anthropic-api-key` | SecureString | No |
| `summary-prompt` | String | No |

## Key Implementation Details

### Subject Parsing
- Extract `#clientname:` prefix (required)
- Strip `Fwd:`, `Re:`, `Fw:`, `Reply:` prefixes (case-insensitive)
- Client name is lowercased and stored as-is

### Sender Extraction
- Parse forwarded headers for `From:` field
- Skip any `From:` matching `allowed-senders` (handles "I replied last" case)
- Fall back to Postmark sender if parsing fails

### Attachment Handling
- Include: `ContentID` empty (manual attachments)
- Skip: `ContentID` present (CID-embedded images)
- Skip: Executables (exe, dll, bat, sh)
- Skip: Files > 20MB
- Upload directly to Notion (no S3)

### Error Handling
- Always return 200 to Postmark (avoid retries)
- Send email notification for actionable errors
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
| No error email | Postmark token or sender verification |
| Lambda timeout | Large attachment, increase timeout |

## Security Notes

- Never log email content (privacy)
- Inbox secret should be UUID or 32+ random chars
- Notion integration should only have access to email database
- Postmark sender domain must be verified
