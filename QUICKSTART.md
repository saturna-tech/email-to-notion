# Quickstart Guide

This guide walks you through setting up Notion Email Archiver from scratch.

---

## Prerequisites

- AWS account with CLI configured
- Terraform installed (v1.0+)
- Node.js 20.x installed
- A domain you control (for receiving email)
- Notion account

---

## Step 1: Notion Setup

### 1.1 Create the Database
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

### 1.2 Create Integration
1. Go to https://www.notion.so/my-integrations
2. Click **New integration**
3. Name it "Email to Notion"
4. Select your workspace
5. Click **Submit**
6. Copy the **Internal Integration Secret** (starts with `secret_`)

### 1.3 Share Database with Integration
1. Open your email database in Notion
2. Click **...** (top right) → **Connections** → **Connect to** → Select "Email to Notion"

### 1.4 Get Database ID
1. Open the database in your browser
2. Copy the ID from the URL:
   ```
   https://notion.so/myworkspace/abc123def456?v=...
                                ^^^^^^^^^^^^^^
                                This is the database ID
   ```

---

## Step 2: AWS Setup

### 2.1 Configure AWS CLI
```bash
aws configure
# Enter your Access Key ID, Secret Access Key, and region (us-east-1 recommended for SES)
```

### 2.2 Generate Inbox Secret
```bash
# Generate a random secret for your inbox address
uuidgen
# Example output: 550e8400-e29b-41d4-a716-446655440000
```

Your inbox email will be: `notion-550e8400-e29b-41d4-a716-446655440000@yourdomain.com`

---

## Step 3: Deploy with Terraform

### 3.1 Clone and Configure

```bash
cd email-to-notion/terraform

# Copy example variables file
cp terraform.tfvars.example terraform.tfvars
```

### 3.2 Edit terraform.tfvars

```hcl
# Required
inbox_secret       = "550e8400-e29b-41d4-a716-446655440000"  # From step 2.2
allowed_senders    = ["you@gmail.com", "you@work.com"]       # Your email addresses
notion_database_id = "abc123def456"                          # From step 1.4
notion_api_key     = "secret_xxxxx"                          # From step 1.2
email_domain       = "yourdomain.com"                        # Your domain for receiving email

# Optional (for AI summarization)
anthropic_api_key = ""  # Leave empty to disable
summary_prompt    = ""  # Leave empty to disable
```

### 3.3 Deploy

```bash
# Initialize Terraform
terraform init

# Preview changes
terraform plan

# Deploy
terraform apply
```

### 3.4 Note the Outputs

After deployment, Terraform will output important values:

```bash
terraform output
```

Key outputs:
- `ses_mx_record` - MX record to add to your DNS
- `ses_verification_token` - TXT record for domain verification
- `ses_inbox_address` - Your secret inbox email address

---

## Step 4: DNS Configuration

### 4.1 Verify Domain with SES

Add a TXT record to verify your domain with SES:

| Type | Host | Value |
|------|------|-------|
| TXT | `_amazonses.yourdomain.com` | (use `ses_verification_token` from terraform output) |

### 4.2 Configure MX Record

Add an MX record to receive email:

| Type | Host | Value | Priority |
|------|------|-------|----------|
| MX | `@` or subdomain | `inbound-smtp.us-east-1.amazonaws.com` | 10 |

**Note:** The MX hostname depends on your AWS region. Use `inbound-smtp.{region}.amazonaws.com`.

Wait for DNS propagation (usually 5-15 minutes). You can verify the domain is verified in the AWS SES console.

---

## Step 5: Test It!

### 5.1 Send Test Email
From one of your allowed sender addresses, forward any email to:
```
notion-{your-secret}@yourdomain.com
```

With subject:
```
#testclient: Fwd: Your Original Subject
```

### 5.2 Verify
1. Check your Notion database - a new row should appear
2. Open the row - email body should be formatted as page content
3. Check "From" field shows original sender (not your forwarding address)

### 5.3 Troubleshooting
If nothing appears:
```bash
# Check Lambda logs
aws logs tail /aws/lambda/email-to-notion --follow
```

Common issues:
- **MX records not propagated**: Wait longer, verify in AWS SES console
- **Domain not verified**: Check the TXT record is correct
- **Wrong secret in email address**: Double-check the inbox_secret
- **Sender not in allowed list**: Check allowed_senders in tfvars
- **Missing #hashtag**: Subject must start with `#clientname:`

---

## Step 6: Enable AI Summarization (Optional)

### 6.1 Get Anthropic API Key
1. Go to https://console.anthropic.com
2. Create an API key

### 6.2 Update Configuration
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

### 6.3 Test
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
| AWS SES | $0.10 per 1,000 emails received |
| AWS S3 | Minimal (emails auto-delete after 7 days) |
| AWS Lambda | Free tier covers typical usage |
| AWS SSM | Free |
| Notion | Free tier or existing plan |
| Claude AI | ~$0.001/email if enabled |

**Total: $0-5/month for typical usage**

---

## Uninstall

```bash
cd terraform
terraform destroy
```

Then:
1. Delete Notion integration
2. Remove DNS MX and TXT records
