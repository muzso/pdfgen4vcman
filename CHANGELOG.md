# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
