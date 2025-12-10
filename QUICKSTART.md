# Quickstart Guide

This guide walks you through setting up Notion Email Archiver from scratch. Total time: ~30 minutes.

---

## Prerequisites

- AWS account with CLI configured
- Terraform installed (v1.0+)
- Node.js 20.x installed
- A domain you control (for receiving email)
- Notion account
- Postmark account (free tier works)

---

## Step 1: Postmark Setup (10 min)

### 1.1 Create Postmark Account
1. Go to https://postmarkapp.com and sign up
2. Create a new Server (e.g., "Email to Notion")

### 1.2 Configure Inbound Email
1. In your Server, go to **Message Streams** → **Inbound**
2. Note the inbound email domain shown (e.g., `abcd1234.inbound.postmarkapp.com`)

### 1.3 Configure DNS
Add an MX record to your domain:

| Type | Host | Value | Priority |
|------|------|-------|----------|
| MX | `@` or subdomain | `inbound.postmarkapp.com` | 10 |

**Example:** To receive email at `notion-xxx@mail.yourdomain.com`, add MX record for `mail.yourdomain.com`.

Wait for DNS propagation (usually 5-15 minutes). Verify in Postmark's inbound settings.

### 1.4 Verify Sender Domain (for outbound notifications)
1. Go to **Sender Signatures** → **Add Domain**
2. Add your domain and follow DNS verification steps (DKIM + Return-Path)
3. This allows Lambda to send error notification emails

### 1.5 Get API Tokens
1. Go to **Server** → **API Tokens**
2. Copy the **Server API Token** (you'll need this for Terraform)

---

## Step 2: Notion Setup (5 min)

### 2.1 Create the Database
1. Create a new page in Notion
2. Add a **Database - Full page**
3. Configure these properties:

| Property Name | Type | Notes |
|---------------|------|-------|
| Name | Title | (default, rename from "Name" if needed) |
| Date | Date | |
| From | Text | |
| Client | Text | |
| Has Attachments | Checkbox | |
| Summary | Text | |

### 2.2 Create Integration
1. Go to https://www.notion.so/my-integrations
2. Click **New integration**
3. Name it "Email to Notion"
4. Select your workspace
5. Click **Submit**
6. Copy the **Internal Integration Secret** (starts with `secret_`)

### 2.3 Share Database with Integration
1. Open your email database in Notion
2. Click **...** (top right) → **Connections** → **Connect to** → Select "Email to Notion"

### 2.4 Get Database ID
1. Open the database in your browser
2. Copy the ID from the URL:
   ```
   https://notion.so/myworkspace/abc123def456?v=...
                                 ^^^^^^^^^^^^^^
                                 This is the database ID
   ```

---

## Step 3: AWS Setup (5 min)

### 3.1 Configure AWS CLI
```bash
aws configure
# Enter your Access Key ID, Secret Access Key, and region
```

### 3.2 Generate Inbox Secret
```bash
# Generate a random secret for your inbox address
uuidgen
# Example output: 550e8400-e29b-41d4-a716-446655440000
```

Your inbox email will be: `notion-550e8400-e29b-41d4-a716-446655440000@yourdomain.com`

---

## Step 4: Deploy with Terraform (10 min)

### 4.1 Clone and Configure

```bash
cd email-to-notion/terraform

# Copy example variables file
cp terraform.tfvars.example terraform.tfvars
```

### 4.2 Edit terraform.tfvars

```hcl
# Required
inbox_secret       = "550e8400-e29b-41d4-a716-446655440000"  # From step 3.2
allowed_senders    = ["you@gmail.com", "you@work.com"]       # Your email addresses
notion_database_id = "abc123def456"                          # From step 2.4
notion_api_key     = "secret_xxxxx"                          # From step 2.2
postmark_server_token = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # From step 1.5

# Optional (for AI summarization)
anthropic_api_key = ""  # Leave empty to disable
summary_prompt    = ""  # Leave empty to disable
```

### 4.3 Deploy

```bash
# Initialize Terraform
terraform init

# Preview changes
terraform plan

# Deploy
terraform apply
```

### 4.4 Note the Outputs

```bash
terraform output webhook_url
# Example: https://abc123.lambda-url.us-east-1.on.aws/
```

---

## Step 5: Connect Postmark to Lambda (2 min)

1. In Postmark, go to **Message Streams** → **Inbound** → **Settings**
2. Set the **Webhook URL** to your Lambda Function URL from step 4.4
3. Click **Save**

---

## Step 6: Test It! (2 min)

### 6.1 Send Test Email
From one of your allowed sender addresses, forward any email to:
```
notion-{your-secret}@yourdomain.com
```

With subject:
```
#testclient: Fwd: Your Original Subject
```

### 6.2 Verify
1. Check your Notion database - a new row should appear
2. Open the row - email body should be formatted as page content
3. Check "From" field shows original sender (not your forwarding address)

### 6.3 Troubleshooting
If nothing appears:
```bash
# Check Lambda logs
aws logs tail /aws/lambda/email-to-notion --follow
```

Common issues:
- **MX records not propagated**: Wait longer, verify in Postmark
- **Wrong secret in email address**: Double-check the inbox_secret
- **Sender not in allowed list**: Check allowed_senders in tfvars
- **Missing #hashtag**: Subject must start with `#clientname:`

---

## Step 7: Enable AI Summarization (Optional)

### 7.1 Get Anthropic API Key
1. Go to https://console.anthropic.com
2. Create an API key

### 7.2 Update Configuration
```bash
# Update SSM parameters directly
aws ssm put-parameter \
  --name "/email-to-notion/anthropic-api-key" \
  --value "sk-ant-xxxxx" \
  --type SecureString \
  --overwrite

aws ssm put-parameter \
  --name "/email-to-notion/summary-prompt" \
  --value "Summarize this email in 2-3 sentences, focusing on action items and key information." \
  --type String \
  --overwrite
```

Or update `terraform.tfvars` and run `terraform apply` again.

### 7.3 Test
Forward another email. The database entry should now have a Summary field populated, and a callout block at the top of the page content.

---

## Daily Usage

### Forward an Email
1. Open email thread you want to archive
2. Click Forward
3. Change subject to: `#clientname: [original subject]`
4. Send to: `notion-{secret}@yourdomain.com`

### Add a New Client
Just use a new hashtag! No configuration needed.

Example: `#newclient: Fwd: Project Proposal`

### Add a New Sender Email
Update SSM parameter:
```bash
aws ssm put-parameter \
  --name "/email-to-notion/allowed-senders" \
  --value "you@gmail.com,you@work.com,you@newemail.com" \
  --type StringList \
  --overwrite
```

---

## Costs

| Service | Expected Cost |
|---------|---------------|
| Postmark | Free (100 emails/mo) or $10/mo |
| AWS Lambda | Free tier covers typical usage |
| AWS SSM | Free |
| Notion | Free tier or existing plan |
| Claude AI | ~$0.001/email if enabled |

**Total: $0-10/month for typical usage**

---

## Uninstall

```bash
cd terraform
terraform destroy
```

Then:
1. Delete Postmark server (optional)
2. Delete Notion integration
3. Remove DNS MX records
