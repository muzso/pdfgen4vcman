# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.7] - 2024-07-23

### Added

- HTTP status error codes (i.e. the status codes that we handle as errors and retry the given page) can now be separately specified for the page URL and its resource URLs (i.e. the URLs that are loaded while the page is being rendered). Previously the default set of HTTP status error codes didn't contain 404, because it's usually not a transient error and a retry shouldn't fix it. But in case of page URLs (especially on volvocars.com) this can be a sign of a transient error and now we retry that page instead of simply saving as PDF.

### Changed

- improved a bit on logging (added HTTP status codes where they were not logged before)

## [1.0.6] - 2024-07-12

### Changed

- we are now removing the chapter opening/closing buttons from the table-of-contents page after the chapters were opened and before the PDF is generated

## [1.0.5] - 2024-07-12

### Fixed

- the filename/path on the "--output" option was not honored as it was (the date&time was injected into it as well), now the application takes this path literally

## [1.0.4] - 2024-07-12

### Fixed

- added a shell script wrapper (entrypoint.sh) around pdfgen4vcman-cli.js to create a HOME directory and set the env on startup so the image can truely be run with any UID (as intended)
- improved error handling so no PDF is saved in the /work directory if an error occured during PDF generation
- PDF is not saved if no pages have been added
- fixed a log message (it contained a mistaken function name)

## [1.0.3] - 2024-07-11

### Added

- added a couple of fields to package.json (homepage, repository, bugs)

### Changed

- updated a couple of dependencies in package-lock.json

## [1.0.2] - 2024-07-11

### Added

- empty pages are now automatically detected and removed from the combined PDF using Ghostscript's ink coverage output device
- Docker: added Ghostscript for empty page detection and a number of fonts and related packages for better font and Unicode characterset coverage (e.g. Japanese characters were not rendered)
- added documentation of the new empty page detection and removal feature
- added new options to control Puppeteer PDF generation parameters
- added `--font-render-hinting=none` and `--force-color-profile=generic-rgb` as default Chrome cmdline options

### Changed

- PDF generation's `printBackground` default value is now `true`
- PDF generation's `omitBackground` default value is now `false`

## [1.0.1] - 2024-07-07

### Added

- this changelog
- Docker: LICENSE file is now included as well
- README.md: added info about logging
- if an HTTP error occurs that would result in a page load failure anyway, now we don't wait for the page.goto() navigation to finish (on its own), but shut it down explicitly and immediately (saving time in the process)

### Fixed

- Docker: "/home/appuser/.npm" is now cleared at the right step (minimal reduction in image size)
- a number of async issues (race conditions) have been resolved
- more robust error handling in a lot places (i.e. catch() statements)
- closing the browser sometimes threw an error

### Changed

- default value of the `--retries` parameter has been changed from zero to `5` so we won't do retries forever (`pdfgen4vcman` is now robust enough so that if `5` retries don't work, more won't help either)
- the `uncaughtExceptionMonitor` event handler was replaced with an `uncaughtException` handler
- `winston` (the logger) now doesn't handle uncaught exceptions and unhandled rejects, only our own code does (and does the cleanup as well before we exit)

## [1.0.0] - 2024-07-06

### Added

- Initial release (feature complete and mostly stable)

[1.0.1]: https://github.com/muzso/pdfgen4vcman/compare/1.0.0...1.0.1
[1.0.0]: https://github.com/muzso/pdfgen4vcman/releases/tag/1.0.0
