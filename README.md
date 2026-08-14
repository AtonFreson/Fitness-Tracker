# Fitness Tracker

A phone-friendly health and fitness tracker hosted through GitHub Pages, with data stored in a separate private GitHub repository.

## Current functionality
- TANITA DC-360 body-composition receipt imports (`.pdf` or image)
- ACCUNIQ body-composition report imports
- Apple Health `export.xml` imports
- Direct Apple Health ZIP uploads without extracting them first
- Traditional Strength Training imports with full timestamped heart-rate readings plus summary/active-energy data when available
- Automatic upload/source detection
- Deduplicated event-based storage in a private GitHub repository; explicit deletes are confirmed
- Browser access using a fine-grained GitHub token saved in the private data repository

More visualisation and general Apple Health functionality will be added later.

## Usage / Setup
The project uses two repositories:

- `Fitness-Tracker` — **public**, hosts the GitHub Pages website
- `Fitness-Tracker-Data` — **private**, stores the imported data

Detailed setup instructions are kept with the private repository template instead of cluttering this README. Extract [`Fitness-Tracker-Data-Starter.zip`](Fitness-Tracker-Data-Starter.zip) and follow its `README.md`.

The tracker links to `TRACKER_TOKEN.txt` in the private repository when a new browser needs access. Initial token creation and the security tradeoff are documented in the private starter README; there is no separate login server to configure.

## Sharing
To share the complete project/setup:

1. Open this repository on GitHub.
2. Click **Code → Download ZIP**.
3. Share that ZIP.

It contains the tracker source and a clean `Fitness-Tracker-Data-Starter.zip` without any personal fitness data.

## Testing
```bash
npm test
```
