# Notices and provenance

Zorya Classifier application code is MIT. The library derives the bounded grid geometry, prompt concepts and lifecycle practices from Zorya Games' screen-locator service, source snapshot `97fca38ef027f0c83c63bd069248e6299619abd2`. Extraction changes are recorded in docs/provenance.json; the old application's private history is not included.

Jev and OpenRouter are third-party services. Their software/model/API rights are not granted by this MIT license. Users provide their own credentials and pay the provider. There is no affiliation claim.

Direct runtime dependencies: Zod 3.25.76 (MIT), Sharp 0.34.5 (Apache-2.0). Sharp's separately installed native packages contain libvips and other libraries with their own notices, including LGPL terms; preserve the notices shipped with those packages when redistributing them. npm resolves and installs them separately; this archive does not bundle their binaries.

Optional benchmark photographs are CC BY 2.0, Open Images annotations CC BY 4.0, and newly authored text fixtures MIT. Preserve benchmarks/corpus/ATTRIBUTION.md and each asset's attribution. Photographs and bulk upstream annotation CSVs are downloaded separately and excluded from the npm archive and source release archive.

The public result JSON under docs/evidence also includes derived Open Images bounding-box annotations. These annotations remain CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); source: Open Images V7, https://storage.googleapis.com/openimages/web/index.html. Reference coordinates were normalized/joined for evaluation. Photo pixels are not included there.
