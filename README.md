# Email to Notion

A self-hosted service for forwarding emails to a Notion database, built on AWS with Lambda, SES, and S3.

Author: Ryan Cabeen, ryan@saturnatech.com

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
