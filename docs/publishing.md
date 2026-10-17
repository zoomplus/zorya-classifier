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

GitHub is sufficient to share source and accept contributions. npm is optional, but makes installation and versioned dependency management easier. The existing local archive can already be installed without either publication.
