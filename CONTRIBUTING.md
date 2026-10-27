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
