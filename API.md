# Creating jobs from another system

`POST https://<project-ref>.supabase.co/functions/v1/create-job`

Headers: `Content-Type: application/json` and `x-api-key: <key>`.

Create a key (shown once) in the Supabase SQL editor, and switch one off the same way:

    select * from public.ra_create_api_key('CRM system');
    update public.ra_api_keys set active = false where name = 'CRM system';

Deploy the function with `supabase functions deploy create-job --no-verify-jwt`.

## Body

| Field | Required | Notes |
|---|---|---|
| `org` or `orgName` | yes | An active **customer** organisation: its id, or its exact name |
| `jobType` or `jobTypeName` | yes | A job type id, or its name |
| `title` | yes | Up to 200 characters |
| `custName` | yes | Customer name |
| `addr1` | yes | Address line 1 |
| `postcode` | yes | A valid UK postcode; stored in standard form (`SW1A 1AA`) |
| `extRef` | no | Your own reference. Sending the same `extRef` again for the same organisation returns the existing job instead of creating another |
| `custEmail`, `custPhone`, `addr2`, `town`, `county`, `notes`, `minutes` | no | `minutes` defaults from the job type |

The job is created with status **New** and the next job number.

## Responses

| Status | Meaning |
|---|---|
| 201 | Created: `{"id":"x1a2b3c4d5e","number":1560,"duplicate":false}` |
| 200 | Same `extRef` already exists: the existing job, `"duplicate":true` |
| 401 | Missing or invalid API key |
| 422 | Bad data: `{"error":"postcode is not a valid UK postcode"}` |
| 400 / 405 / 500 | Not JSON / not POST / server error |

## Example

    curl -X POST 'https://<project-ref>.supabase.co/functions/v1/create-job' \
      -H 'x-api-key: ra_...' -H 'Content-Type: application/json' \
      -d '{"orgName":"Acme Facilities","jobTypeName":"Boiler service","title":"Leaking tap",
           "custName":"A Customer","addr1":"1 High St","postcode":"SW1A 1AA","extRef":"CRM-7731"}'

## Test harness

Open `create-job-test.html` (also served next to the app) to send requests to this service from a browser and run a set of
checks: missing or wrong key, wrong method, bad JSON, each missing or invalid field, unknown organisation or job type,
and (optionally) creating a job and repeating its `extRef`. Test jobs have an `extRef` starting `TEST-`.
