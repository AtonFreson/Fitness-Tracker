# Fitness Tracker

Phone-friendly tracker hosted on GitHub Pages, with fitness data stored in a separate private GitHub repository.

## Visualiser
- **Summary** — composition reference, recent training and latest records
- **Body** — dated device snapshots, every numeric metric, unrestricted report wording and nearby device comparisons
- **Training** — consistency calendar, recorded time/energy and session heart-rate inspection with elapsed-time comparison
- **Explore** — date ranges, chart scrubbing, per-device smoothing, paired comparisons, conditional projections and a composition scenario calculator
- **Data** — import, review, edit, sync, filter, export and delete records

ACCUNIQ is the preferred composition reference. TANITA keeps a separate history; models never average readings from different devices. See [design and analytics methods](docs/visualiser-design.md) for the research, assumptions and data requirements.

## Imports
- TANITA DC-360 PDF/image scans using Google Cloud Vision OCR with an isolated local fallback
- ACCUNIQ reports
- Apple Health `export.xml` or the original export ZIP
- Traditional Strength Training workouts with active energy and timestamped heart-rate samples

Health ZIPs are read in bounded chunks and parsed in a background worker. Re-importing retains and deduplicates older heart-rate samples even if the newer export omits them. The ZIP fallback is bundled locally.

The private data repository stores deduplicated logs in monthly JSON files under `data/events/`.

## Batch receipt scans

Choose **Batch-scan TANITA receipts** to separate several receipts from one photo. Keep small gaps between receipts and all corners visible against a contrasting surface.

During PDF review, the blue outline marks the crop; the surrounding 10% margin is shown for inspection and is excluded from the PDF. Select **TL**, **TR**, **BL**, or **BR** and use the fixed directional controls to move that corner by 1 or 10 photo pixels. Rotation, corner reset, and a magnified corner view help with fine adjustments. Confirm the date and download each PDF, then import it through the tracker as usual.

## Setup
The project uses:

- `Fitness-Tracker` — public GitHub Pages app
- `Fitness-Tracker-Data` — private data repository

Extract [`Fitness-Tracker-Data-Starter.zip`](Fitness-Tracker-Data-Starter.zip) and follow its `README.md` for setup.

## Development
```bash
npm test
```
