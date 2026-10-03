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
- Raw changes, median smoothing and correlations use one source at a time. The separate model view can combine sources through explicit observation uncertainty and TANITA offsets relative to ACCUNIQ. It is labelled as an estimate, never a recorded measurement.
- Nearby device differences in the Body comparison table are descriptive paired observations, not correction factors. Pair within three calendar days and use each TANITA reading at most once.
- All qualitative fields are unrestricted strings. Display complete wording as reported; do not map an unknown phrase to a known class or a score.
- Fat-free mass includes water and other lean tissue. Do not add water or muscle to fat plus fat-free mass, and do not infer regional body shape from whole-body readings.

## Analytics

- Calendar charts preserve the recorded local calendar date. Heart-rate elapsed time uses absolute timestamps.
- Median smoothing uses daily medians from the preceding 28 days within each source. Missing observations stay missing. Gaps over 45 days break plotted lines.
- Comparisons pair two metrics from the same record and same device. Pearson r requires at least four pairs and nonzero variance. Correlation is descriptive, not causation; some composition metrics are mathematically related.
- Body measurements can also be compared with recorded strength minutes or sessions in the preceding 28 calendar days, excluding the measurement day. These windows must fit within the imported workout history; they do not establish continuous tracking coverage or causation.
- Conditional model predictions require at least six distinct measurement days in the preceding 90 days spanning 28 days, a latest reading within 30 days, and no recent gap over 45 days. A joint model also requires an ACCUNIQ anchor within 90 days. Prediction is limited to 28 days. See the state model below.
- The composition scenario is arithmetic: target weight = assumed fat-free mass / (1 − selected body-fat fraction). It is not a forecast or a recommended goal.
- Workout charts show recorded duration, active/resting/total energy, distance, METs, pauses, elevation, outdoor temperature and heart rate. No sets, repetitions, exercise names, RPE, resting heart rate or HRV are inferred. Imported METs are the source estimate, not a new effort score.
- Heart-rate distribution weights consecutive samples by observed elapsed time. Gaps over 60 seconds are excluded; coverage is shown against elapsed session time. Bins use explicit bpm boundaries rather than assumed personal training zones.

## Import reliability

ZIP decompression observes stream backpressure in both native and fallback paths. Selected-file reads remain on the main thread and transfer bounded byte ranges to the worker, avoiding WebKit's failure when a selected File is cloned into a worker. Parsing runs in a module worker with progress updates. No expanded XML string or DOM is retained. The fflate 0.8.2 fallback and its MIT license are bundled under `vendor/`. Re-imports merge unique historical heart-rate samples because newer Apple exports may omit old readings. Record editing still deliberately replaces values.

## Scope

This version visualises numeric body measurements, indicators, impedance, unrestricted qualitative classifications and every exported workout type. Daily steps, sleep, mobility and dietary intake outside workouts are not imported; their overlapping sources and daily coverage require a separate aggregation policy. Exercise-level gym logs and anatomical segment readings are not inferred.


## Body state model

The recursive state follows fat mass, fat-free mass, both rates of change, a TANITA fat-mass offset and a TANITA weight offset. Weight equals fat plus fat-free mass at every step; fat percentage is derived from these same compartments. Muscle and water estimates are not independently fused with those masses. Rates decay with a 28-day time constant; process uncertainty grows between observations. Long gaps suppress prediction.

The update uses weight and fat mass together with correlated measurement noise, accounting for fat mass being derived partly from weight. One reading per device per local day avoids treating repeated measurements as independent evidence. A joint model estimates offsets relative to ACCUNIQ; it cannot identify a shared error in both instruments. Without ACCUNIQ the reference is explicitly TANITA. Sequential updates use only measurements available at that date. An innovation over a three-sigma joint distance increases observation noise rather than forcing the model to follow a likely outlier. Joseph-form covariance updates preserve numerical stability.

Starting observation standard deviations are 0.5 kg for both scales, and 1.5 body-fat percentage points for ACCUNIQ versus 3 for TANITA. Users can vary observation noise by 0.75×, 1× or 1.5×. A shared uncertainty floor of 0.35 kg for weight, 1 kg for compartment mass, and 1.5 percentage points for fat percentage prevents apparent precision from many BIA readings. These are transparent product assumptions, **not measured device specifications or a validated clinical model**. The approximate 95% bands depend on those assumptions; fat-percentage propagation is first-order and bands are limited to the physical range. Predictions can still be wrong under changing diet, hydration or activity.

The method follows the prediction/update formulation in [Welch and Bishop, An Introduction to the Kalman Filter](https://homepages.inf.ed.ac.uk/rbf/CVonline/LOCAL_COPIES/WELCH/kalman.html). The implemented mass/rate dynamics and numerical assumptions are our design, not parameters claimed from that paper. [Hall's physiological body-weight model](https://www.niddk.nih.gov/research-funding/at-niddk/labs-branches/laboratory-biological-modeling/integrative-physiology-section/research/body-weight-planner) is a different option requiring energy-intake and activity assumptions. This tracker lacks dietary intake and complete daily expenditure; workout calories alone cannot identify an energy imbalance, so they are not converted into predicted fat loss.

## Workout field policy

| Exported field | Treatment |
| --- | --- |
| Activity type, start/end, active duration | Stable IDs; strength IDs retained; activity filters; elapsed and paused time |
| Active-energy statistics / totalEnergyBurned | Convert energy units to kcal; Apple defines totalEnergyBurned as active energy |
| Basal-energy statistics | Store session resting calories; total calories calculated only when active and resting are both known |
| Heart-rate statistics and matching samples | Keep source summaries and unique timestamped samples, retaining previously saved history |
| WorkoutZoneGroup / WorkoutZone | Show reported HR boundaries and durations separately from sample-derived bpm bands; retain original fields |
| Distance statistics | Convert to km; show recorded distance and derived average speed |
| Pause, resume, marker, segment events | Preserve all attributes and show elapsed session timeline |
| Average METs, temperature, elevation, indoor flag, timezone | Store source value and normalised display value with units |
| Humidity | Display only valid 0–100% values; preserve out-of-range exports verbatim without an invented correction |
| Metadata, recording attributes, extra child fields | Retain and expose full original values under exported fields |
| Explicit latitude/longitude metadata | Validate coordinates and show a single location pin |
| WorkoutRoute / FileReference | Resolve only the explicitly linked archive entry; never borrow another session's coordinates |
| GPX track points | Preserve coordinates, time, altitude, speed, course, horizontal/vertical accuracy and segment breaks |

Routes use a local interactive Mercator view with pan, zoom, point inspection, elevation and speed charts. Full points are saved; only rendering is reduced above 5,000 points. Street tiles are optional and requested directly from OpenStreetMap after the user presses Load street map. Tile requests reveal the viewed area to that provider. A session without coordinates states that fact instead of inferring a gym location. Missing routes in XML-only imports retain existing saved route data. Oversized or invalid routes generate a warning while other workout fields still import.

Primary references: [Apple workout metadata](https://developer.apple.com/documentation/healthkit/workout-metadata-keys), [Apple totalEnergyBurned semantics](https://developer.apple.com/documentation/healthkit/hkworkout/totalenergyburned), [Apple workout route association](https://developer.apple.com/documentation/healthkit/creating-a-workout-route).
