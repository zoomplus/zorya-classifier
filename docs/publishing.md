# Publishing handoff

The owner has authorized publication under GitHub account `zoomplus` and npm account `zoomplus`. The selected destinations are the public repository `zoomplus/zorya-classifier` and public package `zorya-classifier`. These names were available at the preflight check. Check the actual repository/registry and release receipt for completion; this document describes the release process rather than asserting remote state.

## Owner and authentication

The supplied account profiles are https://github.com/zoomplus and https://www.npmjs.com/~zoomplus. The owner requested creation of the repository and publication without manually preparing either destination. MIT was already selected for the extracted code. No private email address is added to package metadata. A local package name is not a registry reservation; recheck availability and identity before dispatch.

Send account names and URLs, not passwords, API keys, recovery codes or authentication files. GitHub can be authenticated locally with `gh auth login --web`; the owner completes the browser flow. npm can use local `npm login` followed by the required browser/2FA publication confirmation. See [GitHub CLI authentication](https://cli.github.com/manual/gh_auth_login) and [npm publication authentication](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/).

For later CI releases, configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) with the actual GitHub repository/workflow. It uses OIDC rather than a long-lived npm token. Configure this after the package ownership and repository are known; a generic workflow would otherwise name an invented owner. Do not place tokens in a workflow or issue.

## Maintainer release sequence

1. Recheck package-name availability, author rights, MIT/third-party notices, acceptance limits and the desired public destination.
2. Set the final package name/scope and repository/homepage/bugs metadata. Update imports/examples if the name changes, then rerun source and installed-archive checks. Existing archive hashes apply only to the original name/content.
3. Run `npm run check`, `npm run pack:check`, `npm run format:check` and a redacted independent secret scan. Inspect actual staged blobs and the produced archive, not only `.gitignore`.
4. Create/push only the clean standalone history, enable secret scanning/push protection and inspect the CI matrix. Raw runs, environment files, personal media and upstream history stay local. Public corpus downloads retain source licenses.
5. Pack the reviewed version, verify its SHA256, then publish with the authorized account. Require the owner's authentication confirmation when prompted. Record registry integrity, Git tag/commit and release evidence.
6. Verify the published version and `latest` dist-tag with the registry. Add the matching version tag and GitHub release notes. Keep the package's `repository`, `homepage` and `bugs` links correct, link npm prominently from GitHub, and update npm keywords plus GitHub Topics for the capabilities actually shipped. Examples include classification, object localization, whole-object bounding boxes, optional segmentation/cutouts, TypeScript and provider-independent model integration. Do not advertise an unqualified text-image research profile as supported.

Both GitHub and npm publication are authorized for this project. A local archive remains useful for pre-release installation, but does not complete the requested release.

## 0.2 release evidence

Use the original-region/full-source-segmentation workflow in the current usage guide. Older interval/proposal experiments and their failed reports remain historical evidence; do not relabel them as measurements of the new flow. Record region hits separately from mask-derived object boxes and pixel-mask quality. The image-free control produces regions only.

Before release, match every runtime file in the final archive to the bytes covered by native/resource acceptance, and require green Windows/Linux × Node 22/24 CI for the release source. A later documentation-only archive can have a different package SHA while retaining the tested runtime; record both complete archive hashes and the explicit runtime-file parity proof. Keep a final independently installed consumer check for the actual release archive.

Keep the final release manifest outside its own archives to avoid self-reference. It records the clean source commit, archive hashes/integrities, model recipe and corpus seals, preserved failures, native/resource receipts, CI run and redacted secret scan. Publish those exact archive bytes, verify the registry response and dist-tag, then attach the matching source and npm artifact to the GitHub release. Do not replace failed accuracy or resource gates with an offline test count.

## 0.2.1 release-candidate handoff

This branch prepares a local **0.2.1 release candidate** from the published **0.2.0** package baseline. Only experimental status documentation, JSDoc, CLI help, the package description, and a test-only Git fixture isolation fix in `test/secrets.test.ts` changed. There are no model, default, or algorithm/runtime behavior changes relative to 0.2.0. npm or GitHub publication has **not** occurred for 0.2.1.

A failed pre-commit attempt during local release preparation is preserved in the maintainer’s local release-preparation logs. That failure led to the narrow test-only isolation fix so hook-provided `GIT_*` variables cannot redirect fixture repositories or mutate unrelated sentinel indexes during secret scans.
