# Notices and provenance

The `zorya-classifier-mcp` package code is MIT licensed. It uses the separately published `zorya-classifier@0.2.3` package as a runtime dependency; that library and its archive are installed by npm and are not copied into this package archive.

The package uses the Model Context Protocol TypeScript SDK, Zod, JOSE, ipaddr.js and Sharp. Their licenses and any transitive dependency notices remain with their separately installed npm packages. The Docker image installs these dependencies from the package lockfile; preserve applicable third-party notices when redistributing the image.

Model providers, hosted APIs, identity providers and OpenRouter are third-party services. Their terms are separate from this package license. Operators supply their own provider credentials, model configuration, OIDC issuer and any segmentation runtime/assets. This package does not download weights or grant rights to model assets.
