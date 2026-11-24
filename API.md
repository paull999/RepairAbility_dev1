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

The job is created with status **New** and the next job number. Its first visit (visit 1, a *Site visit* event, not yet closed) is created with it.

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

## GetBookings and ConfirmBooking

Two more functions, using the same API keys and headers as `create-job`. Deploy them with
`supabase functions deploy get-bookings --no-verify-jwt` and `supabase functions deploy confirm-booking --no-verify-jwt`
(both folders hold the same code), and run the new section at the end of `schema.sql`.

### `POST /functions/v1/get-bookings`

Works out the servicers and booking options for a job the same way as the **Book** button in the app: servicers who are
insured, have the skills and cover the job's postcode, then each one's next five available days (respecting working days,
lead time and unavailable dates), with one option per booking window, or one per day, or a single option for *Assign only*
servicers. At most 60 options, earliest first.

| Field | Required | Notes |
|---|---|---|
| `job` or `jobNumber` | yes | The job id, or its number |
| `servicer` | no | A servicer id from an earlier response, to list only that servicer |

The job must not be Cancelled, Closed or Invoiced, and its customer needs an agreed price for the job type
(the same rule as the app). Response `200`:

    {"job":{"id":"x1a2b3c4d5e","number":1560,"status":"New","postcode":"CB1 1AH","jobType":"Dishwasher", ...},
     "servicers":[{"id":"vftzz3a","name":"Cambridge Appliance Repairs","bookTo":"Book to a booking window","earliestDate":"2026-11-25", ...}],
     "bookings":[{"key":"bk_952d20587148ae90170244ac2ade784c61e7","servicerId":"vftzz3a","servicer":"Cambridge Appliance Repairs",
                  "bookTo":"Book to a booking window","date":"2026-11-25","bookingWindow":"AM (08:00\u201312:00)","alreadyBooked":0}],
     "expiresAt":"2026-11-24T16:14:43.000Z"}

Every booking has its own unique `key`. Keys last 24 hours, and asking again for the same job replaces its earlier keys.

### `POST /functions/v1/confirm-booking`

Body: `{"key":"bk_..."}` using a key from `get-bookings`. The job is booked exactly as the Book button does it: the servicer is
assigned, the date and booking window are set (none for *Assign only*), an engineer from another organisation is cleared,
the coverage supplement is recalculated and the status becomes **Booked**. All of that job's keys are then removed, so a key
cannot be used twice.

Response `200`: `{"job":{"id":"...","number":1560,"status":"Booked"},"booking":{"servicerId":"...","servicer":"...","date":"2026-11-25","bookingWindow":"AM (08:00\u201312:00)"}}`

| Status | Meaning |
|---|---|
| 401 | Missing or invalid API key |
| 404 | Job not found, or the key is unknown or already used |
| 410 | The key has expired: call `get-bookings` again |
| 409 | The diary changed since the key was issued (servicer unavailable, or no longer able to do the job) |
| 422 | Missing field, servicer cannot do the job, job closed or cancelled, or no agreed price |

## Test harnesses

`booking-test.html` walks through generating a new job, getting its bookings and confirming one, and logs each call with its
`curl`.

`create-job-test.html` sends requests to `create-job` from a browser and runs a set of checks: missing or wrong key, wrong method, bad JSON, each missing or invalid field, unknown organisation or job type,
and (optionally) creating a job and repeating its `extRef`. Test jobs have an `extRef` starting `TEST-`.
