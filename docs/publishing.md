# Publishing handoff

The repository and npm archive are prepared locally. No public repository, remote, registry release or automated publishing workflow has been created. Publication requires a destination and an authenticated owner.

## Information from the owner

1. GitHub username or organization, repository name, and whether to create a new public repository or use an existing URL. Confirm the owner permits MIT publication of the extracted code.
2. npm username/organization and preferred name: `zorya-classifier` if available, or `@scope/zorya-classifier`. A local name in package.json is not a reservation; check registry availability and permissions at publication time.
3. Public maintainer name/contact if desired in package metadata, and an explicit instruction to publish the reviewed version.

Send account names and URLs, not passwords, API keys, recovery codes or authentication files. GitHub can be authenticated locally with `gh auth login --web`; the owner completes the browser flow. npm can use local `npm login` followed by the required browser/2FA publication confirmation. See [GitHub CLI authentication](https://cli.github.com/manual/gh_auth_login) and [npm publication authentication](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/).

For later CI releases, configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) with the actual GitHub repository/workflow. It uses OIDC rather than a long-lived npm token. Configure this after the package ownership and repository are known; a generic workflow would otherwise name an invented owner. Do not place tokens in a workflow or issue.

## Maintainer release sequence

1. Recheck package-name availability, author rights, MIT/third-party notices, acceptance limits and the desired public destination.
2. Set the final package name/scope and repository/homepage/bugs metadata. Update imports/examples if the name changes, then rerun source and installed-archive checks. Existing archive hashes apply only to the original name/content.
3. Run `npm run check`, `npm run pack:check`, `npm run format:check` and a redacted independent secret scan. Inspect actual staged blobs and the produced archive, not only `.gitignore`.
4. Create/push only the clean standalone history, enable secret scanning/push protection and inspect the CI matrix. Raw runs, environment files, personal media and upstream history stay local. Public corpus downloads retain source licenses.
5. Pack the reviewed version, verify its SHA256, then publish with the authorized account. Require the owner's authentication confirmation when prompted. Record registry integrity, Git tag/commit and release evidence.

GitHub is sufficient to share source and accept contributions. npm is optional, but makes installation and versioned dependency management easier. The existing local archive can already be installed without either publication.
