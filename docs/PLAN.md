# Implementation Plan

This document outlines the staged implementation plan for the Email-to-Notion integration system as specified in DESIGN.md.

---

## Stage 1: Infrastructure Foundation

**Goal:** Deploy minimal AWS infrastructure that can receive webhooks.

### Tasks
1. Create Terraform configuration for:
   - Lambda function (Node.js 20.x, 512MB, 60s timeout)
   - Lambda Function URL
   - IAM role with SSM and CloudWatch permissions
   - CloudWatch log group
   - SSM parameters (placeholder values for now)

2. Create minimal Lambda handler that:
   - Logs incoming requests
   - Returns 200 OK

3. Deploy to AWS

### Success Criteria
- [ ] `terraform apply` completes without errors
- [ ] Lambda Function URL is accessible via HTTPS
- [ ] Sending a POST request to the URL returns 200
- [ ] Request is logged in CloudWatch

---

## Stage 2: Postmark Integration

**Goal:** Receive and validate inbound emails from Postmark.

### Tasks
1. Set up Postmark inbound server and DNS (MX records)

2. Update Lambda to:
   - Parse Postmark webhook payload
   - Validate recipient address contains inbox secret
   - Validate sender is in allowed senders list
   - Return 200 for valid requests, 403 for unauthorized

3. Update SSM parameters with real values:
   - `inbox-secret`
   - `allowed-senders`

### Success Criteria
- [ ] Postmark MX records are configured and verified
- [ ] Email to `notion-{secret}@yourdomain.com` triggers Lambda
- [ ] Email from allowed sender logs payload and returns 200
- [ ] Email from unauthorized sender returns 200 (silent reject) with no processing
- [ ] Email to wrong address (wrong secret) returns 200 (silent reject)

---

## Stage 3: Subject Line Parsing

**Goal:** Extract client tag and clean subject from forwarded emails.

### Tasks
1. Implement `parseSubject()` function:
   - Extract `#clientname:` from subject
   - Strip `Fwd:`, `Re:`, `Fw:`, `Reply:` prefixes (case-insensitive, repeating)
   - Return `{ client, subject }` or throw error

2. Add error handling:
   - Missing client tag → log error, skip processing (notification added later)

### Success Criteria
- [ ] `#acme: Fwd: Re: Q4 Invoice` → `{ client: "acme", subject: "Q4 Invoice" }`
- [ ] `#beta: FW: FW: Meeting` → `{ client: "beta", subject: "Meeting" }`
- [ ] `#new: Hello World` → `{ client: "new", subject: "Hello World" }`
- [ ] `Missing hashtag` → throws error / logs warning
- [ ] Subject parsing logged in CloudWatch

---

## Stage 4: Forwarded Email Parsing

**Goal:** Extract original sender and date from forwarded headers.

### Tasks
1. Implement `parseForwardedHeaders()` function:
   - Find all `From:` occurrences
   - Skip any matching allowed senders (self-replies)
   - Extract first external sender
   - Parse `Date:` or `Sent:` field

2. Implement `stripForwardingHeaders()` function:
   - Remove Gmail, Outlook, Apple Mail, generic forwarding headers
   - Handle both plain text and HTML content

### Success Criteria
- [ ] Forwarded email from client → extracts client's email and date
- [ ] Forwarded thread where you replied last → extracts client (skips your address)
- [ ] Gmail, Outlook, Apple Mail headers all stripped correctly
- [ ] Fallback to Postmark sender/date if parsing fails

---

## Stage 5: Email Body Processing

**Goal:** Convert HTML email to Notion-compatible blocks.

### Tasks
1. Add dependencies: `turndown`, `turndown-plugin-gfm`

2. Implement HTML → Markdown conversion:
   - Configure turndown with GFM plugin
   - Add rule to ignore `<img>` tags
   - Linkify plain-text URLs

3. Implement Markdown → Notion blocks conversion:
   - Paragraphs, headings (h1-h3)
   - Bulleted and numbered lists
   - Quotes, code blocks, dividers
   - Bold, italic, strikethrough annotations
   - Links

4. Implement text chunking (2000 char limit per rich_text)

### Success Criteria
- [ ] HTML email with formatting converts to proper Notion blocks
- [ ] Links (both `<a>` tags and plain URLs) become clickable
- [ ] Images are ignored (not converted)
- [ ] Long paragraphs are chunked correctly
- [ ] Forwarding headers are not present in output

---

## Stage 6: Notion Database Integration

**Goal:** Create database entries with email content.

### Tasks
1. Add dependency: `@notionhq/client`

2. Create Notion integration and database manually (see QUICKSTART.md)

3. Implement Notion client:
   - Create page in database with properties (Name, Date, From, Client, Has Attachments, Summary)
   - Append content blocks to page

4. Update SSM parameters:
   - `notion-database-id`
   - `notion-api-key`

### Success Criteria
- [ ] Forwarded email creates database row with correct properties
- [ ] "From" shows original sender (not forwarder)
- [ ] "Date" shows original email date
- [ ] "Client" matches hashtag
- [ ] Page content contains formatted email body
- [ ] Entry visible in Notion database

---

## Stage 7: Attachment Handling

**Goal:** Upload email attachments to Notion pages.

### Tasks
1. Implement attachment filtering:
   - Include: `ContentID` empty (manual attachments)
   - Exclude: `ContentID` present (CID-embedded images)
   - Exclude: Executable files (exe, dll, bat, sh)
   - Exclude: Files > 20MB

2. Implement Notion file upload:
   - Upload via Notion API
   - Add as file block (documents) or image block (images)
   - Track upload failures

3. Add warning callouts for failed/skipped attachments

4. Update "Has Attachments" property based on successful uploads

### Success Criteria
- [ ] PDF attachment appears as file block in Notion
- [ ] PNG/JPG attachment appears as image block
- [ ] CID-embedded images are not uploaded
- [ ] Executable files are skipped with warning callout
- [ ] Large files are skipped with warning callout
- [ ] "Has Attachments" checkbox is set correctly

---

## Stage 8: AI Summarization

**Goal:** Generate optional AI summaries using Claude.

### Tasks
1. Add dependency: `@anthropic-ai/sdk`

2. Implement `summarizeEmail()` function:
   - Skip if API key or prompt not configured
   - Call Claude 3.5 Haiku with prompt + email body
   - Return summary text or null

3. Add summary to Notion:
   - Set "Summary" property on database row
   - Add callout block at top of page content

4. Update SSM parameters:
   - `anthropic-api-key`
   - `summary-prompt`

### Success Criteria
- [ ] With API key + prompt configured: summary appears in database and page
- [ ] Without API key: no summary, no error
- [ ] Claude API failure: email still processed, warning logged
- [ ] Summary is concise (2-3 sentences)

---

## Stage 9: Error Notifications

**Goal:** Send email notifications for failures and warnings.

### Tasks
1. Add dependency: `postmark`

2. Implement notification functions:
   - `notifyError()`: For complete failures (missing hashtag, Notion API down)
   - `notifyWarning()`: For partial success (attachment failures)

3. Set up Postmark outbound:
   - Verify sender domain/signature
   - Get Server API Token

4. Update SSM parameter:
   - `postmark-server-token`

5. Integrate notifications into main flow:
   - Wrap processing in try/catch
   - Send appropriate notification on failure
   - Send warning notification if attachments failed but entry created

### Success Criteria
- [ ] Missing hashtag → error email received with helpful message
- [ ] Notion API failure → error email received
- [ ] Attachment upload failure → warning email with Notion link
- [ ] Unauthorized sender → NO email sent (silent reject)
- [ ] Claude API failure → NO email sent (non-critical)

---

## Stage 10: End-to-End Testing & Hardening

**Goal:** Verify complete flow and add production hardening.

### Tasks
1. End-to-end test scenarios:
   - Simple email (no attachments)
   - Email with multiple attachments
   - Email with unsupported attachment
   - Thread where you replied last
   - Missing hashtag
   - Unauthorized sender
   - Gmail, Outlook, Apple Mail forwarding formats

2. Add structured logging:
   - Log email ID, client, success/failure
   - Log attachment counts and failures
   - Avoid logging email content (privacy)

3. Add input validation:
   - Sanitize client names (alphanumeric only)
   - Validate SSM parameters on startup
   - Handle malformed Postmark payloads gracefully

4. Review error handling:
   - Ensure no unhandled promise rejections
   - Ensure Lambda always returns 200 to Postmark (avoid retries)

### Success Criteria
- [ ] All test scenarios pass
- [ ] CloudWatch logs are structured and queryable
- [ ] No sensitive data in logs
- [ ] Malformed requests don't crash Lambda
- [ ] Lambda always returns 200 (even on internal errors)

---

## Stage 11: Documentation & Deployment

**Goal:** Finalize documentation and production deployment.

### Tasks
1. Update README.md with project overview

2. Finalize QUICKSTART.md with complete setup instructions

3. Create example terraform.tfvars.example

4. Add .gitignore for:
   - terraform.tfvars
   - .terraform/
   - node_modules/
   - *.zip

5. Production deployment:
   - Use remote Terraform state (S3 + DynamoDB)
   - Enable Lambda versioning
   - Set up CloudWatch alarm for errors

### Success Criteria
- [ ] New user can deploy from QUICKSTART.md in < 30 minutes
- [ ] No secrets in git repository
- [ ] Terraform state is remote and encrypted
- [ ] CloudWatch alarm fires on Lambda errors

---

## Dependency Summary

| Stage | Dependencies Added |
|-------|-------------------|
| 1 | (none - infrastructure only) |
| 2 | (none - Postmark webhook is passive) |
| 3 | (none - pure JS) |
| 4 | (none - pure JS) |
| 5 | `turndown`, `turndown-plugin-gfm` |
| 6 | `@notionhq/client` |
| 7 | (none - uses Notion SDK) |
| 8 | `@anthropic-ai/sdk` |
| 9 | `postmark` |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Postmark webhook format changes | Pin to known payload structure, log unknown fields |
| Notion API rate limits | Add exponential backoff, warn in docs about high volume |
| Claude API costs spike | Log token usage, set max_tokens limit |
| Email parsing edge cases | Comprehensive test suite, fallback to raw content |
| Lambda timeout on large emails | Increase timeout, skip very large attachments |
