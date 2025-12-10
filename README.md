# Email to Notion

A self-hosted service privacy-centric service for archiving emails to Notion, built on AWS.

Author: Ryan Cabeen, ryan@saturnatech.com

## Why This Exists

Email is where client communication happens, but it's a terrible archive. Threads get buried, attachments scatter across inboxes, and searching for "that invoice from Acme" means digging through thousands of messages.

This tool solves that by letting you selectively archive important email threads to Notion with a simple forward. Tag the client in the subject line, and the email lands in a searchable database—complete with the original sender, formatted content, and attachments.

**The key insight**: You don't want *all* your email in Notion. You want to *choose* which threads matter, then forget about them until you need to find them again.

**Why self-hosted?** Your email contains sensitive client data. This runs entirely in your AWS account—no third-party services see your content beyond transient processing. You own the infrastructure, the data stays yours.

## How It Works

1. Forward an email to `notion-{secret}@yourdomain.com`
2. Add `#clientname:` to the subject line
3. Email appears in your Notion database with parsed metadata

```
Email → SES → S3 → Lambda → Notion
```

## Features

- **Client tagging** - `#acme: Fwd: Invoice` creates entry tagged "acme"
- **Original sender extraction** - Parses forwarded headers, skips your replies
- **Rich text conversion** - HTML emails become formatted Notion blocks
- **File uploads** - Attachments uploaded directly to Notion pages
- **AI summaries** - Optional Claude 3.5 Haiku summarization
- **Error logging** - Failed emails logged to Notion with error details

## Quick Start

See [QUICKSTART.md](QUICKSTART.md) for full setup instructions.

```bash
# 1. Configure
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
# Edit terraform.tfvars with your values

# 2. Deploy
cd terraform && terraform init && terraform apply

# 3. Configure DNS with MX record from terraform output
```

## Documentation

| Document | Description |
|----------|-------------|
| [QUICKSTART.md](QUICKSTART.md) | Setup and deployment guide |
| [docs/DESIGN.md](docs/DESIGN.md) | Technical specification |
| [docs/PLAN.md](docs/PLAN.md) | Implementation stages |
| [CLAUDE.md](CLAUDE.md) | Development context |

## Tech Stack

- **Runtime**: Node.js 20.x on AWS Lambda
- **Infrastructure**: Terraform
- **Email**: AWS SES (inbound) with S3 storage
- **Database**: Notion API
- **AI**: Claude 3.5 Haiku (optional)

## Development

```bash
cd src
npm install
npm test
```

## License

MIT
