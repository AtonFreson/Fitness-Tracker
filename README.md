# Fitness Tracker

Phone-friendly tracker hosted on GitHub Pages, with fitness data stored in a separate private GitHub repository.

## Imports
- TANITA DC-360 PDF/image scans using Google Cloud Vision OCR
- ACCUNIQ reports
- Apple Health `export.xml` or the original export ZIP
- Traditional Strength Training workouts with active energy and timestamped heart-rate samples

The private data repository stores deduplicated logs in monthly JSON files under `data/events/`.

## Setup
The project uses:

- `Fitness-Tracker` — public GitHub Pages app
- `Fitness-Tracker-Data` — private data repository

Extract [`Fitness-Tracker-Data-Starter.zip`](Fitness-Tracker-Data-Starter.zip) and follow its `README.md` for setup.

## Development
```bash
npm test
```
