# Dataset manifests

Commit manifest metadata only. The actual audio must remain in a private
location or DVC remote and must not be committed. Obtain written consent for
every speaker, use pseudonymous speaker IDs, and keep the `test` split untouched
until final comparison.

CSV columns, in order:

```text
clip_id,speaker_id,language,accent_region,channel,network,sample_rate_hz,duration_s,scenario,reference_text,contains_numbers,contains_names,contains_pidgin,consent_id,split,recorded_at
```
