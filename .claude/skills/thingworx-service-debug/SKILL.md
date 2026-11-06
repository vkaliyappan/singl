---
name: thingworx-service-debug
description: 'Debug ThingWorx services by tracing execution step-by-step. Use when a ThingWorx service returns unexpected results, empty output, wrong status values, or throws errors. Provide the service code and input payload to start. The skill traces the execution path, identifies the failing branch, and requests live API outputs (GetVersions, GetDownstreamEquivalentLinks, etc.) as needed to pinpoint the bug.'
argument-hint: 'Paste the service .js file and the input payload JSON'
---

# ThingWorx Service Debugger

## When to Use
- Service returns 0 rows / empty infotable
- Status values are wrong (e.g., ✅ when should be 🕒)
- Service throws an exception with unclear cause
- Logic branches produce unexpected results

## Procedure

### 1. Gather Input
Ask the user for:
- The service `.js` source (or open the active file)
- The input payload JSON (from ThingWorx Composer test panel)
- The actual output JSON (if available)

### 2. Static Trace
Read the service code and trace the execution path given the input:
- Evaluate branch conditions (if/else) using the actual input values
- Identify which API calls will be made and with which parameters
- Note any assumptions the code makes about API response shape

### 3. Request Live API Results (Iteratively)
When the trace reaches an API call whose result is unknown, give the user the exact payload to run:

```
Thing: <ThingName>
Service: <ServiceName>
Payload:
{
  "param": "value"
}
```

Ask them to paste the result, then continue tracing with the real data.

### 4. Identify the Bug
Common ThingWorx service bugs to look for:

| Bug Pattern | Symptom |
|---|---|
| `GetVersions` only returns one View (e.g. Design) | `mfgVersions = []`, `latestMfgVersion = null`, fallback comparison always returns ✅ |
| `null` fallback in version compare (`latestX ? latestX.Version : "0"`) | Any version > "0" appears current |
| Exception in inner try/catch with no fallback row | Result infotable has 0 rows despite having input data |
| `Latest` flag ignored on downstream part | Outdated link shown as current |
| API returns all historical records (not just current) | Must filter by max version per part number |

### 5. Propose Fix
- Show only the changed code block, not the whole file
- Explain why the original logic was wrong
- Verify the fix against the actual API data collected in step 3

## ThingWorx Infotable Notes
- Empty output (0 rows) shows only `fieldDefinitions` in the REST response — no `rows` key
- `DataShapes["X"].CreateValues()` creates an empty infotable
- `result.AddRow(obj)` — extra fields in `obj` are silently ignored; missing fields default to type default
- A `catch` block that only logs will silently swallow exceptions and leave the result empty

## OData API Patterns (Windchill)
- `GetVersions({ PartId })` — returns versions within the same part family and View. Design parts do NOT return Manufacturing-view parts.
- `GetDownstreamEquivalentLinks({ PartId, $expand: "Downstream" })` — returns ALL historical equivalence links, not just the current one. Must find max version per downstream part number to get the active link.
- `downstream.Latest` — `true` if this is the latest version of the downstream part in Windchill. Use this instead of version comparison when `GetVersions` cannot cross Views.
