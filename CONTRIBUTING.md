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

Releases are published to npm by GitHub Actions (`.github/workflows/release.yml`) when a GitHub
Release is published, through npm trusted publishing: no npm token is stored anywhere.

1. Add the changes under a new version heading in `CHANGELOG.md`.
2. Bump the version, which commits and tags it (`patch` for fixes, `minor` for new features,
   `major` for breaking changes), and push:

   ```sh
   npm version patch
   git push --follow-tags
   ```

3. On GitHub, open **Releases → Draft a new release**, choose the new tag (`v0.1.1`), paste the
   changelog entry and press **Publish release**. The workflow checks that the tag matches
   `package.json`, runs the full check and publishes.

### Telling the projects built on it

After publishing, the release workflow tells the projects built on this package that a new
version is out, and each opens its own update: Web-Media-Player moves to it (its "Update the
decoder" workflow) and TMPlayer-web too, as far as the newest player accepts (its "Update player
libraries" workflow). They also look once a day or a week on their own, so this only makes it
immediate. It needs one secret here, under **Settings → Secrets and variables → Actions**:
`DISPATCH_TOKEN`, a fine-grained personal access token with **Contents: read and write** on
Roshan-Here/Web-Media-Player and Roshan-Here/Tmplayer-web. Without it the step only notes that
no one was told.
