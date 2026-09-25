# Narcotic Inventory Audit

Standalone personal PWA for the Gladstone Fire Department narcotic inventory / audit workflow.

## Privacy
Application source code is stored in GitHub. Controlled-substance audit records, signatures, and imported usage data are **not** committed to this repository. Runtime data is stored locally in the browser (IndexedDB) unless a future private backend is configured.

## Core workflow
- Current physical balance for Medic 1, Medic 2, Medic 3, Safe, and Expired
- Fentanyl 100 mcg, Versed 2 mg, Versed 5 mg, Ketamine 500 mg, Morphine 10 mg
- Inventory transactions and activity history
- Monthly audits with persistent drafts
- Signer + witness capture for each location
- Final audit attestation
- Usage-summary import notes
- Reports and printable audit view
- Offline/PWA support
- JSON backup/export/import for migration and recovery

## Migration safety
The original GPT Site remains the source of truth until its historical submitted data has been exported and imported here. Do not delete or retire the original Site until counts and reports have been verified.

## Deployment
This repository is designed for GitHub Pages. GitHub Pages must be enabled for the `main` branch (root folder) in repository settings if it is not already enabled.
