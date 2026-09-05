# Telegram Jobs Public Visibility System

## Overview

This document describes how Telegram-sourced jobs are made visible on the public Jobs page, and the migration process for existing data.

## The Requirement

**Only Telegram jobs with verified apply URLs are shown publicly.**

This ensures users only see job listings where:
- The apply URL has been discovered and validated
- The URL points to an actual application page (not a job board, article, or company homepage)
- The application link is confirmed to work

## How It Works

### 1. New Telegram Jobs (Future)

```
Telegram Message
  ↓
normalize + extract applyUrl
  ↓
save to database
  ↓
resolveApplyUrlFields()
  ├─ verdict=direct → applyUrl stored, applyUrlStatus='verified', applyUrlVerified=true
  ├─ verdict=aggregator → applyUrl=null, moved to sourceUrl, applyUrlVerified=false
  └─ verdict=other → applyUrl=null, applyUrlVerified=false
  ↓
If applyUrlVerified !== true:
  → Enqueue to apply-discovery queue
  → Universal Apply Agent attempts discovery
  → If successful: applyUrlVerified=true → Job becomes visible
  → If unsuccessful: Job remains hidden
```

### 2. Visibility Rules

**Telegram Jobs:**
- ✅ VISIBLE if `source === 'telegram'` AND `applyUrlVerified === true`
- ❌ HIDDEN if `source === 'telegram'` AND `applyUrlVerified !== true`

**Non-Telegram Jobs (e.g., GitHub, API imports):**
- ✅ VISIBLE based on standard active job criteria only
- No `applyUrlVerified` requirement

### 3. Implementation Details

**Backend Filter (`job.model.ts`):**
```typescript
export function telegramJobVisibilityClauses(): JobQueryFilter[] {
  return [
    {
      $or: [
        // Non-Telegram sources: no applyUrlVerified requirement
        { source: { $ne: 'telegram' } },
        // Telegram sources: must have verified apply URL
        { source: 'telegram', applyUrlVerified: true },
      ],
    },
  ];
}
```

Applied in:
- `GET /api/v1/jobs` (public jobs listing)
- `GET /api/v1/jobs/recommended` (personalized recommendations)

## Migration for Existing Data

### Problem

Existing Telegram jobs in the database may have:
- Invalid/unverified apply URLs
- Missing `applyUrlVerified` field
- URLs pointing to aggregators or articles instead of actual application pages

### Solution

Run the migration script:

```bash
npm run telegram:verify-apply-urls
```

This script:

1. **Identifies** all Telegram jobs without `applyUrlVerified === true`
2. **Cleans** invalid apply URLs by setting them to `null`
3. **Enqueues** jobs to the apply-discovery queue for re-discovery
4. **Preserves** jobs that already have verified URLs

### Migration Process

```
Existing Telegram Jobs
  ↓
Find jobs where:
  - source = 'telegram'
  - applyUrlVerified !== true
  ↓
For each job:
  ├─ If applyUrl is invalid/unverified
  │  └─ Set applyUrl = null, applyUrlStatus = 'pending'
  └─ Enqueue to apply-discovery queue
      ↓
      Universal Apply Agent processes
      ├─ Valid URL found → applyUrlVerified = true → Job becomes visible
      └─ No valid URL → Job remains hidden
```

### Safety Features

- **Idempotent**: Safe to run multiple times
- **Batch processing**: Processes jobs in chunks (50 at a time)
- **Rate limiting**: 2-second delay between batches
- **Duplicate detection**: Skips jobs already in discovery queue
- **Preservation**: Never touches already-verified jobs

## Testing

Comprehensive test suite in `tests/telegram-jobs-visibility.test.ts`:

✅ Shows Telegram jobs with verified apply URLs  
✅ Hides Telegram jobs without verified apply URLs  
✅ Hides Telegram jobs with applyUrlVerified = null  
✅ Shows both verified Telegram and non-Telegram jobs  
✅ Filters correctly in mixed scenarios  

Run tests:
```bash
npm test telegram-jobs-visibility.test.ts
```

## Example Scenarios

### Scenario 1: New Telegram Job with Direct Apply URL

```
Job posted: "Apply at https://careers.company.com/job/123"
  ↓
Direct URL extracted
  ↓
applyUrlVerified = true
  ↓
✅ Job immediately visible on /jobs
```

### Scenario 2: New Telegram Job with Aggregator Link

```
Job posted: "Apply at https://freshershunt.in/company-job"
  ↓
Aggregator detected
  ↓
applyUrl = null, moved to sourceUrl
applyUrlVerified = false
  ↓
Enqueued to discovery queue
  ↓
Universal Agent attempts discovery:
  ├─ Success: Finds actual apply URL → applyUrlVerified = true → ✅ Job becomes visible
  └─ Failure: No valid URL found → ❌ Job stays hidden
```

### Scenario 3: Existing Job (Before Migration)

```
Existing job with invalid URL
  ↓
Run migration script
  ↓
Invalid URL cleared (applyUrl = null)
  ↓
Job enqueued for discovery
  ↓
Universal Agent processes:
  ├─ Valid URL found → ✅ Job becomes visible
  └─ No valid URL → ❌ Job stays hidden
```

## Monitoring

Check job visibility status:

```bash
# Count visible Telegram jobs
db.jobs.countDocuments({
  source: 'telegram',
  applyUrlVerified: true,
  status: 'active'
})

# Count hidden Telegram jobs
db.jobs.countDocuments({
  source: 'telegram',
  applyUrlVerified: { $ne: true },
  status: 'active'
})

# Check discovery queue status
npm run queue:status
```

## Benefits

1. **User Experience**: Users only see jobs with actual, working apply links
2. **Data Quality**: No fake, invalid, or aggregator URLs shown as "Apply Now"
3. **Automatic Recovery**: Jobs that initially fail discovery can be re-processed
4. **Source Flexibility**: Non-Telegram sources maintain their own visibility rules
5. **Safe Migration**: Existing data cleaned up without data loss

## Related Files

- `src/models/job.model.ts` - Visibility logic
- `src/routes/jobs.route.ts` - Public API endpoints
- `src/scripts/telegram-jobs-verify-apply-urls.ts` - Migration script
- `tests/telegram-jobs-visibility.test.ts` - Test suite
- `src/apply-discovery/` - Universal Apply Link Discovery Agent
