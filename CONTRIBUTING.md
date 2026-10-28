# Contributing

Thank you for helping. Bug reports, fixes and new sources are all welcome.

## Setting up

```sh
npm install
npm run check          # types, formatting, unit tests and the build
```

To try the decoder in a browser:

```sh
npm run fixtures       # makes test videos (needs ffmpeg with libx265)
npm run example        # opens the example page
```

And to run the same checks headless (once, `npx playwright install chromium`):

```sh
npm run test:browser
```

## Pull requests

- Keep changes focused, and add or update tests in `test/` for behaviour you change.
- Run `npm run check` (and `npm run test:browser` for decoder changes) before opening one.
- Describe what changed and why; link the issue if there is one.
- By contributing you agree that your contribution is licensed under the MIT License of
  this project.

## Reporting a bug

Please include the browser and system, the file's container and codecs (`ffprobe` output is
ideal), and the text of `diagnosticsReport()` from the page where it failed.

## Releasing

Releasing is a version bump pushed to `master`; GitHub Actions does the rest. When CI passes on
a push and `package.json` holds a version that is not on npm yet, `.github/workflows/release.yml`
publishes it (npm trusted publishing: no npm token is stored anywhere, and npm adds a provenance
statement), tags the commit `v<version>`, and makes the GitHub Release from that version's
`CHANGELOG.md` entry. A push that leaves the version alone publishes nothing.

1. Add the changes under a new version heading in `CHANGELOG.md` (`## [0.2.1] - date`, and its
   link at the bottom).
2. Bump the version without a local tag (the workflow makes the tag; `patch` for fixes,
   `minor` for new features, `major` for breaking changes), commit and push:

   ```sh
   npm version patch --no-git-tag-version
   git commit -am "Release 0.2.1"
   git push
   ```

3. Watch **Actions**: CI runs, then Release publishes. To retry a failed release, open
   **Actions → Release → Run workflow**.

Don't publish from your own computer: the version would be on npm without its tag, GitHub
Release or the message to the projects built on it, and the workflow would then skip it.

One-time setup on npmjs.com, already done: the package's **Settings → Trusted publishing**
names this repository and the workflow file `release.yml`.

### Telling the projects built on it

After publishing, the release workflow tells the projects built on this package that a new
version is out, and each opens its own update: Web-Media-Player moves to it (its "Update the
decoder" workflow) and TMPlayer-web too, as far as the newest player accepts (its "Update player
libraries" workflow). They also look once a day or a week on their own, so this only makes it
immediate. It needs one secret here, under **Settings → Secrets and variables → Actions**:
`DISPATCH_TOKEN`, a fine-grained personal access token with **Contents: read and write** on
Roshan-Here/Web-Media-Player and Roshan-Here/Tmplayer-web. Without it the step only notes that
no one was told.
