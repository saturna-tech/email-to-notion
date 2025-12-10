# Implementation Plan

This document outlines the staged implementation plan for Notion Email Archiver as specified in DESIGN.md.

---

## Stage 1: Infrastructure Foundation

**Goal:** Deploy minimal AWS infrastructure that can receive emails.

### Tasks
1. Create Terraform configuration for:
   - Lambda function (Node.js 20.x, 512MB, 60s timeout)
   - SES domain identity and receipt rules
   - S3 bucket for email storage (7-day retention)
   - IAM role with S3, SSM, and CloudWatch permissions
   - CloudWatch log group
   - SSM parameters (placeholder values for now)

2. Create minimal Lambda handler that:
   - Logs incoming SES events
   - Returns success

3. Deploy to AWS

### Success Criteria
- [ ] `terraform apply` completes without errors
- [ ] SES domain identity created (pending verification)
- [ ] S3 bucket created with lifecycle policy
- [ ] Lambda function deployed

---

## Stage 2: SES Integration

**Goal:** Receive and validate inbound emails from SES.

### Tasks
1. Configure DNS records:
   - TXT record for SES domain verification
   - MX record pointing to SES inbound

2. Update Lambda to:
   - Parse SES event structure
   - Fetch raw MIME from S3
   - Parse MIME using mailparser
   - Validate recipient address contains inbox secret
   - Validate sender is in allowed senders list
   - Return success for valid requests

3. Update SSM parameters with real values:
   - `inbox-secret`
   - `allowed-senders`

### Success Criteria
- [ ] SES domain is verified
- [ ] MX records are configured
- [ ] Email to `notion-{secret}@yourdomain.com` triggers Lambda
- [ ] Email from allowed sender logs parsed content
- [ ] Email from unauthorized sender is silently rejected
- [ ] Email to wrong address (wrong secret) is not processed

---

## Stage 3: Subject Line Parsing

**Goal:** Extract client tag and clean subject from forwarded emails.

### Tasks
1. Implement `parseSubject()` function:
   - Extract `#clientname:` from subject
   - Strip `Fwd:`, `Re:`, `Fw:`, `Reply:` prefixes (case-insensitive, repeating)
   - Return `{ client, subject }` or throw error

2. Add error handling:
   - Missing client tag → log error, create error entry in Notion (added later)

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
- [ ] Fallback to SES sender/date if parsing fails

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
   - Include: `cid` empty (manual attachments)
   - Exclude: `cid` present (CID-embedded images)
   - Exclude: Executable files (exe, dll, bat, sh)
   - Exclude: Files > 20MB

2. Implement Notion file upload:
   - Call POST /v1/files to get signed upload URL
   - Upload file content to signed URL
   - Add file block (documents) or image block (images) to page
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

## Stage 9: Error Handling

**Goal:** Log errors to Notion database for visibility.

### Tasks
1. Implement error entry creation:
   - Create database entry with "[ERROR]" prefix in title
   - Set client to "error"
   - Include error message in page content

2. Integrate error handling into main flow:
   - Wrap processing in try/catch
   - Log errors to Notion when possible
   - Always log to CloudWatch
   - Re-throw to signal Lambda failure (for retry/DLQ if configured)

### Success Criteria
- [ ] Missing hashtag → error entry in Notion with helpful message
- [ ] Notion API failure → attempted error entry, logged to CloudWatch
- [ ] Unauthorized sender → NO entry (silent reject)
- [ ] All errors logged to CloudWatch with stack traces

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
   - Handle malformed MIME gracefully

4. Review error handling:
   - Ensure no unhandled promise rejections
   - Lambda throws on error (allows retry/DLQ)

### Success Criteria
- [ ] All test scenarios pass
- [ ] CloudWatch logs are structured and queryable
- [ ] No sensitive data in logs
- [ ] Malformed emails don't crash Lambda

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
   - Use remote Terraform state (S3 + DynamoDB) if desired
   - Enable Lambda versioning
   - Set up CloudWatch alarm for errors (optional)

### Success Criteria
- [ ] New user can deploy from QUICKSTART.md
- [ ] No secrets in git repository
- [ ] CloudWatch logs show successful processing

---

## Dependency Summary

| Stage | Dependencies Added |
|-------|-------------------|
| 1 | `@aws-sdk/client-ssm` |
| 2 | `@aws-sdk/client-s3`, `mailparser` |
| 3 | (none - pure JS) |
| 4 | (none - pure JS) |
| 5 | `turndown`, `turndown-plugin-gfm` |
| 6 | `@notionhq/client` |
| 7 | (none - uses Notion SDK) |
| 8 | `@anthropic-ai/sdk` |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| SES delivery issues | Monitor CloudWatch, check MX records |
| MIME parsing edge cases | Comprehensive test suite, fallback to raw content |
| Notion API rate limits | Add exponential backoff, warn in docs about high volume |
| Claude API costs spike | Log token usage, set max_tokens limit |
| Lambda timeout on large emails | Increase timeout, skip very large attachments |
| S3 bucket filling up | Lifecycle policy auto-deletes after 7 days |

---

## Completed Stages

All stages have been implemented:

- [x] Stage 1: Infrastructure Foundation
- [x] Stage 2: SES Integration
- [x] Stage 3: Subject Line Parsing
- [x] Stage 4: Forwarded Email Parsing
- [x] Stage 5: Email Body Processing
- [x] Stage 6: Notion Database Integration
- [x] Stage 7: Attachment Handling (with Notion file upload fix)
- [x] Stage 8: AI Summarization
- [x] Stage 9: Error Handling
- [x] Stage 10: End-to-End Testing & Hardening
- [x] Stage 11: Documentation & Deployment

### Key Implementation Notes

**Notion File Upload Fix**: The Notion API requires a two-step process for file uploads:
1. Call `POST /v1/files` with filename and content type to get a signed upload URL
2. PUT the file content directly to the signed URL
3. Reference the uploaded file in a block

This is different from the external URL approach and allows direct file storage in Notion without external hosting.
