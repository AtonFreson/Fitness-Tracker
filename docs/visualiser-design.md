# Visualiser design and evidence

## Product research (2 October 2026)

| Reference | Useful pattern | Application here |
| --- | --- | --- |
| [Apple Health](https://support.apple.com/en-lamr/guide/iphone/iphe3d379c32/ios) | Summary and highlights open into detailed history | Summary is the landing page; every metric leads to its chart and original record |
| [Apple training load](https://support.apple.com/guide/watch/track-your-training-load-apde4c07a6cf/watchos) | Recent training in the context of a longer baseline | Weekly recorded minutes and session frequency, clearly distinguished from physiological training load |
| [MacroFactor weight trend](https://help.macrofactorapp.com/en/articles/21-weight-trend) | Raw readings and an explicitly separate smoothed trend | Raw samples stay visible; optional 28-day trailing median is calculated per device |
| [Oura Trends](https://support.ouraring.com/hc/en-us/articles/360055983614-Using-Trends) | Consistent ranges, chart inspection, paired metric comparison | Range controls, pointer/keyboard scrubbing, same-record scatter comparisons with sample counts |
| [Hevy statistics](https://www.hevyapp.com/features/gym-performance/) | Overview, calendar, detailed sessions and history | Training calendar, weekly bars, session heart-rate charts and elapsed-time comparison |
| [Withings Body Scan](https://www.withings.com/en-us/collections/body-scan) | Body composition and longitudinal context | Fat and fat-free mass shown as the two non-overlapping parts of total weight |
| [WHOOP body composition](https://support.whoop.com/s/article/Body-Composition-Weight-Trends) | Weight, fat and lean-mass trends beside activity | Body and training shown together, without inferring recovery from missing inputs |
| [Strava Fitness & Freshness](https://support.strava.com/en-us/articles/15402032-how-fitness-freshness-is-calculated) | Explain the inputs behind a calculated score | Show transparent observed metrics; do not invent a strain, readiness or strength score |

Visual references: the published Hevy statistics screenshots, Apple Health Summary examples, and MacroFactor's raw/trend chart illustrations. The interface uses system typography, restrained surfaces, semantic chart colours, grouped rows, five persistent destinations, and progressive disclosure. Mobile has a bottom navigation bar; desktop has a left rail and wider charts.

## Measurement policy

ACCUNIQ is the preferred reference for composition because this user's instrument measures through both hands and feet. TANITA DC-360 uses foot electrodes. [TANITA's explanation](https://tanita.eu/bioelectrical-impedance-analysis) describes the additional measurements from hand electrodes. Electrode count alone does not supply an individual accuracy percentage: [a comparison with DXA](https://pubmed.ncbi.nlm.nih.gov/36619314/) found high precision alongside systematic offsets. Hydration and measurement conditions also matter ([TANITA guidance](https://tanita.eu/how-to-best-use)).

- Default reference: latest available ACCUNIQ reading, with its actual date. Fall back to TANITA only when that metric has no ACCUNIQ data. Never present an older reference as today's measurement.
- All changes, smoothing, correlations and regressions use one source at a time. Separate traces expose disagreement; they are never averaged into a synthetic body measurement.
- Nearby device differences are descriptive paired observations, not correction factors. Pair within three calendar days and use each TANITA reading at most once.
- All qualitative fields are unrestricted strings. Display complete wording as reported; do not map an unknown phrase to a known class or a score.
- Fat-free mass includes water and other lean tissue. Do not add water or muscle to fat plus fat-free mass, and do not infer regional body shape from whole-body readings.

## Analytics

- Calendar charts preserve the recorded local calendar date. Heart-rate elapsed time uses absolute timestamps.
- Median smoothing uses daily medians from the preceding 28 days within each source. Missing observations stay missing. Gaps over 45 days break plotted lines.
- Comparisons pair two metrics from the same record and same device. Pearson r requires at least four pairs and nonzero variance. Correlation is descriptive, not causation; some composition metrics are mathematically related.
- Body measurements can also be compared with recorded strength minutes or sessions in the preceding 28 calendar days, excluding the measurement day. These windows must fit within the imported workout history; they do not establish continuous tracking coverage or causation.
- Projections use daily medians from the preceding 90 days, at least six distinct days spanning 28 days, a latest reading within 30 days, and no gap over 45 days. Linear extrapolation is limited to 28 days. Its 95% prediction interval reflects residual variability under a simple linear model, not device accuracy or a medical confidence interval. No silent switch from ACCUNIQ to TANITA when data is sparse.
- The composition scenario is arithmetic: target weight = assumed fat-free mass / (1 − selected body-fat fraction). It is not a forecast or a recommended goal.
- Workout charts show recorded duration, active energy, session frequency and heart rate. No sets, repetitions, exercise names, RPE, resting heart rate or HRV are inferred from the strength-session exports.
- Heart-rate distribution weights consecutive samples by observed elapsed time. Gaps over 60 seconds are excluded; coverage is shown against elapsed session time. Bins use explicit bpm boundaries rather than assumed personal training zones.

## Import reliability

ZIP decompression observes stream backpressure in both native and fallback paths. Selected-file reads remain on the main thread and transfer bounded byte ranges to the worker, avoiding WebKit's failure when a selected File is cloned into a worker. Parsing runs in a module worker with progress updates. No expanded XML string or DOM is retained. The fflate 0.8.2 fallback and its MIT license are bundled under `vendor/`. Re-imports merge unique historical heart-rate samples because newer Apple exports may omit old readings. Record editing still deliberately replaces values.

## Scope

This version visualises every numeric body measurement, reported indicator position, impedance reading, qualitative classification, and the strength-workout fields currently stored by the tracker. Other Apple Health categories (daily steps, sleep, mobility and non-strength workouts), exercise-level gym logs and anatomical segment readings need explicit schema/import support before they can power additional views.
